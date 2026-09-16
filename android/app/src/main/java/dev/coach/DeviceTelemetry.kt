package dev.coach

import android.content.Context
import android.os.Build
import android.util.AtomicFile
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/** Bounded local journal survives process death and retries without duplicating server reports. */
class DeviceTelemetry(context: Context, private val scope: CoroutineScope) {
    private val file = AtomicFile(File(context.filesDir, "device-diagnostics.json"))
    private val prefs = context.getSharedPreferences("diagnostics", Context.MODE_PRIVATE)
    private val installId = prefs.getString("installId", null) ?: id().also { prefs.edit().putString("installId", it).commit() }
    private val client = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
    private val mutex = Mutex()
    private val entries = runCatching { JSONArray(file.openRead().bufferedReader().use { it.readText() }) }
        .getOrDefault(JSONArray()).let { array -> (0 until array.length()).map { array.getJSONObject(it) }.toMutableList() }
    private var storageFailed = false
    private val _status = MutableStateFlow("Diagnostics saved on phone")
    val status = _status.asStateFlow()
    var runId = id(); private set
    init { scope.launch { while (isActive) { sync(); delay(10_000) } } }
    fun newRun() { runId = id() }
    fun record(code: String, stage: String, severity: String = "info", recovery: String = "none",
               sessionId: String = "", generation: Int = 0, details: JSONObject = JSONObject()) {
        val report = json("eventId" to id(), "deviceInstallId" to installId, "runId" to runId,
            "occurredAt" to System.currentTimeMillis(), "code" to code, "stage" to stage,
            "severity" to severity, "recovery" to recovery,
            "sessionId" to sessionId.takeIf { it.isNotEmpty() }, "generation" to generation.takeIf { it > 0 },
            "details" to details.put("deviceModel", Build.MODEL.take(80)).put("androidApi", Build.VERSION.SDK_INT).put("appVersion", "0.1.1"))
        scope.launch(Dispatchers.IO) { mutex.withLock {
            entries.add(json("report" to report, "uploaded" to false))
            if (entries.size > 500) entries.removeAt(0)
            persist(); updateStatus()
        } }
    }
    private fun persist() {
        storageFailed = runCatching {
            val stream = file.startWrite()
            try { stream.write(JSONArray(entries).toString().toByteArray()); file.finishWrite(stream) }
            catch (error: Exception) { file.failWrite(stream); throw error }
        }.isFailure
    }
    private fun updateStatus() {
        if (storageFailed) { _status.value = "Diagnostics storage failed; keep the app open and save diagnostics"; return }
        val pending = entries.count { !it.optBoolean("uploaded") && !it.optBoolean("rejected") }
        val rejected = entries.count { it.optBoolean("rejected") }
        if (rejected > 0) { _status.value = "$pending waiting to sync; $rejected reports need an app/server update. Save diagnostics."; return }
        _status.value = if (pending == 0) "Diagnostics synced to computer" else "$pending diagnostics saved on phone; waiting to sync"
    }
    suspend fun sync() = withContext(Dispatchers.IO) {
        // Holding the lock also serializes automatic and manual retries.
        mutex.withLock {
            val pending = entries.filter { !it.optBoolean("uploaded") && !it.optBoolean("rejected") }.take(50)
            if (pending.isEmpty()) { updateStatus(); return@withLock }
            fun upload(batch: List<JSONObject>): Int {
                val body = json("reports" to JSONArray(batch.map { it.getJSONObject("report") }))
                return client.newCall(Request.Builder().url("http://127.0.0.1:8787/api/diagnostics")
                    .header("X-Coach-Local", "1").post(body.toString().toRequestBody("application/json".toMediaType())).build())
                    .execute().use { it.code }
            }
            runCatching {
                when (val status = upload(pending)) {
                    in 200..299 -> pending.forEach { it.put("uploaded", true) }
                    400, 413 -> pending.forEach { entry ->
                        // Keep incompatible reports for export; they must not block valid newer reports.
                        when (val single = upload(listOf(entry))) {
                            in 200..299 -> entry.put("uploaded", true)
                            400, 413 -> entry.put("rejected", true)
                            else -> error("Diagnostics upload unavailable ($single)")
                        }
                    }
                    else -> error("Diagnostics upload unavailable ($status)")
                }
            }
            persist()
            updateStatus()
        }
    }
    suspend fun export(context: Context): File = withContext(Dispatchers.IO) { mutex.withLock {
        File(context.filesDir, "coach-diagnostics.json").apply {
            writeText(json("schemaVersion" to 1, "exportedAt" to System.currentTimeMillis(), "entries" to JSONArray(entries)).toString(2))
        }
    } }
}
