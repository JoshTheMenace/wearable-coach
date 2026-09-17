package dev.coach

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class SessionPresentationTest {
    @Test fun controlAndAudioContinueWhilePresentationWaitsThenCameraStartsAfterReceipt() = runBlocking {
        val sessionScope = this
        val receipt = CompletableDeferred<Unit>()
        val cameraStop = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        var presentation: Job? = null
        var camera: Job? = null
        val binding = launch(start = CoroutineStart.UNDISPATCHED) {
            presentation = sessionScope.presentSessionSnapshot(current = { true }, render = {
                receipt.await(); order.add("hud_receipt")
            }, startCamera = {
                order.add("camera_start")
                camera = sessionScope.launch { cameraStop.await() }
            }, onFailure = { throw it })
            order.add("audio_connected")
        }
        try {
            yield()
            assertEquals(listOf("audio_connected"), order)
            receipt.complete(Unit)
            binding.join(); presentation?.join()
            assertEquals(listOf("audio_connected", "hud_receipt", "camera_start"), order)
            assertTrue(camera?.isActive == true)
        } finally {
            binding.cancelAndJoin(); presentation?.cancelAndJoin(); camera?.cancelAndJoin()
        }
    }

    @Test fun supersededSnapshotCannotStartCameraAfterItsReceiptArrives() = runBlocking {
        val receipt = CompletableDeferred<Unit>()
        var current = true
        var cameraStarted = false
        val job = launch {
            presentSessionSnapshot(current = { current }, render = { receipt.await() },
                startCamera = { cameraStarted = true }, onFailure = { throw it })
        }
        yield(); current = false; receipt.complete(Unit); job.join()
        assertFalse(cameraStarted)
    }

    @Test fun duplicateSnapshotWaitsForPendingReceiptBeforeStartingCamera() = runBlocking {
        val receipt = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        var firstCurrent = true
        val first = presentSessionSnapshot(current = { firstCurrent }, render = {
            receipt.await(); order.add("hud_receipt")
        }, startCamera = { fail("Superseded snapshot started camera") }, onFailure = { throw it })
        yield(); firstCurrent = false
        val duplicate = presentSessionSnapshot(previous = first, current = { true },
            render = { /* This revision is already stored, so applyHud skips it. */ },
            startCamera = { order.add("camera_start") }, onFailure = { throw it })
        yield(); assertTrue(order.isEmpty())
        receipt.complete(Unit); duplicate.join()
        assertEquals(listOf("hud_receipt", "camera_start"), order)
    }

    @Test fun snapshotCannotOvertakeStagedDirectHudWhileItsReceiptIsPending() = runBlocking {
        val receipt = CompletableDeferred<Unit>()
        var staged = false
        var rendered = false
        var cameraStarted = false
        val directHud = presentSessionSnapshot(current = { true }, render = {
            staged = true; receipt.await(); rendered = true
        }, startCamera = {}, onFailure = { throw it })
        yield(); assertTrue(staged)
        val snapshot = presentSessionSnapshot(previous = directHud, current = { true },
            render = { if (!staged) fail("Expected the same revision to be staged") },
            startCamera = { assertTrue(rendered); cameraStarted = true }, onFailure = { throw it })
        yield(); assertFalse(cameraStarted)
        receipt.complete(Unit); snapshot.join(); assertTrue(cameraStarted)
    }

    @Test fun cancellingQueuedPresentationAlsoCancelsBlockedPredecessor() = runBlocking {
        val receipt = CompletableDeferred<Unit>()
        val directHud = presentSessionSnapshot(current = { true }, render = { receipt.await() }, startCamera = {}, onFailure = { throw it })
        yield()
        val snapshot = presentSessionSnapshot(previous = directHud, current = { true }, render = {}, startCamera = {}, onFailure = { throw it })
        snapshot.cancelAndJoin(); directHud.join()
        assertTrue(directHud.isCancelled)
    }
}
