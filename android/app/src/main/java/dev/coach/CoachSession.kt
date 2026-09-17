package dev.coach

import android.content.Context
import android.media.AudioDeviceInfo
import android.os.SystemClock
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

fun json(vararg values: Pair<String, Any?>) = JSONObject().apply { values.forEach { (key, value) -> if (value != null) put(key, value) } }
fun id(): String = UUID.randomUUID().toString()
data class Settings(val provider: String = "mock", val model: String = "mock-coach", val device: String = "mock",
    val recordFrames: Boolean = false, val manualActivity: Boolean = false, val observerModel: String = "", val cprLesson: Boolean = true, val practiceMode: String = "live") {
    val url get() = "http://127.0.0.1:8787"
}
data class CoachState(val status: String = "idle", val sessionId: String = "", val generation: Int = 0,
    val provider: String = "mock", val device: String = "mock", val manualActivity: Boolean = false, val practiceMode: String = "live",
    val muted: Boolean = false, val hud: String = "{}", val hudRevision: Int = -1,
    val captions: List<String> = emptyList(), val diagnostics: List<String> = emptyList(),
    val error: String? = null, val route: String = "System default", val frame: ByteArray? = null,
    val hudImage: ByteArray? = null, val inspection: InspectionState? = null, val glassesDisplayAvailable: Boolean? = null,
    val spectatorToken: String = "", val providers: String = "", val preview: Boolean = false,
    val liveVideo: Boolean = false, val liveChanging: Boolean = false, val liveFrames: Int = 0,
    val liveMessage: String = "", val lastLiveFrameAt: Long = 0,
    val lesson: String = "", val lessonIntro: String = "", val demonstration: String = "", val lessonMedia: String = "Preparing lesson clips…",
    val lessonClipsReady: Set<String> = emptySet())

