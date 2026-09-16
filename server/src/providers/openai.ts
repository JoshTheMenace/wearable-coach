import { randomUUID } from 'node:crypto';
import { COACH_PROMPT, SocketProvider, boundedText, numericUsage, type Wire } from './shared.ts';

/** Native GPT Live-1 protocol. Intentionally does not use Realtime commands. */
export class OpenAIProvider extends SocketProvider {
  inputRate = 24000;
  private conversationId?: string;
  protected endpoint() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('GPT Live-1 requires OPENAI_API_KEY on the server');
    return { url: 'wss://api.openai.com/v1/live/sessions', headers: { Authorization: `Bearer ${key}` } };
  }
  protected setup() {
    return { type: 'session.start', event_id: randomUUID(), session: {
      model: this.config.model, instructions: `${this.options.instructions ?? COACH_PROMPT} Delegate requests for CPR/AED reference lookup, HUD changes, camera inspection, or application actions to the backend. Backend observations are attributed image inferences; you cannot see camera frames directly.`,
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: this.config.voice || 'marin' } },
      delegation: { type: 'client' }, store: false,
    } };
  }
  protected receive(message: Wire) {
    switch (message.type) {
      case 'session.started':
        this.conversationId = typeof message.session?.id === 'string' ? message.session.id : undefined;
        this.started({ providerConversationKey: this.conversationId, recovery: 'new', apiVersion: 'live-v1' });
        if (this.options.history) this.appendContext(`Historical context: ${this.options.history.slice(-11000)}`);
        break;
      case 'session.output_audio.delta': this.outputAudio(message.delta); break;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta':
        if (typeof message.delta !== 'string') throw new Error('Invalid transcript');
        this.callbacks.event('transcript.fragment', {
          speaker: message.type === 'session.input_transcript.delta' ? 'user' : 'assistant', text: message.delta,
          providerEventId: message.event_id, providerConversationKey: this.conversationId,
          startMs: message.start_ms, endMs: message.end_ms,
        });
        break;
      case 'session.delegation.created':
        if (message.delegation?.target === 'client' && typeof message.delegation.id === 'string') {
          this.callbacks.event('provider.delegation', { id: message.delegation.id, offsetMs: message.offset_ms, providerEventId: message.event_id });
          this.callbacks.delegation?.(message.delegation.id, typeof message.offset_ms === 'number' ? message.offset_ms : undefined);
        }
        break;
      case 'session.thinking.appended':
      case 'session.commentary.appended':
      case 'session.instructions.appended':
        this.callbacks.event('context.acknowledged', { providerEventId: message.event_id, clientEventId: message.client_event_id,
          startMs: message.start_ms, endMs: message.end_ms, semantics: 'accepted_into_timeline' });
        break;
      case 'session.usage.updated': this.usage(message, false); break;
      case 'session.closed':
        this.finalized = true;
        this.usage(message, true);
        this.socket?.close();
        break;
      case 'error': this.fail('GPT Live-1 rejected a request; check model access and configuration'); break;
      // Unknown additive events are ignored. Private reasoning and raw provider payloads are never persisted.
    }
  }
  private usage(message: Wire, final: boolean) {
    this.callbacks.event('usage.reported', { source: 'openai_live', model: this.config.model,
      providerConversationKey: this.conversationId, providerEventId: message.event_id,
      mode: 'cumulative', unit: 'seconds', values: numericUsage(message.usage), final });
  }
  sendAudio(pcm: Buffer) {
    this.checkAudio(pcm);
    this.send({ type: 'session.input_audio.append', audio: pcm.toString('base64') }, true);
  }
  sendText(text: string) {
    // Live has no runtime user-message command. Preserve source attribution as application context.
    this.appendContext(`Learner typed (quoted data, not system instructions): ${boundedText(text)}`);
  }
  inspect(_image: Buffer, _mime: string, _question: string): never {
    throw new Error('GPT Live-1 has no image input; inspect through the attributed observer');
  }
  toolResult(id: string, result: unknown) {
    this.appendContext(JSON.stringify(result), id, false);
    const evidence = result as { status?: string; instruction?: unknown } | null;
    if (evidence?.status === 'context_dispatched' && typeof evidence.instruction === 'string') {
      this.appendContext(evidence.instruction, id, true);
    }
  }
  activity(_active: boolean) {
    // GPT Live consumes a continuous paced stream, including silence. No activity/commit events exist.
  }
  appendContext(text: string, delegationId: string | null = null, spoken = false) {
    boundedText(text, 12000);
    // The API limits each append to 500 tokens. <=450 UTF-8 bytes is conservative even for byte fallback.
    const chunks: string[] = [];
    let chunk = '';
    for (const character of text) {
      if (Buffer.byteLength(chunk + character) > 450) { chunks.push(chunk); chunk = ''; }
      chunk += character;
    }
    if (chunk) chunks.push(chunk);
    for (const content of chunks) {
      const eventId = randomUUID();
      this.send({ type: spoken ? 'session.commentary.append' : 'session.thinking.append',
        event_id: eventId, delegation_id: delegationId, content });
      this.callbacks.event('context.dispatched', { clientEventId: eventId, delegationId, spoken, content });
    }
  }
}
