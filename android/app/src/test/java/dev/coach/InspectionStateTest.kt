package dev.coach

import org.junit.Assert.*
import org.junit.Test

class InspectionStateTest {
    @Test fun lateEventsCannotReplaceNewInspection() {
        val current = InspectionState("new", "Which part is loose?")
        assertEquals(current, current.update("old", "failed"))
        assertEquals("Inspecting image", current.update("new", "running").label)
    }
    @Test fun retryPreservesOriginalQuestionAfterFailureAndRebind() {
        val failed = InspectionState("work", "Which part is loose?").update("work", "failed", detail = "capture failed")
        assertTrue(failed.canRetry)
        assertEquals("Which part is loose?", failed.question)
        assertEquals(failed, failed.update("work", "running"))
        assertTrue(InspectionState("work", failed.question, "cancelled").canRetry)
        assertFalse(InspectionState("work", "", "failed").canRetry)
    }
    @Test fun dispatchDoesNotClaimSpeechOrVerification() {
        val complete = InspectionState("work", "What is visible?").update("work", "completed", "context_dispatched")
        assertEquals("Sent to coach", complete.label)
        assertFalse(complete.canRetry)
        assertEquals("Simulation sent", complete.copy(resultStatus = "simulation").label)
    }
}
