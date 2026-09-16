package dev.coach

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.*
import android.os.SystemClock
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.display.Display
import com.meta.wearable.dat.display.addDisplay
import com.meta.wearable.dat.display.removeDisplay
import com.meta.wearable.dat.display.types.DisplayState
import com.meta.wearable.dat.display.views.Direction
import com.meta.wearable.dat.display.views.ImageSize
import com.meta.wearable.dat.display.views.TextStyle
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class CapturedFrame(val jpeg: ByteArray, val width: Int, val height: Int, val source: String,
    val earliestCapture: Long?, val latestCapture: Long?, val basis: String, val receivedAtMono: Long? = null)

class DeviceBridge(private val context: Context, private val lifecycle: LifecycleOwner,
    private val scope: CoroutineScope, private val report: (String) -> Unit) {
    private var phoneProvider: ProcessCameraProvider? = null
    private var phoneCapture: ImageCapture? = null
    private var session: DeviceSession? = null
    private var camera: Camera? = null
    private var display: Display? = null
    private var monitor: Job? = null
    private var videoMonitor: Job? = null
    private var videoFrames = VideoFrames()
    private var videoError: String? = null
    var mode = "mock"; private set
    var displayAvailable = false; private set

    @SuppressLint("MissingPermission")
    suspend fun start(mode: String) {
        close()
        this.mode = mode
        when (mode) {
            "phone" -> {
                val future = ProcessCameraProvider.getInstance(context)
                val provider = suspendCancellableCoroutine<ProcessCameraProvider> { continuation ->
                    future.addListener({ runCatching { future.get() }.onSuccess { continuation.resume(it) }
                        .onFailure { continuation.resumeWithException(it) } }, ContextCompat.getMainExecutor(context))
                }
                val capture = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
                provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, capture)
                phoneProvider = provider; phoneCapture = capture
                report("Phone camera ready; HUD target is phone")
            }
            "meta_display" -> {
                check(Wearables.registrationState.value == RegistrationState.REGISTERED) { "Register with Meta AI first" }
                val permission = Wearables.checkPermissionStatus(Permission.CAMERA).fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                check(permission == PermissionStatus.Granted) { "Grant Meta camera access using the Meta permission button" }
                val created = Wearables.createSession(AutoDeviceSelector()).fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                session = created
                monitor = scope.launch { created.errors.collect { report("Meta: ${it.description}") } }
                created.start()
                withTimeout(20_000) { created.state.first { it == DeviceSessionState.STARTED } }
                val added = created.addCamera(StreamConfiguration(videoQuality = VideoQuality.LOW, frameRate = 2, compressVideo = false))
                    .fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                camera = added
                val frames = videoFrames
                videoMonitor = scope.launch {
                    launch { added.stream.state.collect {
                        if (it != StreamState.STREAMING) frames.reset()
                        report("Meta video state: $it")
                    } }
                    launch { added.stream.errorStream.collect {
                        videoError = it.name
                        report("Meta video error: ${it.description}")
                    } }
                    try {
                        added.stream.videoStream.collect { frame ->
                            if (!frame.isCompressed && !frame.isCodecConfig) {
                                try {
                                    if (frames.receive(frame.buffer, frame.width, frame.height, SystemClock.elapsedRealtime(), frame.presentationTimeUs)) {
                                        videoError = null
                                        if (frames.current?.sequence == 1L) report("Meta video frames arriving: ${frame.width}x${frame.height}")
                                    }
                                } catch (_: IllegalArgumentException) {
                                    if (videoError == null) report("Meta video frame layout unsupported: ${frame.width}x${frame.height}, bytes=${frame.buffer.remaining()}")
                                    videoError = "UnsupportedVideoLayout"
                                }
                            }
                        }
                    } catch (error: CancellationException) { throw error }
                    catch (error: Exception) {
                        videoError = error.javaClass.simpleName
                        report("Meta video stream failed: $videoError")
                    }
                }
                added.stream.start().fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                withTimeout(20_000) { added.stream.state.first { it == StreamState.STREAMING } }
                // Ordinary Ray-Ban Meta can expose camera without a display. Report this honestly.
                created.addDisplay().onSuccess { capability ->
                    display = capability
                    displayAvailable = withTimeoutOrNull(12_000) { capability.state.first { it == DisplayState.STARTED } } != null
                }.onFailure { error, _ -> report("Glasses display unavailable: ${error.description}; phone preview only") }
                report("Meta camera ready; glasses display=$displayAvailable; using new video frames, sensor clock unknown")
            }
            else -> report("Mock camera and phone HUD ready; synthetic evidence is labeled")
        }
    }

    suspend fun capture(allowPhotoFallback: Boolean = false): CapturedFrame = when (mode) {
        "phone" -> {
            val capture = checkNotNull(phoneCapture) { "Phone camera not ready" }
            val file = File.createTempFile("capture-", ".jpg", context.cacheDir)
            val before = System.currentTimeMillis()
            try {
                suspendCancellableCoroutine<Unit> { continuation ->
                    capture.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(context),
                        object : ImageCapture.OnImageSavedCallback {
                            override fun onImageSaved(result: ImageCapture.OutputFileResults) { if (continuation.isActive) continuation.resume(Unit) }
                            override fun onError(error: ImageCaptureException) { if (continuation.isActive) continuation.resumeWithException(error) }
                        })
                }
                val after = System.currentTimeMillis()
                withContext(Dispatchers.Default) { encoded(decode(file.readBytes()), "phone", before, after, "phone_capture_request_interval") }
            } finally { file.delete() }
        }
        "meta_display" -> {
            checkNotNull(camera) { "Meta camera not ready" }
            val frame = videoFrames.next(SystemClock.elapsedRealtime())
            if (frame == null && allowPhotoFallback) captureMetaPhoto()
            else if (frame == null) throw CameraCaptureFailure(when (videoError) {
                null -> "VideoFrameTimeout"
                "UnsupportedVideoLayout" -> "UnsupportedVideoLayout"
                else -> "VideoStreamFailed"
            })
            else withContext(Dispatchers.Default) {
                val output = ByteArrayOutputStream()
                check(YuvImage(frame.nv21, ImageFormat.NV21, frame.width, frame.height, null)
                    .compressToJpeg(Rect(0, 0, frame.width, frame.height), 80, output)) { "JPEG encoding failed" }
                CapturedFrame(output.toByteArray(), frame.width, frame.height, "meta_display", null, null,
                    "meta_video_clock_unknown", frame.receivedAtMono)
            }
        }
        else -> withContext(Dispatchers.Default) {
            val now = System.currentTimeMillis()
            val bitmap = Bitmap.createBitmap(960, 540, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.rgb(14, 29, 38))
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(110, 220, 190); textSize = 40f }
            canvas.drawText("MOCK CAMERA · SYNTHETIC FRAME", 32f, 64f, paint)
            paint.color = Color.WHITE; paint.textSize = 30f
            canvas.drawText("No physical scene is being observed", 32f, 120f, paint)
            canvas.drawText("Captured $now", 32f, 168f, paint)
            paint.color = Color.rgb(238, 190, 83); canvas.drawRect(340f, 250f, 610f, 430f, paint)
            encoded(bitmap, "mock", now, now, "synthetic_generation")
        }
    }

    suspend fun render(hud: JSONObject, imageBytes: ByteArray? = null): String {
        if (hud.has("imageAssetId") && imageBytes == null) return "unsupported"
        if (mode != "meta_display") return "phone_received"
        val active = display ?: return "unsupported"
        if (!displayAvailable || active.state.value != DisplayState.STARTED) return "unsupported"
        val bitmap = imageBytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        if (imageBytes != null && bitmap == null) return "failed"
        val result = active.sendContent {
            flexBox(direction = Direction.COLUMN, gap = 10, padding = 16) {
                bitmap?.let { image(bitmap = it, sizePreset = ImageSize.FILL) }
                hud.optJSONObject("card")?.let { card ->
                    if (card.optString("title").isNotEmpty()) text(card.optString("title"), style = TextStyle.HEADING)
                    text(card.optString("body"), style = TextStyle.BODY)
                }
                hud.optJSONArray("checklist")?.let { rows ->
                    for (i in 0 until rows.length()) rows.optJSONObject(i)?.let { row ->
                        text("${if (row.optBoolean("checked")) "✓" else "○"} ${row.optString("text")}", style = TextStyle.BODY)
                    }
                }
                hud.optJSONObject("timer")?.let { timer ->
                    val seconds = ((timer.optLong("startedAt") + timer.optLong("durationMs") - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                    text("${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}", style = TextStyle.HEADING)
                }
                if (hud.length() == 0) text("", style = TextStyle.BODY)
            }
        }
        bitmap?.recycle()
        return result.fold(onSuccess = { "sdk_submitted" }, onFailure = { error, _ -> report("Meta HUD: ${error.description}"); "failed" })
    }

    fun cameraStats(): JSONObject = JSONObject().put("streamState", camera?.stream?.state?.value?.name ?: "unavailable")
        .put("framesReceived", videoFrames.receivedCount)
        .put("lastFrameAgeMs", videoFrames.current?.let { SystemClock.elapsedRealtime() - it.receivedAtMono } ?: JSONObject.NULL)
        .put("streamError", videoError ?: JSONObject.NULL)
        .put("firmwareInfo", if (mode == "meta_display") Wearables.devicesMetadata.values.map { it.value }
            .filter { it.linkState == LinkState.CONNECTED }.singleOrNull()?.firmwareInfo ?: JSONObject.NULL else JSONObject.NULL)

    fun close() {
        videoMonitor?.cancel(); videoMonitor = null
        videoFrames = VideoFrames(); videoError = null
        monitor?.cancel(); monitor = null
        runCatching { camera?.stop() }; camera = null
        runCatching { session?.removeDisplay() }; display = null; displayAvailable = false
        runCatching { session?.stop() }; session = null
        phoneProvider?.unbindAll(); phoneProvider = null; phoneCapture = null
    }

    private fun decode(bytes: ByteArray): Bitmap {
        val bitmap = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) { "Image decoding failed" }
        val exif = ExifInterface(bytes.inputStream())
        val matrix = Matrix().apply {
            if (exif.isFlipped) postScale(-1f, 1f)
            postRotate(exif.rotationDegrees.toFloat())
        }
        return if (matrix.isIdentity) bitmap else Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also { bitmap.recycle() }
    }
    private suspend fun captureMetaPhoto(): CapturedFrame {
        report("No video frame arrived; trying one still photo for this inspection")
        val photo = withTimeoutOrNull(10_000) {
            checkNotNull(camera).stream.capturePhoto().fold(onSuccess = { it },
                onFailure = { error, _ -> throw CameraCaptureFailure(error.javaClass.simpleName) })
        } ?: throw CameraCaptureFailure("CaptureFailed")
        return when (photo) {
            is PhotoData.Bitmap -> {
                val owned = checkNotNull(photo.bitmap.copy(Bitmap.Config.ARGB_8888, false)) { "Image copying failed" }
                withContext(Dispatchers.Default) { encoded(owned, "meta_display", null, null, "meta_photo_clock_unknown") }
            }
            is PhotoData.HEIC -> {
                val buffer = photo.data.duplicate().apply { rewind() }
                val owned = ByteArray(buffer.remaining()).also { buffer.get(it) }
                withContext(Dispatchers.Default) { encoded(decode(owned), "meta_display", null, null, "meta_photo_clock_unknown") }
            }
        }
    }
    private fun encoded(bitmap: Bitmap, source: String, earliest: Long?, latest: Long?, basis: String): CapturedFrame {
        val scaled = if (bitmap.width > 1280) Bitmap.createScaledBitmap(bitmap, 1280, bitmap.height * 1280 / bitmap.width, true) else bitmap
        val output = ByteArrayOutputStream()
        check(scaled.compress(Bitmap.CompressFormat.JPEG, 80, output)) { "JPEG encoding failed" }
        val frame = CapturedFrame(output.toByteArray(), scaled.width, scaled.height, source, earliest, latest, basis)
        if (scaled !== bitmap) scaled.recycle()
        bitmap.recycle()
        return frame
    }
}
