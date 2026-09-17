package dev.coach

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
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
        var provider by remember { mutableStateOf("gemini") }
        var model by remember { mutableStateOf("gemini-3.8-live") }
        var device by remember { mutableStateOf("meta_display") }
        var observer by remember { mutableStateOf("") }
        var cprLesson by remember { mutableStateOf(true) }
        var scriptedDemo by remember { mutableStateOf(false) }
        var presentationVideo by remember { mutableStateOf(true) }
        var recordFrames by remember { mutableStateOf(false) }
        var manualActivity by remember { mutableStateOf(false) }
        var activity by remember { mutableStateOf(false) }
        var text by remember { mutableStateOf("") }
        var question by remember { mutableStateOf("What is visible, and what should I notice?") }
        var hudText by remember { mutableStateOf("Ready for the next step") }
        var routes by remember { mutableStateOf(emptyList<android.media.AudioDeviceInfo>()) }
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        var checkingServer by remember { mutableStateOf(false) }
        val session = service?.session
        val state = session?.state?.collectAsState()?.value ?: CoachState()
        val telemetryStatus = session?.telemetry?.status?.collectAsState()?.value.orEmpty()
        val active = state.status !in setOf("idle", "ended", "failed", "interrupted")
        val ready = state.status == "active"
        val settings = Settings(provider, model, device, recordFrames, manualActivity && !cprLesson, observer, cprLesson, if (cprLesson && scriptedDemo) "scripted_demo" else "live", presentationVideo)
        val providerAccess = remember(state.providers, provider) {
            val providers = runCatching { JSONObject(state.providers).getJSONArray("providers") }.getOrNull()
            (0 until (providers?.length() ?: 0)).map { providers!!.getJSONObject(it) }.firstOrNull { it.optString("id") == provider }
        }
        val lessonSupported = !cprLesson || provider == "gemini" && device == "meta_display"
        LaunchedEffect(session, provider, active) {
            if (session != null && !active) {
                checkingServer = true
                try { session.providers(settings, clearError = state.status !in CoachSession.terminalStates) } catch (error: Exception) { session.failed(error, "bootstrap") }
                finally { checkingServer = false }
            }
        }
        DisposableEffect(active) {
            if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            onDispose { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        }
        LaunchedEffect(session) { while (true) { delay(1000); now = session?.serverNow() ?: System.currentTimeMillis() } }
        MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF76E3C1), background = Color(0xFF101921), surface = Color(0xFF192630))) {
            Surface(Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        if (!active) Image(painterResource(R.drawable.marine_seal), "United States Marine Corps emblem", Modifier.size(112.dp).align(Alignment.CenterHorizontally))
                        Text("MARINE TUTOR", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
                        Text(if (state.lesson.isNotEmpty()) "CPR practice" else "Learn. Practise. Improve.", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                        Text(when {
                            ready && state.device == "meta_display" -> when (state.glassesDisplayAvailable) {
                                true -> "Coach connected · glasses display available"
                                false -> "Coach connected · glasses display unavailable"
                                null -> "Coach connected · checking glasses display…"
                            }
                            ready -> "Coach connected · ${state.device}"
                            active -> if (state.status == "starting" && state.liveMessage.isNotBlank()) state.liveMessage else "Connecting your coach and glasses…"
                            else -> "Start here, then learn and practice in your glasses."
                        }, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
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
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Text("Your coach is ready", style = MaterialTheme.typography.titleLarge)
                                    Text("Start your coach, then tell it what you want to learn. For today’s practice, ask: “Pull up CPR training.”")
                                    Text("Wear and wake the glasses. Keep this phone connected by USB to the Mac running the coach server; it keeps the session connected while you practice.", style = MaterialTheme.typography.bodySmall)
                                    Button({ start(settings) }, enabled = session != null && !checkingServer && providerAccess?.optBoolean("available") == true && lessonSupported, modifier = Modifier.fillMaxWidth()) {
                                        Text(if (cprLesson) "Start coach" else "Start session")
                                    }
                                    if (cprLesson) {
                                        Text("Learn through your glasses", style = MaterialTheme.typography.titleSmall)
                                        Text("Ask questions, review a demonstration, and practise with live coaching.", style = MaterialTheme.typography.bodyMedium)
                                        Text("During videos, the microphone pauses. Tap Next here to skip ahead; voice resumes afterward.", style = MaterialTheme.typography.bodySmall)
                                    }
                                    Text(when {
                                        checkingServer -> "Checking local server…"
                                        providerAccess?.optBoolean("available") == true -> "Local server ready · ${if (provider == "gemini") "Gemini Live" else provider} configured"
                                        providerAccess != null -> providerAccess.optString("reason")
                                        else -> "Local server unavailable. Check the USB connection and retry below."
                                    }, style = MaterialTheme.typography.bodySmall)
                                    if (!lessonSupported) Text("For the glasses tutor, select Gemini and Meta glasses in Session settings.", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
                                    if (!checkingServer && providerAccess?.optBoolean("available") != true) TextButton({ lifecycleScope.launch {
                                        checkingServer = true
                                        try { session?.providers(settings) } catch (error: Exception) { session?.failed(error, "bootstrap") }
                                        finally { checkingServer = false }
                                    } }) { Text("Retry connection") }
                                }
                            }
                            DetailSection("Session settings") {
                                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(presentationVideo, { presentationVideo = it }); Text("Play videos on laptop / TV; keep glasses camera live") }
                                if (cprLesson) {
                                    Text("Practice mode", style = MaterialTheme.typography.titleSmall)
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        FilterChip(!scriptedDemo, { scriptedDemo = false }, label = { Text("Live practice") })
                                        FilterChip(scriptedDemo, { scriptedDemo = true }, label = { Text("Scripted demo") })
                                    }
                                    Text(if (scriptedDemo) "Selected: Scripted demo. Planned corrections; no visual assessment." else "Selected: Live practice. Camera checks hand placement.", style = MaterialTheme.typography.bodySmall)
                                }
                                Text("Coach provider", style = MaterialTheme.typography.titleSmall)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    listOf("gemini", "mock", "openai").forEach { choice -> FilterChip(provider == choice, {
                                        provider = choice; model = when (choice) { "gemini" -> "gemini-3.8-live"; "openai" -> "gpt-live-1"; else -> "mock-coach" }
                                    }, { Text(choice) }) }
                                }
                                Text("Camera / device", style = MaterialTheme.typography.titleSmall)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    listOf("meta_display", "phone", "mock").forEach { choice -> FilterChip(device == choice, { device = choice }, { Text(if (choice == "meta_display") "Meta glasses" else choice) }) }
                                }
                                Text("The glasses screen requires Meta Ray-Ban Display. Continuous CPR camera feedback uses Gemini with Meta glasses.", style = MaterialTheme.typography.bodySmall)
                                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(cprLesson, { cprLesson = it }); Text("Marine tutor · voice-start lessons") }
                                OutlinedTextField(model, { model = it }, label = { Text("Exact model") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                if (provider == "openai") OutlinedTextField(observer, { observer = it }, label = { Text("Observer model (server default if blank)") }, modifier = Modifier.fillMaxWidth())
                                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(recordFrames, { recordFrames = it }); Text("Retain inspection images") }
                                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(manualActivity && !cprLesson, { manualActivity = it }, enabled = !cprLesson); Text("Manual speech boundaries (general sessions)") }
                                OutlinedButton({ lifecycleScope.launch { runCatching { session?.providers(settings) }.onSuccess { session?.dismissError() }.onFailure { session?.failed(it, "bootstrap") } } }) { Text("Check server access") }
                            }
                        } else {
                            DetailSection("Session settings") {
                                Text(if (state.practiceMode == "scripted_demo") "Scripted demo · planned corrections; no visual assessment." else "Live practice · camera checks hand placement.", style = MaterialTheme.typography.bodySmall)
                                Text("Start a new session to change the practice mode.", style = MaterialTheme.typography.bodySmall)
                            }
                            if (state.device == "meta_display" && state.glassesDisplayAvailable == false)
                                Text("The coach is connected, but glasses cards and video are not available yet. Wake and connect the glasses; Hardware setup below has connection tools.", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
                            if (state.lesson.isNotEmpty()) {
                                if (state.muted && state.demonstration.isEmpty()) Text("Mic muted. Unmute to control the lesson by voice.", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
                                LessonControls(state, session, now)
                            }
                            else if (runCatching { JSONObject(state.hud).optString("brand") == "marines" }.getOrDefault(false)) {
                                Card(Modifier.fillMaxWidth()) {
                                    Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                        Image(painterResource(R.drawable.marine_seal), "United States Marine Corps emblem", Modifier.size(160.dp))
                                        Text("What would you like to learn?", style = MaterialTheme.typography.titleLarge)
                                        Text("Your coach is listening through the glasses.", style = MaterialTheme.typography.bodyMedium)
                                    }
                                }
                            } else {
                                Button({ session?.describeView() },
                                    enabled = ready && state.demonstration.isEmpty() && !state.liveChanging && state.inspection?.status !in setOf("reserved", "running") &&
                                        (!state.liveVideo || state.lastLiveFrameAt > 0 && now - state.lastLiveFrameAt < 5000), modifier = Modifier.fillMaxWidth()) {
                                    Text("Tell me what you see")
                                }
                                Text("Ask about the camera view, even with the mic muted.", style = MaterialTheme.typography.bodySmall)
                                DetailSection("CPR lesson") { LessonControls(state, session, now) }
                            }
                            if (state.provider == "gemini" && state.device == "meta_display" && state.practiceMode != "scripted_demo") {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Switch(state.liveVideo, { session?.setLiveVideo(it) }, enabled = ready && state.demonstration.isEmpty() && !state.liveChanging)
                                    Column(Modifier.padding(start = 12.dp)) {
                                        Text("Live camera", style = MaterialTheme.typography.titleSmall)
                                        Text(when {
                                            state.demonstration.isNotEmpty() -> "Uploads pause during video playback"
                                            state.liveChanging -> "Updating camera…"
                                            state.liveVideo && state.lastLiveFrameAt > 0 && now - state.lastLiveFrameAt < 5000 -> "Sending fresh frames for coaching"
                                            state.liveVideo -> "Waiting for a fresh camera frame"
                                            else -> "Camera feedback is off"
                                        }, style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                            }
                            if (state.manualActivity) Button({ activity = !activity; session?.command("activity", json("active" to activity)) }, enabled = ready && state.demonstration.isEmpty()) { Text(if (activity) "Finish speaking" else "Begin speaking") }
                            DetailSection("Type to your coach") {
                                OutlinedTextField(text, { text = it }, label = { Text("Message the coach") }, modifier = Modifier.fillMaxWidth())
                                Button({ session?.command("send_text", json("text" to text)); text = "" }, enabled = ready && text.isNotBlank() && state.demonstration.isEmpty()) { Text("Send message") }
                            }
                            DetailSection("Audio · ${state.route}") {
                                Text("Coach speech follows the selected audio route.", style = MaterialTheme.typography.bodySmall)
                                OutlinedButton({ routes = session?.routes().orEmpty() }) { Text("Choose audio route") }
                                routes.forEach { route -> OutlinedButton({ session?.route(route.id); routes = emptyList() }) { Text("${route.productName} · type ${route.type}") } }
                                OutlinedButton({ session?.stopSpeech() }, enabled = ready) { Text("Stop coach speech") }
                            }
                            DetailSection("Captions") {
                                if (state.captions.isEmpty()) Text("Your conversation will appear here.", style = MaterialTheme.typography.bodySmall)
                                state.captions.takeLast(12).forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            }
                            DetailSection("Glasses display preview") {
                                HudCard(state.hud, state.hudImage, now)
                                Text("This is the requested card; it does not confirm what is visible in the glasses.", style = MaterialTheme.typography.bodySmall)
                            }
                            DetailSection("Camera and display tools") {
                                if (state.lesson.isEmpty()) {
                                    OutlinedTextField(question, { question = it }, label = { Text("Inspection question") }, modifier = Modifier.fillMaxWidth())
                                    Button({ session?.command("inspect_frame", json("question" to question)) }, enabled = ready && question.isNotBlank() && state.demonstration.isEmpty()) { Text("Inspect now") }
                                    OutlinedButton({ lifecycleScope.launch { session?.capture(null) } }, enabled = ready && state.demonstration.isEmpty()) { Text("Capture preview") }
                                    state.inspection?.let { inspection ->
                                        Text(inspection.label, style = MaterialTheme.typography.titleSmall)
                                        Text(inspection.question, style = MaterialTheme.typography.bodySmall)
                                        if (inspection.details.isNotBlank()) Text(inspection.details, style = MaterialTheme.typography.bodySmall)
                                        if (inspection.status == "completed") Text("This does not confirm speech or verify an action.", style = MaterialTheme.typography.bodySmall)
                                        if (inspection.canRetry) OutlinedButton({ session?.command("inspect_frame", json("question" to inspection.question)) }, enabled = ready) { Text("Retry inspection") }
                                    }
                                }
                                if (cprLesson && device == "meta_display") Text("Camera preview streams to the laptop between lesson videos.")
                                else Row(verticalAlignment = Alignment.CenterVertically) { Switch(state.preview, { session?.setPreview(it) }, enabled = ready && !state.liveVideo && state.demonstration.isEmpty()); Text("Sample preview ≤1 fps", Modifier.padding(start = 12.dp)) }
                                state.frame?.let { bytes ->
                                    val bitmap = remember(bytes) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                                    bitmap?.let { Image(it.asImageBitmap(), "Latest captured frame", Modifier.fillMaxWidth().heightIn(max = 250.dp)) }
                                }
                                Text("${state.liveMessage} · ${state.liveFrames} frames sent", style = MaterialTheme.typography.bodySmall)
                                if (state.lesson.isEmpty()) {
                                    OutlinedTextField(hudText, { hudText = it.take(240) }, label = { Text("Manual HUD card") }, modifier = Modifier.fillMaxWidth())
                                    Button({ session?.command("set_hud", json("hud" to json("card" to json("title" to "Coach", "body" to hudText)))) }, enabled = ready) { Text("Set HUD") }
                                    OutlinedButton({ session?.clearHud() }, enabled = ready) { Text("Clear HUD") }
                                }
                            }
                        }
                        DetailSection("Hardware setup") {
                            Text("Use these if the glasses have not been registered or connected.", style = MaterialTheme.typography.bodySmall)
                            OutlinedButton({
                                if (!datInitialized) { permissionLauncher.launch(requiredPermissions().toTypedArray()); banner = "Grant permissions, then tap Register Meta again" }
                                else runCatching { Wearables.startRegistration(this@MainActivity) }.onFailure { banner = it.message.orEmpty() }
                            }) { Text("Register Meta glasses") }
                            OutlinedButton({ if (datInitialized) metaPermission.launch(Permission.CAMERA) else banner = "Register Meta first" }) { Text("Allow Meta camera access") }
                            OutlinedButton({ runCatching { Wearables.openFirmwareUpdate(this@MainActivity) }.onFailure { banner = it.message.orEmpty() } }) { Text("Glasses firmware update") }
                            OutlinedButton({ runCatching { Wearables.openDATGlassesAppUpdate(this@MainActivity) }.onFailure { banner = it.message.orEmpty() } }) { Text("Glasses DAT app update") }
                        }
                        DetailSection("Diagnostics and session evidence") {
                            Text("${state.status} · ${state.provider} / ${state.device} · Generation ${state.generation}", style = MaterialTheme.typography.bodySmall)
                            Text(telemetryStatus, style = MaterialTheme.typography.bodySmall)
                            if (state.providers.isNotEmpty()) Text(state.providers, style = MaterialTheme.typography.bodySmall)
                            Text("Test ${session?.telemetry?.runId?.take(8).orEmpty()} · ${state.sessionId.take(8)}", style = MaterialTheme.typography.bodySmall)
                            if (active) OutlinedButton({ session?.retryConnection() }) { Text("Reconnect session") }
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
                            OutlinedButton({ lifecycleScope.launch { session?.telemetry?.sync(retryRejected = true) } }) { Text("Sync diagnostics") }
                            OutlinedButton({ lifecycleScope.launch {
                                runCatching { session?.exportDiagnostics() }.onSuccess { file -> exportFile = file; exportDestination.launch("coach-diagnostics.json") }
                                    .onFailure { session?.failed(it, "storage") }
                            } }) { Text("Save diagnostics") }
                            state.diagnostics.takeLast(15).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                    if (active) {
                        HorizontalDivider()
                        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Button({ session?.mute() }, enabled = ready && state.demonstration.isEmpty(), modifier = Modifier.weight(1f)) {
                                Text(if (state.muted) "Unmute mic" else "Mute mic")
                            }
                            OutlinedButton({ lifecycleScope.launch { session?.end(); service?.stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE); service?.stopSelf() } }, modifier = Modifier.weight(1f)) { Text("End session") }
                        }
                    }
                }
            }
        }
    }

}

