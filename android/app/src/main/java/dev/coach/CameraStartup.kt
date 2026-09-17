package dev.coach

import com.meta.wearable.dat.camera.types.StreamError
import com.meta.wearable.dat.camera.types.StreamState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first

// Watch before start(), and keep watching until the first frame arrives.
internal suspend fun awaitCameraStartup(states: Flow<StreamState>, errors: Flow<StreamError>, startAndAwaitFrame: suspend () -> Unit) = coroutineScope {
    val stateMonitor = launch(start = CoroutineStart.UNDISPATCHED) {
        var progressed = false
        states.collect { state ->
            if (state == StreamState.CLOSED || state == StreamState.STOPPED && progressed)
                throw CameraCaptureFailure("VideoStreamFailed")
            if (state != StreamState.STOPPED) progressed = true
        }
    }
    val errorMonitor = launch(start = CoroutineStart.UNDISPATCHED) {
        errors.first { it == StreamError.CRITICAL_STREAM_ERROR }
        throw CameraCaptureFailure("VideoStreamFailed")
    }
    try { startAndAwaitFrame() }
    finally { stateMonitor.cancel(); errorMonitor.cancel() }
}

// A failed capability can leave its parent transport stale. Only reuse it once.
internal suspend fun recoverCameraConnection(
    reuseExistingSession: Boolean = true,
    attempt: suspend (reuseSession: Boolean, number: Int) -> VideoRecovery,
    onFailure: (Exception, Int) -> Unit,
    pause: suspend (Long) -> Unit = { delay(it) }
): VideoRecovery {
    repeat(3) { index ->
        try { return attempt(reuseExistingSession && index == 0, index + 1) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { onFailure(error, index + 1) }
        if (index < 2) pause(2_000L * (index + 1))
    }
    return VideoRecovery.FAILED
}
