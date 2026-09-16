import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createProvider, inferTask, observeFrame, type ProviderCallbacks, type ProviderOptions } from '../src/providers/index.ts';

const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture'); await pause(); }
}
function recorder() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const audio: Buffer[] = [], errors: Error[] = [], calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  const delegations: { id: string; offsetMs?: number }[] = [];
  let interrupts = 0;
  const callbacks: ProviderCallbacks = {
    event: (type, payload) => events.push({ type, payload }), audio: pcm => audio.push(pcm), tool: call => calls.push(call),
    delegation: (id, offsetMs) => delegations.push({ id, offsetMs }), interrupted: () => { interrupts++; },
    error: error => errors.push(error), closed: reason => events.push({ type: 'closed', payload: { reason } }),
  };
  return { callbacks, events, audio, errors, calls, delegations, get interrupts() { return interrupts; } };
}
async function wire(ready: unknown, finalize = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const messages: any[] = [];
  let peer: WebSocket;
  let endpoint = '';
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', data => {
      const message = JSON.parse(data.toString()); messages.push(message);
      if (messages.length === 1) socket.send(JSON.stringify(ready));
      if (message.type === 'session.close' && finalize) socket.send(JSON.stringify({ type: 'session.closed', usage: { seconds: 4.5 }, event_id: 'final-usage' }));
    });
  });
  const options: ProviderOptions = { socketFactory: url => { endpoint = url; return new WebSocket(`ws://127.0.0.1:${address.port}`); }, closeTimeoutMs: 100 };
  return { options, messages, get endpoint() { return endpoint; }, send: (message: unknown) => peer.send(JSON.stringify(message)),
    close: async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('Gemini sends aligned image/question, manual boundaries and exact tool result IDs over the wire', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({ setupComplete: {} }); t.after(() => fixture.close());
  const r = recorder();
  const adapter = createProvider({ provider: 'gemini', model: 'gemini-3.8-live', manualActivity: true }, r.callbacks, fixture.options);
  await adapter.connect();
  assert.match(fixture.endpoint, /v1alpha\.GenerativeService\.BidiGenerateContent$/);
  assert.deepEqual(fixture.messages[0].setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(fixture.messages[0].setup.realtimeInputConfig.automaticActivityDetection.disabled, true);
  assert.equal(fixture.messages[0].setup.generationConfig.thinkingConfig, undefined);
  adapter.activity(true); adapter.sendAudio(Buffer.from([1, 0, 2, 0])); adapter.activity(false);
  adapter.inspect(Buffer.from('exact-frame'), 'image/png', 'Which block is blue?');
  await until(() => fixture.messages.length === 5);
  assert.deepEqual(fixture.messages[1], { realtimeInput: { activityStart: {} } });
  assert.equal(fixture.messages[2].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual(fixture.messages[3], { realtimeInput: { activityEnd: {} } });
  const parts = fixture.messages[4].clientContent.turns[0].parts;
  assert.equal(Buffer.from(parts[0].inlineData.data, 'base64').toString(), 'exact-frame');
  assert.equal(parts[1].text, 'Which block is blue?');
  fixture.send({ toolCall: { functionCalls: [{ id: 'opaque-call', name: 'clear_hud' }] } });
  await until(() => r.calls.length === 1);
  assert.deepEqual(r.calls[0], { id: 'opaque-call', name: 'clear_hud', args: {} });
  adapter.toolResult('opaque-call', { status: 'cancelled', applicationEffect: 'not_applied' });
  await until(() => fixture.messages.length === 6);
  assert.deepEqual(fixture.messages[5].toolResponse.functionResponses[0], { id: 'opaque-call', name: 'clear_hud', response: { status: 'cancelled', applicationEffect: 'not_applied' } });
  await adapter.close();
});

test('Gemini preserves captions, isolates thought parts, cancellation and resumption secrets', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({ setupComplete: {} }); t.after(() => fixture.close());
  const r = recorder();
  const adapter = createProvider({ provider: 'gemini', model: 'gemini-3.8-live-extended-thinking' }, r.callbacks,
    { ...fixture.options, resumeHandle: 'private-resume-token' });
  await adapter.connect();
  assert.deepEqual(fixture.messages[0].setup.sessionResumption, { handle: 'private-resume-token' });
  assert.equal(fixture.messages[0].setup.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  fixture.send({ serverContent: { inputTranscription: { text: 'one ' }, outputTranscription: { text: 'two' }, interrupted: true,
    turnComplete: true, interactionStatus: 'IN_PROGRESS', modelTurn: { parts: [
      { thought: true, text: 'private reasoning' }, { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQA=' } },
    ] } } });
  fixture.send({ toolCallCancellation: { ids: ['call-cancelled'] } });
  fixture.send({ sessionResumptionUpdate: { newHandle: 'next-private-token', resumable: true } });
  await until(() => adapter.resumeHandle === 'next-private-token');
  assert.equal(r.interrupts, 1); assert.equal(r.audio.length, 1);
  assert.deepEqual(r.events.filter(e => e.type === 'transcript.fragment').map(e => e.payload.text), ['one ', 'two']);
  assert.ok(r.events.some(e => e.type === 'provider.work_state' && e.payload.state === 'IN_PROGRESS'));
  assert.ok(r.events.some(e => e.type === 'provider.tools_cancelled'));
  assert.doesNotMatch(JSON.stringify(r.events), /private|reasoning|next-private-token/);
  fixture.send({ sessionResumptionUpdate: { resumable: false, newHandle: '' } });
  await until(() => !adapter.resumeHandle);
  await adapter.close();
});

test('Gemini seeded history waits for explicit input and provider cancellation releases call IDs', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({ setupComplete: {} }); t.after(() => fixture.close());
  const r = recorder();
  const adapter = createProvider({ provider: 'gemini', model: 'gemini-3.8-live' }, r.callbacks,
    { ...fixture.options, history: 'Prior learner request: say hello.' });
  await adapter.connect();
  await until(() => fixture.messages.length === 2);
  assert.equal(fixture.messages[0].setup.historyConfig, undefined);
  assert.equal(fixture.messages[1].clientContent.turnComplete, false);
  assert.match(fixture.messages[1].clientContent.turns[0].parts[0].text, /not a new learner request/);
  adapter.sendText('Now say Ready.');
  await until(() => fixture.messages.length === 3);
  assert.equal(fixture.messages[2].clientContent.turnComplete, true);
  const calls = Array.from({ length: 256 }, (_, i) => ({ id: `cancel-${i}`, name: 'clear_hud', args: {} }));
  fixture.send({ toolCall: { functionCalls: calls } });
  await until(() => r.calls.length === 256);
  fixture.send({ toolCallCancellation: { ids: calls.map(call => call.id) } });
  await until(() => r.events.some(event => event.type === 'provider.tools_cancelled'));
  assert.throws(() => adapter.toolResult('cancel-0', {}), /Unknown provider tool call/);
  fixture.send({ toolCall: { functionCalls: [{ id: 'after-cancellation', name: 'clear_hud', args: {} }] } });
  await until(() => r.calls.length === 257);
  assert.equal(r.errors.length, 0);
  adapter.toolResult('after-cancellation', { status: 'applied' });
  await adapter.close();
});

test('closing during provider setup settles connect immediately and ignores late setup', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({}); t.after(() => fixture.close());
  const r = recorder();
  const adapter = createProvider({ provider: 'gemini', model: 'gemini-3.8-live' }, r.callbacks,
    { ...fixture.options, connectTimeoutMs: 10000 });
  const rejected = assert.rejects(adapter.connect(), /closed before ready/);
  await until(() => fixture.messages.length === 1);
  const closing = adapter.close();
  fixture.send({ setupComplete: {} });
  await rejected;
  await closing;
  assert.equal(r.events.filter(event => event.type === 'provider.ready').length, 0);
  assert.equal(r.errors.length, 0);
});

test('GPT Live uses native startup, cumulative usage, delegated context and graceful close', async t => {
  process.env.OPENAI_API_KEY = 'test-only-openai';
  const fixture = await wire({ type: 'session.started', session: { id: 'live-conversation' } }); t.after(() => fixture.close());
  const r = recorder();
  const adapter = createProvider({ provider: 'openai', model: 'gpt-live-1' }, r.callbacks, fixture.options);
  await adapter.connect();
  assert.equal(fixture.endpoint, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(fixture.messages[0].type, 'session.start');
  assert.deepEqual(fixture.messages[0].session.delegation, { type: 'client' });
  adapter.sendAudio(Buffer.from([1, 0])); adapter.activity(false);
  adapter.appendContext('The observer inferred a blue block; capture time is uncertain.', 'opaque-item-id');
  await until(() => fixture.messages.length === 3);
  assert.equal(fixture.messages[1].type, 'session.input_audio.append');
  assert.equal(fixture.messages[2].type, 'session.thinking.append');
  assert.equal(fixture.messages[2].delegation_id, 'opaque-item-id');
  fixture.send({ type: 'session.input_transcript.delta', delta: 'hello ', start_ms: 10, end_ms: 30, event_id: 'caption-1' });
  fixture.send({ type: 'session.delegation.created', delegation: { id: 'opaque-item-id', target: 'client' }, offset_ms: 42, event_id: 'delegated' });
  fixture.send({ type: 'session.output_audio.delta', delta: 'AQA=' });
  fixture.send({ type: 'session.usage.updated', usage: { seconds: 3.5, secret: 'must not survive' }, event_id: 'usage-1' });
  fixture.send({ type: 'session.thinking.appended', event_id: 'ack-1', client_event_id: fixture.messages[2].event_id, start_ms: 42, end_ms: 42 });
  await until(() => r.events.some(e => e.type === 'context.acknowledged'));
  assert.deepEqual(r.delegations, [{ id: 'opaque-item-id', offsetMs: 42 }]);
  assert.deepEqual(r.events.find(e => e.type === 'usage.reported')?.payload.values, { seconds: 3.5 });
  assert.equal(r.events.find(e => e.type === 'usage.reported')?.payload.mode, 'cumulative');
  assert.equal(r.events.find(e => e.type === 'transcript.fragment')?.payload.text, 'hello ');
  assert.equal(r.audio.length, 1);
  assert.throws(() => adapter.inspect(Buffer.from('frame'), 'image/png', 'question'), /no image input/);
  await adapter.close();
  assert.ok(r.events.some(e => e.type === 'usage.reported' && e.payload.final === true));
  assert.ok(r.events.some(e => e.type === 'closed' && e.payload.reason === 'finalized'));
  assert.ok(!fixture.messages.some(m => /^(input_audio_buffer|response\.)/.test(m.type || '')));
});

test('GPT context chunks stay below the documented append limit without corrupting Unicode', async t => {
  process.env.OPENAI_API_KEY = 'test-only-openai';
  const fixture = await wire({ type: 'session.started', session: { id: 'live-conversation' } }); t.after(() => fixture.close());
  const adapter = createProvider({ provider: 'openai', model: 'gpt-live-1' }, recorder().callbacks, fixture.options);
  await adapter.connect();
  const text = 'Evidence 🧭: '.repeat(100);
  adapter.appendContext(text);
  await until(() => fixture.messages.slice(1).map(m => m.content).join('') === text);
  assert.ok(fixture.messages.slice(1).every(m => Buffer.byteLength(m.content) <= 450 && m.delegation_id === null));
  await adapter.close();
});

test('startup errors are bounded and do not expose vendor error text or keys', async t => {
  process.env.OPENAI_API_KEY = 'test-only-openai';
  const fixture = await wire({ type: 'error', error: { message: 'secret-key-and-signed-url' } }); t.after(() => fixture.close());
  const r = recorder();
  const adapter = createProvider({ provider: 'openai', model: 'gpt-live-1' }, r.callbacks, fixture.options);
  await assert.rejects(adapter.connect(), /rejected a request/);
  assert.doesNotMatch(r.errors.map(e => e.message).join(), /secret-key/);
});

test('missing setup and missing final usage each terminate within their deadline', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini'; process.env.OPENAI_API_KEY = 'test-only-openai';
  const stalled = await wire({}); t.after(() => stalled.close());
  const gemini = createProvider({ provider: 'gemini', model: 'gemini-3.8-live' }, recorder().callbacks,
    { ...stalled.options, connectTimeoutMs: 30 });
  await assert.rejects(gemini.connect(), /setup timed out/);
  const fixture = await wire({ type: 'session.started', session: { id: 'unfinished' } }, false); t.after(() => fixture.close());
  const r = recorder();
  const openai = createProvider({ provider: 'openai', model: 'gpt-live-1' }, r.callbacks, fixture.options);
  await openai.connect();
  await assert.rejects(openai.close(), /without final usage/);
  await until(() => r.events.some(e => e.type === 'closed'));
  await assert.rejects(openai.close(), /without final usage/);
});

test('slow provider fences audio at 250 ms and requires reconnect instead of stitching a discontinuity', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({ setupComplete: {} }); t.after(() => fixture.close());
  const r = recorder(); let client: WebSocket;
  const adapter = createProvider({ provider: 'gemini', model: 'gemini-3.8-live' }, r.callbacks,
    { ...fixture.options, socketFactory: (url, options) => { client = fixture.options.socketFactory!(url, options); return client; } });
  await adapter.connect();
  Object.defineProperty(client!, 'bufferedAmount', { value: 11000 });
  adapter.sendAudio(Buffer.from([1, 0]));
  assert.ok(r.events.some(e => e.type === 'media.discontinuity' && e.payload.reason === 'provider_backpressure'));
  assert.match(r.errors[0].message, /250 ms/);
  assert.throws(() => adapter.sendAudio(Buffer.from([1, 0])), /not ready/);
  assert.throws(() => adapter.sendText('Hello'), /not ready/);
  assert.equal(fixture.messages.length, 1);
  await adapter.close();
});

