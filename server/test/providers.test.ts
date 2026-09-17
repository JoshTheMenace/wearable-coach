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
  assert.deepEqual(fixture.messages[0].setup.tools[0].functionDeclarations.map((tool:{name:string;behavior:string})=>[tool.name,tool.behavior]),[
    ['play_training_video','NON_BLOCKING'],['lesson_action','NON_BLOCKING'],['set_hud','NON_BLOCKING'],['clear_hud','NON_BLOCKING'],['inspect_frame','BLOCKING'],['lookup_training_reference','BLOCKING'],
  ]);
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

test('Gemini reference lookup preserves its query, source payload and opaque response ID', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({ setupComplete: {} }); t.after(() => fixture.close());
  const r = recorder();
  const adapter = createProvider({ provider: 'gemini', model: 'gemini-3.8-live' }, r.callbacks, fixture.options);
  await adapter.connect();
  const lookup = fixture.messages[0].setup.tools[0].functionDeclarations.find((tool: { name: string }) => tool.name === 'lookup_training_reference');
  assert.equal(lookup.behavior, 'BLOCKING');
  assert.deepEqual(lookup.parameters.required, ['query']);
  assert.equal(lookup.parameters.properties.query.maxLength, 1200);
  assert.equal(lookup.parameters.properties.limit.maximum, 5);
  const args = { query: 'What does the CPR reference say about hand placement?', limit: 2 };
  fixture.send({ toolCall: { functionCalls: [{ id: 'reference-opaque-71', name: lookup.name, args }] } });
  await until(() => r.calls.length === 1);
  assert.deepEqual(r.calls[0], { id: 'reference-opaque-71', name: 'lookup_training_reference', args });
  const response = { status: 'found', dataset: { version: 'fixture-v1' }, results: [{ id: 'fact-1', source: { title: 'Fixture reference', year: 2025 } }] };
  adapter.toolResult('reference-opaque-71', response);
  await until(() => fixture.messages.length === 2);
  assert.deepEqual(fixture.messages[1].toolResponse.functionResponses, [{ id: 'reference-opaque-71', name: lookup.name, response }]);
  assert.throws(() => adapter.toolResult('reference-opaque-71', response), /Unknown provider tool call/);
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

test('GPT native inspection sends full evidence as thinking before a spoken instruction with the same delegation ID',async t=>{
  process.env.OPENAI_API_KEY='test-only-openai';
  const fixture=await wire({type:'session.started',session:{id:'inspection'}});t.after(()=>fixture.close());
  const adapter=createProvider({provider:'openai',model:'gpt-live-1'},recorder().callbacks,fixture.options);
  await adapter.connect();
  const result={status:'context_dispatched',frameId:'frame-one',observation:{claims:['界'.repeat(1200)],limitations:['Capture age is unknown.']},instruction:'Describe the supplied observation briefly and mention its unknown age.'};
  adapter.toolResult('inspection-delegation',result);
  await until(()=>fixture.messages.some(message=>message.type==='session.commentary.append'));
  const messages=fixture.messages.slice(1),spoken=messages.filter(message=>message.type==='session.commentary.append');
  assert.equal(messages.filter(message=>message.type==='session.thinking.append').map(message=>message.content).join(''),JSON.stringify(result));
  assert.equal(spoken.map(message=>message.content).join(''),result.instruction);
  assert.ok(messages.every(message=>message.delegation_id==='inspection-delegation'&&Buffer.byteLength(message.content)<=450));
  assert.equal(messages.at(-1).type,'session.commentary.append');assert.ok(messages.slice(0,-1).every(message=>message.type==='session.thinking.append'));
  await adapter.close();
});

test('GPT cancelled native outcomes update thinking without speaking cancellation JSON',async t=>{
  process.env.OPENAI_API_KEY='test-only-openai';
  const fixture=await wire({type:'session.started',session:{id:'cancelled-inspection'}});t.after(()=>fixture.close());
  const adapter=createProvider({provider:'openai',model:'gpt-live-1'},recorder().callbacks,fixture.options);
  await adapter.connect();
  const result={status:'cancelled',reason:'new_inspection',applicationEffect:'not_applied'};
  adapter.toolResult('cancelled-delegation',result);
  await until(()=>fixture.messages.length===2);
  assert.deepEqual(fixture.messages.slice(1).map(message=>({type:message.type,content:message.content,delegation_id:message.delegation_id})),[
    {type:'session.thinking.append',content:JSON.stringify(result),delegation_id:'cancelled-delegation'},
  ]);
  await adapter.close();
  assert.ok(!fixture.messages.some(message=>message.type==='session.commentary.append'));
});

test('GPT delegated lookup appends reference data before requesting a sourced answer', async t => {
  process.env.OPENAI_API_KEY = 'test-only-openai';
  const fixture = await wire({ type: 'session.started', session: { id: 'reference-session' } }); t.after(() => fixture.close());
  const adapter = createProvider({ provider: 'openai', model: 'gpt-live-1' }, recorder().callbacks, fixture.options);
  await adapter.connect();
  assert.match(fixture.messages[0].session.instructions, /Delegate requests for CPR\/AED reference lookup/);
  const result = { status: 'context_dispatched', reference: { status: 'no_match', results: [] },
    instruction: 'Explain that the reference lookup found no matching facts; do not supply guidance from memory.' };
  adapter.toolResult('reference-delegation', result);
  await until(() => fixture.messages.some(message => message.type === 'session.commentary.append'));
  const messages = fixture.messages.slice(1);
  assert.equal(messages.filter(message => message.type === 'session.thinking.append').map(message => message.content).join(''), JSON.stringify(result));
  assert.equal(messages.at(-1).type, 'session.commentary.append');
  assert.equal(messages.at(-1).content, result.instruction);
  assert.ok(messages.every(message => message.delegation_id === 'reference-delegation'));
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

test('task handler maps reference questions to lookup queries and rejects missing or oversized arguments', async () => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  let request: any;
  const infer = (question: string | null, action = 'lookup_training_reference') => inferTask('Look up the CPR training reference', {}, new AbortController().signal, {
    fetchImpl: async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ action, message: 'Look up the training reference.', hud: null, question }) }] } }] });
    },
  });
  const result = await infer('  CPR hand placement  ');
  assert.equal(result.action, 'lookup_training_reference');
  assert.deepEqual(result.args, { query: 'CPR hand placement' });
  assert.ok(request.generationConfig.responseJsonSchema.properties.action.enum.includes('lookup_training_reference'));
  assert.match(request.systemInstruction.parts[0].text, /facts do not prove learner performance/);
  await assert.rejects(infer(null), /required action arguments/);
  await assert.rejects(infer('   '), /required action arguments/);
  await assert.rejects(infer('q'.repeat(1201)), /invalid structured result/);
  assert.equal((await infer('q'.repeat(1200))).args.query, 'q'.repeat(1200));
  await assert.rejects(infer('q'.repeat(1001), 'inspect_frame'), /required action arguments/);
});

