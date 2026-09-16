package dev.coach

data class InspectionState(val workId: String, val question: String, val status: String = "reserved",
    val resultStatus: String = "", val details: String = "") {
    val canRetry get() = question.isNotBlank() && status in setOf("failed", "cancelled", "aborted")
    val label get() = when (status) {
        "reserved" -> "Waiting for camera"
        "running" -> "Inspecting image"
        "completed" -> if (resultStatus == "simulation") "Simulation sent" else "Sent to coach"
        "failed" -> "Inspection failed"
        "cancelled" -> "Inspection cancelled"
        "aborted" -> "Inspection interrupted"
        else -> "Inspection pending"
    }
    fun update(id: String, next: String, result: String = resultStatus, detail: String = details): InspectionState =
        if (id != workId || status in setOf("completed", "failed", "cancelled", "aborted")) this
        else copy(status = next, resultStatus = result, details = detail)
}
