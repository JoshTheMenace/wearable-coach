package dev.coach

import org.junit.Assert.*
import org.junit.Test
import java.net.ConnectException

class CoachFailureTest {
    @Test fun cameraFailuresExplainThatNoImageArrived() {
        val issue = CoachFailure.from(CameraCaptureFailure("CaptureFailed"))
        assertEquals("capture.failed", issue.code)
        assertTrue(issue.message.contains("No image"))
        assertTrue(issue.message.contains("restart the glasses"))
        assertTrue(CoachFailure.from(BackendFailure(412)).message.contains("no recent frames"))
        val startup = CoachFailure.from(CameraCaptureFailure("DeviceStartTimeout"))
        assertTrue(startup.message.contains("wake them"))
        assertFalse(startup.message.contains("No image"))
        assertTrue(CoachFailure.from(CameraCaptureFailure("VideoStartTimeout")).message.contains("sent no video"))
    }
    @Test fun failuresGiveRecoveryStepsWithoutLeakingTransportContent() {
        val issue = CoachFailure.from(ConnectException("https://secret.example?key=do-not-log"))
        assertEquals("network.unavailable", issue.code)
        assertTrue(issue.message.contains("USB"))
        assertFalse(issue.message.contains("secret"))
        assertTrue(CoachFailure.from(BackendFailure(401)).message.contains("new session"))
        assertTrue(CoachFailure.from(BackendFailure(409)).message.contains("Reconnect"))
        assertTrue(CoachFailure.from(SecurityException("private content")).message.contains("Settings"))
    }
}