test('mock lookup and reference prefixes take precedence over camera inspection', async () => {
  const r = recorder(); const adapter = createProvider({ provider: 'mock', model: 'mock-coach-v1' }, r.callbacks);
  await adapter.connect();
  adapter.sendText('lookup CPR hand placement');
  adapter.sendText(' Reference can the camera measure depth?');
  await until(() => r.calls.length === 2);
  assert.deepEqual(r.calls.map(({ name, args }) => ({ name, args })), [
    { name: 'lookup_training_reference', args: { query: 'CPR hand placement' } },
    { name: 'lookup_training_reference', args: { query: 'can the camera measure depth?' } },
  ]);
  await adapter.close();
});

test('Gemini video uses realtime input without starting a turn and drops congested frames', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({ setupComplete: {} }); t.after(() => fixture.close());
  const r = recorder();let client:WebSocket;
  const adapter = createProvider({provider:'gemini',model:'gemini-3.8-live'},r.callbacks,{
    ...fixture.options,socketFactory:(url,options)=>client=fixture.options.socketFactory!(url,options),
  });
  await adapter.connect();
  assert.equal(adapter.sendVideo!(Buffer.from('camera-frame'),'image/jpeg'),true);
  await until(()=>fixture.messages.length===2);
  assert.deepEqual(fixture.messages[1],{realtimeInput:{video:{mimeType:'image/jpeg',data:Buffer.from('camera-frame').toString('base64')}}});
  Object.defineProperty(client!,'bufferedAmount',{value:1000,configurable:true});
  assert.equal(adapter.sendVideo!(Buffer.from('frame-with-audio'),'image/jpeg'),true);
  await until(()=>fixture.messages.length===3);
  Object.defineProperty(client!,'bufferedAmount',{value:11000});
  assert.equal(adapter.sendVideo!(Buffer.from('dropped-frame'),'image/jpeg'),false);
  assert.throws(()=>adapter.sendVideo!(Buffer.alloc(256*1024+1),'image/jpeg'),/256 KiB/);
  await pause();assert.equal(fixture.messages.length,3);assert.equal(r.errors.length,0);
  await adapter.close();
});

