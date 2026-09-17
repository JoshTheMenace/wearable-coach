package dev.coach

import kotlinx.coroutines.*
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

// One cached asset per player, reachable only from this phone. No bearer token enters the URL.
internal class LessonVideoServer(private val file: File, private val report: (String) -> Unit = {}) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val clients = ConcurrentHashMap.newKeySet<Socket>()
    private val requests = AtomicInteger()
    private val transferredBytes = AtomicLong()
    private val failures = AtomicInteger()
    private val deliveryId = UUID.randomUUID().toString()
    private val startedAt = System.nanoTime()
    private val path = "/$deliveryId.mp4"
    val url = "http://127.0.0.1:${server.localPort}$path"

    init {
        require(file.isFile && file.length() > 0)
        event("opened")
        scope.launch {
            try {
                while (isActive) {
                    val socket = server.accept()
                    if (clients.size >= 8) { socket.close(); continue }
                    clients.add(socket)
                    launch { try { serve(socket) } catch (error: Exception) {
                        failures.incrementAndGet(); event("incomplete", "errorClass" to error.javaClass.simpleName)
                    } }
                        .invokeOnCompletion { clients.remove(socket); runCatching { socket.close() } }
                }
            } catch (_: Exception) { /* Closing the listener unblocks accept. */ }
        }
    }

    private fun event(phase: String, vararg details: Pair<String, Any>) {
        val value = JSONObject().put("deliveryId", deliveryId).put("phase", phase).put("measurementBasis", "phone_loopback_http")
            .put("elapsedMs", (System.nanoTime() - startedAt) / 1_000_000).put("fileBytes", file.length())
            .put("requests", requests.get()).put("transferredBytes", transferredBytes.get()).put("incompleteRequests", failures.get())
        details.forEach { (key, item) -> value.put(key, item) }
        report("Lesson media HTTP: $value")
    }

    private fun serve(socket: Socket) {
        socket.soTimeout = 5_000
        val input = socket.getInputStream().buffered()
        var headerBytes = 0
        fun line(): String = buildString {
            while (true) {
                val byte = input.read()
                check(byte >= 0 && ++headerBytes <= 8192) { "Incomplete or oversized headers" }
                if (byte == 10) break
                if (byte != 13) append(byte.toChar())
            }
        }
        val request = line().split(' ')
        val headers = mutableMapOf<String, String>()
        while (true) {
            val header = line()
            if (header.isEmpty()) break
            headers[header.substringBefore(':').lowercase()] = header.substringAfter(':').trim()
        }
        val output = socket.getOutputStream()
        fun respond(status: String, fields: String) {
            output.write("HTTP/1.1 $status\r\nConnection: close\r\n$fields\r\n".toByteArray())
        }
        if (request.size != 3 || request[1] != path || request[0] !in listOf("GET", "HEAD")) {
            respond("404 Not Found", "Content-Length: 0\r\n"); return
        }
        requests.incrementAndGet()
        val size = file.length()
        val range = headers["range"]
        val match = range?.let { Regex("bytes=(\\d*)-(\\d*)").matchEntire(it) }
        var start = 0L; var end = size - 1
        if (range != null) {
            val first = match?.groupValues?.get(1)?.toLongOrNull()
            val last = match?.groupValues?.get(2)?.toLongOrNull()
            if (match == null || match.groupValues[1].isNotEmpty() && first == null || match.groupValues[2].isNotEmpty() && last == null) {
                respond("416 Range Not Satisfiable", "Content-Range: bytes */$size\r\nContent-Length: 0\r\n"); return
            }
            if (first != null) { start = first; end = minOf(last ?: end, end) }
            else if (last != null && last > 0) start = maxOf(0, size - last)
            else { respond("416 Range Not Satisfiable", "Content-Range: bytes */$size\r\nContent-Length: 0\r\n"); return }
        }
        if (start > end || start >= size) {
            respond("416 Range Not Satisfiable", "Content-Range: bytes */$size\r\nContent-Length: 0\r\n"); return
        }
        val requestStarted = System.nanoTime()
        event("request", "method" to request[0], "rangeStart" to start, "rangeEnd" to end)
        respond(if (range == null) "200 OK" else "206 Partial Content",
            "Content-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: ${end - start + 1}\r\n" +
                if (range == null) "" else "Content-Range: bytes $start-$end/$size\r\n")
        if (request[0] == "GET") RandomAccessFile(file, "r").use { source ->
            source.seek(start)
            var remaining = end - start + 1
            val buffer = ByteArray(64 * 1024)
            while (remaining > 0) {
                val count = source.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                check(count > 0) { "Unexpected end of file" }
                output.write(buffer, 0, count); remaining -= count; transferredBytes.addAndGet(count.toLong())
            }
        }
        output.flush()
        event("completed", "method" to request[0], "requestBytes" to if (request[0] == "GET") end - start + 1 else 0L,
            "durationMs" to (System.nanoTime() - requestStarted) / 1_000_000)
    }

    override fun close() {
        if (server.isClosed) return
        runCatching { server.close() }
        clients.forEach { runCatching { it.close() } }
        scope.cancel()
        event("closed")
    }
}
