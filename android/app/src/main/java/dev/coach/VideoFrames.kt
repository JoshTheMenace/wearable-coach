package dev.coach

import java.nio.ByteBuffer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

internal data class ReceivedVideoFrame(val sequence: Long, val receivedAtMono: Long,
    val width: Int, val height: Int, val nv21: ByteArray, val presentationTimeUs: Long)

// DAT 0.9 requests COLOR_FormatYUV420Planar (I420). Own the bytes before returning
// to the SDK; keep only the latest frame and interleave V/U for Android's JPEG encoder.
internal class VideoFrames {
    private val latest = MutableStateFlow<ReceivedVideoFrame?>(null)
    var receivedCount = 0L; private set
    val current get() = latest.value

    fun reset() { latest.value = null }

    fun receive(buffer: ByteBuffer, width: Int, height: Int, receivedAtMono: Long, presentationTimeUs: Long): Boolean {
        // PTS orders frames only; its clock is not a sensor capture timestamp.
        if (current?.let { presentationTimeUs <= it.presentationTimeUs } == true) return false
        require(width in 2..4096 && height in 2..4096 && width % 2 == 0 && height % 2 == 0)
        val pixels = width * height
        val source = buffer.duplicate()
        require(source.remaining() == pixels * 3 / 2) { "Unsupported decoded video layout" }
        val owned = ByteArray(source.remaining())
        source.get(owned, 0, pixels)
        val u = source.position()
        val v = u + pixels / 4
        for (i in 0 until pixels / 4) {
            owned[pixels + i * 2] = source.get(v + i)
            owned[pixels + i * 2 + 1] = source.get(u + i)
        }
        latest.value = ReceivedVideoFrame(++receivedCount, receivedAtMono, width, height, owned, presentationTimeUs)
        return true
    }

    suspend fun next(requestedAtMono: Long, timeoutMs: Long = 4_000): ReceivedVideoFrame? {
        val afterSequence = receivedCount
        return withTimeoutOrNull(timeoutMs) {
            latest.first { it != null && it.sequence > afterSequence && it.receivedAtMono > requestedAtMono }
        }
    }
}
