package dev.coach

// Only a real player callback can acknowledge playback; repeated and old callbacks are ignored.
internal class DemoPlaybackLease(val requestId: String, val generation: Int, val binding: Int) {
    var playing = false; private set
    var terminal = false; private set
    fun accepts(requestId: String?, generation: Int, binding: Int, status: String): Boolean {
        if (terminal || requestId != this.requestId || generation != this.generation || binding != this.binding) return false
        return when (status) {
            "playing" -> if (playing) false else { playing = true; true }
            "ended" -> if (!playing) false else { terminal = true; true }
            "failed" -> { terminal = true; true }
            else -> false
        }
    }
}