@Composable private fun DetailSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton({ expanded = !expanded }, modifier = Modifier.fillMaxWidth()) {
            Text(title, modifier = Modifier.weight(1f))
            Text(if (expanded) "−" else "+")
        }
        if (expanded) Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable private fun LessonPageContent(page: JSONObject) {
    val compact = page.optString("template") == "practice"
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(page.optString("chapter"), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
        Text(page.optString("title"), style = if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(page.optString("body"), style = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge)
        page.optJSONObject("support")?.let { support ->
            HorizontalDivider()
            support.optString("title").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            Text(support.optString("body"), style = MaterialTheme.typography.bodyMedium)
        }
        Text(page.optString("hint"), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall)
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
            hud.optJSONObject("lessonPage")?.let { LessonPageContent(it) }
            if (!hud.has("lessonPage")) {
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
}

@Composable private fun LessonControls(state: CoachState, session: CoachSession?, now: Long) {
    val lesson = remember(state.lesson) { runCatching { JSONObject(state.lesson) }.getOrNull() }
    val page = remember(state.hud) { runCatching { JSONObject(state.hud).optJSONObject("lessonPage") }.getOrNull() }
    val demonstration = remember(state.demonstration) { runCatching { JSONObject(state.demonstration) }.getOrNull() }
    val intro = remember(state.lessonIntro) { runCatching { JSONObject(state.lessonIntro) }.getOrNull() }
    val uriHandler = LocalUriHandler.current
    val phase = lesson?.optString("phase").orEmpty()
    val teachingPage = lesson?.optString("teachingPage", "opening").orEmpty()
    val paused = lesson?.optString("status") == "paused"
    val ready = state.status == "active"
    val practice = phase in setOf("placement", "practice")
    val scripted = lesson?.has("scriptedStage") == true
    val observation = lesson?.optJSONObject("lastObservation")
    val observationAt = observation?.optLong("at")
    val stale = observationAt != null && now - observationAt !in 0..5000
    val movieActive = demonstration != null && demonstration.optString("status") != "cueing"
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (lesson == null) {
                Text("Adult CPR · manikin practice", style = MaterialTheme.typography.titleLarge)
                Button({ session?.lessonAction("start") }, enabled = ready) { Text("Start CPR lesson") }
            } else {
                if (movieActive) {
                    Text(if (demonstration?.optString("status") != "playing") "Preparing your video…" else if (demonstration.optString("target") == "presentation") "Video playing on laptop / TV" else "Video playing on glasses", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleLarge)
                } else if (page != null) LessonPageContent(page)
                else Text("Waiting for the current lesson page…", style = MaterialTheme.typography.bodyMedium)
                if (demonstration != null) {
                    Text("Microphone paused during video. It resumes automatically afterward.", style = MaterialTheme.typography.bodyMedium)
                    Button({ session?.lessonAction("skip_demo") }, enabled = ready, modifier = Modifier.fillMaxWidth()) { Text("Next") }
                }
                if (practice && demonstration == null && !scripted) {
                    DetailSection("Observation evidence") {
                        Text(when {
                            paused -> "Practice checks paused; the coach keeps listening."
                            !lesson.optBoolean("ready") -> "Waiting for you to say Ready."
                            lesson.optBoolean("needsPlacementCheck") -> "Fresh hand-placement evidence is needed."
                            stale -> "The previous observation is no longer current."
                            else -> observation?.optString("reason")?.ifBlank { "Waiting for a clear camera view." } ?: "Waiting for a clear camera view."
                        }, style = MaterialTheme.typography.bodySmall)
                        val completed = lesson.optJSONArray("completed")
                        if ((0 until (completed?.length() ?: 0)).any { index -> completed!!.getJSONObject(index).let { it.optString("step") == "placement" && it.optString("evidence") == "learner_confirmed" } })
                            Text("Placement not verified · you chose to continue", color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
                        observation?.let {
                            Text(when (it.optString("cameraSource")) { "recorded_video" -> "Recorded simulation"; "mock" -> "Synthetic simulation"; else -> "Camera frame" } + " · ${((now - it.optLong("at")).coerceAtLeast(0) / 1000)}s ago", style = MaterialTheme.typography.labelSmall)
                        }
                        lesson.optString("observerError").takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall) }
                    }
                }
                DetailSection("Optional phone controls") {
                    if (demonstration != null) {
                        OutlinedButton({ session?.lessonAction("pause") }, enabled = ready, modifier = Modifier.fillMaxWidth()) { Text("Pause video") }
                    } else if (paused) {
                        Button({ session?.lessonAction("resume") }, enabled = ready && (!lesson.has("pausedClip") || lesson.optString("pausedClip") in state.lessonClipsReady), modifier = Modifier.fillMaxWidth()) { Text(if (lesson.has("pausedClip")) "Restart clip from beginning" else "Resume lesson") }
                        if (lesson.has("pausedClip")) Text("The interrupted clip will restart from the beginning.", style = MaterialTheme.typography.bodySmall)
                    } else {
                        if (phase in setOf("intro", "complete")) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton({ session?.lessonAction("back") }, enabled = ready && if (phase == "intro") teachingPage != "opening" else lesson.optInt("recapPage") > 0, modifier = Modifier.weight(1f)) { Text("Back") }
                                Button({ session?.lessonAction("next") }, enabled = ready && if (phase == "intro") teachingPage != "compression-pattern" || "overview" in state.lessonClipsReady else lesson.optInt("recapPage") == 0, modifier = Modifier.weight(1f)) { Text(if (phase == "intro" && teachingPage == "compression-pattern") "Show demo" else "Next") }
                            }
                        }
                        OutlinedButton({ session?.lessonAction("repeat") }, enabled = ready, modifier = Modifier.fillMaxWidth()) { Text("Repeat explanation") }
                        if (phase in setOf("intro", "demonstration")) {
                            Button({ session?.command("play_training_video", json("clipId" to "overview")) }, enabled = ready && "overview" in state.lessonClipsReady, modifier = Modifier.fillMaxWidth()) { Text("Play overview from beginning") }
                            if (phase == "demonstration") TextButton({ session?.lessonAction("skip_demo") }, enabled = ready) { Text("Skip demonstration") }
                        }
                        if (practice) {
                            if ((scripted || !lesson.optBoolean("ready")) && (phase == "placement" || lesson.optBoolean("needsPlacementCheck"))) Button({ session?.lessonAction("ready") }, enabled = ready, modifier = Modifier.fillMaxWidth()) { Text(if (scripted) "Ready to continue" else "Ready for the placement check") }
                            OutlinedButton({ session?.command("play_training_video", json("clipId" to "hand-placement")) }, enabled = ready && "hand-placement" in state.lessonClipsReady, modifier = Modifier.fillMaxWidth()) { Text("Replay hand placement · 5 seconds") }
                            if (!scripted && (phase == "placement" || lesson.optBoolean("needsPlacementCheck"))) TextButton({ session?.lessonAction("skip_placement") }, enabled = ready) { Text("Continue without visual check") }
                            if (phase == "practice") Button({ session?.lessonAction("finish_practice") }, enabled = ready, modifier = Modifier.fillMaxWidth()) { Text("I’m done") }
                        }
                        if (phase == "complete") OutlinedButton({ session?.lessonAction("restart") }, enabled = ready, modifier = Modifier.fillMaxWidth()) { Text("Practise again") }
                        else TextButton({ session?.lessonAction("pause") }, enabled = ready) { Text("Pause lesson") }
                    }
                }
            }
            DetailSection("Training reference and sources") {
                intro?.optString("scope")?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                val facts = intro?.optJSONArray("facts")
                if (facts == null || facts.length() == 0) {
                    Text("The optional phone reference is unavailable.", style = MaterialTheme.typography.bodySmall)
                    TextButton({ session?.retryLessonMedia() }, enabled = ready) { Text("Retry phone reference") }
                } else for (index in 0 until facts.length()) {
                    val fact = facts.getJSONObject(index)
                    Text(fact.optString("text"))
                    fact.optJSONObject("source")?.let { source ->
                        val url = source.optString("url")
                        TextButton({ runCatching { uriHandler.openUri(url) } }, enabled = url.startsWith("https://"), contentPadding = PaddingValues(0.dp)) { Text(source.optString("title"), style = MaterialTheme.typography.labelSmall) }
                    }
                }
            }
            if (phase != "complete") {
                Text(state.lessonMedia, style = MaterialTheme.typography.bodySmall)
                if (state.lessonClipsReady.isEmpty() && state.glassesDisplayAvailable != true) Text("Wake and connect the glasses to play lesson videos.", style = MaterialTheme.typography.bodySmall)
                if (state.lessonMedia.startsWith("Lesson video unavailable")) TextButton({ session?.retryLessonMedia() }, enabled = ready && demonstration == null) { Text("Retry video download") }
            }
        }
    }
}
