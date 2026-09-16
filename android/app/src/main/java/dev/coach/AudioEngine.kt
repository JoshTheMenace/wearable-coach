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

class AudioEngine(context: Context, private val report: (String) -> Unit) {
    companion object { const val PLAYBACK_QUEUE_MS = 10000 }
    private val manager = context.getSystemService(AudioManager::class.java)
    private val executor = context.mainExecutor
    private val routeListener = AudioManager.OnCommunicationDeviceChangedListener { report("Audio route changed: ${routeDescription()}") }
    private var routeListening = false
    private val alive = AtomicBoolean(false)
    private val run = AtomicInteger()
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
    private var pendingAudio = PcmWriteQueue(outputRate * 2 * PLAYBACK_QUEUE_MS / 1000)
    private var samplesWritten = 0L
    private var droppedSamples = 0L
    private var receivedBytes = 0L
    private var capturedBytes = 0L
    private var shortWrites = 0L
    private var queueHighWaterBytes = 0
    private var lastProgressAt = 0L
    private var startedAt = 0L

    fun routes(): List<AudioDeviceInfo> = manager.availableCommunicationDevices
    fun route(deviceId: Int): Boolean {
        val device = routes().firstOrNull { it.id == deviceId } ?: return false
        val accepted = manager.setCommunicationDevice(device)
        report("Route requested: ${device.productName}; accepted=$accepted; actual=${manager.communicationDevice?.productName}")
        return accepted
    }
    fun routeDescription(): String = manager.communicationDevice?.let { "${it.productName} (type ${it.type}, id ${it.id})" } ?: "System default"

    @SuppressLint("MissingPermission")
    fun start(inputRate: Int, outputRate: Int, generation: Int, epoch: Int, send: (ByteArray) -> Boolean) {
        close(resetRoute = false)
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        manager.addOnCommunicationDeviceChangedListener(executor, routeListener)
        routeListening = true
        this.outputRate = outputRate
        this.inputRate = inputRate
        val chunkBytes = inputRate / 50 * 2
        recorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(format(inputRate, AudioFormat.CHANNEL_IN_MONO))
            .setBufferSizeInBytes(maxOf(AudioRecord.getMinBufferSize(inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), chunkBytes * 4))
            .build()
        check(recorder?.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" }
        player = AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(format(outputRate, AudioFormat.CHANNEL_OUT_MONO))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(outputRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), outputRate))
            .build()
        check(player?.state == AudioTrack.STATE_INITIALIZED) { "Speaker initialization failed" }
        // The platform default is the full 500ms capacity; a 240ms mock tone would never start.
        player!!.setStartThresholdInFrames(outputRate / 50)
        if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(recorder!!.audioSessionId)?.apply { enabled = true }
        synchronized(lock) {
            pendingAudio = PcmWriteQueue(outputRate * 2 * PLAYBACK_QUEUE_MS / 1000)
            receivedBytes = 0; capturedBytes = 0; shortWrites = 0; droppedSamples = 0; queueHighWaterBytes = 0
            startedAt = SystemClock.elapsedRealtime()
            gate.bind(generation, epoch); samplesWritten = 0; player!!.play()
        }
        alive.set(true)
        recorder!!.startRecording()
        val activeRecorder = recorder!!
        val activeRun = run.get()
        recordingThread = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            val buffer = ByteArray(chunkBytes)
            var sequence = 0L
            try {
            while (alive.get() && activeRun == run.get()) {
                val n = activeRecorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                if (!alive.get() || activeRun != run.get()) break
                if (n <= 0) { report("Audio input discontinuity: microphone read failed ($n); inputRate=$inputRate; route=${routeDescription()}"); break }
                synchronized(lock) { capturedBytes += n }
                // Send paced silence when muted. GPT Live requires continuous input timing.
                val pcm = if (muted) ByteArray(n) else buffer.copyOf(n)
                if (!send(AudioPacket(generation, 0, sequence++, SystemClock.elapsedRealtime().toDouble(), pcm).bytes())) {
                    if (alive.get() && activeRun == run.get()) report("Audio input discontinuity: socket send rejected; inputRate=$inputRate; route=${routeDescription()}")
                    break
                }
            }
            } catch (error: Exception) {
                if (alive.get() && activeRun == run.get()) report("Audio input discontinuity: ${error.message ?: error.javaClass.simpleName}")
            }
        }, "coach-microphone").apply { start() }
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
        player?.play()
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
        run.incrementAndGet()
        runCatching { recorder?.stop() }
        recordingThread?.join(500); recordingThread = null
        playbackThread?.join(500); playbackThread = null
        recorder?.release(); recorder = null
        echo?.release(); echo = null
        synchronized(lock) { suppress(); player?.release(); player = null }
        if (routeListening) { manager.removeOnCommunicationDeviceChangedListener(routeListener); routeListening = false }
        if (resetRoute) { manager.clearCommunicationDevice(); manager.mode = AudioManager.MODE_NORMAL }
    }
    private fun format(rate: Int, channel: Int) = AudioFormat.Builder().setSampleRate(rate).setChannelMask(channel).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()
}
