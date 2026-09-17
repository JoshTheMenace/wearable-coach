package dev.coach

import kotlinx.coroutines.*

// Control/audio binding must not wait for glasses; camera warmup follows the first card.
internal fun CoroutineScope.presentSessionSnapshot(
    previous: Job? = null,
    current: () -> Boolean,
    render: suspend () -> Unit,
    startCamera: () -> Unit,
    onFailure: (Exception) -> Unit
): Job = launch {
    previous?.join()
    if (current()) {
        try { render(); if (current()) startCamera() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { if (current()) onFailure(error) }
    }
}.also { job -> job.invokeOnCompletion { if (it is CancellationException) previous?.cancel() } }
