package dev.coach

import kotlinx.coroutines.Job

// Release recovery's capture/display locks before submitting the video cue card.
internal suspend fun stopCameraForVideo(vararg jobs: Job?) {
    jobs.forEach { it?.cancel() }
    jobs.forEach { it?.join() }
}
