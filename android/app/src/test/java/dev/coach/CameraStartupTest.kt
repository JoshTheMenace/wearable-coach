package dev.coach

import com.meta.wearable.dat.camera.types.StreamError
import com.meta.wearable.dat.camera.types.StreamState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test

class CameraStartupTest {
    @Test fun initialStoppedIsAllowedAndSuccessWaitsForAFrame() = runBlocking {
        val states = MutableStateFlow(StreamState.STOPPED)
        val errors = MutableSharedFlow<StreamError>()
        val frame = CompletableDeferred<Unit>()
        val pending = async(start = CoroutineStart.UNDISPATCHED) {
            awaitCameraStartup(states, errors) {
                states.first { it == StreamState.STREAMING }
                frame.await()
            }
        }
        assertFalse(pending.isCompleted)
        states.value = StreamState.STREAMING
        yield()
        assertFalse(pending.isCompleted)
        frame.complete(Unit)
        pending.await()
        assertEquals(0, states.subscriptionCount.value)
        assertEquals(0, errors.subscriptionCount.value)
    }

    @Test fun criticalErrorFailsBeforeTheStreamStartsInsteadOfWaitingForTimeout() = runBlocking {
        val states = MutableStateFlow(StreamState.STOPPED)
        val errors = MutableSharedFlow<StreamError>()
        val pending = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { awaitCameraStartup(states, errors) { awaitCancellation() } }
        }
        errors.emit(StreamError.CRITICAL_STREAM_ERROR)
        val failure = withTimeout(1_000) { pending.await().exceptionOrNull() }
        assertEquals("VideoStreamFailed", (failure as CameraCaptureFailure).cameraError)
    }

    @Test fun stoppedAfterStartingAndClosedWhileWaitingForFramesBothFailFast() = runBlocking {
        for ((active, terminal) in listOf(StreamState.STARTING to StreamState.STOPPED, StreamState.STREAMING to StreamState.CLOSED)) {
            val states = MutableStateFlow(StreamState.STOPPED)
            val errors = MutableSharedFlow<StreamError>()
            val pending = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { awaitCameraStartup(states, errors) { awaitCancellation() } }
            }
            states.value = active
            yield()
            states.value = terminal
            val failure = withTimeout(1_000) { pending.await().exceptionOrNull() }
            assertEquals("VideoStreamFailed", (failure as CameraCaptureFailure).cameraError)
        }
    }

    @Test fun cancellationRemovesStartupWatchers() = runBlocking {
        val states = MutableStateFlow(StreamState.STOPPED)
        val errors = MutableSharedFlow<StreamError>()
        val pending = launch(start = CoroutineStart.UNDISPATCHED) {
            awaitCameraStartup(states, errors) { awaitCancellation() }
        }
        pending.cancelAndJoin()
        assertTrue(pending.isCancelled)
        assertEquals(0, states.subscriptionCount.value)
        assertEquals(0, errors.subscriptionCount.value)
    }

    @Test fun staleParentIsRebuiltAfterTheFirstCapabilityFails() = runBlocking {
        val reused = mutableListOf<Boolean>()
        val result = recoverCameraConnection(attempt = { reuse, _ ->
            reused.add(reuse)
            if (reuse) throw CameraCaptureFailure("VideoStartTimeout")
            VideoRecovery.RECOVERED
        }, onFailure = { _, _ -> }, pause = {})
        assertEquals(listOf(true, false), reused)
        assertEquals(VideoRecovery.RECOVERED, result)
    }

    @Test fun disconnectedGlassesWaitWithoutRepeatedSessionRestarts() = runBlocking {
        var attempts = 0
        val result = recoverCameraConnection(attempt = { _, _ -> attempts++; VideoRecovery.WAITING },
            onFailure = { _, _ -> fail("Waiting is not a failed startup") }, pause = { fail("Waiting must not retry") })
        assertEquals(VideoRecovery.WAITING, result)
        assertEquals(1, attempts)
    }

    @Test fun closingTheLessonCancelsRecoveryWithoutRebuilding() = runBlocking {
        var attempts = 0
        val pending = launch(start = CoroutineStart.UNDISPATCHED) {
            recoverCameraConnection(attempt = { _, _ -> attempts++; awaitCancellation() },
                onFailure = { _, _ -> fail("Cancellation must not trigger recovery") }, pause = {})
        }
        pending.cancelAndJoin()
        assertEquals(1, attempts)
    }

    @Test fun failedReplacementSessionsStopAfterThreeAttempts() = runBlocking {
        val reused = mutableListOf<Boolean>()
        val failures = mutableListOf<Int>()
        val delays = mutableListOf<Long>()
        val result = recoverCameraConnection(attempt = { reuse, _ ->
            reused.add(reuse); throw CameraCaptureFailure("VideoStreamFailed")
        }, onFailure = { _, number -> failures.add(number) }, pause = { delays.add(it) })
        assertEquals(VideoRecovery.FAILED, result)
        assertEquals(listOf(true, false, false), reused)
        assertEquals(listOf(1, 2, 3), failures)
        assertEquals(listOf(2_000L, 4_000L), delays)
    }
}
