package dev.coach

import android.annotation.SuppressLint
import android.content.Context
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.os.Process
import android.os.SystemClock
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** The same gate runs at receipt and immediately before writing to AudioTrack. */
class AudioGate {
    var generation = -1; private set
    var epoch = -1; private set
    var suppressed = true; private set
    private var lastSequence = -1L
    @Synchronized fun bind(generation: Int, epoch: Int) {
        this.generation = generation; this.epoch = epoch; suppressed = false; lastSequence = -1
    }
    @Synchronized fun stop() { suppressed = true }
    @Synchronized fun flush(generation: Int, epoch: Int): Boolean {
        if (generation != this.generation || epoch <= this.epoch) return false
        this.epoch = epoch; suppressed = false; lastSequence = -1
        return true
    }
    @Synchronized fun accept(packet: AudioPacket): Boolean {
        if (suppressed || packet.generation != generation || packet.epoch != epoch || packet.sequence <= lastSequence) return false
        lastSequence = packet.sequence
        return true
    }
}

data class AudioPacket(val generation: Int, val epoch: Int, val sequence: Long, val timestamp: Double, val pcm: ByteArray) {
    fun bytes(): ByteArray = ByteBuffer.allocate(24 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
        .putInt(MAGIC).putInt(generation).putInt(epoch).putInt(sequence.toInt()).putDouble(timestamp).put(pcm).array()
    companion object {
        const val MAGIC = 0x434f4143
        fun parse(bytes: ByteArray): AudioPacket? {
            if (bytes.size < 26 || bytes.size % 2 != 0) return null
            val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            if (b.int != MAGIC) return null
            return AudioPacket(b.int, b.int, b.int.toLong() and 0xffffffffL, b.double, bytes.copyOfRange(24, bytes.size))
        }
    }
}

/** Caller holds the playback lock. A nonblocking short write is backpressure, not lost audio. */
class PcmWriteQueue(private val capacityBytes: Int) {
    private val chunks = ArrayDeque<ByteArray>()
    private var offset = 0
    var byteCount = 0; private set
    fun offer(pcm: ByteArray, hardwareBytes: Int = 0): Boolean {
        if (pcm.size + byteCount + hardwareBytes > capacityBytes) return false
        chunks.addLast(pcm); byteCount += pcm.size
        return true
    }
    fun drain(write: (ByteArray, Int, Int) -> Int): Int {
        val chunk = chunks.firstOrNull() ?: return 0
        val remaining = chunk.size - offset
        val written = write(chunk, offset, remaining)
        if (written < 0) return written
        check(written <= remaining && written % 2 == 0) { "AudioTrack returned invalid PCM16 byte count: $written" }
        byteCount -= written
        offset += written
        if (offset == chunk.size) { chunks.removeFirst(); offset = 0 }
        return written
    }
    fun clear() { chunks.clear(); offset = 0; byteCount = 0 }
}

internal fun pcmRmsDbfs(pcm: ByteArray, size: Int = pcm.size): Double {
    var energy = 0.0
    for (i in 0 until size - 1 step 2) {
        val sample = ((pcm[i].toInt() and 255) or (pcm[i + 1].toInt() shl 8)).toShort().toDouble()
        energy += sample * sample
    }
    return if (energy == 0.0) -120.0 else (10 * kotlin.math.log10(energy / (size / 2) / (32768.0 * 32768))).coerceAtLeast(-120.0)
}

class AudioEngine(context: Context, private val report: (String) -> Unit) {
    // Gemini can synthesize a full explanation faster than it plays. Bound memory to
    // 2.88MB at 24kHz; interruptions still flush immediately through the audio gate.
    companion object { const val PLAYBACK_QUEUE_MS = 60000 }
    private val manager = context.getSystemService(AudioManager::class.java)
    private val executor = context.mainExecutor
    private val preferences = context.getSharedPreferences("audio-route", Context.MODE_PRIVATE)
    private var preferredType = preferences.getInt("type", 0)
    private var preferredName = preferences.getString("name", "").orEmpty()
    @Volatile private var movieAudio = false
    private fun selectedRouteAvailable() = preferredType == 0 || manager.communicationDevice?.let { it.type == preferredType && it.productName.toString() == preferredName } == true
    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            if (alive.get() && !movieAudio && !selectedRouteAvailable())
                routes().firstOrNull { it.type == preferredType && it.productName.toString() == preferredName }?.let { manager.setCommunicationDevice(it) }
        }
    }
    private val routeListener = AudioManager.OnCommunicationDeviceChangedListener {
        if (movieAudio) return@OnCommunicationDeviceChangedListener
        synchronized(lock) { if (!selectedRouteAvailable()) player?.pause() else if (!gate.suppressed) player?.play() }
        report("Audio route changed: ${routeDescription()}")
        report(if (selectedRouteAvailable()) "Selected audio route restored" else "Selected audio route unavailable; playback paused to prevent phone fallback")
    }
    private var routeListening = false
    private val alive = AtomicBoolean(false)
    private val run = AtomicInteger()
    private val captureRun = AtomicInteger()
    private val captureSequence = AtomicLong()
    private var captureGeneration = 0
    private var sendCapture: ((ByteArray) -> Boolean)? = null
    private val lock = Any()
    val gate = AudioGate()
    @Volatile var muted = false
    private var recorder: AudioRecord? = null
    private var player: AudioTrack? = null
    private var echo: AcousticEchoCanceler? = null
    private var recordingThread: Thread? = null
    private var playbackThread: Thread? = null
    private var outputRate = 24000
    private var inputRate = 16000
    private var pendingAudio = PcmWriteQueue(outputRate * 2 * (PLAYBACK_QUEUE_MS / 1000))
    private var samplesWritten = 0L
    private var droppedSamples = 0L
    private var receivedBytes = 0L
    private var capturedBytes = 0L
    private var shortWrites = 0L
    private var queueHighWaterBytes = 0
    private var lastProgressAt = 0L
    private var startedAt = 0L
    @Volatile private var inputRmsDbfs = -120.0
    @Volatile private var inputMaxRmsDbfs = -120.0
    @Volatile private var inputAboveThresholdAt = 0L

    fun routes(): List<AudioDeviceInfo> = manager.availableCommunicationDevices
    fun route(deviceId: Int): Boolean {
        if (movieAudio) return false
        val device = routes().firstOrNull { it.id == deviceId } ?: return false
        val accepted = manager.setCommunicationDevice(device)
        if (accepted) {
            preferredType = device.type; preferredName = device.productName.toString()
            preferences.edit().putInt("type", preferredType).putString("name", preferredName).apply()
        }
        report("Route requested: ${device.productName}; accepted=$accepted; actual=${manager.communicationDevice?.productName}")
        return accepted
    }
    fun routeDescription(): String = manager.communicationDevice?.let { "${it.productName} (type ${it.type}, id ${it.id})" } ?: "System default"

    @SuppressLint("MissingPermission")
    fun start(inputRate: Int, outputRate: Int, generation: Int, epoch: Int, send: (ByteArray) -> Boolean) {
        close(resetRoute = false)
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        routes().firstOrNull { it.type == preferredType && it.productName.toString() == preferredName }?.let { manager.setCommunicationDevice(it) }
        manager.addOnCommunicationDeviceChangedListener(executor, routeListener)
        routeListening = true
        this.outputRate = outputRate
        this.inputRate = inputRate
        player = AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(format(outputRate, AudioFormat.CHANNEL_OUT_MONO))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(outputRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), outputRate))
            .build()
        check(player?.state == AudioTrack.STATE_INITIALIZED) { "Speaker initialization failed" }
        // The platform default is the full 500ms capacity; a 240ms mock tone would never start.
        player!!.setStartThresholdInFrames(outputRate / 50)
        synchronized(lock) {
            pendingAudio = PcmWriteQueue(outputRate * 2 * (PLAYBACK_QUEUE_MS / 1000))
            receivedBytes = 0; capturedBytes = 0; shortWrites = 0; droppedSamples = 0; queueHighWaterBytes = 0
            startedAt = SystemClock.elapsedRealtime()
            gate.bind(generation, epoch); samplesWritten = 0; if (selectedRouteAvailable()) player!!.play()
        }
        alive.set(true)
        manager.registerAudioDeviceCallback(deviceCallback, android.os.Handler(android.os.Looper.getMainLooper()))
        captureGeneration = generation; captureSequence.set(0); sendCapture = send
        startRecorder()
        val activeRun = run.get()
        playbackThread = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            while (alive.get() && activeRun == run.get()) {
                synchronized(lock) {
                    if (!gate.suppressed && pendingAudio.byteCount > 0) drainPlayback()
                }
                Thread.sleep(5)
            }
        }, "coach-playback").apply { start() }
        report("Audio active: input=$inputRate output=$outputRate; echo cancellation=${echo?.enabled == true}; bufferFrames=${player?.bufferSizeInFrames}; startThresholdFrames=${player?.startThresholdInFrames}; queueBudgetMs=$PLAYBACK_QUEUE_MS; ${routeDescription()}")
    }

    @Suppress("DEPRECATION")
    val movieRouteReleased get() = movieAudio && manager.mode == AudioManager.MODE_NORMAL && !manager.isBluetoothScoOn && recorder?.routedDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_MIC

    // Release the glasses call/SCO route while their native video decoder owns audio.
    // The phone microphone keeps spoken movie controls available without coach output.
    fun setMovieAudio(enabled: Boolean) {
        if (movieAudio == enabled || !alive.get()) return
        suppress()
        movieAudio = enabled
        stopRecorder()
        if (enabled) { manager.clearCommunicationDevice(); manager.mode = AudioManager.MODE_NORMAL }
        else {
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            routes().firstOrNull { it.type == preferredType && it.productName.toString() == preferredName }?.let { manager.setCommunicationDevice(it) }
        }
        startRecorder()
        report("Movie audio mode: ${if (enabled) "phone_microphone" else "glasses_conversation"}; ${routeDescription()}")
    }

    @SuppressLint("MissingPermission")
    private fun startRecorder() {
        inputRmsDbfs = -120.0; inputMaxRmsDbfs = -120.0; inputAboveThresholdAt = 0L
        val chunkBytes = inputRate / 50 * 2
        val source = if (movieAudio) MediaRecorder.AudioSource.MIC else MediaRecorder.AudioSource.VOICE_COMMUNICATION
        val activeRecorder = AudioRecord.Builder().setAudioSource(source)
            .setAudioFormat(format(inputRate, AudioFormat.CHANNEL_IN_MONO))
            .setBufferSizeInBytes(maxOf(AudioRecord.getMinBufferSize(inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), chunkBytes * 4)).build()
        recorder = activeRecorder
        check(activeRecorder.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" }
        if (movieAudio) {
            val phoneMic = manager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
            check(phoneMic != null && activeRecorder.setPreferredDevice(phoneMic)) { "Phone microphone unavailable for movie controls" }
        } else if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(activeRecorder.audioSessionId)?.apply { enabled = true }
        val activeCapture = captureRun.get()
        val send = checkNotNull(sendCapture)
        val generation = captureGeneration
        activeRecorder.startRecording()
        recordingThread = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            val buffer = ByteArray(chunkBytes)
            try {
                while (alive.get() && activeCapture == captureRun.get()) {
                    val n = activeRecorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    if (!alive.get() || activeCapture != captureRun.get()) break
                    check(n > 0) { "Microphone read failed ($n)" }
                    inputRmsDbfs = pcmRmsDbfs(buffer, n)
                    inputMaxRmsDbfs = maxOf(inputMaxRmsDbfs, inputRmsDbfs)
                    if (inputRmsDbfs > -45) inputAboveThresholdAt = SystemClock.elapsedRealtime()
                    synchronized(lock) { capturedBytes += n }
                    val pcm = if (muted) ByteArray(n) else buffer.copyOf(n)
                    check(send(AudioPacket(generation, 0, captureSequence.getAndIncrement(), SystemClock.elapsedRealtime().toDouble(), pcm).bytes())) { "Microphone socket send rejected" }
                }
            } catch (error: Exception) {
                if (alive.get() && activeCapture == captureRun.get()) report("Audio input discontinuity: ${error.message ?: error.javaClass.simpleName}")
            }
        }, "coach-microphone").apply { start() }
    }

    private fun stopRecorder() {
        captureRun.incrementAndGet()
        runCatching { recorder?.stop() }
        recordingThread?.join(500); recordingThread = null
        recorder?.release(); recorder = null
        echo?.release(); echo = null
    }

    fun receive(bytes: ByteArray) {
        val packet = AudioPacket.parse(bytes) ?: return
        synchronized(lock) {
            if (!gate.accept(packet)) return
            if (player == null) return
            val hardwareBytes = hardwarePendingBytes()
            val queuedBytes = hardwareBytes + pendingAudio.byteCount
            receivedBytes += packet.pcm.size
            if (!pendingAudio.offer(packet.pcm, hardwareBytes)) {
                droppedSamples += packet.pcm.size / 2
                suppress()
                report("Playback discontinuity: queue overflow; queuedMs=${queuedBytes * 500L / outputRate}; packetMs=${packet.pcm.size * 500L / outputRate}; budgetMs=$PLAYBACK_QUEUE_MS; route=${routeDescription()}")
                return
            }
            queueHighWaterBytes = maxOf(queueHighWaterBytes, queuedBytes + packet.pcm.size)
            if (pendingAudio.byteCount == packet.pcm.size) lastProgressAt = SystemClock.elapsedRealtime()
            drainPlayback()
        }
    }

    private fun hardwarePendingBytes(): Int {
        val head = player?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0
        return ((samplesWritten - head).coerceAtLeast(0) * 2).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    private fun drainPlayback() {
        val output = player ?: return
        if (!selectedRouteAvailable()) { lastProgressAt = SystemClock.elapsedRealtime(); return }
        try {
            val written = pendingAudio.drain { bytes, offset, count ->
                output.write(bytes, offset, count, AudioTrack.WRITE_NON_BLOCKING).also { if (it in 0 until count) shortWrites++ }
            }
            check(written >= 0) { "AudioTrack write error $written; route=${routeDescription()}" }
            if (written > 0) { samplesWritten += written / 2; lastProgressAt = SystemClock.elapsedRealtime() }
            else check(SystemClock.elapsedRealtime() - lastProgressAt < 2000) { "AudioTrack made no progress for 2000ms; queuedBytes=${pendingAudio.byteCount}; route=${routeDescription()}" }
        } catch (error: Exception) {
            suppress()
            report("Playback discontinuity: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    fun suppress() = synchronized(lock) {
        gate.stop()
        pendingAudio.clear()
        player?.pause(); player?.flush()
        samplesWritten = 0
    }

    fun flush(generation: Int, epoch: Int) = synchronized(lock) {
        if (!gate.flush(generation, epoch)) return@synchronized
        pendingAudio.clear()
        player?.pause(); player?.flush()
        samplesWritten = 0
        if (selectedRouteAvailable()) player?.play()
    }

    fun stats(): Map<String, Any> = synchronized(lock) { mapOf(
        "inputRate" to inputRate, "outputRate" to outputRate, "capturedBytes" to capturedBytes,
        "receivedBytes" to receivedBytes, "writtenSamples" to samplesWritten, "droppedSamples" to droppedSamples,
        "playedSamples" to (player?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0L),
        "queuedBytes" to pendingAudio.byteCount + hardwarePendingBytes(),
        "pendingMs" to (pendingAudio.byteCount + hardwarePendingBytes()) * 500L / outputRate,
        "queueHighWaterMs" to queueHighWaterBytes * 500L / outputRate, "queueBudgetMs" to PLAYBACK_QUEUE_MS,
        "shortWrites" to shortWrites, "underruns" to (player?.underrunCount ?: 0), "suppressed" to gate.suppressed,
        "routeType" to (manager.communicationDevice?.type ?: 0),
        "durationMs" to if (startedAt == 0L) 0L else SystemClock.elapsedRealtime() - startedAt,
        "audioMode" to manager.mode, "captureMode" to if (movieAudio) "phone_microphone" else "glasses_conversation",
        "captureSequence" to captureSequence.get(), "microphoneRouteType" to (recorder?.routedDevice?.type ?: 0),
        "inputRmsDbfs" to inputRmsDbfs, "inputMaxRmsDbfs" to inputMaxRmsDbfs, "inputThresholdDbfs" to -45,
        "inputAboveThresholdAgeMs" to if (inputAboveThresholdAt == 0L) -1L else SystemClock.elapsedRealtime() - inputAboveThresholdAt,
        "communicationRoute" to routeDescription(), "microphoneRoute" to (recorder?.routedDevice?.productName?.toString() ?: "unknown"),
        "speakerRoute" to (player?.routedDevice?.productName?.toString() ?: "unknown")
    ) }
    fun metricsSnapshot(): Map<String, Number> = stats().filterKeys {
        it in setOf("queuedBytes", "droppedSamples", "underruns", "inputRate", "outputRate", "routeType", "durationMs",
            "capturedBytes", "receivedBytes", "writtenSamples", "playedSamples", "pendingMs", "queueHighWaterMs", "queueBudgetMs", "shortWrites")
    }.mapValues { it.value as Number }
    fun metrics(): String = stats().entries.joinToString("; ") { "${it.key}=${it.value}" }

    fun close(resetRoute: Boolean = true) {
        alive.set(false)
        manager.unregisterAudioDeviceCallback(deviceCallback)
        run.incrementAndGet()
        stopRecorder(); sendCapture = null
        playbackThread?.join(500); playbackThread = null
        synchronized(lock) { suppress(); player?.release(); player = null }
        if (routeListening) { manager.removeOnCommunicationDeviceChangedListener(routeListener); routeListening = false }
        if (resetRoute || movieAudio) { manager.clearCommunicationDevice(); manager.mode = AudioManager.MODE_NORMAL }
        movieAudio = false
    }
    private fun format(rate: Int, channel: Int) = AudioFormat.Builder().setSampleRate(rate).setChannelMask(channel).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()
}
