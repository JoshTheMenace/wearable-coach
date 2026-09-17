import { decodeAudio } from '../../contracts/index.ts';

export class PresentationAudio {
  private context?: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private until = 0;
  private generation = 0;
  private epoch = 0;
  private seq = -1;
  enabled = false;
  async enable() { this.context ??= new AudioContext(); await this.context.resume(); this.enabled = true; }
  mute() { this.enabled = false; this.flush(); }
  flush() { for (const source of this.sources) { source.onended = null; source.stop(); } this.sources.clear(); this.until = 0; }
  reset() { this.flush(); this.generation = 0; this.epoch = 0; this.seq = -1; }
  bind(generation: number, epoch: number) {
    if (generation < this.generation || generation === this.generation && epoch < this.epoch) return;
    if (generation !== this.generation || epoch !== this.epoch) { this.flush(); this.seq = -1; }
    this.generation = generation; this.epoch = epoch;
  }
  progress() {
    const context = this.context;
    const pendingMs = context && this.enabled && this.sources.size ? Math.ceil((Math.max(0, this.until - context.currentTime) + (context.baseLatency || 0) + (context.outputLatency || 0)) * 1000) : 0;
    return { generation: this.generation, speechEpoch: this.epoch, pendingMs: Math.min(60000, pendingMs) };
  }
  play(bytes: ArrayBuffer, rate: number) {
    const packet = decodeAudio(new Uint8Array(bytes)), context = this.context;
    if (!context || !this.enabled || context.state !== 'running' || packet.generation !== this.generation || packet.speechEpoch !== this.epoch || packet.seq <= this.seq) return;
    this.seq = packet.seq;
    const pcm = new DataView(packet.pcm.buffer, packet.pcm.byteOffset, packet.pcm.byteLength);
    const buffer = context.createBuffer(1, packet.pcm.byteLength / 2, rate), samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    this.sources.add(source); source.onended = () => this.sources.delete(source);
    const at = Math.max(context.currentTime + 0.02, this.until); this.until = at + buffer.duration; source.start(at);
  }
  async test() {
    await this.enable();
    const context = this.context!, oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.frequency.value = 660; gain.gain.value = 0.06;
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.3);
  }
  close() { this.flush(); void this.context?.close(); }
}
