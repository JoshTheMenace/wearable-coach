import WebSocket from 'ws';
import { COACH_PROMPT, SocketProvider, boundedText, imageCheck, numericUsage, type Wire } from './shared.ts';

export const hudTools = [
  { name: 'set_hud', description: 'Replace the entire HUD. Ask for short text, a checklist, or a timer. Acceptance is not display confirmation.',
    parameters: { type: 'OBJECT', properties: {
      card: { type: 'OBJECT', properties: { title: { type: 'STRING' }, body: { type: 'STRING' } }, required: ['body'] },
      checklist: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, text: { type: 'STRING' }, checked: { type: 'BOOLEAN' } }, required: ['id', 'text', 'checked'] } },
      timer: { type: 'OBJECT', properties: { durationMs: { type: 'INTEGER' } }, required: ['durationMs'] },
    } } },
  { name: 'clear_hud', description: 'Clear the entire HUD.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'inspect_frame', description: 'Request a fresh camera frame to answer a specific question. Do not infer that an older view is current.',
    parameters: { type: 'OBJECT', properties: { question: { type: 'STRING' } }, required: ['question'] } },
];

export class GeminiProvider extends SocketProvider {
  inputRate = 16000;
  private calls = new Map<string, string>();
  protected endpoint() {
    const key = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Gemini requires GEMINI_KEY or GEMINI_API_KEY on the server');
    return { url: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent',
      headers: { 'x-goog-api-key': key } };
  }
  protected setup() {
    const extended = this.config.model === 'gemini-3.8-live-extended-thinking';
    return { setup: {
      model: `models/${this.config.model}`,
      generationConfig: { responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voice || 'Puck' } } },
        ...(extended ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
      },
      systemInstruction: { parts: [{ text: COACH_PROMPT }] },
      tools: [{ functionDeclarations: hudTools.map(tool => ({ ...tool, behavior: tool.name === 'inspect_frame' ? 'BLOCKING' : 'NON_BLOCKING' })) }],
      inputAudioTranscription: {}, outputAudioTranscription: {},
      sessionResumption: this.options.resumeHandle ? { handle: this.options.resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
      ...(this.config.manualActivity ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } : {}),
    } };
  }
  protected receive(message: Wire) {
    if (message.setupComplete) {
      this.started({ recovery: this.options.resumeHandle ? 'resumed' : 'new', apiVersion: 'v1alpha' });
      if (this.options.history && !this.options.resumeHandle) this.send({ clientContent: {
        turns: [{ role: 'user', parts: [{ text: `Historical application context, not a new learner request:\n${this.options.history.slice(-12000)}` }] }], turnComplete: false,
      } });
    }
    const content = message.serverContent;
    if (content) {
      if (content.interrupted) this.callbacks.interrupted();
      for (const [field, speaker] of [['inputTranscription', 'user'], ['outputTranscription', 'assistant']]) {
        if (typeof content[field]?.text === 'string') this.callbacks.event('transcript.fragment', { speaker, text: content[field].text });
      }
      for (const part of content.modelTurn?.parts ?? []) {
        // Never persist a private thought part, even if a provider begins emitting one.
        if (part.thought) continue;
        if (part.inlineData?.mimeType?.startsWith('audio/pcm')) this.outputAudio(part.inlineData.data);
      }
      if (content.turnComplete) this.callbacks.event('provider.utterance_complete', { interactionStatus: typeof content.interactionStatus === 'string' ? content.interactionStatus : 'unknown' });
    }
    const interactionStatus = content?.interactionStatus ?? message.interactionStatus;
    if (['IDLE', 'IN_PROGRESS'].includes(interactionStatus)) this.callbacks.event('provider.work_state', { state: interactionStatus });
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (typeof call.id !== 'string' || typeof call.name !== 'string' || call.args != null && (typeof call.args !== 'object' || Array.isArray(call.args)))
        throw new Error('Malformed Gemini tool call');
      if (this.calls.size >= 256 && !this.calls.has(call.id)) throw new Error('Too many pending provider tools');
      this.calls.set(call.id, call.name);
      this.callbacks.tool({ id: call.id, name: call.name, args: call.args ?? {} });
    }
    if (Array.isArray(message.toolCallCancellation?.ids)) {
      const ids = message.toolCallCancellation.ids.filter((id: unknown) => typeof id === 'string').slice(0, 256);
      for (const id of ids) this.calls.delete(id);
      this.callbacks.event('provider.tools_cancelled', { ids });
    }
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      this.resumeHandle = update.resumable && typeof update.newHandle === 'string' ? update.newHandle : undefined;
      this.callbacks.event('provider.resumption', { resumable: !!this.resumeHandle });
    }
    if (message.goAway) this.callbacks.event('provider.go_away', { timeLeft: typeof message.goAway.timeLeft === 'string' ? message.goAway.timeLeft.slice(0, 40) : null });
    if (message.usageMetadata) this.callbacks.event('usage.reported', { source: 'gemini_live', model: this.config.model,
      mode: 'delta', unit: 'tokens', values: numericUsage(message.usageMetadata), final: false });
    if (message.error) this.fail('Gemini rejected the session request; check model access and configuration');
  }
  sendAudio(pcm: Buffer) {
    this.checkAudio(pcm);
    this.send({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }, true);
  }
  sendText(text: string) {
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: boundedText(text) }] }], turnComplete: true } });
  }
  sendVideo(image: Buffer, mime: string) {
    imageCheck(image, mime);
    if (image.length > 256 * 1024) throw new Error('Live video frames must be at most 256 KiB');
    if (!this.ready || this.closing || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Provider is not ready');
    // Permit the normal paced audio backlog, but never queue another video frame.
    if (this.videoQueuedBytes || this.socket.bufferedAmount > Math.ceil(this.inputRate * 2 * 0.25 * 4 / 3)) return false;
    const encoded = JSON.stringify({ realtimeInput: { video: { data: image.toString('base64'), mimeType: mime } } });
    this.videoQueuedBytes = Buffer.byteLength(encoded);
    this.socket.send(encoded, error => { this.videoQueuedBytes = 0; if (error && !this.closing) this.fail('Provider video transport failed'); });
    return true;
  }
  inspect(image: Buffer, mime: string, question: string) {
    imageCheck(image, mime);
    // One content message binds the question to these pixels, avoiding cross-channel ordering assumptions.
    this.send({ clientContent: { turns: [{ role: 'user', parts: [
      { inlineData: { mimeType: mime, data: image.toString('base64') } }, { text: boundedText(question, 1000) },
    ] }], turnComplete: true } });
  }
  toolResult(id: string, result: unknown) {
    const name = this.calls.get(id);
    if (!name) throw new Error('Unknown provider tool call');
    const response = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
    this.send({ toolResponse: { functionResponses: [{ id, name, response }] } });
    this.calls.delete(id);
  }
  activity(active: boolean) {
    if (this.config.manualActivity) this.send({ realtimeInput: active ? { activityStart: {} } : { activityEnd: {} } });
  }
  appendContext(text: string, _delegationId?: string | null, spoken = false) {
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `Application evidence update (not a learner request): ${boundedText(text, 12000)}${spoken ? '\nBriefly explain this result to the learner.' : '\nUse this context only when relevant.'}` }] }], turnComplete: spoken } });
    this.callbacks.event('context.dispatched', { acknowledged: false });
  }
}