test('queued video does not consume the audio budget or conceal a growing audio queue', async t => {
  process.env.GEMINI_KEY = 'test-only-gemini';
  const fixture = await wire({ setupComplete: {} }); t.after(() => fixture.close());
  const r=recorder();let client:WebSocket;
  const adapter=createProvider({provider:'gemini',model:'gemini-3.8-live'},r.callbacks,{
    ...fixture.options,socketFactory:(url,options)=>client=fixture.options.socketFactory!(url,options),
  });
  await adapter.connect();
  // Simulate writes waiting on the transport; callbacks stay pending, including the video write.
  t.mock.method(client!,'send',()=>{});
  assert.equal(adapter.sendVideo!(Buffer.alloc(128*1024),'image/jpeg'),true);
  assert.equal(adapter.sendVideo!(Buffer.from('second-pending-frame'),'image/jpeg'),false);
  adapter.sendAudio(Buffer.alloc(3200));assert.equal(r.errors.length,0);
  adapter.sendAudio(Buffer.alloc(3200));assert.equal(r.errors.length,0);
  adapter.sendAudio(Buffer.alloc(3200));assert.match(r.errors[0].message,/250 ms/);
  await adapter.close();
});

test('Gemini advertises course start and returns rejected movie controls silently with their exact call ID',async t=>{
  process.env.GEMINI_KEY='test-only-gemini';
  const fixture=await wire({setupComplete:{}});t.after(()=>fixture.close());
  const r=recorder(),adapter=createProvider({provider:'gemini',model:'gemini-3.8-live'},r.callbacks,fixture.options);
  await adapter.connect();
  const tool=fixture.messages[0].setup.tools[0].functionDeclarations.find((tool:{name:string})=>tool.name==='lesson_action');
  assert.ok(tool.parameters.properties.action.enum.includes('start'));
  fixture.send({toolCall:{functionCalls:[{id:'pause-denied',name:'lesson_action',args:{action:'pause'}}]}});await until(()=>r.calls.length===1);
  const result={status:'rejected',retryable:false,silent:true,reason:'No fresh learner request'};
  adapter.toolResult('pause-denied',result);await until(()=>fixture.messages.length===2);
  assert.deepEqual(fixture.messages[1].toolResponse.functionResponses,[{id:'pause-denied',name:'lesson_action',response:result,scheduling:'SILENT'}]);
  await adapter.close();
});

test('task handler can propose the prepared course start from a Marine lobby',async()=>{
  process.env.GEMINI_KEY='test-only-gemini';
  const result=await inferTask('learner: Pull up some CPR training.',{tutorMode:'marine',hud:{brand:'marines'}},new AbortController().signal,{
    fetchImpl:async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({action:'lesson_action',question:'start',message:'I’ll pull that up.',hud:null})}]}}]}),
  });
  assert.deepEqual(result.args,{action:'start'});assert.equal(result.promptVersion,'task-handler-v7-course-navigation');
});

test('Gemini exposes four course tools with contextual navigation and preserves generic lobby tools',async t=>{
  process.env.GEMINI_KEY='test-only-gemini';
  for(const lessonActive of [true,false]){
    const fixture=await wire({setupComplete:{}});t.after(()=>fixture.close());
    const adapter=createProvider({provider:'gemini',model:'gemini-3.8-live'},recorder().callbacks,{...fixture.options,lessonActive});
    await adapter.connect();
    const tool=fixture.messages[0].setup.tools[0].functionDeclarations.find((tool:{name:string})=>tool.name==='lesson_action');
    assert.deepEqual(tool.parameters.properties.action.enum,lessonActive?['next','back','repeat','pause','resume','end_session']:['start','end_session']);
    const names=fixture.messages[0].setup.tools[0].functionDeclarations.map((tool:{name:string})=>tool.name);
    assert.deepEqual(names,lessonActive?['play_training_video','lesson_action','inspect_frame','lookup_training_reference']:['play_training_video','lesson_action','set_hud','clear_hud','inspect_frame','lookup_training_reference']);
    await adapter.close();
  }
});