class CoachSession(private val context: Context, lifecycle: LifecycleOwner, private val scope: CoroutineScope) {
    val telemetry = DeviceTelemetry(context, scope)
    private val _state = MutableStateFlow(CoachState())
    val state: StateFlow<CoachState> = _state
    private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS).build()
    private val audio = AudioEngine(context, ::audioReport)
    private val device = DeviceBridge(context, lifecycle, scope, ::deviceReport)
    private var config = Settings()
    private var token = ""
    private var control: WebSocket? = null
    private var controlReady = false
    private var media: WebSocket? = null
    @Volatile private var binding = 0
    private var generation = 0
    private var epoch = 0
    private var inputRate = 16000
    private var outputRate = 24000
    @Volatile private var closed = true
    @Volatile private var ending = false
    @Volatile private var expectedRebind = false
    private var rebindWaitJob: Job? = null
    private var recoveries = 0
    private var recoveryWindowAt = 0L
    private var activeStage = "bootstrap"
    private var reconnectJob: Job? = null
    private var startJob: Job? = null
    private var previewJob: Job? = null
    private var cameraFeedJob: Job? = null
    private val continuousCamera get() = config.cprLesson && config.device == "meta_display"
    private var liveJob: Job? = null
    private var liveControlJob: Job? = null
    private var liveEpoch = 0
    private var hudRestorePending = false
    private var hudRestoreJob: Job? = null
    private var presentationRevision = 0L
    private var presentationJob: Job? = null
    private var timerJob: Job? = null
    private var rendererId = id()
    private var clearLatchRevision: Int? = null
    private val lessonMedia = LessonMediaCache(File(context.filesDir, "lesson-media"))
    private var lessonClips = emptyList<LessonClip>()
    private var lessonMediaJob: Job? = null
    private var demoJob: Job? = null
    private var demoDeadlineJob: Job? = null
    private var cuePlaybackJob: Job? = null
    private var videoPreparationJob: Job? = null
    @Volatile private var demoRequestId: String? = null
    private var demoLease: DemoPlaybackLease? = null
    private val captureMutex = Mutex()
    private val renderMutex = Mutex()
    private var clockOffset = 0.0
    private var clockUncertainty = Double.POSITIVE_INFINITY
    private val clockId = id()
    private var throughSeq = 0L
    private var healthJob: Job? = null
    private var glassesRecoveryJob: Job? = null
    private var glassesRecoveryExhausted = false
    private var endWatchJob: Job? = null
    val sessionId get() = _state.value.sessionId
    init { telemetry.record("app.lifecycle", "app") }

    private fun audioReport(message: String) {
        val sourceBinding = binding
        val shuttingDownAudio = ending || closed || expectedRebind || demoRequestId != null
        if (demoRequestId != null && message.contains("discontinuity")) {
            log(message)
            report("media.summary", json("kind" to "lesson_video_audio", "requestId" to demoRequestId, "phase" to "input_failed", "audio" to JSONObject(audio.stats())))
        }
        scope.launch {
        if (sourceBinding != binding || shuttingDownAudio || ending || closed || expectedRebind || demoRequestId != null) return@launch
        log(message)
        if (message.startsWith("Selected audio route unavailable")) _state.update { it.copy(error = "Glasses audio disconnected. Playback is paused; reconnect the glasses or choose an audio route.") }
        if (message == "Selected audio route restored") _state.update { if (it.error?.startsWith("Glasses audio disconnected.") == true) it.copy(error = null) else it }
        if (message.startsWith("Audio route changed:")) {
            _state.update { it.copy(route = audio.routeDescription()) }
            report("device.status", json("audioRoute" to audio.routeDescription(), "observedAt" to System.currentTimeMillis()))
        }
        if (message.contains("discontinuity")) {
            diagnostic("audio.discontinuity", "audio", "warning", "retrying", JSONObject(audio.metricsSnapshot()))
            reconnect()
        } else diagnostic("audio.status", "audio", details = JSONObject(audio.metricsSnapshot()))
    } }

    private fun deviceReport(message: String) {
        log(message)
        if (message.startsWith("Lesson video state: ")) report("media.summary", json("kind" to "lesson_video_player",
            "requestId" to demoRequestId, "state" to message.removePrefix("Lesson video state: ")))
        if (message.startsWith("Lesson media HTTP: ")) {
            val delivery = JSONObject(message.removePrefix("Lesson media HTTP: ")).put("kind", "lesson_video_http")
            if (delivery.optString("phase") == "opened") delivery.put("requestId", demoRequestId).put("audio", JSONObject(audio.stats()))
            report("media.summary", delivery)
        }
        if (!closed && !ending && message.startsWith("Meta display error: ")) {
            val code = message.substringAfter("Meta display error: ").filter { it.isLetterOrDigit() || it == '_' }.take(60)
            diagnostic("command.failed", "hud", "error", "user_action", json("errorClass" to "GlassesDisplay_$code"))
            _state.update { it.copy(error = "Glasses display interrupted ($code). Keep the glasses connected while the lesson reconnects.") }
            advertiseLessonMedia()
            report("device.status", json("camera" to device.cameraStats(), "observedAt" to System.currentTimeMillis()))
            recoverLessonGlasses()
        }
    }

    fun log(message: String) {
        _state.update { it.copy(diagnostics = (it.diagnostics + "${System.currentTimeMillis()} $message").takeLast(150)) }
    }
    private fun diagnostic(code: String, stage: String, severity: String = "info", recovery: String = "none", details: JSONObject = JSONObject()) {
        telemetry.record(code, stage, severity, recovery, sessionId, generation,
            details.put("provider", config.provider).put("model", config.model.takeIf { it in setOf("mock-coach", "gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gpt-live-1") } ?: "custom-model").put("device", config.device))
    }
    fun failed(error: Throwable, stage: String = activeStage, details: JSONObject = JSONObject()) {
        if (error is CancellationException && error !is TimeoutCancellationException) return
        val issue = CoachFailure.from(error)
        details.put("errorClass", error.javaClass.simpleName.ifEmpty { "Throwable" })
        if (error is CameraCaptureFailure) details.put("cameraError", error.cameraError)
        if (error is BackendFailure) details.put("httpStatus", error.status)
        diagnostic(issue.code, stage, "error", issue.recovery, details)
        log("${issue.code}: ${issue.message}")
        _state.update { it.copy(error = issue.message) }
    }
    fun dismissError() { _state.update { it.copy(error = null) } }
    suspend fun exportDiagnostics() = telemetry.export(context)

    suspend fun providers(settings: Settings, clearError: Boolean = true): String {
        config = settings
        return request("/api/providers", settings = settings).toString(2).also { value ->
            diagnostic("app.lifecycle", "bootstrap", recovery = "recovered")
            _state.update { it.copy(providers = value, error = if (clearError) null else it.error) }
        }
    }

    suspend fun start(settings: Settings) {
        if (!closed) return
        glassesRecoveryJob?.cancelAndJoin(); glassesRecoveryJob = null
        config = settings
        ending = false; expectedRebind = false; recoveries = 0; activeStage = "bootstrap"
        telemetry.newRun()
        _state.value = CoachState(status = "starting", provider = config.provider, device = config.device,
            manualActivity = config.manualActivity, practiceMode = config.practiceMode, diagnostics = _state.value.diagnostics)
        generation = 0; epoch = 0; throughSeq = 0; clearLatchRevision = null; hudRestorePending = false; glassesRecoveryExhausted = false
        diagnostic("session.start_requested", "session")
        rendererId = id(); clockUncertainty = Double.POSITIVE_INFINITY; clockOffset = 0.0
        closed = false
        startJob = currentCoroutineContext()[Job]
        try {
            val started = System.currentTimeMillis()
            val response = request("/api/sessions", json("createKey" to id(), "config" to json("provider" to config.provider,
                "model" to config.model, "device" to config.device, "recordFrames" to config.recordFrames,
                "manualActivity" to config.manualActivity, "practiceMode" to config.practiceMode, "tutorMode" to if (config.cprLesson) "marine" else null, "observerModel" to config.observerModel.ifBlank { null })))
            updateClock(response, started)
            token = response.getString("token")
            generation = response.getJSONObject("snapshot").getInt("generation")
            _state.update { it.copy(sessionId = response.getString("sessionId"), spectatorToken = response.optString("spectatorToken")) }
            diagnostic("session.created", "session")
            activeStage = "camera"
            // Establish the camera transport before Bluetooth voice starts using the link.
            try { device.start(config.device, withCamera = !config.cprLesson || continuousCamera) }
            catch (error: CameraCaptureFailure) {
                if (config.device != "meta_display" || error.cameraError != "VideoStartTimeout") throw error
                val recovered = device.recoverVideo { attempt ->
                    diagnostic("reconnect.attempt", "camera", "warning", "retrying", json("attempt" to attempt, "cameraError" to error.cameraError))
                }
                if (recovered == VideoRecovery.RECOVERED) diagnostic("reconnect.recovered", "camera", recovery = "recovered")
                else if (continuousCamera) device.start(config.device, withCamera = false)
                else throw error
            }
            _state.update { it.copy(glassesDisplayAvailable = device.displayAvailable) }
            activeStage = "control"
            applySnapshot(response.getJSONObject("snapshot"))
            connect()
            prepareLessonMedia()
        } catch (error: Throwable) {
            if (error is CancellationException && error !is TimeoutCancellationException) {
                withContext(NonCancellable) { if (sessionId.isNotEmpty()) withTimeoutOrNull(2500) { runCatching { endRemote() } } }
                closed = true; release(); _state.update { it.copy(status = "ended") }
                throw error
            }
            failed(error)
            if (sessionId.isNotEmpty()) runCatching { endRemote() }
            closed = true; release()
            _state.update { it.copy(status = "failed") }
        } finally { startJob = null }
    }

    private fun updateClock(response: JSONObject, sent: Long) {
        if (!response.has("serverTime")) return
        val received = System.currentTimeMillis()
        val uncertainty = (received - sent).coerceAtLeast(0) / 2.0
        if (uncertainty < clockUncertainty) {
            clockOffset = response.getDouble("serverTime") - (sent + received) / 2.0
            clockUncertainty = uncertainty
        }
    }

    private fun connect() {
        controlReady = false
        val activeBinding = ++binding
        val controlRequest = Request.Builder().url(wsUrl("control")).build()
        control = client.newWebSocket(controlRequest, object : WebSocketListener() {
            override fun onOpen(socket: WebSocket, response: Response) {
                if (activeBinding != binding || closed || ending) { socket.cancel(); return }
                socket.send(json("type" to "hello", "token" to token, "generation" to generation).toString())
            }
            override fun onMessage(socket: WebSocket, text: String) { scope.launch {
                if (activeBinding == binding && !closed) runCatching { onControl(JSONObject(text), activeBinding) }.onFailure { failed(it) }
            } }
            override fun onFailure(socket: WebSocket, error: Throwable, response: Response?) { scope.launch { if (activeBinding == binding && !closed && !ending && !expectedRebind) { transportLost(error); reconnect() } } }
            override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason); scope.launch { if (activeBinding == binding && !closed && !ending && !expectedRebind) { diagnostic("transport.closed", "network", "warning", "retrying", json("closeCode" to code)); reconnect() } } }
            override fun onClosed(socket: WebSocket, code: Int, reason: String) { scope.launch { if (activeBinding == binding && !closed && !ending && !expectedRebind) { diagnostic("transport.closed", "network", "warning", "retrying", json("closeCode" to code)); reconnect() } } }
        })
    }

    private fun transportLost(error: Throwable) {
        diagnostic("transport.failure", "network", "warning", "retrying", json("errorClass" to error.javaClass.simpleName.ifEmpty { "Throwable" }))
    }

    private suspend fun onControl(message: JSONObject, activeBinding: Int) {
        if (ending && !(message.optString("type") == "snapshot" && message.optJSONObject("snapshot")?.optString("status") in terminalStates)) return
        when (message.optString("type")) {
            "snapshot" -> {
                controlReady = true
                applySnapshot(message.getJSONObject("snapshot"))
                if (_state.value.status in terminalStates) { closed = true; release(); return }
                if (_state.value.status == "active" && media == null) connectAudio(activeBinding)
                advertiseLessonMedia()
                startCameraFeed()
                report("device.status", json("cameraSource" to config.device, "hudTarget" to if (device.displayAvailable) "glasses" else "phone",
                    "glassesDisplayAvailable" to device.displayAvailable, "audioRoute" to audio.routeDescription(),
                    "foregroundService" to true, "sdkVersion" to BuildConfig.META_DAT_VERSION, "camera" to device.cameraStats(), "observedAt" to System.currentTimeMillis()))
            }
            "event" -> {
                val event = message.getJSONObject("event")
                if (event.optInt("generation") != generation || event.optLong("seq") <= throughSeq) return
                throughSeq = event.optLong("seq")
                val payload = event.optJSONObject("payload") ?: JSONObject()
                inspectionEvent(event.optString("type"), payload)
                when (event.optString("type")) {
                    "transcript.fragment" -> _state.update { it.copy(captions = (it.captions + "${payload.optString("speaker")}: ${payload.optString("text")}").takeLast(80)) }
                    "session.ended", "session.failed", "session.interrupted" -> {
                        _state.update { it.copy(status = event.getString("type").substringAfter('.'), error = if (event.optString("type") == "session.ended") null else it.error) }; closed = true; release()
                    }
                    "error", "connection.failed" -> {
                        diagnostic("session.failed", "provider", "error", "user_action")
                        _state.update { it.copy(error = "The coach provider failed. Check access and try starting a new session.") }
                    }
                    "connection.opened" -> log("Provider connection opened")
                    "video.stale" -> _state.update { it.copy(liveMessage = "Live camera stalled. Waiting for a new frame.") }
                    "video.changed" -> if (!payload.optBoolean("enabled")) stopLiveLocally()
                        else if (demoRequestId == null && payload.optString("inputConsumer") != "lesson_observer") startLiveUploads(payload.optInt("liveVideoEpoch", liveEpoch))
                    "lesson.changed" -> _state.update { it.copy(lesson = payload.optJSONObject("lesson")?.toString().orEmpty()) }
                    "demo.started" -> applyDemonstration(payload)
                    "demo.finished" -> stopDemonstration()
                    "hud.accepted" -> if (demoRequestId != null) applyHud(payload.optJSONObject("hud") ?: JSONObject(), payload.getInt("hudRevision"))
                }
            }
            "hud" -> if (message.optInt("generation") == generation) presentHud(message.optJSONObject("hud") ?: JSONObject(), message.getInt("hudRevision"))
            "flush" -> if (message.optInt("generation") == generation) {
                val nextEpoch = message.getInt("speechEpoch")
                if (nextEpoch > epoch) { epoch = nextEpoch; audio.flush(generation, epoch); if (demoRequestId != null) audio.suppress(); log("Playback flush applied: epoch $epoch") }
            }
            "capture" -> if (message.optInt("generation") == generation) {
                val workId = message.optString("workId")
                if (workId.isNotBlank() && _state.value.inspection?.workId != workId)
                    _state.update { it.copy(inspection = InspectionState(workId, message.optString("question"))) }
                scope.launch { capture(workId.ifEmpty { null }) }
            }
            "reconnect_required" -> reconnect()
            "rebind" -> {
                cancelPresentation()
                glassesRecoveryJob?.cancel()
                expectedRebind = false; rebindWaitJob?.cancel()
                stopDemonstration()
                audio.suppress(); audio.close(false)
                controlReady = false; ++binding; control?.cancel(); control = null; media?.cancel(); media = null
                reconnectJob?.cancel()
                applySnapshot(message.getJSONObject("snapshot"))
                connect()
            }
            "error" -> if (!ending && !closed) {
                if (message.optInt("code") == 409) reconnect() else failed(BackendFailure(message.optInt("code", 500)), "control")
            }
            "command.result" -> {
                if (message.optString("status") == "effect_failed") {
                    diagnostic("command.failed", "control", "error", "user_action")
                    _state.update { it.copy(error = "The coach did not accept this action. Retry after the connection recovers.") }
                } else log("Command ${message.optString("commandId")}: ${message.optString("status", "received")}")
            }
        }
    }

    private suspend fun applySnapshot(snapshot: JSONObject) {
        val nextGeneration = snapshot.getInt("generation")
        if (nextGeneration < generation) return
        if (nextGeneration != generation) {
            cancelPresentation()
            stopDemonstration()
            stopLiveLocally()
            audio.suppress(); val oldMedia = media; media = null; oldMedia?.cancel()
            generation = nextGeneration; rendererId = id()
            _state.update { it.copy(hudRevision = -1) }
        }
        epoch = snapshot.optInt("speechEpoch")
        inputRate = snapshot.optInt("inputRate", 16000); outputRate = snapshot.optInt("outputRate", 24000)
        throughSeq = snapshot.optLong("throughSeq")
        val transcripts = snapshot.optJSONArray("transcripts") ?: JSONArray()
        val work = snapshot.optJSONArray("work") ?: JSONArray()
        val inspection = (0 until work.length()).map { work.getJSONObject(it) }
            .filter { it.optString("kind") == "inspect" }.asReversed().maxByOrNull { it.optLong("createdAt") }?.let(::inspectionFromWork)
        val status = snapshot.optString("status", "active")
        if (status == "ending") { ending = true; stopLiveLocally(); audio.close(); previewJob?.cancel(); watchEnd() }
        if (status != _state.value.status) {
            diagnostic(when (status) { "active" -> "session.active"; "ended" -> "session.ended"; "failed", "interrupted" -> "session.failed"; else -> "app.lifecycle" }, "session",
                if (status in setOf("failed", "interrupted")) "error" else "info")
        }
        _state.update { it.copy(status = status, generation = generation, inspection = inspection,
            lesson = snapshot.optJSONObject("lesson")?.toString().orEmpty(),
            error = when (status) { "active", "ended" -> null; "failed" -> "The coach could not start. Check provider access and try again."; else -> it.error },
            captions = (0 until transcripts.length()).map { index -> transcripts.getJSONObject(index).let { "${it.optString("speaker")}: ${it.optString("text")}" } }) }
        applyDemonstration(if (status == "active") snapshot.optJSONObject("demonstration") else null)
        if (generation != nextGeneration || closed) return
        val liveVideo = status == "active" && demoRequestId == null && snapshot.optBoolean("liveVideo")
        if (!liveVideo) stopLiveLocally()
        ++presentationRevision
        // Bind audio independently; present the starting card before camera recovery takes the display lock.
        if (controlReady && control != null) presentHud(snapshot.optJSONObject("hud") ?: JSONObject(), snapshot.optInt("hudRevision")) {
            if (liveVideo) startLiveUploads(snapshot.optInt("liveVideoEpoch"))
        }
    }

    private fun prepareLessonMedia() {
        lessonMediaJob?.cancel()
        lessonClips = emptyList()
        advertiseLessonMedia()
        _state.update { it.copy(lessonMedia = "Preparing lesson clips…") }
        val activeSession = sessionId
        lessonMediaJob = scope.launch {
            try {
                val manifest = request("/api/sessions/$sessionId/lesson-media", auth = token)
                if (closed || sessionId != activeSession) return@launch
                _state.update { it.copy(lessonIntro = manifest.optJSONObject("intro")?.toString().orEmpty()) }
                if (config.device != "meta_display") {
                    _state.update { it.copy(lessonMedia = "Glasses video requires Meta Ray-Ban Display") }; return@launch
                }
                val clips = LessonMediaCache.parse(manifest)
                val ready = mutableListOf<LessonClip>()
                for (clip in clips) {
                    withContext(Dispatchers.IO) {
                        lessonMedia.prepare(clip) { path ->
                            require(path.startsWith("/api/sessions/$activeSession/")) { "Lesson clip belongs to another session" }
                            awaitResponse(Request.Builder().url(config.url + path).header("Authorization", "Bearer $token").build(),
                                client.newBuilder().followRedirects(false).followSslRedirects(false).build())
                        }
                    }
                    if (closed || sessionId != activeSession) return@launch
                    ready.add(clip); lessonClips = ready.toList()
                    _state.update { it.copy(lessonMedia = "${ready.size}/${clips.size} lesson clips cached on phone") }
                    advertiseLessonMedia()
                }
                withContext(Dispatchers.IO) { lessonMedia.prune(clips) }
                if (clips.isEmpty()) _state.update { it.copy(lessonMedia = "No lesson clips are configured on the server") }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (!closed && sessionId == activeSession) {
                    diagnostic("request.failed", "storage", "warning", "user_action", json("errorClass" to error.javaClass.simpleName))
                    _state.update { it.copy(lessonMedia = "Lesson video unavailable. Retry the download when the server is ready.",
                        lessonIntro = it.lessonIntro.ifEmpty { json("error" to "The lesson reference could not load.").toString() }) }
                    advertiseLessonMedia()
                }
            }
        }
    }

    fun retryLessonMedia() { if (!closed && !ending && demoRequestId == null) prepareLessonMedia() }

    private fun advertiseLessonMedia() {
        val displayReady = device.canPlayLessonVideo && glassesRecoveryJob?.isActive != true
        val capable = !closed && !ending && controlReady && displayReady
        _state.update { it.copy(glassesDisplayAvailable = displayReady,
            lessonClipsReady = if (capable) lessonClips.map { clip -> clip.lessonKey }.toSet() else emptySet()) }
        if (closed || ending || !controlReady) return
        report("device.status", json("glassesDisplayAvailable" to displayReady, "displayCapabilities" to json("video" to capable, "source" to "device-local",
            "maxWidth" to 400, "maxHeight" to 400, "maxPixels" to 70000),
            "demoAssets" to JSONArray(if (capable) lessonClips.map { it.advertisement() } else emptyList<JSONObject>())))
    }

    // Display recovery must preserve the continuous camera in Marine tutor sessions.
    private fun recoverLessonGlasses() {
        fun eligible() = config.cprLesson && config.device == "meta_display" && !closed && !ending &&
            !expectedRebind && controlReady && _state.value.status == "active" && demoRequestId == null && !_state.value.liveVideo
        if (!eligible() || glassesRecoveryJob?.isActive == true || glassesRecoveryExhausted) return
        if (device.canPlayLessonVideo) return
        val expectedBinding = binding
        val expectedGeneration = generation
        glassesRecoveryJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                captureMutex.withLock {
                    if (!eligible() || binding != expectedBinding || generation != expectedGeneration) return@withLock
                    _state.update { it.copy(liveMessage = "Checking the glasses connection…") }
                    advertiseLessonMedia()
                    val result = device.recoverVideo(withCamera = continuousCamera) { attempt ->
                        diagnostic("reconnect.attempt", "camera", "warning", "retrying", json("attempt" to attempt))
                    }
                    if (!eligible() || binding != expectedBinding || generation != expectedGeneration) return@withLock
                    advertiseLessonMedia()
                    report("device.status", json("camera" to device.cameraStats(), "observedAt" to System.currentTimeMillis()))
                    when (result) {
                        VideoRecovery.RECOVERED -> {
                            glassesRecoveryExhausted = !device.canPlayLessonVideo
                            if (glassesRecoveryExhausted) {
                                _state.update { it.copy(error = "The glasses display is still unavailable after reconnecting.") }
                            } else {
                                diagnostic("reconnect.recovered", "camera", recovery = "recovered")
                                _state.update { it.copy(error = null, liveMessage = "Glasses reconnected. Your lesson is ready.") }
                                val latest = _state.value
                                applyHud(JSONObject(latest.hud), latest.hudRevision, replay = true)
                            }
                        }
                        VideoRecovery.WAITING -> _state.update { it.copy(liveMessage = "Waiting for the glasses to reconnect. Voice remains available.") }
                        VideoRecovery.FAILED -> {
                            glassesRecoveryExhausted = true
                            diagnostic("reconnect.exhausted", "camera", "error", "user_action")
                            _state.update { it.copy(error = "The glasses could not reconnect. Your lesson is saved; voice remains available.") }
                        }
                    }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (eligible() && binding == expectedBinding && generation == expectedGeneration) {
                    glassesRecoveryExhausted = true
                    failed(error, "camera")
                }
            }
        }
        glassesRecoveryJob?.start()
    }

    private suspend fun applyDemonstration(demo: JSONObject?) {
        if (demo?.optString("status") == "cueing") {
            val cueGeneration = generation; val cueBinding = binding
            val previous = runCatching { JSONObject(_state.value.demonstration) }.getOrNull()
            if (previous?.optString("requestId") != demo.optString("requestId")) {
                stopDemonstration(); audio.flush(generation, epoch)
                _state.update { it.copy(demonstration = demo.toString()) }
                cancelPresentation()
                val cameraJobs = arrayOf(cameraFeedJob, glassesRecoveryJob, liveJob, hudRestoreJob)
                cameraFeedJob = null; glassesRecoveryJob = null
                stopLiveLocally()
                videoPreparationJob = scope.launch(start = CoroutineStart.LAZY) {
                    try {
                        stopCameraForVideo(*cameraJobs)
                        if (!device.canPlayLessonVideo) captureMutex.withLock { renderMutex.withLock {
                            device.recoverVideo(withCamera = false) { log("Preparing video display, attempt $it") }
                        } }
                    } catch (error: CancellationException) { throw error }
                    catch (error: Exception) { failed(error, "hud") }
                }
                videoPreparationJob?.start()
            }
            videoPreparationJob?.join()
            if (closed || ending || generation != cueGeneration || binding != cueBinding ||
                runCatching { JSONObject(_state.value.demonstration).optString("requestId") }.getOrNull() != demo.optString("requestId")) return
            _state.update { it.copy(demonstration = demo.toString(), liveMessage = "Listen to the cue; the video starts afterward.") }
            if (cuePlaybackJob?.isActive != true) {
                val expectedBinding = binding; val expectedGeneration = generation; val requestId = demo.optString("requestId")
                fun current(): Boolean {
                    val latest = runCatching { JSONObject(_state.value.demonstration) }.getOrNull()
                    return !closed && !ending && binding == expectedBinding && generation == expectedGeneration &&
                        latest?.optString("status") == "cueing" && latest.optString("requestId") == requestId
                }
                cuePlaybackJob = scope.launch {
                    while (isActive && current()) {
                        delay(500)
                        if (!current()) break
                        report("playback.metric", json("speechEpoch" to epoch, "metrics" to JSONObject(audio.metricsSnapshot()), "measurementBasis" to "android_playback_head_estimate"))
                    }
                }
            }
            return
        }
        cuePlaybackJob?.cancel(); cuePlaybackJob = null
        val requestId = demo?.optString("requestId")?.takeIf { it.isNotBlank() }
        if (requestId == demoRequestId) return
        stopDemonstration()
        if (requestId == null || closed || ending) return
        val lease = DemoPlaybackLease(requestId, generation, binding)
        demoLease = lease; demoRequestId = requestId
        glassesRecoveryJob?.cancel()
        stopLiveLocally(); setPreview(false); timerJob?.cancel()
        audio.muted = _state.value.muted; audio.suppress()
        _state.update { it.copy(demonstration = demo.toString(), liveMessage = "Starting the video. Say pause the video to interrupt.") }
        val clip = lessonClips.find { it.id == demo.getString("assetId") }
        var playbackStartedAt = 0L
        fun playback(status: String, reason: String? = null) {
            if (closed || ending || demoLease !== lease || !lease.accepts(demoRequestId, generation, binding, status)) return
            if (status == "playing") playbackStartedAt = serverNow()
            val audioState = JSONObject(audio.stats())
            if (status != "playing") {
                demoJob?.cancel(); demoDeadlineJob?.cancel(); device.stopLessonVideo()
                restoreMovieAudio()
            }
            _state.update { it.copy(demonstration = JSONObject(demo.toString()).put("status", status).toString()) }
            report("media.summary", json("kind" to "lesson_video_audio", "requestId" to requestId, "phase" to status, "audio" to audioState))
            report("demo.playback", json("requestId" to requestId, "status" to status, "reason" to reason?.take(240)))
            log("Lesson video $status${reason?.let { ": $it" }.orEmpty()}")
        }
        demoDeadlineJob = scope.launch {
            delay((demo.optLong("startedAt") + 30_000 - serverNow()).coerceIn(1, 30_000))
            if (!lease.playing) playback("failed", "Glasses playback did not start within 30 seconds")
            else {
                delay((playbackStartedAt + demo.optLong("durationMs", 55_000) + 15_000 - serverNow()).coerceAtLeast(1))
                playback("failed", "Glasses playback exceeded its deadline")
            }
        }
        demoJob = scope.launch {
            try {
                glassesRecoveryJob?.join()
                check(clip != null && withContext(Dispatchers.IO) { lessonMedia.verified(clip) }) { "Requested video is not cached on this phone" }
                repeat(2) {
                    val retry = CompletableDeferred<Unit>()
                    captureMutex.withLock { renderMutex.withLock render@{
                        if (demoLease !== lease || demoRequestId != requestId || lease.terminal) return@render
                        audio.setMovieAudio(true)
                        check(withTimeoutOrNull(3_000) { while (!audio.movieRouteReleased) delay(50); true } == true) { "Phone microphone route did not become ready for video" }
                        report("media.summary", json("kind" to "lesson_video_audio", "requestId" to requestId, "phase" to "handoff", "audio" to JSONObject(audio.stats())))
                        device.playLessonVideo(lessonMedia.file(clip)) callback@{ status, reason ->
                            if (retry.isCompleted || closed || ending || demoLease !== lease) return@callback
                            if (status == "failed" && lease.retryStartup(demoRequestId, generation, binding, reason)) {
                                report("media.summary", json("kind" to "lesson_video_audio", "requestId" to requestId, "phase" to "startup_retry", "reason" to reason))
                                retry.complete(Unit)
                            } else playback(status, reason)
                        }
                    } }
                    retry.await() // The original deadline and terminal callbacks cancel this job.
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { playback("failed", error.message ?: "Glasses video could not start") }
        }
    }

    private fun restoreMovieAudio() {
        runCatching { audio.setMovieAudio(false) }.onFailure { log("Movie audio restoration failed: ${it.javaClass.simpleName}") }
    }

    private fun stopDemonstration() {
        videoPreparationJob?.cancel(); videoPreparationJob = null
        cuePlaybackJob?.cancel(); cuePlaybackJob = null
        if (demoRequestId == null) { _state.update { it.copy(demonstration = "") }; return }
        demoRequestId = null; demoLease = null
        demoJob?.cancel(); demoJob = null; demoDeadlineJob?.cancel(); demoDeadlineJob = null
        device.stopLessonVideo()
        restoreMovieAudio()
        audio.muted = _state.value.muted
        _state.update { it.copy(demonstration = "") }
        val expectedGeneration = generation
        scope.launch {
            if (!closed && !ending && demoRequestId == null && generation == expectedGeneration) {
                val latest = _state.value
                runCatching { applyHud(JSONObject(latest.hud), latest.hudRevision, replay = true) }.onFailure { failed(it, "hud") }
            }
        }
    }

    fun lessonAction(action: String) {
        val lesson = runCatching { JSONObject(_state.value.lesson) }.getOrNull()
        command("lesson_action", json("action" to action, "expectedRevision" to lesson?.optInt("revision")))
    }

    private fun inspectionFromWork(work: JSONObject): InspectionState {
        val result = work.optJSONObject("result") ?: JSONObject()
        return InspectionState(work.optString("id"), work.optJSONObject("input")?.optString("question").orEmpty(),
            work.optString("status", "reserved"), if (config.provider == "mock") "simulation" else result.optString("status"), inspectionDetails(result))
    }

    private fun inspectionDetails(result: JSONObject): String = buildList {
        result.optString("reason").takeIf { it.isNotBlank() }?.let { add(it.replace('_', ' ')) }
        result.optString("captureFreshness").takeIf { it.isNotBlank() }?.let { add("Capture freshness: $it") }
        if (result.has("elapsedMs")) add("${result.optLong("elapsedMs")} ms")
        result.optJSONObject("observation")?.let { observation ->
            observation.optString("visibility").takeIf { it.isNotBlank() }?.let { add("Visibility: $it") }
            for ((key, label) in listOf("limitations" to "Limitations", "claims" to "Model claims")) {
                val entries = observation.optJSONArray(key) ?: continue
                if (entries.length() > 0) add("$label:")
                for (index in 0 until entries.length()) add(entries.optString(index))
            }
        }
    }.joinToString("\n")

    private fun inspectionEvent(type: String, payload: JSONObject) {
        if (type == "work.reserved" && payload.optString("kind") == "inspect") {
            _state.update { it.copy(inspection = inspectionFromWork(payload)) }; return
        }
        val status = type.removePrefix("work.")
        if (!type.startsWith("work.") || status !in setOf("running", "completed", "failed", "cancelled", "aborted")) return
        val result = payload.optJSONObject("result") ?: JSONObject()
        _state.update { it.copy(inspection = it.inspection?.update(payload.optString("workId"), status,
            if (config.provider == "mock") "simulation" else result.optString("status"), inspectionDetails(result))) }
    }

    private fun connectAudio(activeBinding: Int) {
        media = client.newWebSocket(Request.Builder().url(wsUrl("audio")).build(), object : WebSocketListener() {
            override fun onOpen(socket: WebSocket, response: Response) { scope.launch {
                if (activeBinding != binding || closed || ending) { socket.cancel(); return@launch }
                socket.send(json("type" to "hello", "token" to token, "generation" to generation).toString())
                try {
                    audio.start(inputRate, outputRate, generation, epoch) { packet ->
                        !closed && activeBinding == binding && socket.queueSize() < (inputRate * 2 / 4) && socket.send(packet.toByteString())
                    }
                    audio.muted = _state.value.muted
                    if (demoRequestId != null) audio.setMovieAudio(true)
                    _state.update { it.copy(route = audio.routeDescription()) }
                    healthJob?.cancel()
                    healthJob = scope.launch {
                        while (isActive && activeBinding == binding && !closed && !ending) {
                            delay(5000)
                            if (activeBinding != binding || closed || ending) break
                            val metrics = JSONObject(audio.metricsSnapshot())
                            report("playback.metric", json("speechEpoch" to epoch, "metrics" to metrics, "measurementBasis" to "android_playback_head_estimate"))
                            diagnostic("audio.status", "audio", details = metrics)
                            if (demoRequestId != null) report("media.summary", json("kind" to "lesson_video_audio", "requestId" to demoRequestId, "phase" to "heartbeat", "audio" to JSONObject(audio.stats())))
                            advertiseLessonMedia()
                            recoverLessonGlasses()
                            if (config.device == "meta_display") report("device.status", json("camera" to device.cameraStats(), "observedAt" to System.currentTimeMillis()))
                        }
                    }
                } catch (error: Throwable) { transportLost(error); reconnect() }
            } }
            override fun onMessage(socket: WebSocket, bytes: ByteString) {
                if (activeBinding != binding || closed || ending || demoRequestId != null) return
                audio.receive(bytes.toByteArray())
            }
            override fun onFailure(socket: WebSocket, error: Throwable, response: Response?) { scope.launch { if (activeBinding == binding && media === socket && !closed && !ending && !expectedRebind) { transportLost(error); reconnect() } } }
            override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason); scope.launch { if (activeBinding == binding && media === socket && !closed && !ending && !expectedRebind) { diagnostic("transport.closed", "network", "warning", "retrying", json("closeCode" to code)); reconnect() } } }
            override fun onClosed(socket: WebSocket, code: Int, reason: String) { scope.launch { if (activeBinding == binding && media === socket && !closed && !ending && !expectedRebind) { diagnostic("transport.closed", "network", "warning", "retrying", json("closeCode" to code)); reconnect() } } }
        })
    }

    fun reconnect() {
        if (closed || ending || startJob?.isActive == true || reconnectJob?.isActive == true) return
        cancelPresentation()
        glassesRecoveryJob?.cancel()
        stopDemonstration()
        stopLiveLocally()
        val now = SystemClock.elapsedRealtime()
        if (now - recoveryWindowAt > 60_000) { recoveryWindowAt = now; recoveries = 0 }
        if (++recoveries > 5) {
            audio.close(false); ++binding; control?.cancel(); control = null; media?.cancel(); media = null
            diagnostic("reconnect.exhausted", "network", "error", "user_action")
            _state.update { it.copy(status = "disconnected", error = "The connection keeps failing. Check USB and the audio route, then tap Reconnect.") }
            return
        }
        audio.suppress(); audio.close(false)
        controlReady = false; ++binding; control?.cancel(); control = null; media?.cancel(); media = null
        _state.update { it.copy(status = "reconnecting", error = null) }
        reconnectJob = scope.launch {
            val requestId = id()
            val previousGeneration = generation
            repeat(5) { attempt ->
                try {
                    diagnostic("reconnect.attempt", "network", "info", "retrying", json("attempt" to attempt + 1))
                    val sent = System.currentTimeMillis()
                    val response = request("/api/sessions/$sessionId/reconnect", json("requestId" to requestId, "generation" to previousGeneration), token)
                    updateClock(response, sent)
                    applySnapshot(response.getJSONObject("snapshot"))
                    diagnostic("reconnect.recovered", "network", "info", "recovered")
                    connect(); return@launch
                } catch (error: Throwable) {
                    if (error is CancellationException) throw error
                    if (error is BackendFailure && error.status == 409) {
                        val current = runCatching { request("/api/sessions/$sessionId", auth = token) }.getOrNull()
                        if (current != null) {
                            applySnapshot(current.getJSONObject("snapshot"))
                            if (_state.value.status in terminalStates) { closed = true; release(); return@launch }
                            connect(); return@launch
                        }
                    }
                    diagnostic("reconnect.attempt", "network", "warning", "retrying", json("attempt" to attempt + 1, "errorClass" to error.javaClass.simpleName))
                    delay(1000L shl attempt)
                }
            }
            diagnostic("reconnect.exhausted", "network", "error", "user_action")
            _state.update { it.copy(status = "disconnected", error = "Reconnect failed. Check USB and the server, then tap Reconnect.") }
        }
    }

    fun retryConnection() { recoveries = 0; reconnect() }

    fun command(type: String, payload: JSONObject = JSONObject()): Boolean {
        if (closed || ending && type != "end_session" || control == null) return false
        val envelope = envelope(type, payload).put("commandId", id())
        val sent = control?.send(envelope.toString()) == true
        if (!sent) failed(IllegalStateException("Control disconnected; $type was not sent"))
        return sent
    }
    private fun envelope(type: String, payload: JSONObject) = json("schemaVersion" to 1, "sessionId" to sessionId,
        "generation" to generation, "messageId" to id(), "type" to type, "payload" to payload,
        "sourceClock" to json("clockId" to clockId, "monoMs" to SystemClock.elapsedRealtime()))
    private fun report(type: String, payload: JSONObject) { if (!closed && !ending) control?.send(envelope(type, payload).toString()) }

    fun mute() {
        val muted = !_state.value.muted
        audio.muted = muted; _state.update { it.copy(muted = muted) }
        command("set_mic", json("muted" to muted))
    }
    fun stopSpeech() {
        audio.suppress(); expectedRebind = true
        command("stop_speech")
        rebindWaitJob?.cancel()
        rebindWaitJob = scope.launch {
            delay(3000)
            if (expectedRebind && !closed && !ending) { expectedRebind = false; reconnect() }
        }
        log("Speech stopped locally; waiting for server recovery barrier")
    }
    fun clearHud() {
        clearLatchRevision = _state.value.hudRevision
        _state.update { it.copy(hud = "{}", hudImage = null) }
        timerJob?.cancel()
        scope.launch { renderMutex.withLock { if (demoRequestId == null) device.render(JSONObject()) } }
        command("clear_hud")
    }
    fun routes(): List<AudioDeviceInfo> = audio.routes()
    fun route(deviceId: Int) {
        runCatching { check(audio.route(deviceId)) { "Audio route unavailable" } }.onFailure { failed(it) }
        _state.update { it.copy(route = audio.routeDescription()) }
        report("device.status", json("audioRoute" to audio.routeDescription(), "observedAt" to System.currentTimeMillis()))
    }

    private fun presentHud(hud: JSONObject, revision: Int, startCamera: () -> Unit = {}) {
        val presentation = presentationRevision
        val expectedGeneration = generation; val expectedBinding = binding
        presentationJob = scope.presentSessionSnapshot(previous = presentationJob,
            current = { !closed && !ending && generation == expectedGeneration && binding == expectedBinding && presentationRevision == presentation },
            render = { applyHud(hud, revision) }, startCamera = startCamera, onFailure = { failed(it, "hud") })
    }

    private suspend fun applyHud(hud: JSONObject, revision: Int, replay: Boolean = false) {
        if (revision < _state.value.hudRevision) return
        val clearAt = clearLatchRevision
        if (clearAt != null && revision <= clearAt) return
        clearLatchRevision = null
        if (revision == _state.value.hudRevision && !replay) return
        _state.update { it.copy(hud = hud.toString(), hudRevision = revision, hudImage = null) }
        timerJob?.cancel()
        if (demoRequestId != null) return // Keep the newest card for restoration after the movie.
        val expectedGeneration = generation
        val expectedBinding = binding
        val expectedRenderer = rendererId
        val imageBytes = hud.optString("imageAssetId").takeIf { it.isNotEmpty() }?.let { assetId ->
            runCatching { withContext(Dispatchers.IO) {
                awaitResponse(Request.Builder().url("${config.url}/api/sessions/$sessionId/assets/$assetId")
                    .header("Authorization", "Bearer $token").build()).use { response ->
                    if (!response.isSuccessful) throw BackendFailure(response.code)
                    checkNotNull(response.body).bytes()
                }
            } }.onFailure { failed(it) }.getOrNull()
        }
        if (generation == expectedGeneration && binding == expectedBinding && _state.value.hudRevision == revision) _state.update { it.copy(hudImage = imageBytes) }
        var lastReceipt: String? = null
        suspend fun renderCurrent() {
            renderMutex.withLock {
                if (closed || demoRequestId != null || generation != expectedGeneration || binding != expectedBinding || _state.value.hudRevision != revision || clearLatchRevision != null) return@withLock
                val expires = hud.optLong("expiresAt", Long.MAX_VALUE)
                val expired = expires <= serverNow()
                val displayHud = if (expired) JSONObject() else JSONObject(hud.toString()).apply {
                    // DAT timer renderer uses local wall time; map server-owned deadline to it.
                    optJSONObject("timer")?.let { it.put("startedAt", it.getLong("startedAt") - clockOffset.toLong()) }
                }
                if (expired) _state.update { it.copy(hud = "{}", hudImage = null) }
                val status = device.render(displayHud, if (expired) null else imageBytes)
                if (status == "sdk_submitted" && generation == expectedGeneration && binding == expectedBinding && _state.value.hudRevision == revision && clearLatchRevision == null)
                    _state.update { if (it.error?.startsWith("Glasses display interrupted (") == true) it.copy(error = null) else it }
                if (generation == expectedGeneration && binding == expectedBinding && _state.value.hudRevision == revision && clearLatchRevision == null && status != lastReceipt) {
                    lastReceipt = status
                    report("hud.receipt", json("hudRevision" to revision, "rendererInstanceId" to expectedRenderer,
                        "target" to if (config.device == "meta_display") "glasses" else if (config.device == "mock") "mock" else "phone", "status" to status))
                }
            }
        }
        renderCurrent()
        if (hud.has("timer") || hud.has("expiresAt")) timerJob = scope.launch {
            while (isActive && !closed && generation == expectedGeneration && binding == expectedBinding && _state.value.hudRevision == revision) {
                delay(1000); renderCurrent()
                if (hud.optLong("expiresAt", Long.MAX_VALUE) <= serverNow()) break
            }
        }
    }

    fun setPreview(enabled: Boolean) {
        if (enabled && (_state.value.liveVideo || demoRequestId != null)) return
        previewJob?.cancel()
        _state.update { it.copy(preview = enabled) }
        if (enabled) previewJob = scope.launch { while (isActive && !closed) { if (!captureMutex.isLocked) capture(null); delay(1000) } }
    }

    private fun stopLiveLocally(invalidatePresentation: Boolean = true) {
        if (invalidatePresentation) ++presentationRevision
        hudRestorePending = false
        hudRestoreJob?.cancel(); hudRestoreJob = null
        liveJob?.cancel(); liveJob = null
        _state.update { it.copy(liveVideo = false, liveFrames = 0, lastLiveFrameAt = 0) }
    }

    private fun cancelPresentation() {
        ++presentationRevision
        presentationJob?.cancel(); presentationJob = null
        _state.update { it.copy(hudRevision = -1) }
    }

    private fun restoreLiveHud(expectedGeneration: Int, expectedEpoch: Int) {
        if (hudRestoreJob?.isActive == true) return
        fun current() = !closed && !ending && demoRequestId == null && generation == expectedGeneration && liveEpoch == expectedEpoch && (_state.value.liveVideo || continuousCamera)
        hudRestorePending = false
        hudRestoreJob = scope.launch {
            try {
                renderMutex.withLock { if (current()) device.restoreDisplay() }
                if (current()) {
                    val latest = _state.value
                    applyHud(JSONObject(latest.hud), latest.hudRevision, replay = true)
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (current()) failed(error, "hud") }
        }
    }

    fun setLiveVideo(enabled: Boolean, stoppedMessage: String = "Live camera off") {
        if (_state.value.liveChanging || closed || ending || demoRequestId != null || config.provider != "gemini" || config.device != "meta_display") return
        stopLiveLocally(); setPreview(false)
        _state.update { it.copy(liveChanging = true, liveMessage = if (enabled) "Starting live camera…" else stoppedMessage) }
        val expectedGeneration = generation
        liveControlJob = scope.launch {
            try {
                val result = request("/api/sessions/$sessionId/commands",
                    envelope("set_live_video", json("enabled" to enabled)).put("commandId", id()), token)
                check(result.optString("status") == "accepted") { "Live video was not accepted" }
                if (closed || ending || generation != expectedGeneration) return@launch
                liveEpoch = result.getInt("liveVideoEpoch")
                _state.update { it.copy(liveVideo = enabled, liveChanging = false, liveMessage = if (enabled) "Waiting for the first frame…" else stoppedMessage) }
                if (enabled) startLiveUploads(liveEpoch)
            } catch (error: Throwable) { failed(error, "camera") }
            finally { _state.update { it.copy(liveChanging = false) } }
        }
    }

    private fun startLiveUploads(epoch: Int) {
        if (config.provider != "gemini" || config.device != "meta_display" || closed || ending || demoRequestId != null) return
        if (continuousCamera) {
            liveEpoch = epoch
            _state.update { it.copy(liveVideo = true, liveChanging = false) }
            startCameraFeed()
            return
        }
        if (liveEpoch == epoch && liveJob?.isActive == true) return
        glassesRecoveryJob?.cancel()
        stopLiveLocally(invalidatePresentation = false); setPreview(false); liveEpoch = epoch
        val expectedGeneration = generation
        _state.update { it.copy(liveVideo = true, liveChanging = false, liveMessage = "Waiting for the first frame…") }
        liveJob = scope.launch {
            glassesRecoveryJob?.join()
            while (isActive && !closed && !ending && demoRequestId == null && generation == expectedGeneration && _state.value.liveVideo) {
                if (!captureMutex.isLocked && !capture(null, liveEpoch)) {
                    if (demoRequestId == null && generation == expectedGeneration) setLiveVideo(false, "Camera upload stopped. Tap Live camera to retry.")
                    break
                }
                delay(1000)
            }
        }
    }

    fun describeView() {
        if (_state.value.liveVideo) command("send_text", json("text" to "Briefly describe what you can see in the live camera view now.", "requireLiveVideo" to true))
        else command("inspect_frame", json("question" to "Briefly describe what is visible in this image and the most noticeable details. Do not guess about anything outside the view."))
    }

    private fun startCameraFeed() {
        if (!continuousCamera || closed || ending || !controlReady || _state.value.demonstration.isNotEmpty() || cameraFeedJob?.isActive == true) return
        cameraFeedJob = scope.launch {
            var failures = 0
            while (isActive && !closed && !ending) {
                if (demoRequestId != null) { delay(250); continue }
                val uploaded = if (captureMutex.isLocked || !controlReady) false
                    else capture(null, if (_state.value.liveVideo && demoRequestId == null) liveEpoch else null, spectatorPreview = true)
                failures = if (uploaded) 0 else minOf(failures + 1, 5)
                delay(if (uploaded) 200 else 1_000L shl (failures - 1))
            }
        }
    }

    suspend fun capture(workId: String?, liveVideoEpoch: Int? = null, spectatorPreview: Boolean = false): Boolean {
        val expectedGeneration = generation
        return captureMutex.withLock {
            if (closed || ending || demoRequestId != null || expectedGeneration != generation) return@withLock false
            val captureStarted = android.os.SystemClock.elapsedRealtime()
            try {
                val frame = withTimeout(15_000) { device.capture(allowPhotoFallback = workId != null && liveVideoEpoch == null) }
                if (closed || ending || demoRequestId != null || expectedGeneration != generation || liveVideoEpoch != null && !_state.value.liveVideo && !spectatorPreview) return@withLock false
                _state.update { it.copy(frame = frame.jpeg) }
                val metadata = json("generation" to generation, "workId" to workId, "cameraSource" to frame.source,
                    "captureTimeBasis" to frame.basis, "width" to frame.width, "height" to frame.height)
                if (spectatorPreview) metadata.put("preview", true).put("frameAgeMs", SystemClock.elapsedRealtime() - checkNotNull(frame.receivedAtMono))
                if (liveVideoEpoch != null) metadata.put("liveVideo", true).put("liveVideoEpoch", liveVideoEpoch)
                    .put("frameAgeMs", SystemClock.elapsedRealtime() - checkNotNull(frame.receivedAtMono))
                if (frame.earliestCapture != null && frame.latestCapture != null && clockUncertainty.isFinite()) {
                    metadata.put("capturedAt", ((frame.earliestCapture + frame.latestCapture) / 2.0 + clockOffset).toLong())
                    metadata.put("clockUncertaintyMs", kotlin.math.ceil(clockUncertainty + (frame.latestCapture - frame.earliestCapture) / 2.0).toLong())
                }
                val response = withContext(Dispatchers.IO) {
                    awaitResponse(Request.Builder().url("${config.url}/api/sessions/$sessionId/frames/${id()}")
                        .header("Authorization", "Bearer $token").header("x-frame-meta", metadata.toString())
                        .post(frame.jpeg.toRequestBody("image/jpeg".toMediaType())).build()).use {
                        if (!it.isSuccessful) throw BackendFailure(it.code)
                        if (liveVideoEpoch != null) JSONObject(it.body!!.string()).optString(if (spectatorPreview) "assessment" else "status") == "submitted" else true
                    }
                }
                if (liveVideoEpoch != null) {
                    if (response) _state.update { it.copy(liveFrames = it.liveFrames + 1, lastLiveFrameAt = serverNow(), liveMessage = if (it.lesson.isNotEmpty()) "Camera frames are reaching the lesson observer" else "Live video is reaching Gemini") }
                    else if (!spectatorPreview) _state.update { it.copy(liveMessage = "Frame dropped; waiting for the next camera update") }
                    if (hudRestorePending) restoreLiveHud(expectedGeneration, liveVideoEpoch)
                } else if (!spectatorPreview) log("${if (workId == null) "Preview" else "Inspect"} frame uploaded, ${frame.width}×${frame.height}, ${frame.basis}")
                if (spectatorPreview && hudRestorePending && demoRequestId == null) restoreLiveHud(expectedGeneration, liveEpoch)
                true
            } catch (error: Throwable) {
                if (error is CancellationException && error !is TimeoutCancellationException) throw error
                if (closed || ending || demoRequestId != null || expectedGeneration != generation) return@withLock false
                if ((liveVideoEpoch != null || spectatorPreview) && error is CameraCaptureFailure && error.cameraError in setOf("VideoFrameTimeout", "VideoStreamFailed")) {
                    _state.update { it.copy(frame = null, liveMessage = "Camera interrupted; checking the glasses…") }
                    hudRestoreJob?.cancelAndJoin(); hudRestoreJob = null
                    report("device.status", json("cameraRecovering" to true))
                    val recovery = try { renderMutex.withLock { device.recoverVideo(restoreCameraDisplay = false) { attempt ->
                        diagnostic("reconnect.attempt", "camera", "warning", "retrying", json("attempt" to attempt))
                        report("device.status", json("camera" to device.cameraStats(), "observedAt" to System.currentTimeMillis()))
                    } } } finally { report("device.status", json("cameraRecovering" to false)) }
                    if (closed || ending || expectedGeneration != generation || !_state.value.liveVideo && !spectatorPreview) return@withLock false
                    when (recovery) {
                        VideoRecovery.WAITING -> {
                            hudRestorePending = true
                            _state.update { it.copy(liveMessage = "Waiting for the glasses to resume. The coach conversation is still active.") }
                            delay(2_000)
                            return@withLock true
                        }
                        VideoRecovery.RECOVERED -> {
                            hudRestorePending = true
                            diagnostic("reconnect.recovered", "camera", recovery = "recovered")
                            report("device.status", json("camera" to device.cameraStats(), "observedAt" to System.currentTimeMillis()))
                            _state.update { it.copy(glassesDisplayAvailable = device.displayAvailable, liveMessage = "Camera recovered; resuming live video…") }
                            return@withLock true
                        }
                        VideoRecovery.FAILED -> diagnostic("reconnect.exhausted", "camera", "error", "user_action")
                    }
                }
                failed(error, "camera", json(
                    "durationMs" to android.os.SystemClock.elapsedRealtime() - captureStarted,
                    "routeType" to audio.stats()["routeType"]))
                if (config.provider == "gemini" && error is CameraCaptureFailure && error.cameraError == "VideoStreamFailed")
                    _state.update { it.copy(error = if (continuousCamera) "Camera interrupted. Reconnecting automatically; your coach conversation is still active." else "Camera interrupted. Wake the glasses and tap Live camera to reconnect. Your coach conversation is still active.") }
                if (liveVideoEpoch == null) report("capture.failed", json("reason" to "Device capture failed; see diagnostics", "workId" to workId, "cameraSource" to config.device))
                false
            }
        }
    }

    private fun watchEnd() {
        if (endWatchJob?.isActive == true) return
        endWatchJob = scope.launch {
            val confirmed = withTimeoutOrNull(10_000) {
                while (!closed) {
                    val snapshot = runCatching { request("/api/sessions/$sessionId", auth = token).getJSONObject("snapshot") }.getOrNull()
                    if (snapshot?.optString("status") in terminalStates) {
                        applySnapshot(snapshot!!); closed = true; ending = false; release()
                        return@withTimeoutOrNull true
                    }
                    delay(500)
                }
                true
            }
            if (confirmed != true && !closed) {
                ending = false; release()
                diagnostic("request.failed", "session", "warning", "user_action")
                _state.update { it.copy(status = "disconnected", error = "Stopped on phone. Restore USB, then tap End session to confirm shutdown.") }
            }
        }
    }

    suspend fun end() {
        if (closed || ending) return
        ending = true
        cancelPresentation()
        glassesRecoveryJob?.cancel()
        stopDemonstration()
        stopLiveLocally(); liveControlJob?.cancel()
        cameraFeedJob?.cancel(); cameraFeedJob = null
        diagnostic("audio.status", "audio", details = JSONObject(audio.metricsSnapshot()))
        audio.suppress(); audio.muted = true
        startJob?.cancelAndJoin()
        if (closed) return
        _state.update { it.copy(status = "ending", error = null) }
        val command = envelope("end_session", json("reason" to "operator")).put("commandId", id())
        control?.send(command.toString())
        // Keep control alive for final receipts, but stop mic before closing its transport.
        audio.close(); reconnectJob?.cancel(); previewJob?.cancel()
        delay(250)
        var confirmed = true
        if (!closed) runCatching { endRemote(command) }.onFailure { error ->
            val current = runCatching { request("/api/sessions/$sessionId", auth = token) }.getOrNull()?.optJSONObject("snapshot")
            if (current?.optString("status") !in terminalStates + "ending") { confirmed = false; failed(error, "session") }
        }
        closed = confirmed; ending = false; release()
        if (confirmed && _state.value.status != "ended") diagnostic("session.ended", "session")
        _state.update { it.copy(status = if (confirmed) "ended" else "disconnected", hud = "{}", preview = false,
            error = if (confirmed) null else "Stopped on phone, but the server has not confirmed the end. Restore USB, then tap End session again.") }
    }
    private suspend fun endRemote(command: JSONObject = envelope("end_session", json("reason" to "operator")).put("commandId", id())) {
        request("/api/sessions/$sessionId/commands", command, token)
    }
    fun release() {
        cameraFeedJob?.cancel(); cameraFeedJob = null
        cancelPresentation()
        stopDemonstration(); lessonMediaJob?.cancel(); lessonMediaJob = null
        stopLiveLocally(); liveControlJob?.cancel()
        ++binding; reconnectJob?.cancel(); previewJob?.cancel(); timerJob?.cancel(); healthJob?.cancel(); glassesRecoveryJob?.cancel(); endWatchJob?.cancel(); rebindWaitJob?.cancel(); expectedRebind = false
        audio.close(); device.close(); controlReady = false
        _state.update { it.copy(lessonClipsReady = emptySet()) }
        control?.cancel(); control = null; media?.cancel(); media = null
    }
    suspend fun export(): File {
        check(sessionId.isNotEmpty()) { "Create a session first" }
        return withContext(Dispatchers.IO) {
            val file = File(context.filesDir, "session-$sessionId.json")
            awaitResponse(Request.Builder().url("${config.url}/api/sessions/$sessionId/export").header("Authorization", "Bearer $token").build())
                .use { response ->
                    if (!response.isSuccessful) throw BackendFailure(response.code)
                    file.writeBytes(checkNotNull(response.body).bytes())
                }
            file
        }
    }
    private suspend fun request(path: String, body: JSONObject? = null, auth: String = "", settings: Settings = config): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(settings.url + path)
        if (auth.isEmpty()) request.header("X-Coach-Local", "1") else request.header("Authorization", "Bearer $auth")
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        awaitResponse(request.build()).use { response ->
            val content = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw BackendFailure(response.code)
            JSONObject(content)
        }
    }
    private suspend fun awaitResponse(request: Request, httpClient: OkHttpClient = client): Response = suspendCancellableCoroutine { continuation ->
        val call = httpClient.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) { if (continuation.isActive) continuation.resumeWithException(error) }
            override fun onResponse(call: Call, response: Response) { continuation.resume(response) { _, value, _ -> value.close() } }
        })
    }
    private fun wsUrl(channel: String) = config.url.replaceFirst("http", "ws") + "/api/sessions/$sessionId/$channel"
    fun serverNow() = (System.currentTimeMillis() + clockOffset).toLong()
    companion object { val terminalStates = setOf("ended", "failed", "interrupted") }
}
