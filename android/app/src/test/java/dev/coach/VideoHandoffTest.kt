package dev.coach

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.junit.Assert.*
import org.junit.Test

class VideoHandoffTest {
    @Test fun retryCanPresentItsCueWhileCameraRecoveryIsWaitingForFrames() = runBlocking {
        val capture = Mutex()
        val display = Mutex()
        var recovering = false
        val recovery = launch(start = CoroutineStart.UNDISPATCHED) {
            capture.withLock { display.withLock {
                recovering = true
                try { awaitCancellation() } finally { recovering = false }
            } }
        }
        val queuedCapture = launch(start = CoroutineStart.UNDISPATCHED) { capture.withLock { fail("Camera restarted during video handoff") } }
        withTimeout(1000) {
            stopCameraForVideo(recovery, queuedCapture)
            display.withLock { assertFalse(recovering) }
        }
        assertTrue(recovery.isCancelled)
        assertTrue(queuedCapture.isCancelled)
    }
}
