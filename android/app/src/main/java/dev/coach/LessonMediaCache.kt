package dev.coach

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID

internal data class LessonClip(val id: String, val lessonKey: String, val title: String, val width: Int,
    val height: Int, val durationMs: Long, val sha256: String, val bytes: Long, val url: String) {
    fun advertisement() = json("id" to id, "lessonKey" to lessonKey, "width" to width, "height" to height,
        "durationMs" to durationMs, "mime" to "video/mp4")
    companion object {
        const val MAX_BYTES = 20L * 1024 * 1024
        fun parse(value: JSONObject): LessonClip {
            val clip = LessonClip(value.getString("id"), value.getString("lessonKey"), value.getString("title").take(120),
                value.getInt("width"), value.getInt("height"), value.getLong("durationMs"), value.getString("sha256"),
                value.getLong("bytes"), value.getString("url"))
            require(UUID.fromString(clip.id).toString() == clip.id && clip.lessonKey in setOf("overview", "hand-placement"))
            require(value.getString("mime") == "video/mp4" && clip.width in 1..400 && clip.height in 1..400 && clip.width * clip.height <= 70000)
            require(clip.durationMs in 100..300000 && clip.bytes in 1..MAX_BYTES && Regex("[a-f0-9]{64}").matches(clip.sha256))
            require(clip.url.startsWith("/api/sessions/") && !clip.url.contains('\\') && !clip.url.contains('#'))
            return clip
        }
    }
}

internal class LessonMediaCache(private val directory: File) {
    fun file(clip: LessonClip) = File(directory, "${clip.sha256}.mp4")
    fun verified(clip: LessonClip): Boolean {
        val file = file(clip)
        return file.isFile && file.length() == clip.bytes && file.inputStream().use { input ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
            digest.digest().joinToString("") { "%02x".format(it) } == clip.sha256
        }
    }
    suspend fun prepare(clip: LessonClip, fetch: suspend (String) -> Response) {
        directory.mkdirs()
        if (verified(clip)) return
        val temporary = File.createTempFile("download-", ".part", directory)
        try {
            fetch(clip.url).use { response ->
                check(response.isSuccessful) { "Lesson clip download failed (${response.code})" }
                val body = checkNotNull(response.body)
                require(body.contentLength() == -1L || body.contentLength() == clip.bytes) { "Lesson clip size changed" }
                body.byteStream().use { input -> temporary.outputStream().use { output ->
                    var count = 0L
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val n = input.read(buffer)
                        if (n < 0) break
                        count += n; check(count <= clip.bytes) { "Lesson clip exceeds expected size" }
                        output.write(buffer, 0, n)
                    }
                    check(count == clip.bytes) { "Incomplete lesson clip" }
                } }
            }
            val digest = MessageDigest.getInstance("SHA-256")
            temporary.inputStream().use { input -> val buffer = ByteArray(64 * 1024)
                while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
            check(digest.digest().joinToString("") { "%02x".format(it) } == clip.sha256) { "Lesson clip checksum mismatch" }
            check(temporary.renameTo(file(clip))) { "Could not cache lesson clip" }
        } finally { temporary.delete() }
    }
    fun prune(clips: Collection<LessonClip>) {
        val keep = clips.map { file(it).name }.toSet()
        directory.listFiles()?.filter { it.name !in keep }?.forEach { it.delete() }
    }
    companion object {
        fun parse(manifest: JSONObject): List<LessonClip> {
            val values = manifest.optJSONArray("clips") ?: JSONArray()
            require(values.length() <= 2) { "Too many lesson clips" }
            return (0 until values.length()).map { LessonClip.parse(values.getJSONObject(it)) }.also { clips ->
                require(clips.map { it.id }.distinct().size == clips.size && clips.map { it.lessonKey }.distinct().size == clips.size)
            }
        }
    }
}
