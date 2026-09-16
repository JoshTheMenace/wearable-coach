package dev.coach

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

class MainActivity : ComponentActivity() {
    private var service by mutableStateOf<CoachService?>(null)
    private var banner by mutableStateOf("")
    companion object { private var datInitialized = false }
    private var pendingStart: Settings? = null
    private var exportFile: File? = null
    private var bound = false
    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (requiredPermissions().all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) {
            initializeDat(); pendingStart?.let(::start)
        } else { banner = "Camera and microphone access are required to start. Bluetooth is required for glasses."; service?.session?.failed(SecurityException(), "permissions") }
        pendingStart = null
    }
    private val metaPermission = registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        result.onSuccess { banner = "Meta camera permission: $it" }.onFailure { error, _ -> banner = error.description }
    }
    private val exportDestination = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) runCatching { contentResolver.openOutputStream(uri)?.use { output -> exportFile?.inputStream()?.use { it.copyTo(output) } } }
            .onSuccess { banner = "Session export saved" }.onFailure { banner = it.message.orEmpty() }
    }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) { service = (binder as CoachService.LocalBinder).service }
        override fun onServiceDisconnected(name: ComponentName) { service = null; banner = "Session service disconnected" }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bound = bindService(Intent(this, CoachService::class.java), connection, Context.BIND_AUTO_CREATE)
        if (requiredPermissions().all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) initializeDat()
        setContent { CoachApp() }
    }
    private fun requiredPermissions() = listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA, Manifest.permission.BLUETOOTH_CONNECT)
    private fun initializeDat() {
        if (datInitialized) return
        Wearables.initialize(this).onSuccess { datInitialized = true }.onFailure { error, _ -> banner = "Meta initialization: ${error.description}" }
    }
    private fun start(settings: Settings) {
        if (requiredPermissions().any { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }) {
            pendingStart = settings
            permissionLauncher.launch((requiredPermissions() + if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()).toTypedArray())
            return
        }
        val current = service ?: return
        ContextCompat.startForegroundService(this, Intent(this, CoachService::class.java))
        current.startSession(settings)
    }
    override fun onDestroy() { if (bound) unbindService(connection); super.onDestroy() }

    @Composable private fun CoachApp() {
        var provider by remember { mutableStateOf("mock") }
        var model by remember { mutableStateOf("mock-coach") }
        var device by remember { mutableStateOf("mock") }
        var observer by remember { mutableStateOf("") }
        var recordFrames by remember { mutableStateOf(false) }
        var manualActivity by remember { mutableStateOf(false) }
        var activity by remember { mutableStateOf(false) }
        var text by remember { mutableStateOf("") }
        var question by remember { mutableStateOf("What is visible, and what should I notice?") }
        var hudText by remember { mutableStateOf("Ready for the next step") }
        var routes by remember { mutableStateOf(emptyList<android.media.AudioDeviceInfo>()) }
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        val session = service?.session
        val state = session?.state?.collectAsState()?.value ?: CoachState()
        val telemetryStatus = session?.telemetry?.status?.collectAsState()?.value.orEmpty()
        val active = state.status !in setOf("idle", "ended", "failed", "interrupted")
        val settings = Settings(provider, model, device, recordFrames, manualActivity, observer)
        LaunchedEffect(session) { while (true) { delay(1000); now = session?.serverNow() ?: System.currentTimeMillis() } }
        MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF76E3C1), background = Color(0xFF101921), surface = Color(0xFF192630))) {
            Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding().navigationBarsPadding()
                .verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("WEARABLE COACH", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
                Text("Your field companion", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text("${state.status.uppercase()}  ·  ${if (state.sessionId.isEmpty()) "No session" else "Generation ${state.generation}"}", color = MaterialTheme.colorScheme.primary)
                if (banner.isNotBlank()) Text(banner, color = MaterialTheme.colorScheme.tertiary)
                state.error?.let { message ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                        Column(Modifier.padding(16.dp)) {
                            Text(message)
                            TextButton({ session?.dismissError() }) { Text("Dismiss") }
                        }
                    }
                }
                if (!active) {
                    Text("Connect by USB to your computer running the coach server.", style = MaterialTheme.typography.bodySmall)
                    Text("Speaker")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("mock", "gemini", "openai").forEach { choice -> FilterChip(provider == choice, {
                            provider = choice; model = when (choice) { "gemini" -> "gemini-3.8-live"; "openai" -> "gpt-live-1"; else -> "mock-coach" }
                        }, { Text(choice) }) }
                    }
                    OutlinedTextField(model, { model = it }, label = { Text("Exact model") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    if (provider == "openai") OutlinedTextField(observer, { observer = it }, label = { Text("Observer model (blank uses server default)") }, modifier = Modifier.fillMaxWidth())
                    Text("Camera / device")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("mock", "phone", "meta_display").forEach { choice -> FilterChip(device == choice, { device = choice }, { Text(if (choice == "meta_display") "Meta" else choice) }) }
                    }
                    if (device == "meta_display") Text("Camera works with supported Meta glasses. The glasses HUD requires Meta Ray-Ban Display; ordinary Ray-Ban Meta has no screen.", style = MaterialTheme.typography.bodySmall)
                    Row { Checkbox(recordFrames, { recordFrames = it }); Text("Retain inspection images", Modifier.padding(top = 12.dp)) }
                    Row { Checkbox(manualActivity, { manualActivity = it }); Text("Manual speech boundaries (Gemini)", Modifier.padding(top = 12.dp)) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({ start(settings) }, enabled = session != null) { Text("Start session") }
                        OutlinedButton({ lifecycleScope.launch { runCatching { session?.providers(settings) }.onSuccess { session?.dismissError() }.onFailure { session?.failed(it, "bootstrap") } } }) { Text("Check access") }
                    }
                    if (state.providers.isNotEmpty()) Text(state.providers, style = MaterialTheme.typography.bodySmall)
                } else {
                    Text("${state.sessionId.take(8)}  ·  ${state.provider} / ${state.device}", style = MaterialTheme.typography.bodySmall)
                    if (state.device == "meta_display" && state.glassesDisplayAvailable == false)
                        Text("Glasses display unavailable. Coach cards appear on this phone.", style = MaterialTheme.typography.bodySmall)
                    Button({ session?.describeView() },
                        enabled = state.status == "active" && !state.liveChanging && state.inspection?.status !in setOf("reserved", "running") &&
                            (!state.liveVideo || state.lastLiveFrameAt > 0 && now - state.lastLiveFrameAt < 5000), modifier = Modifier.fillMaxWidth()) {
                        Text("Tell me what you see")
                    }
                    Text(if (state.liveVideo) "Asks Gemini about the live camera view. Works with the mic muted." else "Captures a new camera frame and asks the coach to describe it. Works with the mic muted.", style = MaterialTheme.typography.bodySmall)
                    if (state.provider == "gemini" && state.device == "meta_display") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Switch(state.liveVideo, { session?.setLiveVideo(it) }, enabled = state.status == "active" && !state.liveChanging)
                            Text("Live camera", Modifier.padding(start = 12.dp))
                        }
                        Text(if (state.liveVideo) "${state.liveMessage} · ${state.liveFrames} frames sent. ${if (state.lastLiveFrameAt > 0) "Last upload ${(now - state.lastLiveFrameAt).coerceAtLeast(0) / 1000}s ago." else ""}"
                            else state.liveMessage.ifBlank { "Continuously sends the camera view to Gemini, up to once per second." }, style = MaterialTheme.typography.bodySmall)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({ session?.mute() }) { Text(if (state.muted) "Unmute mic" else "Mute mic") }
                        Button({ session?.stopSpeech() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer)) { Text("Stop speech") }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton({ session?.retryConnection() }) { Text("Reconnect") }
                        OutlinedButton({ lifecycleScope.launch { session?.end(); service?.stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE); service?.stopSelf() } }) { Text("End session") }
                    }
                    if (state.manualActivity) Button({ activity = !activity; session?.command("activity", json("active" to activity)) }) { Text(if (activity) "Finish speaking" else "Begin speaking") }
                    OutlinedTextField(text, { text = it }, label = { Text("Message the coach") }, modifier = Modifier.fillMaxWidth())
                    Button({ if (text.isNotBlank()) { session?.command("send_text", json("text" to text)); text = "" } }) { Text("Send text") }
                    OutlinedTextField(question, { question = it }, label = { Text("Inspection question") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({ session?.command("inspect_frame", json("question" to question)) }, enabled = question.isNotBlank()) { Text("Inspect now") }
                        OutlinedButton({ lifecycleScope.launch { session?.capture(null) } }) { Text("Capture preview") }
                    }
                    state.inspection?.let { inspection ->
                        Text(inspection.label, style = MaterialTheme.typography.titleSmall)
                        Text(inspection.question, style = MaterialTheme.typography.bodySmall)
                        if (inspection.details.isNotBlank()) Text(inspection.details, style = MaterialTheme.typography.bodySmall)
                        if (inspection.status == "completed") Text("This does not confirm speech or verify an action.", style = MaterialTheme.typography.bodySmall)
                        if (inspection.canRetry) OutlinedButton({ session?.command("inspect_frame", json("question" to inspection.question)) }, enabled = state.status == "active") { Text("Retry inspection") }
                    }
                    Row { Switch(state.preview, { session?.setPreview(it) }, enabled = !state.liveVideo); Text("Sample preview ≤1 fps", Modifier.padding(12.dp)) }
                    state.frame?.let { bytes ->
                        val bitmap = remember(bytes) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                        bitmap?.let { Image(it.asImageBitmap(), "Latest captured frame", Modifier.fillMaxWidth().heightIn(max = 250.dp)) }
                    }
                    Text("Phone HUD preview", style = MaterialTheme.typography.titleLarge)
                    HudCard(state.hud, state.hudImage, now)
                    Text("This preview does not confirm pixels on glasses.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(hudText, { hudText = it.take(240) }, label = { Text("Manual HUD card") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({ session?.command("set_hud", json("hud" to json("card" to json("title" to "Coach", "body" to hudText)))) }) { Text("Set HUD") }
                        OutlinedButton({ session?.clearHud() }) { Text("Clear HUD") }
                    }
                    Text("Audio route: ${state.route}", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton({ routes = session?.routes().orEmpty() }) { Text("Choose audio route") }
                    routes.forEach { route -> OutlinedButton({ session?.route(route.id); routes = emptyList() }) { Text("${route.productName} · type ${route.type}") } }
                    Text("Captions", style = MaterialTheme.typography.titleLarge)
                    state.captions.takeLast(12).forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
                HorizontalDivider()
                Text("Hardware setup", style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton({
                        if (!datInitialized) { permissionLauncher.launch(requiredPermissions().toTypedArray()); banner = "Grant permissions, then tap Register Meta again" }
                        else runCatching { Wearables.startRegistration(this@MainActivity) }.onFailure { banner = it.message.orEmpty() }
                    }) { Text("Register Meta") }
                    OutlinedButton({ if (datInitialized) metaPermission.launch(Permission.CAMERA) else banner = "Register Meta first" }) { Text("Meta camera access") }
                }
                OutlinedButton({ runCatching { Wearables.openFirmwareUpdate(this@MainActivity) }.onFailure { banner = it.message.orEmpty() } }) { Text("Glasses firmware update") }
                OutlinedButton({ runCatching { Wearables.openDATGlassesAppUpdate(this@MainActivity) }.onFailure { banner = it.message.orEmpty() } }) { Text("Glasses DAT app update") }
                if (state.sessionId.isNotEmpty()) {
                    OutlinedButton({ lifecycleScope.launch {
                        runCatching { session?.export() }.onSuccess { file -> exportFile = file; exportDestination.launch(file?.name ?: "session.json") }.onFailure { banner = it.message.orEmpty() }
                    } }) { Text("Export session evidence") }
                    OutlinedButton({
                        val clipboard = getSystemService(ClipboardManager::class.java)
                        clipboard.setPrimaryClip(ClipData.newPlainText("Spectator token", state.spectatorToken))
                        banner = "Read-only spectator token copied. Paste it into the spectator app."
                    }) { Text("Copy spectator token") }
                }
                Text("Diagnostics", style = MaterialTheme.typography.titleMedium)
                Text(telemetryStatus, style = MaterialTheme.typography.bodySmall)
                Text("Test ${session?.telemetry?.runId?.take(8).orEmpty()} · ${state.sessionId.take(8)}", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton({ lifecycleScope.launch { session?.telemetry?.sync() } }) { Text("Sync diagnostics") }
                    OutlinedButton({ lifecycleScope.launch {
                        runCatching { session?.exportDiagnostics() }.onSuccess { file -> exportFile = file; exportDestination.launch("coach-diagnostics.json") }
                            .onFailure { session?.failed(it, "storage") }
                    } }) { Text("Save diagnostics") }
                }
                state.diagnostics.takeLast(15).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                Spacer(Modifier.height(24.dp))
            }
            }
        }
    }
}

