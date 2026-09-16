import { boundedText, imageCheck } from './shared.ts';
import type { ProviderAdapter, ProviderCallbacks, ProviderConfig } from './types.ts';

/** Local deterministic fixture. Its PCM is a labeled tone, never presented as synthesized speech. */
export class MockProvider implements ProviderAdapter {
  inputRate = 16000;
  outputRate = 24000;
  private open = false;
  private sequence = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private config: ProviderConfig, private callbacks: ProviderCallbacks) {}
  async connect() {
    this.open = true;
    this.callbacks.event('provider.ready', { provider: 'mock', model: this.config.model, simulated: true, inputRate: this.inputRate, outputRate: this.outputRate });
    this.callbacks.event('transcript.fragment', { speaker: 'assistant', text: 'Simulated coach connected. Type “show card”, “clear”, “inspect”, or “lookup <question>”. Audio is a test tone.', simulated: true });
  }
  sendAudio(pcm: Buffer) {
    if (!this.open) throw new Error('Provider is not ready');
    if (!pcm.length || pcm.length % 2 || pcm.length > this.inputRate * 2) throw new Error('Invalid PCM16 packet');
  }
  private later(callback: () => void, delay: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.open) callback(); }, delay);
    this.timers.add(timer);
  }
  private speak(text: string) {
    this.callbacks.event('transcript.fragment', { speaker: 'assistant', text, simulated: true });
    this.callbacks.event('playback.simulated', { kind: 'tone', frequencyHz: 440, durationMs: 240 });
    // Paced 20 ms packets exercise the same queue and interruption path as a real provider.
    for (let packet = 0; packet < 12; packet++) this.later(() => {
      const pcm = Buffer.alloc(960);
      for (let i = 0; i < 480; i++) pcm.writeInt16LE(Math.round(2400 * Math.sin(2 * Math.PI * 440 * (packet * 480 + i) / 24000)), i * 2);
      this.callbacks.audio(pcm);
      if (packet === 11) this.callbacks.event('provider.utterance_complete', { simulated: true });
    }, packet * 20);
  }
  sendText(text: string) {
    if (!this.open) throw new Error('Provider is not ready');
    boundedText(text);
    this.callbacks.event('transcript.fragment', { speaker: 'user', text, simulated: true });
    const call = (name: string, args: Record<string, unknown>, delay = 25) => {
      const id = `mock-call-${++this.sequence}`;
      this.later(() => this.callbacks.tool({ id, name, args }), delay);
    };
    if (/^(lookup|reference)\s+/i.test(text.trim())) call('lookup_training_reference', { query: text.trim().replace(/^(lookup|reference)\s+/i, '').slice(0, 1200) });
    else if (/invalid/i.test(text)) call('set_hud', { card: { body: 'x'.repeat(241) } });
    else if (/inspect|look|camera/i.test(text)) call('inspect_frame', { question: text.slice(0, 1000) });
    else if (/clear/i.test(text)) call('clear_hud', {});
    else if (/show|card|hud|delayed/i.test(text)) call('set_hud', { card: { title: 'Simulated coach', body: 'Pause, inspect your setup, and explain your next step.' } }, /delayed/i.test(text) ? 2500 : 25);
    else if (/timer/i.test(text)) call('set_hud', { timer: { durationMs: 10000 } });
    this.speak('Simulated response: I received your request. Any HUD action will be validated by the server.');
  }
  inspect(image: Buffer, mime: string, question: string) {
    if (!this.open) throw new Error('Provider is not ready');
    imageCheck(image, mime);
    boundedText(question, 1000);
    this.speak('Simulated inspection: a frame was received. This mock does not interpret the image.');
  }
  toolResult(id: string, result: unknown) {
    this.callbacks.event('provider.tool_result', { id, result, simulated: true });
  }
  activity(active: boolean) {
    if (active) {
      this.callbacks.interrupted();
      // Speech interruption intentionally does not cancel delayed tool calls.
    }
  }
  appendContext(text: string, _id?: string | null, spoken = false) {
    boundedText(text, 12000);
    if (spoken) this.speak(`Simulated result: ${text}`);
    else this.callbacks.event('context.dispatched', { content: text, simulated: true });
  }
  async close() {
    this.open = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.callbacks.closed('mock_closed');
  }
}
