package dev.coach

import kotlinx.coroutines.runBlocking
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.Socket
import java.net.URI
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

class LessonVideoTest {
    private val bytes = ByteArray(2048) { (it % 251).toByte() }
    private fun manifest(content: ByteArray = bytes) = JSONObject().put("id", UUID.randomUUID().toString())
        .put("lessonKey", "hand-placement").put("title", "Hand placement").put("width", 320).put("height", 180)
        .put("durationMs", 4000).put("mime", "video/mp4").put("bytes", content.size)
        .put("sha256", MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) })
        .put("url", "/api/sessions/session/lesson-media/clip")
    private fun response(content: ByteArray) = Response.Builder().request(Request.Builder().url("http://127.0.0.1/clip").build())
        .protocol(Protocol.HTTP_1_1).code(200).message("OK").body(content.toResponseBody()).build()

    @Test fun playerAcknowledgementsAreFencedAndCompletionRequiresPlayback() {
        val lease = DemoPlaybackLease("request", 2, 3)
        assertFalse(lease.accepts("request", 2, 3, "ended"))
        assertFalse(lease.accepts("old", 2, 3, "playing"))
        assertFalse(lease.accepts("request", 1, 3, "playing"))
        assertFalse(lease.accepts("request", 2, 2, "playing"))
        assertTrue(lease.accepts("request", 2, 3, "playing"))
        assertFalse(lease.accepts("request", 2, 3, "playing"))
        assertTrue(lease.accepts("request", 2, 3, "ended"))
        assertFalse(lease.accepts("request", 2, 3, "failed"))
        assertTrue(DemoPlaybackLease("r", 1, 1).accepts("r", 1, 1, "failed"))
    }

    @Test fun coldPlayerFailureRetriesOnceWithoutAcknowledgingPlayback() {
        val lease = DemoPlaybackLease("request", 2, 3)
        assertFalse(lease.retryStartup("request", 2, 3, "Glasses video error: OTHER_ERROR"))
        assertTrue(lease.retryStartup("request", 2, 3, "Glasses video error: PLAYBACK_FAILED"))
        assertFalse(lease.playing); assertFalse(lease.terminal)
        assertFalse(lease.accepts("request", 2, 3, "ended"))
        assertFalse(lease.retryStartup("request", 2, 3, "Glasses video error: PLAYBACK_FAILED"))
        assertTrue(lease.accepts("request", 2, 3, "playing"))
        assertTrue(lease.accepts("request", 2, 3, "ended"))
    }

    @Test fun obsoleteCallbacksCannotConsumeTheCurrentLeasesRetry() {
        val lease = DemoPlaybackLease("request", 2, 3)
        val reason = "Glasses video error: PLAYBACK_FAILED"
        assertFalse(lease.retryStartup("old", 2, 3, reason))
        assertFalse(lease.retryStartup(null, 2, 3, reason))
        assertFalse(lease.retryStartup("request", 1, 3, reason))
        assertFalse(lease.retryStartup("request", 2, 2, reason))
        assertTrue(lease.retryStartup("request", 2, 3, reason))
    }

    @Test fun playbackAndDeadlineFailureBothPreventStartupRetry() {
        val reason = "Glasses video error: PLAYBACK_FAILED"
        val playing = DemoPlaybackLease("request", 2, 3)
        assertTrue(playing.accepts("request", 2, 3, "playing"))
        assertFalse(playing.retryStartup("request", 2, 3, reason))
        assertTrue(playing.accepts("request", 2, 3, "ended"))
        assertFalse(playing.retryStartup("request", 2, 3, reason))
        val expired = DemoPlaybackLease("request", 2, 3)
        assertTrue(expired.accepts("request", 2, 3, "failed"))
        assertFalse(expired.retryStartup("request", 2, 3, reason))
    }

    @Test fun cacheVerifiesDownloadsAndReusesOnlyMatchingContent() = runBlocking {
        val directory = Files.createTempDirectory("lesson-cache").toFile()
        try {
            val cache = LessonMediaCache(directory)
            val clip = LessonClip.parse(manifest())
            var downloads = 0
            cache.prepare(clip) { downloads++; response(bytes) }
            assertTrue(cache.verified(clip))
            cache.prepare(clip) { downloads++; response(bytes) }
            assertEquals(1, downloads)
            cache.file(clip).writeBytes(ByteArray(bytes.size))
            assertFalse(cache.verified(clip))
            cache.prepare(clip) { downloads++; response(bytes) }
            assertEquals(2, downloads)
            cache.prune(emptyList())
            assertFalse(cache.file(clip).exists())
        } finally { directory.deleteRecursively() }
    }

    @Test fun corruptOrOversizedDownloadsNeverBecomePlayable() = runBlocking {
        val directory = Files.createTempDirectory("lesson-cache").toFile()
        try {
            val cache = LessonMediaCache(directory)
            val clip = LessonClip.parse(manifest())
            for (invalid in listOf(ByteArray(bytes.size), bytes + byteArrayOf(1), bytes.copyOf(50))) {
                assertTrue(runCatching { cache.prepare(clip) { response(invalid) } }.isFailure)
                assertFalse(cache.verified(clip)); assertTrue(directory.listFiles()!!.isEmpty())
            }
        } finally { directory.deleteRecursively() }
    }

    @Test fun manifestAcceptsTheFullTrainingVideoWithinTheTenMinuteLimit() {
        val clip = LessonClip.parse(manifest().put("lessonKey", "overview").put("durationMs", 534826))
        assertEquals(534826L, clip.durationMs)
        assertEquals(534826L, clip.advertisement().getLong("durationMs"))
        assertEquals(600000L, LessonClip.parse(manifest().put("durationMs", 600000)).durationMs)
    }

    @Test fun manifestRejectsUnsupportedAssetsAndUntrustedUrls() {
        for ((key, value) in listOf("width" to 500, "height" to 400, "durationMs" to 600001, "bytes" to LessonClip.MAX_BYTES + 1,
            "mime" to "image/jpeg", "url" to "https://example.com/video.mp4", "sha256" to "../file", "lessonKey" to "unknown")) {
            assertTrue("$key", runCatching { LessonClip.parse(manifest().put(key, value)) }.isFailure)
        }
        val clip = manifest()
        assertTrue(runCatching { LessonMediaCache.parse(JSONObject().put("clips", JSONArray().put(clip).put(clip))) }.isFailure)
    }

    @Test fun localServerSupportsHeadRangesAndClosesItsListener() {
        val file = File.createTempFile("lesson-video", ".mp4").apply { writeBytes(bytes) }
        val reports = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
        val server = LessonVideoServer(file) { reports.add(JSONObject(it.removePrefix("Lesson media HTTP: "))) }
        val uri = URI(server.url)
        fun request(method: String = "GET", range: String? = null, path: String = uri.path): Pair<String, ByteArray> =
            Socket(uri.host, uri.port).use { socket ->
                socket.soTimeout = 2000
                socket.getOutputStream().write("$method $path HTTP/1.1\r\nHost: localhost\r\n${range?.let { "Range: $it\r\n" }.orEmpty()}\r\n".toByteArray())
                val response = socket.getInputStream().readBytes()
                val boundary = response.toString(Charsets.ISO_8859_1).indexOf("\r\n\r\n")
                response.copyOfRange(0, boundary).toString(Charsets.US_ASCII) to response.copyOfRange(boundary + 4, response.size)
            }
        try {
            val full = request(); assertTrue(full.first.startsWith("HTTP/1.1 200")); assertArrayEquals(bytes, full.second)
            val head = request("HEAD"); assertTrue(head.first.contains("Content-Length: ${bytes.size}")); assertEquals(0, head.second.size)
            for ((range, expected) in listOf("bytes=100-131" to bytes.copyOfRange(100, 132), "bytes=-32" to bytes.takeLast(32).toByteArray(), "bytes=2000-" to bytes.copyOfRange(2000, 2048))) {
                val partial = request(range = range); assertTrue(partial.first.startsWith("HTTP/1.1 206")); assertArrayEquals(expected, partial.second)
            }
            for (range in listOf("bytes=3000-", "bytes=9-3", "bytes=0-1,8-9", "bytes=-0", "bytes=99999999999999999999-1"))
                assertTrue(request(range = range).first.startsWith("HTTP/1.1 416"))
            assertTrue(request(path = "/private.mp4").first.startsWith("HTTP/1.1 404"))
            server.close()
            assertTrue(runCatching { Socket(uri.host, uri.port).close() }.isFailure)
            val summary = reports.last { it.getString("phase") == "closed" }
            assertEquals(10, summary.getInt("requests"))
            assertEquals(2160L, summary.getLong("transferredBytes"))
            assertEquals(0, summary.getInt("incompleteRequests"))
            assertEquals(1, reports.map { it.getString("deliveryId") }.distinct().size)
            assertTrue(reports.any { it.optString("method") == "HEAD" && it.optString("phase") == "completed" && it.getLong("requestBytes") == 0L })
            assertTrue(reports.none { it.toString().contains(uri.path) })
        } finally { server.close(); file.delete() }
    }
}
