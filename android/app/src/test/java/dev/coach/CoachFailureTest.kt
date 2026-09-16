package dev.coach

import org.junit.Assert.*
import org.junit.Test
import java.net.ConnectException

class CoachFailureTest {
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