@Composable private fun HudCard(encoded: String, imageBytes: ByteArray?, now: Long) {
    val hud = remember(encoded) { runCatching { JSONObject(encoded) }.getOrDefault(JSONObject()) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            imageBytes?.let { bytes ->
                val bitmap = remember(bytes) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                bitmap?.let { Image(it.asImageBitmap(), "HUD image", Modifier.fillMaxWidth().heightIn(max = 200.dp)) }
            }
            if (hud.has("imageAssetId") && imageBytes == null) Text("HUD image unavailable", color = MaterialTheme.colorScheme.error)
            if (hud.length() == 0) Text("Display clear", color = MaterialTheme.colorScheme.outline)
            hud.optJSONObject("card")?.let {
                if (it.optString("title").isNotEmpty()) Text(it.optString("title"), style = MaterialTheme.typography.titleLarge)
                Text(it.optString("body"))
            }
            hud.optJSONArray("checklist")?.let { rows -> for (i in 0 until rows.length()) rows.getJSONObject(i).let {
                Text("${if (it.optBoolean("checked")) "✓" else "○"} ${it.optString("text")}")
            } }
            hud.optJSONObject("timer")?.let {
                val seconds = ((it.optLong("startedAt") + it.optLong("durationMs") - now) / 1000).coerceAtLeast(0)
                Text("${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}", style = MaterialTheme.typography.headlineLarge)
            }
        }
    }
}
