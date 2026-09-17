package dev.coach

import org.junit.Assert.*
import org.junit.Test

class AudioGateTest {
    private fun packet(generation: Int = 2, epoch: Int = 3, seq: Long = 1) = AudioPacket(generation, epoch, seq, 44.0, byteArrayOf(1, 2, 3, 4))
    @Test fun captureLevelMeasuresSignedLittleEndianPcmWithoutTreatingSilenceAsSpeech() {
        assertEquals(-120.0, pcmRmsDbfs(ByteArray(640)), 0.001)
        assertEquals(0.0, pcmRmsDbfs(byteArrayOf(0, -128, -1, 127)), 0.001)
        assertEquals(-6.0206, pcmRmsDbfs(byteArrayOf(0, 64, 0, -64)), 0.001)
        assertEquals(-120.0, pcmRmsDbfs(byteArrayOf(0, 0, -1, 127), 2), 0.001)
    }
    @Test fun rejectsStaleFutureAndDuplicatePackets() {
        val gate = AudioGate().apply { bind(2, 3) }
        assertFalse(gate.accept(packet(generation = 1)))
        assertFalse(gate.accept(packet(epoch = 4)))
        assertTrue(gate.accept(packet()))
        assertFalse(gate.accept(packet()))
    }
    @Test fun localStopOnlyReopensAtNewAuthorizedBarrier() {
        val gate = AudioGate().apply { bind(2, 3); stop() }
        assertFalse(gate.accept(packet()))
        assertFalse(gate.flush(2, 3))
        assertFalse(gate.flush(1, 4))
        assertTrue(gate.flush(2, 4))
        assertFalse(gate.accept(packet()))
        assertTrue(gate.accept(packet(epoch = 4)))
    }
    @Test fun packetRoundTripPreservesUnsignedSequenceAndPcm() {
        val original = packet(seq = 4294967295)
        val decoded = AudioPacket.parse(original.bytes())!!
        assertEquals(original.sequence, decoded.sequence)
        assertEquals(original.generation, decoded.generation)
        assertEquals(original.epoch, decoded.epoch)
        assertArrayEquals(original.pcm, decoded.pcm)
        assertNull(AudioPacket.parse(byteArrayOf(0, 1)))
    }
    @Test fun shortWritesKeepUnwrittenAudioUntilTheSinkHasSpace() {
        val queue = PcmWriteQueue(16)
        val heard = ArrayList<Byte>()
        assertTrue(queue.offer(byteArrayOf(1, 2, 3, 4, 5, 6)))
        assertEquals(2, queue.drain { bytes, offset, _ -> heard.addAll(bytes.copyOfRange(offset, offset + 2).toList()); 2 })
        assertEquals(4, queue.byteCount)
        assertEquals(0, queue.drain { _, _, _ -> 0 })
        assertEquals(4, queue.byteCount)
        assertEquals(4, queue.drain { bytes, offset, length -> heard.addAll(bytes.copyOfRange(offset, offset + length).toList()); length })
        assertEquals(listOf<Byte>(1, 2, 3, 4, 5, 6), heard)
        assertEquals(0, queue.byteCount)
    }
    @Test fun queueAcceptsProviderBurstsButBoundsHardwarePlusPendingAudio() {
        val capacity = 24000 * 2 * (AudioEngine.PLAYBACK_QUEUE_MS / 1000)
        val queue = PcmWriteQueue(capacity)
        assertTrue(queue.offer(ByteArray(240000), hardwareBytes = 24000)) // Five seconds plus 500ms in hardware.
        assertTrue(queue.offer(ByteArray(capacity - 264000), hardwareBytes = 24000))
        assertFalse(queue.offer(byteArrayOf(1, 2), hardwareBytes = 24000))
        assertEquals(capacity - 24000, queue.byteCount)
    }
    @Test fun spokenIntroductionCanArriveThreeTimesFasterThanPlayback() {
        val queue = PcmWriteQueue(24000 * 2 * (AudioEngine.PLAYBACK_QUEUE_MS / 1000))
        val pcm = ByteArray(24000 * 2 * 30) { (it % 251).toByte() }
        val output = java.io.ByteArrayOutputStream()
        fun play() = queue.drain { bytes, offset, count -> minOf(count, 960).also { output.write(bytes, offset, it) } }
        for (offset in pcm.indices step 2880) {
            assertTrue("Provider speech must not overflow and restart the introduction", queue.offer(pcm.copyOfRange(offset, offset + 2880)))
            play() // 60ms of generated speech arrives during 20ms of real playback.
        }
        while (queue.byteCount > 0) play()
        assertArrayEquals(pcm, output.toByteArray())
    }
    @Test fun fiveSecondBurstSurvivesRepeatedShortWritesWithoutLosingPcm() {
        val queue = PcmWriteQueue(24000 * 2 * (AudioEngine.PLAYBACK_QUEUE_MS / 1000))
        val pcm = ByteArray(240000) { (it % 251).toByte() }
        val output = java.io.ByteArrayOutputStream()
        assertTrue(queue.offer(pcm))
        while (queue.byteCount > 0) {
            queue.drain { bytes, offset, length -> minOf(length, 960).also { output.write(bytes, offset, it) } }
        }
        assertArrayEquals(pcm, output.toByteArray())
    }
    @Test fun stopClearsPartiallyWrittenAudioBeforeANewEpoch() {
        val queue = PcmWriteQueue(24000 * 2 * (AudioEngine.PLAYBACK_QUEUE_MS / 1000))
        assertTrue(queue.offer(ByteArray(240000) { 1 }))
        queue.drain { _, _, _ -> 960 }
        queue.clear()
        assertEquals(0, queue.byteCount)
        queue.offer(byteArrayOf(7, 8))
        queue.drain { bytes, offset, length -> assertArrayEquals(byteArrayOf(7, 8), bytes.copyOfRange(offset, offset + length)); length }
        assertEquals(0, queue.byteCount)
    }
    @Test fun negativeSinkResultIsAnErrorWithoutConsumingQueuedAudio() {
        val queue = PcmWriteQueue(16)
        queue.offer(byteArrayOf(1, 2))
        assertEquals(-6, queue.drain { _, _, _ -> -6 })
        assertEquals(2, queue.byteCount)
    }
}
