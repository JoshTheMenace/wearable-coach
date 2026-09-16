package dev.coach

import java.nio.ByteBuffer
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class VideoFramesTest {
    @Test fun ownsTheBufferAndPreservesLumaAndChromaOrder() {
        val sdkBytes = byteArrayOf(99, 10, 20, 30, 40, 50, 60)
        val buffer = ByteBuffer.wrap(sdkBytes).apply { position(1) }
        val frames = VideoFrames()
        frames.receive(buffer, 2, 2, 100, 100L)
        assertEquals(1, buffer.position())
        sdkBytes.fill(0)
        assertArrayEquals(byteArrayOf(10, 20, 30, 40, 60, 50), frames.current!!.nv21)
    }

    @Test fun nextRequiresANewFrameReceivedAfterTheRequest() = runBlocking {
        val frames = VideoFrames()
        val buffer = ByteBuffer.wrap(ByteArray(6))
        frames.receive(buffer, 2, 2, 100, 100L)
        val pending = async(start = CoroutineStart.UNDISPATCHED) { frames.next(200) }
        frames.receive(buffer, 2, 2, 150, 150L)
        yield()
        assertFalse(pending.isCompleted)
        frames.receive(buffer, 2, 2, 201, 201L)
        assertEquals(201L, pending.await()!!.receivedAtMono)
        assertNull(frames.next(300, timeoutMs = 10))
    }

    @Test fun cancellationDoesNotDeliverTheCachedFrame() = runBlocking {
        val frames = VideoFrames()
        val pending = async(start = CoroutineStart.UNDISPATCHED) { frames.next(100) }
        pending.cancelAndJoin()
        assertTrue(pending.isCancelled)
    }

    @Test fun duplicateOrReorderedPresentationTimesCannotSatisfyFreshCapture() = runBlocking {
        val frames = VideoFrames()
        val buffer = ByteBuffer.wrap(ByteArray(6))
        frames.receive(buffer, 2, 2, 100, 5_000)
        val pending = async(start = CoroutineStart.UNDISPATCHED) { frames.next(200) }
        assertFalse(frames.receive(buffer, 2, 2, 201, 5_000))
        assertFalse(frames.receive(buffer, 2, 2, 202, 4_000))
        yield()
        assertFalse(pending.isCompleted)
        assertEquals(100L, frames.current!!.receivedAtMono)
        assertTrue(frames.receive(buffer, 2, 2, 203, 6_000))
        assertEquals(203L, pending.await()!!.receivedAtMono)
        // A new device session owns a new collector, so its PTS epoch starts cleanly.
        assertTrue(VideoFrames().receive(buffer, 2, 2, 300, 0))
    }

    @Test fun streamRestartClearsPtsWithoutReusingFrameSequence() = runBlocking {
        val frames = VideoFrames()
        val buffer = ByteBuffer.wrap(ByteArray(6))
        frames.receive(buffer, 2, 2, 100, 5_000)
        val pending = async(start = CoroutineStart.UNDISPATCHED) { frames.next(200) }
        frames.reset()
        assertNull(frames.current)
        assertEquals(1L, frames.receivedCount)
        assertTrue(frames.receive(buffer, 2, 2, 201, 0))
        val next = pending.await()!!
        assertEquals(2L, next.sequence)
        assertEquals(0L, next.presentationTimeUs)
        assertEquals(201L, next.receivedAtMono)
    }

    @Test fun rejectsUnknownStrideInsteadOfEncodingCorruptPixels() {
        val frames = VideoFrames()
        for (length in listOf(5, 7)) {
            assertThrows(IllegalArgumentException::class.java) { frames.receive(ByteBuffer.wrap(ByteArray(length)), 2, 2, 100, 100L) }
        }
        assertNull(frames.current)
    }
}
