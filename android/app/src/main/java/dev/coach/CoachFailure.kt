package dev.coach

import java.io.IOException

class BackendFailure(val status: Int) : IOException("Backend request failed ($status)")
class CameraCaptureFailure(val cameraError: String) : IllegalStateException("Glasses camera capture failed")
data class CoachFailure(val code: String, val message: String, val recovery: String = "user_action") {
    companion object {
        fun from(error: Throwable): CoachFailure = when {
            error is CameraCaptureFailure && error.cameraError == "MetaRegistrationRequired" -> CoachFailure("capture.failed", "Connect Wearable Coach using Register Meta, then start the session again.")
            error is CameraCaptureFailure && error.cameraError == "MetaPermissionRequired" -> CoachFailure("capture.failed", "Tap Meta camera access and choose Always allow. If access was denied, disconnect Wearable Coach in Meta AI’s app settings, register it again, and retry.")
            error is CameraCaptureFailure && error.cameraError == "DeviceStartTimeout" -> CoachFailure("capture.failed", "The glasses did not start a session. Put them on, wake them, and start a new session. If it repeats, check their connection in Meta AI. Diagnostics have been saved.")
            error is CameraCaptureFailure && error.cameraError == "VideoStartTimeout" -> CoachFailure("capture.failed", "The glasses connected but sent no video. Put them on, wake them, and start a new session. Camera diagnostics have been saved.")
            error is CameraCaptureFailure && error.cameraError == "VideoFrameTimeout" -> CoachFailure("capture.failed", "No new video frames arrived from the glasses. Live camera stopped; wake the glasses and tap Live camera to retry. Camera diagnostics have been saved.")
            error is CameraCaptureFailure -> CoachFailure("capture.failed", "No image arrived from the glasses camera. Wake the glasses and start a new session. If it repeats, restart the glasses; camera diagnostics have been saved.")
            error is BackendFailure && error.status == 412 -> CoachFailure("request.failed", "Live camera has no recent frames. Wait for the feed to resume, then retry.")
            error is BackendFailure && error.status == 409 -> CoachFailure("request.failed", "The session changed. Reconnect, or start a new session if it has ended.")
            error is BackendFailure && error.status == 401 -> CoachFailure("request.failed", "The connection is no longer authorized. Start a new session.")
            error is BackendFailure && error.status == 429 -> CoachFailure("request.failed", "The server is busy. Wait a moment and retry.")
            error is BackendFailure -> CoachFailure("request.failed", "The server could not complete this request (${error.status}). Retry; diagnostics have been saved.")
            error is SecurityException -> CoachFailure("permissions.denied", "Camera, microphone or Bluetooth access is missing. Grant access in Android Settings and retry.")
            error is IOException -> CoachFailure("network.unavailable", "Cannot reach the coach server. Keep USB connected and the server running, then retry.")
            else -> CoachFailure("app.error", "This action could not finish. Retry; diagnostics have been saved.")
        }
    }
}
