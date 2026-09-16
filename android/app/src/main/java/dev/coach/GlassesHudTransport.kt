package dev.coach

import com.google.protobuf.ByteString
import com.google.protobuf.InvalidProtocolBufferException
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.dwa.protos.*
import com.meta.wearable.dat.dwa.capability.display.internal.protos.DisplayResponsePayload
import com.meta.wearable.dat.dwa.capability.display.internal.protos.DisplayEventPayload
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.io.Closeable
import java.util.UUID

class GlassesDisplayFailure(val code: String) : IllegalStateException("Glasses display: $code")

// Version-pinned bridge: current display format over the working DAT 0.8 camera transport.
object GlassesHudTransport {
    private fun Any.sdk(name: String, vararg args: Any?): Any? = javaClass.methods.single {
        it.name.substringBefore('$') == name && it.parameterCount == args.size && !it.name.endsWith("\$default")
    }.invoke(this, *args)

    private fun channel(session: DeviceSession): Any {
        check(BuildConfig.META_DAT_VERSION == "0.8.0") { "Revalidate glasses display transport for this SDK" }
        val manager = checkNotNull(Wearables.sdk("getSessionManager"))
        return checkNotNull(manager.sdk("getOrCreateDwaChannel", session.sdk("getDevice")))
    }

    private fun displayError(event: DwaEvent): String? {
        if (event.capability != Capability.CAPABILITY_DISPLAY || !event.hasCapabilityEventPayload()) return null
        return try {
            val payload = DisplayEventPayload.parseFrom(event.capabilityEventPayload)
            if (payload.hasDisplayEvent() && payload.displayEvent.hasError()) payload.displayEvent.error.code.name else null
        } catch (_: InvalidProtocolBufferException) { "MALFORMED_EVENT" }
    }

    // Keep observing after the submission ACK: rendering can fail asynchronously.
    fun observeErrors(session: DeviceSession, report: (String) -> Unit): Closeable {
        val onResponse: (DwaApiResponse) -> Unit = {}
        val onEvent: (DwaEvent) -> Unit = { displayError(it)?.let(report) } // Ignore read-only card clicks.
        val onError: (Exception) -> Unit = { report("CHANNEL_ERROR") }
        val onClosed: () -> Unit = { report("CHANNEL_CLOSED") }
        return channel(session).sdk("registerCallbacks", onResponse, onEvent, onError, onClosed) as Closeable
    }

    suspend fun restoreAfterCameraStart(session: DeviceSession) {
        check(BuildConfig.META_DAT_VERSION == "0.8.0") { "Revalidate glasses display transport for this SDK" }
        check(session.state.value == DeviceSessionState.STARTED)
        val manager = checkNotNull(Wearables.sdk("getSessionManager"))
        val device = checkNotNull(session.sdk("getDevice"))
        val channels = manager.javaClass.getDeclaredField("channels").apply { isAccessible = true }.get(manager) as Map<*, *>
        val active = checkNotNull(channels[device])
        val wireId = checkNotNull(active.sdk("getDatSession")).sdk("getId")
        val devMode = (manager.sdk("isDevMode") as Function0<*>).invoke()
        // Legacy camera takes foreground. Re-launch the existing DWA session without changing
        // the manager's legacy-camera flag; its wire ID differs from DeviceSession's local ID.
        active.sdk("requestStartSession-pLZwAQ4", wireId, device.sdk("getIdentifier"), manager.sdk("getAppId"), true, devMode)
        val body = DwaRequestBody.newBuilder().setCapabilityQuery(CapabilityQueryRequest.getDefaultInstance()).build()
        val ack = request(session, Capability.CAPABILITY_UNKNOWN, body, 15_000)
        if (!ack.hasCapabilityQuery()) throw GlassesDisplayFailure("RESTORE_UNEXPECTED_RESPONSE")
        // Fresh query ACK proves the channel responds, not that the launch succeeded or pixels are visible.
    }

    suspend fun send(session: DeviceSession, bytes: ByteArray) {
        val body = DwaRequestBody.newBuilder().setCapabilityPayload(ByteString.copyFrom(bytes)).build()
        val ack = request(session, Capability.CAPABILITY_DISPLAY, body, 10_000)
        if (!DisplayResponsePayload.parseFrom(ack.capabilityResponsePayload).hasDisplayContent()) throw GlassesDisplayFailure("UNEXPECTED_RESPONSE")
    }

    private suspend fun request(session: DeviceSession, capability: Capability, body: DwaRequestBody, timeoutMs: Long): DwaApiResponse {
        val channel = channel(session)
        val id = UUID.randomUUID().toString()
        val response = CompletableDeferred<DwaApiResponse>()
        val onResponse: (DwaApiResponse) -> Unit = { if (it.requestMessageId == id) response.complete(it) }
        val onEvent: (DwaEvent) -> Unit = { displayError(it)?.let { code -> response.completeExceptionally(GlassesDisplayFailure(code)) } }
        val onError: (Exception) -> Unit = { response.completeExceptionally(GlassesDisplayFailure("CHANNEL_ERROR")) }
        val onClosed: () -> Unit = { response.completeExceptionally(GlassesDisplayFailure("CHANNEL_CLOSED")) }
        val callbacks = channel.sdk("registerCallbacks", onResponse, onEvent, onError, onClosed) as Closeable
        try {
            if (channel.sdk("sendCapabilityRequest", capability, body, id) != true) throw GlassesDisplayFailure("SEND_FAILED")
            val ack = withTimeoutOrNull(timeoutMs) { response.await() } ?: throw GlassesDisplayFailure("ACK_TIMEOUT")
            if (ack.status != ResponseStatus.RESPONSE_STATUS_OK) throw GlassesDisplayFailure(ack.status.name)
            return ack
        } finally { callbacks.close() }
    }
}
