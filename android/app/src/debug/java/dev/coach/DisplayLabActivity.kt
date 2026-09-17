package dev.coach

import android.app.Activity
import android.content.Intent
import android.graphics.*
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.WindowManager
import android.widget.*
import com.google.protobuf.CodedOutputStream
import com.meta.wearable.dat.camera.addStream
import com.meta.wearable.dat.camera.types.*
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.display.Display
import com.meta.wearable.dat.display.addDisplay
import com.meta.wearable.dat.display.types.*
import com.meta.wearable.dat.display.views.VideoPlayer
import com.meta.wearable.dat.dwa.protos.*
import com.meta.wearable.dat.dwa.capability.display.internal.protos.DisplayEventPayload
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import kotlin.coroutines.*
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED
import java.util.zip.GZIPOutputStream

// Debug-only hardware experiments. No coach connection, microphone, or camera uploads.
class DisplayLabActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val lock = Mutex()
    private val ready = CompletableDeferred<Unit>()
    private lateinit var screen: TextView
    private lateinit var display: Display
    private var session: DeviceSession? = null
    private var callbacks: Closeable? = null
    private var player: VideoPlayer? = null
    private var playerMonitor: Job? = null
    private var videoServer: LocalVideoServer? = null
    private var urlStarted = 0L
    private var urlLabel = ""
    private var localTransfer: Job? = null
    private var localMedia = "excerpt-a.mp4"
    private var localStarted = 0L
    private var localSize = 0L
    private var localSent = 0L
    private var cameraStarted = false
    private var frames = 0L
    private var page = 0
    private var angle = 0
    private var revision = 0
    private var zoomMode = 0
    private var zoomIndex = 0
    private data class ImagePresentation(val width: Int = 320, val height: Int = 220, val scale: Float = 1f, val framed: Boolean = false)
    private val history = ArrayDeque<String>()
    private val clipUrl = "https://github.com/facebook/meta-wearables-dat-android/raw/refs/heads/assets/video_266x150_faststart.mp4"

    private fun note(message: String) {
        val line = "${SystemClock.elapsedRealtime()} $message"
        Log.i("DisplayLab", line)
        File(filesDir, "display-lab.log").appendText("$line\n")
        history.addLast(line); while (history.size > 20) history.removeFirst()
        screen.text = history.joinToString("\n")
    }

    private fun Any.sdk(name: String, vararg args: Any?): Any? = javaClass.methods.single {
        it.name.substringBefore('$').substringBefore('-') == name && it.parameterCount == args.size && !it.name.endsWith("\$default")
    }.invoke(this, *args)

    private fun dam(value: Boolean) { Wearables.sdk("setUsesDamOverride", value) }
    private fun delegate(): Any = checkNotNull(display.javaClass.getDeclaredField("delegate").apply { isAccessible = true }.get(display))

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        screen = TextView(this).apply { textSize = 12f; setPadding(16, 12, 16, 12) }
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(12, 32, 12, 12) }
        for (commands in listOf(listOf("diagram", "3d", "lesson"), listOf("zoom_native", "zoom_size", "zoom_crop"), listOf("url", "bytes", "flow"), listOf("camera", "stop", "end"))) {
            layout.addView(LinearLayout(this).apply {
                commands.forEach { action -> addView(Button(this@DisplayLabActivity).apply {
                    text = action; setOnClickListener { run(action) }
                }, LinearLayout.LayoutParams(0, 60, 1f)) }
            })
        }
        layout.addView(ScrollView(this).apply { addView(screen) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(layout)
        scope.launch {
            try {
                Wearables.initialize(this@DisplayLabActivity).fold(onSuccess = {}, onFailure = { e, _ -> error(e.description) })
                note("START sdk=${BuildConfig.META_DAT_VERSION} registration=${Wearables.registrationState.value}")
                val selector = AutoDeviceSelector()
                withTimeout(30_000) { selector.activeDeviceFlow().first { it != null } }
                dam(false)
                val active = Wearables.createSession(selector).fold(onSuccess = { it }, onFailure = { e, _ -> error(e.description) })
                session = active
                launch { active.state.collect { note("SESSION $it") } }
                launch { active.errors.collect { note("SESSION_ERROR ${it.description}") } }
                try {
                    dam(true)
                    active.start()
                    withTimeout(20_000) { active.state.first { it == DeviceSessionState.STARTED } }
                    display = active.addDisplay().fold(onSuccess = { it }, onFailure = { e, _ -> error(e.description) })
                    launch { display.state.collect { note("DISPLAY $it") } }
                    withTimeout(15_000) { display.state.first { it == DisplayState.STARTED } }
                } finally { dam(false) }
                observeEvents(active)
                @Suppress("UNCHECKED_CAST")
                val progress = delegate().sdk("getVideoStreamProgress") as Flow<Long>
                launch { progress.collect { localSent = it; note("VIDEO_BYTES_SENT $it") } }
                ready.complete(Unit)
                note("READY")
                run(intent.getStringExtra("probe") ?: "diagram", intent.getStringExtra("media"))
            } catch (e: Exception) {
                ready.completeExceptionally(e)
                note("START_FAILED ${e.javaClass.simpleName}: ${e.message}")
                session?.stop()
            }
        }
    }

    private fun observeEvents(active: DeviceSession) {
        val manager = checkNotNull(Wearables.sdk("getSessionManager"))
        val channel = checkNotNull(manager.sdk("getOrCreateDwaChannel", active.sdk("getDevice")))
        val response: (DwaApiResponse) -> Unit = {}
        val event: (DwaEvent) -> Unit = { wire ->
            if (wire.capability == Capability.CAPABILITY_DISPLAY && wire.hasCapabilityEventPayload()) {
                scope.launch {
                    runCatching {
                        val payload = DisplayEventPayload.parseFrom(wire.capabilityEventPayload)
                        note("EVENT ${payload.toString().replace('\n', ' ')}")
                        if (payload.hasVideoEvent() && urlStarted != 0L) note("URL_PLAYBACK source=$urlLabel type=${payload.videoEvent.type} elapsedMs=${SystemClock.elapsedRealtime() - urlStarted}")
                        if (payload.hasVideoEvent() && localStarted != 0L) note("LOCAL_PLAYBACK file=$localMedia type=${payload.videoEvent.type} elapsedMs=${SystemClock.elapsedRealtime() - localStarted} sent=$localSent total=$localSize")
                        if (payload.hasDisplayEvent() && payload.displayEvent.hasClick()) {
                            val id = payload.displayEvent.click.identifier
                            // Ignore callbacks from screens replaced while an event was in transit.
                            if (id.substringBefore(':') == revision.toString()) run(id.substringAfter(':'))
                        }
                    }.onFailure { note("EVENT_ERROR ${it.message}") }
                }
            }
        }
        val error: (Exception) -> Unit = { scope.launch { note("CHANNEL_ERROR ${it.message}") } }
        val closed: () -> Unit = { scope.launch { note("CHANNEL_CLOSED") } }
        callbacks = channel.sdk("registerCallbacks", response, event, error, closed) as Closeable
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); run(intent.getStringExtra("probe") ?: "diagram", intent.getStringExtra("media")) }

    private fun run(action: String, media: String? = null) {
        scope.launch {
            try {
                ready.await()
                lock.withLock {
                    note("COMMAND $action frames=$frames")
                    when (action) {
                        "diagram" -> show("LOCAL DIAGRAM", diagram(), listOf("3D snapshot" to "3d", "Lesson controls" to "lesson"))
                        "3d", "rotate" -> { if (action == "rotate") angle = (angle + 1) % 4
                            show("3D VIEW ${angle + 1}/4", assets.open("display-lab/view$angle.png").use { it.readBytes() }, listOf("Rotate" to "rotate", "Lesson" to "lesson")) }
                        "lesson" -> { page = 0; lesson() }
                        "next", "previous" -> { page = (page + if (action == "next") 1 else -1).coerceIn(0, 2); lesson() }
                        "answer_a", "answer_b" -> show(if (action == "answer_a") "CORRECT: BLUE" else "TRY AGAIN: BLUE", null, listOf("Review diagram" to "diagram", "Restart lesson" to "lesson"))
                        "zoom_native", "zoom_size", "zoom_crop" -> {
                            zoomMode = listOf("zoom_native", "zoom_size", "zoom_crop").indexOf(action)
                            zoomIndex = 0; zoom()
                        }
                        "zoom_in", "zoom_out" -> {
                            zoomIndex = (zoomIndex + if (action == "zoom_in") 1 else -1).coerceIn(0, if (zoomMode == 2) 3 else 2)
                            zoom()
                        }
                        "zoom_mode" -> { zoomMode = (zoomMode + 1) % 3; zoomIndex = 0; zoom() }
                        "url", "url_local" -> {
                            localTransfer?.cancelAndJoin()
                            stopVideo()
                            val source = if (action == "url_local") {
                                val name = media ?: "compact-master.mp4"
                                require(File(name).name == name && name.endsWith(".mp4"))
                                val file = File(filesDir, "display-lab/$name")
                                check(file.isFile)
                                urlLabel = "phone/$name"
                                LocalVideoServer(file) { line -> scope.launch { note(line) } }.also { videoServer = it }.url
                            } else { urlLabel = "public/sample"; clipUrl }
                            urlStarted = SystemClock.elapsedRealtime()
                            note("URL_START source=$urlLabel${videoServer?.let { " url=${it.url}" } ?: ""}")
                            player = VideoPlayer(VideoSource.Url(source), VideoCodec.MP4).also { video ->
                                playerMonitor = scope.launch {
                                    launch { video.state.collect { note("PLAYER_STATE $it") } }
                                    launch { video.error.collect { note("PLAYER_ERROR $it") } }
                                }
                                display.sendContent { video(player = video) }.fold(onSuccess = { note("URL_BIND $it") }, onFailure = { e, _ -> error(e.description) })
                                video.play()
                            }
                        }
                        "bytes", "flow" -> {
                            stopVideo()
                            val bytes = assets.open("display-lab/clip.mp4").use { it.readBytes() }
                            val input: Any = if (action == "bytes") bytes else flow {
                                var offset = 0
                                while (offset < bytes.size) { val end = minOf(offset + 15_000, bytes.size); emit(bytes.copyOfRange(offset, end)); offset = end }
                            }
                            val started = SystemClock.elapsedRealtime()
                            val result = withTimeout(45_000) { sendVideoBytes(input) }
                            note("VIDEO_TRANSFER mode=$action bytes=${bytes.size} elapsedMs=${SystemClock.elapsedRealtime()-started} result=$result")
                        }
                        "local", "local_hold" -> startLocalVideo(media ?: localMedia, action == "local_hold")
                        "camera" -> startCamera()
                        "stop" -> { stopVideo(); show("BACK TO LESSON", null, listOf("Diagram" to "diagram", "Lesson" to "lesson")) }
                        "end" -> { stopVideo(); session?.stop(); finish() }
                    }
                }
            } catch (e: CancellationException) {
                if (e is TimeoutCancellationException) { note("TIMEOUT $action"); if (action in listOf("bytes", "flow")) delegate().sdk("stopVideoStream") }
                else throw e
            } catch (e: Exception) { note("FAILED $action ${e.javaClass.simpleName}: ${e.cause?.message ?: e.message}") }
        }
    }

    private suspend fun sendVideoBytes(input: Any): Any? = suspendCancellableCoroutine { continuation ->
        val target = delegate()
        val method = target.javaClass.methods.single { it.name.startsWith("sendVideoStream-") && it.parameterTypes[0].isInstance(input) }
        try {
            val result = method.invoke(target, input, VideoCodec.MP4, continuation)
            if (result !== COROUTINE_SUSPENDED) continuation.resume(result)
        } catch (e: Exception) { continuation.resumeWithException(e.cause ?: e) }
    }

    private fun stopVideo() {
        videoServer?.close(); videoServer = null; urlStarted = 0L
        localTransfer?.cancel(); localTransfer = null; localStarted = 0L
        player?.close(); player = null
        playerMonitor?.cancel(); playerMonitor = null
        delegate().sdk("stopVideoStream")
    }

    private suspend fun startLocalVideo(name: String, holdEnd: Boolean) {
        require(File(name).name == name && name.endsWith(".mp4")) { "Expected an MP4 filename" }
        val file = File(filesDir, "display-lab/$name")
        check(file.isFile && file.length() > 0) { "Missing local fixture: $name" }
        localTransfer?.cancelAndJoin()
        stopVideo()
        localMedia = name; localSize = file.length(); localSent = 0
        localStarted = SystemClock.elapsedRealtime()
        note("LOCAL_START file=$name bytes=$localSize holdEnd=$holdEnd")
        // A separate job keeps Stop/End responsive while receiver credits throttle delivery.
        localTransfer = scope.launch {
            try {
                val input = flow {
                    file.inputStream().use { stream ->
                        val buffer = ByteArray(15_000)
                        while (true) {
                            val count = withContext(Dispatchers.IO) { stream.read(buffer) }
                            if (count < 0) break
                            emit(buffer.copyOf(count))
                        }
                    }
                    note("LOCAL_FILE_EMITTED file=$name elapsedMs=${SystemClock.elapsedRealtime() - localStarted}")
                    if (holdEnd) { note("LOCAL_HOLD_END begin"); delay(10_000); note("LOCAL_HOLD_END release") }
                }
                val result = withTimeout(180_000) { sendVideoBytes(input) }
                note("LOCAL_TRANSFER file=$name elapsedMs=${SystemClock.elapsedRealtime() - localStarted} result=$result")
            } catch (e: CancellationException) {
                if (e is TimeoutCancellationException) { note("LOCAL_TIMEOUT file=$name"); delegate().sdk("stopVideoStream") }
                else throw e
            } catch (e: Exception) { note("LOCAL_FAILED file=$name ${e.cause?.message ?: e.message}"); delegate().sdk("stopVideoStream") }
        }
    }

    private suspend fun startCamera() {
        if (cameraStarted) { note("CAMERA already active frames=$frames"); return }
        val active = checkNotNull(session)
        val stream = active.addStream(StreamConfiguration(videoQuality = VideoQuality.MEDIUM, frameRate = 24, compressVideo = false))
            .fold(onSuccess = { it }, onFailure = { e, _ -> error(e.description) })
        cameraStarted = true
        scope.launch { stream.videoStream.collect { frames++; if (frames == 1L || frames % 240 == 0L) note("CAMERA_FRAME $frames ${it.width}x${it.height}") } }
        scope.launch { stream.errorStream.collect { note("CAMERA_ERROR $it") } }
        stream.start().fold(onSuccess = {}, onFailure = { e, _ -> error(e.description) })
        withTimeout(20_000) { while (frames == 0L) delay(100) }
        GlassesHudTransport.restoreAfterCameraStart(active)
        show("CAMERA + DIAGRAM", diagram(), listOf("3D snapshot" to "3d", "Lesson" to "lesson"))
    }

    private suspend fun lesson() {
        when (page) {
            0 -> show("LESSON 1/3", null, listOf("Read: blue is the center" to "next", "Next" to "next"))
            1 -> show("LESSON 2/3", diagram(), listOf("Previous" to "previous", "Next: quiz" to "next"))
            2 -> show("CENTER COLOR?", null, listOf("A: Blue" to "answer_a", "B: Orange" to "answer_b", "Previous" to "previous"))
        }
    }

    private suspend fun zoom() {
        val factor = listOf(1f, 1.5f, 2f, 4f)[zoomIndex]
        var bytes = assets.open("display-lab/view0.png").use { it.readBytes() }
        val presentation = when (zoomMode) {
            0 -> ImagePresentation(240, 165, factor, true)
            1 -> ImagePresentation((240 * factor).toInt(), (165 * factor).toInt(), framed = true)
            else -> {
                val source = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                val bitmap = Bitmap.createBitmap(480, 330, Bitmap.Config.ARGB_8888)
                val width = 240 * factor; val height = 165 * factor
                Canvas(bitmap).apply {
                    drawColor(Color.BLACK)
                    drawBitmap(source, null, RectF((480 - width) / 2, (330 - height) / 2, (480 + width) / 2, (330 + height) / 2), Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
                }
                bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
                source.recycle(); bitmap.recycle()
                ImagePresentation(480, 330, framed = true)
            }
        }
        val mode = listOf("NATIVE SCALE", "LAYOUT SIZE", "PHONE CROP")[zoomMode]
        note("ZOOM mode=$mode factor=$factor bounds=${presentation.width}x${presentation.height}")
        show("$mode ${factor}x", bytes, listOf("Zoom in" to "zoom_in", "Zoom out" to "zoom_out", "Next method" to "zoom_mode"), presentation)
    }

    private fun diagram(): ByteArray {
        val bitmap = Bitmap.createBitmap(320, 220, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.BLACK)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 5f }
        canvas.drawRoundRect(65f, 30f, 255f, 195f, 45f, 45f, paint)
        paint.color = Color.CYAN; paint.style = Paint.Style.FILL
        canvas.drawCircle(160f, 105f, 26f, paint)
        paint.color = Color.rgb(255, 160, 50)
        canvas.drawCircle(100f, 155f, 14f, paint); canvas.drawCircle(220f, 155f, 14f, paint)
        paint.color = Color.WHITE; paint.textSize = 19f
        canvas.drawText("LOCAL BITMAP TEST", 66f, 216f, paint)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); bitmap.recycle() }.toByteArray()
    }

    private fun key(value: Int) = String(Character.toChars(value))
    private fun node(type: Int, vararg attrs: Pair<Int, Any>) = JSONObject().put(key(type), JSONObject().also { o -> attrs.forEach { (k,v) -> o.put(key(k),v) } })
    private fun text(value: String) = node(13335, 41 to value, 35 to "optimistic-iris-sd-400", 45 to "28sp", 59 to "36sp", 43 to "#FFFFFF")
    private fun column(children: List<JSONObject>, center: Boolean = false) = node(13320, 41 to "column", 42 to "no_wrap", 44 to if (center) "center" else "flex_start", 36 to "center", 32 to JSONArray(children))

    private suspend fun show(title: String, image: ByteArray?, actions: List<Pair<String,String>>, presentation: ImagePresentation = ImagePresentation()) {
        revision++
        val children = mutableListOf(text(title))
        val encoded = image?.let { bytes ->
            val bitmap = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
            ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it); bitmap.recycle() }.toByteArray()
        }
        if (encoded != null) {
            val imageNode = node(13323, 41 to "data:image/jpeg;base64,${Base64.encodeToString(encoded, Base64.NO_WRAP)}", 40 to "fit_center",
                132 to node(24201, 58 to presentation.width.toString(), 41 to presentation.height.toString(), 65 to 0))
            if (presentation.framed) imageNode.getJSONObject(key(13323)).put(key(33), "zoom-image")
            if (presentation.scale != 1f) imageNode.getJSONObject(key(13323)).put(key(136), presentation.scale).put(key(137), presentation.scale)
            children += if (presentation.framed) column(listOf(imageNode), true).apply {
                getJSONObject(key(13320)).put(key(33), "zoom-viewport").put(key(132), node(24201, 58 to "480", 41 to "330", 65 to 0))
            } else imageNode
        }
        actions.forEach { (label, action) ->
            val id = "$revision:$action"
            // Test stable component identity while keeping callback revisions separate.
            children += node(22655, 32 to JSONArray(listOf(column(listOf(text(label))))), 33 to if (presentation.framed) action else id, 43 to true,
                132 to node(24201, 58 to "440", 41 to if (presentation.framed) "56" else "72", 65 to 0, 49 to "8"),
                133 to JSONArray(listOf(node(23426, 35 to "(jl9 \"$id\")"))),
                41 to node(23457, 38 to "default", 40 to "medium"))
        }
        val root = column(children, true)
        if (presentation.framed) root.getJSONObject(key(13320)).put(key(33), "zoom-root")
        root.getJSONObject(key(13320)).put(key(132), node(24201, 58 to "600", 41 to "600"))
        val json = JSONObject().put("layout", JSONObject().put("bloks_payload", JSONObject().put("tree", root).put("ft", JSONObject())))
        val gzip = ByteArrayOutputStream().also { output -> GZIPOutputStream(output).use { it.write(json.toString().toByteArray()) } }.toByteArray()
        check(gzip.size <= 15_000) { "Fixture exceeds measured legacy transport budget: ${gzip.size} bytes" }
        fun field(id: Int, bytes: ByteArray) = ByteArrayOutputStream().also { output -> CodedOutputStream.newInstance(output).also { it.writeByteArray(id, bytes); it.flush() } }.toByteArray()
        val started = SystemClock.elapsedRealtime()
        GlassesHudTransport.send(checkNotNull(session), field(3, field(3, gzip)))
        note("DISPLAY_ACK title=$title imageBytes=${encoded?.size ?: 0} gzipBytes=${gzip.size} elapsedMs=${SystemClock.elapsedRealtime()-started} revision=$revision")
    }

    override fun onDestroy() {
        videoServer?.close()
        callbacks?.close(); player?.close(); session?.stop(); scope.cancel()
        runCatching { dam(false) }; super.onDestroy()
    }
}
