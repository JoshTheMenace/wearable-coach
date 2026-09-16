package dev.coach

import java.io.IOException

class BackendFailure(val status: Int) : IOException("Backend request failed ($status)")
data class CoachFailure(val code: String, val message: String, val recovery: String = "user_action") {
    companion object {
        fun from(error: Throwable): CoachFailure = when {
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
