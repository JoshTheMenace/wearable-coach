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
import com.meta.wearable.dat.camera.Stream
import com.meta.wearable.dat.camera.addStream
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
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.Closeable
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class CapturedFrame(val jpeg: ByteArray, val width: Int, val height: Int, val source: String,
    val earliestCapture: Long?, val latestCapture: Long?, val basis: String, val receivedAtMono: Long? = null)

enum class VideoRecovery { RECOVERED, WAITING, FAILED }

class DeviceBridge(private val context: Context, private val lifecycle: LifecycleOwner,
    private val scope: CoroutineScope, private val report: (String) -> Unit) {
    private var phoneProvider: ProcessCameraProvider? = null
    private var phoneCapture: ImageCapture? = null
    private var session: DeviceSession? = null
    private var stream: Stream? = null
    private var display: Display? = null
    private var displayObserver: Closeable? = null
    private var lastDisplayError: String? = null
    private var lastDisplayErrorAt = 0L
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
                if (Wearables.registrationState.value != RegistrationState.REGISTERED) throw CameraCaptureFailure("MetaRegistrationRequired")
                val permission = Wearables.checkPermissionStatus(Permission.CAMERA).fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                if (permission != PermissionStatus.Granted) throw CameraCaptureFailure("MetaPermissionRequired")
                setDamBootstrap(false)
                val created = Wearables.createSession(AutoDeviceSelector()).fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                session = created
                monitor = scope.launch { created.errors.collect { report("Meta: ${it.description}") } }
                // DAT 0.8 snapshots legacy video at creation; display needs DAM at session start.
                // Restore legacy lifecycle handling before adding the stream, or video never arrives.
                try {
                    setDamBootstrap(true)
                    created.start()
                    withTimeoutOrNull(20_000) { created.state.first { it == DeviceSessionState.STARTED } }
                        ?: throw CameraCaptureFailure("DeviceStartTimeout")
                    created.addDisplay().onSuccess { capability ->
                        display = capability
                        displayAvailable = withTimeoutOrNull(12_000) { capability.state.first { it == DisplayState.STARTED } } != null
                        if (displayAvailable) displayObserver = GlassesHudTransport.observeErrors(created) { code ->
                            scope.launch(Dispatchers.Main.immediate) { if (session === created) reportDisplayError(code) }
                        }
                    }.onFailure { error, _ -> report("Glasses display unavailable: ${error.description}; phone preview only") }
                } finally { setDamBootstrap(false) }
                val added = created.addStream(StreamConfiguration(videoQuality = VideoQuality.MEDIUM, frameRate = 24, compressVideo = false))
                    .fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                stream = added
                val frames = videoFrames
                videoMonitor = scope.launch {
                    launch { added.state.collect {
                        if (it != StreamState.STREAMING) frames.reset()
                        report("Meta video state: $it")
                    } }
                    launch { added.errorStream.collect {
                        videoError = it.name
                        report("Meta video error: ${it.description}")
                    } }
                    try {
                        added.videoStream.collect { frame ->
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
                added.start().fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                withTimeoutOrNull(20_000) { added.state.first { it == StreamState.STREAMING } }
                    ?: throw CameraCaptureFailure("VideoStartTimeout")
                frames.next(SystemClock.elapsedRealtime(), 8_000) ?: throw CameraCaptureFailure("VideoStartTimeout")
                restoreDisplay()
                report("Meta camera ready; glasses display=$displayAvailable; using new video frames, sensor clock unknown")
            }
            else -> report("Mock camera and phone HUD ready; synthetic evidence is labeled")
        }
    }

    // Called by the serialized live capture coroutine: cancelling live also cancels recovery.
    suspend fun recoverVideo(onAttempt: (Int) -> Unit): VideoRecovery {
        if (mode != "meta_display") return VideoRecovery.FAILED
        videoFrames.reset()
        var rebuilt = false
        try {
            repeat(3) { attempt ->
                currentCoroutineContext().ensureActive()
                if (session?.state?.value == DeviceSessionState.PAUSED || stream?.state?.value == StreamState.PAUSED)
                    return VideoRecovery.WAITING
                if (Wearables.devicesMetadata.values.none { it.value.linkState == LinkState.CONNECTED })
                    return VideoRecovery.WAITING
                onAttempt(attempt + 1)
                try {
                    val active = stream
                    if (attempt == 0 && session?.state?.value == DeviceSessionState.STARTED && active?.state?.value == StreamState.STOPPED) {
                        active.start().fold(onSuccess = { it }, onFailure = { error, _ -> error(error.description) })
                        withTimeoutOrNull(20_000) { active.state.first { it == StreamState.STREAMING } }
                            ?: throw CameraCaptureFailure("VideoStartTimeout")
                        videoFrames.next(SystemClock.elapsedRealtime(), 8_000) ?: throw CameraCaptureFailure("VideoStartTimeout")
                        restoreDisplay()
                    } else {
                        rebuilt = true
                        start("meta_display") // A stopped parent session cannot be restarted.
                    }
                    return VideoRecovery.RECOVERED
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    report("Meta camera recovery attempt ${attempt + 1} failed: ${error.javaClass.simpleName}")
                    if (attempt < 2) delay(2_000L * (attempt + 1))
                }
            }
            if (rebuilt) close()
            return VideoRecovery.FAILED
        } catch (error: CancellationException) {
            if (rebuilt) close() // Do not leave a partially started replacement behind.
            throw error
        }
    }

    suspend fun restoreDisplay() {
        val active = session ?: return
        if (!displayAvailable) return
        try {
            GlassesHudTransport.restoreAfterCameraStart(active)
            if (session === active) report("Meta display relaunch requested after camera start; DWA query acknowledged")
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { if (session === active) reportDisplayError((error as? GlassesDisplayFailure)?.code ?: "RESTORE_FAILED") }
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
            if (stream == null) throw CameraCaptureFailure("VideoStreamFailed")
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
        if (hud.has("imageAssetId")) return "unsupported" // DAT 0.8 cannot send local bitmap content.
        val active = display ?: return "unsupported"
        if (!displayAvailable || active.state.value != DisplayState.STARTED) return "unsupported"
        val lines = buildList {
            hud.optJSONObject("card")?.let { card ->
                card.optString("title").takeIf { it.isNotEmpty() }?.let { add(GlassesHudPayload.Line(it, true)) }
                add(GlassesHudPayload.Line(card.optString("body")))
            }
            hud.optJSONArray("checklist")?.let { rows ->
                for (i in 0 until rows.length()) rows.optJSONObject(i)?.let { row ->
                    add(GlassesHudPayload.Line("${if (row.optBoolean("checked")) "✓" else "○"} ${row.optString("text")}"))
                }
            }
            hud.optJSONObject("timer")?.let { timer ->
                val seconds = ((timer.optLong("startedAt") + timer.optLong("durationMs") - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                add(GlassesHudPayload.Line("${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}", true))
            }
        }
        return try {
            GlassesHudTransport.send(checkNotNull(session), GlassesHudPayload.encode(lines))
            lastDisplayError = null
            "sdk_submitted" // Acknowledgment is not proof of visible pixels.
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { reportDisplayError((error as? GlassesDisplayFailure)?.code ?: "SEND_EXCEPTION"); "failed" }
    }

    private fun reportDisplayError(code: String) {
        val now = SystemClock.elapsedRealtime()
        // The observer and pending send can report the same event; retain later repeated failures.
        if (lastDisplayError == code && now - lastDisplayErrorAt < 1000) return
        lastDisplayError = code; lastDisplayErrorAt = now
        report("Meta display error: $code")
    }

    fun cameraStats(): JSONObject = JSONObject().put("streamState", stream?.state?.value?.name ?: "unavailable")
        .put("framesReceived", videoFrames.receivedCount)
        .put("lastFrameAgeMs", videoFrames.current?.let { SystemClock.elapsedRealtime() - it.receivedAtMono } ?: JSONObject.NULL)
        .put("streamError", videoError ?: JSONObject.NULL)
        .put("wearState", wearState() ?: JSONObject.NULL)
        .put("lastDisplayError", lastDisplayError ?: JSONObject.NULL)
        .put("firmwareInfo", if (mode == "meta_display") Wearables.devicesMetadata.values.map { it.value }
            .filter { it.linkState == LinkState.CONNECTED }.singleOrNull()?.firmwareInfo ?: JSONObject.NULL else JSONObject.NULL)

    fun close() {
        videoMonitor?.cancel(); videoMonitor = null
        videoFrames = VideoFrames(); videoError = null
        monitor?.cancel(); monitor = null
        runCatching { displayObserver?.close() }; displayObserver = null; lastDisplayError = null
        runCatching { stream?.stop() }; stream = null
        runCatching { session?.removeDisplay() }; display = null; displayAvailable = false
        runCatching { session?.stop() }; session = null
        runCatching { setDamBootstrap(false) }
        phoneProvider?.unbindAll(); phoneProvider = null; phoneCapture = null
    }

    // Internal API, pinned to DAT 0.8. Revalidate this workaround before upgrading the SDK.
    private fun setDamBootstrap(enabled: Boolean) {
        check(BuildConfig.META_DAT_VERSION == "0.8.0") { "Revalidate Meta camera/display compatibility for this SDK" }
        Wearables.javaClass.getMethod("setUsesDamOverride\$fbandroid_java_com_meta_wearable_dat_core_core", Boolean::class.javaPrimitiveType)
            .invoke(Wearables, enabled)
    }

    private fun wearState(): String? = session?.let { active -> runCatching {
        val suffix = "\$fbandroid_java_com_meta_wearable_dat_core_core"
        val heartbeat = active.javaClass.getMethod("getHeartbeatMonitor$suffix").invoke(active)
        (heartbeat.javaClass.getMethod("getDonState$suffix").invoke(heartbeat) as StateFlow<*>).value.toString()
    }.getOrNull() }

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
            checkNotNull(stream).capturePhoto().fold(onSuccess = { it },
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
