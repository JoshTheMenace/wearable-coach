package dev.coach

import kotlinx.coroutines.*
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Debug-only, loopback-only server for one selected file. Supports native-player range requests.
internal class LocalVideoServer(private val file: File, private val report: (String) -> Unit) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val clients = ConcurrentHashMap.newKeySet<Socket>()
    private val path = "/${UUID.randomUUID()}.mp4"
    val url = "http://127.0.0.1:${server.localPort}$path"

    init {
        scope.launch {
            try {
                while (isActive) {
                    val socket = server.accept()
                    clients.add(socket)
                    launch { try { serve(socket) } catch (e: Exception) { report("HTTP_ERROR ${e.message}") }
                        finally { clients.remove(socket); socket.close() } }
                }
            } catch (e: Exception) { if (isActive) report("HTTP_ACCEPT_ERROR ${e.message}") }
        }
    }

    private fun serve(socket: Socket) {
        socket.soTimeout = 5_000
        val reader = socket.getInputStream().bufferedReader()
        val request = reader.readLine()?.split(' ') ?: return
        val headers = mutableMapOf<String, String>()
        var headerBytes = 0
        while (true) {
            val line = reader.readLine() ?: return
            if (line.isEmpty()) break
            headerBytes += line.length
            require(headerBytes < 8192) { "Headers too large" }
            headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
        }
        val output = socket.getOutputStream()
        fun respond(status: String, fields: String) {
            output.write("HTTP/1.1 $status\r\nConnection: close\r\n$fields\r\n".toByteArray())
        }
        if (request.size < 2 || request[1] != path || request[0] !in listOf("GET", "HEAD")) {
            respond("404 Not Found", "Content-Length: 0\r\n"); return
        }
        val size = file.length()
        val range = headers["range"]
        val match = range?.let { Regex("bytes=(\\d*)-(\\d*)").matchEntire(it) }
        var start = 0L; var end = size - 1
        if (range != null) {
            val first = match?.groupValues?.get(1)?.toLongOrNull()
            val last = match?.groupValues?.get(2)?.toLongOrNull()
            if (first != null) { start = first; end = minOf(last ?: end, end) }
            else if (last != null && last > 0) start = maxOf(0, size - last)
            else { respond("416 Range Not Satisfiable", "Content-Range: bytes */$size\r\nContent-Length: 0\r\n"); return }
        }
        if (start > end || start >= size) {
            respond("416 Range Not Satisfiable", "Content-Range: bytes */$size\r\nContent-Length: 0\r\n"); return
        }
        report("HTTP_REQUEST method=${request[0]} range=${range ?: "full"} bytes=${end - start + 1}")
        respond(if (range == null) "200 OK" else "206 Partial Content",
            "Content-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: ${end - start + 1}\r\n" +
                if (range == null) "" else "Content-Range: bytes $start-$end/$size\r\n")
        if (request[0] == "GET") RandomAccessFile(file, "r").use { input ->
            input.seek(start)
            var remaining = end - start + 1
            val buffer = ByteArray(64 * 1024)
            while (remaining > 0) {
                val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                check(count > 0) { "Unexpected end of file" }
                output.write(buffer, 0, count); remaining -= count
            }
        }
        output.flush()
        report("HTTP_COMPLETE")
    }

    override fun close() { server.close(); clients.forEach { it.close() }; scope.cancel() }
}