test('observer binds one image to one question and validates structured inference', async () => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  let request: any;
  const fetchImpl: typeof fetch = async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
      visibility: 'partial', claims: ['A blue block is visible.'], limitations: ['The label is obscured.'],
    }) }] } }], usageMetadata: { totalTokenCount: 40 } });
  };
  const result = await observeFrame(Buffer.from('pinned-pixels'), 'image/png', 'What is visible?', new AbortController().signal, { fetchImpl });
  assert.equal(Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64').toString(), 'pinned-pixels');
  assert.match(request.contents[0].parts[1].text, /What is visible/);
  assert.equal(request.generationConfig.responseMimeType, 'application/json');
  assert.ok(request.generationConfig.responseJsonSchema.properties.visibility);
  assert.equal(result.visibility, 'partial'); assert.equal(result.usage.totalTokenCount, 40);
  assert.match(result.attribution, /model inference/);
  const invalid: typeof fetch = async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"visibility":"certain"}' }] } }] });
  await assert.rejects(observeFrame(Buffer.from('pinned-pixels'), 'image/png', 'What?', new AbortController().signal, { fetchImpl: invalid }), /invalid structured/);
});

test('task handler rejects invented tool actions and aborts before an inference request', async () => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const clarification = await inferTask('', {}, new AbortController().signal);
  assert.equal(clarification.action, 'clarify');
  const fetchImpl: typeof fetch = async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    action: 'set_hud', message: 'Show the requested reminder.', hud: { card: { body: 'Inspect the setup.' } }, question: null,
  }) }] } }] });
  const result = await inferTask('Show a reminder to inspect the setup', { hud: {} }, new AbortController().signal, { fetchImpl });
  assert.deepEqual(result.args, { card: { body: 'Inspect the setup.' } });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(inferTask('show card', {}, cancelled.signal, { fetchImpl }), { name: 'AbortError' });
  const invalid: typeof fetch = async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"action":"execute_shell","message":"go","hud":null,"question":null}' }] } }] });
  await assert.rejects(inferTask('show card', {}, new AbortController().signal, { fetchImpl: invalid }), /invalid structured/);
});

test('mock emits labeled audible PCM and close fences delayed tools and audio', async () => {
  const r = recorder(); const adapter = createProvider({ provider: 'mock', model: 'mock-coach-v1' }, r.callbacks);
  await adapter.connect(); adapter.sendText('show card');
  await until(() => r.calls.length === 1 && r.audio.length > 0);
  assert.equal(r.calls[0].name, 'set_hud');
  assert.ok(r.audio[0].some(byte => byte !== 0));
  assert.ok(r.events.some(e => e.type === 'playback.simulated' && e.payload.kind === 'tone'));
  adapter.sendText('delayed card'); await adapter.close();
  const count = r.audio.length; await pause(60); assert.equal(r.audio.length, count); assert.equal(r.calls.length, 1);
});
