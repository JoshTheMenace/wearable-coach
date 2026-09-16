import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { Store } from '../src/store.ts';
import type { Command } from '../../contracts/index.ts';
import type { observeLessonFrame } from '../src/lesson-observer.ts';
import type { ProviderCallbacks, ProviderOptions } from '../src/providers/types.ts';

type Observation = Awaited<ReturnType<typeof observeLessonFrame>>;
const correct: Observation = { placement: 'correct', confidence: 0.95, reason: 'The hand heel is visible on the marked manikin target.',
  landmarksVisible: true, manikinVisible: true, model: 'test-observer', usage: { totalTokenCount: 12 }, promptVersion: 'fixture-v1' };
const pixels = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const capabilities = { video: true, source: 'device-local', maxWidth: 400, maxHeight: 400, maxPixels: 70000 };

async function setup(t: TestContext) {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const dir = mkdtempSync(join(tmpdir(), 'coach-lesson-')), store = new Store(join(dir, 'test.sqlite'));
  const requests: Array<{ bytes: Buffer; mime: string; fact: string; signal: AbortSignal; resolve: (value: Observation) => void; reject: (error: Error) => void }> = [];
  const instances: Array<{ callbacks: ProviderCallbacks; options?: ProviderOptions; contexts: Array<{ text: string; spoken?: boolean }>; results: Array<{ id: string; result: any }> }> = [];
  const coordinator = new Coordinator(store, dir, {
    createProvider: (_config, callbacks, options) => {
      const instance = { callbacks, options, contexts: [] as Array<{ text: string; spoken?: boolean }>, results: [] as Array<{ id: string; result: any }> };
      instances.push(instance);
      return { inputRate: 16000, outputRate: 24000, connect: async () => {}, close: async () => {}, sendAudio: () => {}, sendText: () => {},
        activity: () => {}, inspect: () => {}, sendVideo: () => true,
        appendContext: (text, _id, spoken) => instance.contexts.push({ text, spoken }), toolResult: (id, result) => instance.results.push({ id, result }) };
    },
    observeLessonFrame: (bytes, mime, fact, signal) => new Promise((resolve, reject) => requests.push({ bytes, mime, fact, signal, resolve, reject })),
  });
  t.after(async () => { requests.forEach(request => request.resolve(correct)); await settle(); await coordinator.close(); rmSync(dir, { recursive: true, force: true }); });
  const { id } = coordinator.create(randomUUID(), { provider: 'gemini', model: 'gemini-3.8-live', device: 'mock', lessonId: 'adult-cpr-demo-v1' });
  await settle();
  const state = () => coordinator.get(id);
  const command = (type: Command['type'], payload: Record<string, unknown> = {}) => coordinator.command(id, {
    schemaVersion: 1, sessionId: id, generation: state().generation, messageId: randomUUID(), commandId: randomUUID(), type, payload,
  });
  const action = (action: string, revision = state().lesson!.revision) => command('lesson_action', { action, expectedRevision: revision });
  const report = (type: string, payload: Record<string, unknown>) => coordinator.report(id, state().generation, randomUUID(), type, payload);
  const assets = (['overview', 'hand-placement'] as const).map(lessonKey => ({ id: randomUUID(), lessonKey, width: 320, height: 180, durationMs: lessonKey === 'overview' ? 10_000 : 4000, mime: 'video/mp4' }));
  const advertise = () => report('device.status', { displayCapabilities: capabilities, demoAssets: assets });
  const enterPlacement = () => { action('continue'); action('continue'); now += 1001; };
  const frame = (meta: Record<string, unknown> = {}) => coordinator.frame(id, randomUUID(), pixels, 'image/png', {
    generation: state().generation, liveVideo: true, liveVideoEpoch: state().liveVideoEpoch, frameAgeMs: 0, cameraSource: 'mock', ...meta,
  });
  return { coordinator, store, id, state, requests, instances, command, action, report, assets, advertise, enterPlacement, frame,
    advance: (ms = 1001) => { now += ms; }, events: () => store.events(id) };
}

test('CPR lesson starts with seeded facts and a durable intro; stale commands and free-form checkoffs cannot alter progress', async t => {
  const h = await setup(t);
  assert.equal(h.state().lesson?.phase, 'intro'); assert.equal(h.state().liveVideo, false);
  assert.match(h.instances[0].options?.instructions ?? '', /sternum/);
  assert.equal(h.events()[0].payload.coachPrompt,h.instances[0].options?.instructions);
  assert.equal(h.events()[0].payload.promptVersion,'coach-v4-cpr-lesson');
  assert.equal(h.state().hud.checklist?.length, 2);
  const initial = structuredClone(h.state().lesson);
  assert.throws(() => h.action('continue', 0), /changed|revision|stale/i);
  assert.deepEqual(h.state().lesson, initial);
  h.instances[0].callbacks.tool({ id: 'invented-pass', name: 'set_hud', args: { checklist: [{ id: 'placement', text: 'Passed', checked: true }] } });
  await settle();
  assert.equal(h.instances[0].results.at(-1)?.result.status, 'rejected');
  assert.deepEqual(h.state().lesson, initial);
  assert.ok(!h.state().hud.checklist?.some(row => row.checked));
});

test('observer checks submitted frames once at a time and delivers bounded correction before two-frame progression', async t => {
  const h = await setup(t); h.enterPlacement();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().liveVideo, true);
  await h.frame(); assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].bytes, pixels); assert.equal(h.requests[0].mime, 'image/png'); assert.match(h.requests[0].fact, /sternum/);
  h.advance(); await h.frame(); assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ ...correct, placement: 'too_low', reason: 'The heel is visibly below the manikin target.' }); await settle();
  assert.equal(h.state().lesson!.lastObservation?.placement, 'too_low');
  assert.ok(!('usage' in h.state().lesson!.lastObservation!));
  assert.match(h.state().hud.card?.body ?? '', /up/);
  const spoken = h.instances.flatMap(instance => instance.contexts).filter(context => context.spoken && /too low|too_low/.test(context.text));
  assert.equal(spoken.length, 1);
  assert.ok(!h.state().lesson!.completed.some(step => step.step === 'placement'));
  const revision = h.state().lesson!.revision;
  h.advance(); await h.frame(); h.requests.at(-1)!.resolve(correct); await settle();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().lesson!.revision, revision);
  h.advance(); await h.frame(); h.requests.at(-1)!.resolve(correct); await settle();
  assert.equal(h.state().lesson!.phase, 'practice');
  assert.equal(h.state().lesson!.completed.find(step => step.step === 'placement')?.evidence, 'simulated_observation');
  h.action('finish_practice');
  assert.equal(h.state().lesson!.phase, 'complete'); assert.equal(h.state().lesson!.completed.at(-1)?.evidence, 'learner_confirmed');
  assert.match(h.state().hud.card?.body ?? '', /not assessed/);
});

for (const reason of ['pause', 'restart', 'demonstration', 'video epoch', 'reconnect', 'end', 'typed input', 'provider interruption'] as const)
  test(`${reason} aborts and fences a late lesson observation`, async t => {
    const h = await setup(t); h.enterPlacement(); await h.frame();
    assert.equal(h.requests.length, 1);
    const old = h.instances[0];
    if (reason === 'pause') h.action('pause');
    if (reason === 'restart') h.action('restart');
    if (reason === 'demonstration') { h.advertise(); h.command('start_demo', { assetId: h.assets[1].id }); }
    if (reason === 'video epoch') { h.command('set_live_video', { enabled: false }); h.command('set_live_video', { enabled: true }); }
    if (reason === 'reconnect') h.coordinator.reconnect(h.id, h.state().generation, randomUUID());
    if (reason === 'end') await h.coordinator.end(h.id);
    if (reason === 'typed input') h.command('send_text', { text: 'Can I see the hand placement again?' });
    if (reason === 'provider interruption') old.callbacks.interrupted();
    await settle(); assert.equal(h.requests[0].signal.aborted, true);
    h.requests[0].resolve({ ...correct, placement: 'too_low' }); await settle();
    assert.equal(h.state().lesson!.observationSeq, 0);
    assert.ok(!h.instances.flatMap(instance => instance.contexts).some(context => context.spoken && /too low|too_low/.test(context.text)));
  });

test('an aged inference and a failed observer cannot fabricate placement progress or expose upstream secrets', async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame();
  h.advance(5001); h.requests[0].resolve(correct); await settle();
  assert.equal(h.state().lesson!.observationSeq, 0);
  await h.frame(); assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error('secret upstream URL or credential')); await settle();
  assert.ok(!h.state().lesson!.completed.some(step => step.step === 'placement'));
  assert.ok(!JSON.stringify({ events: h.events(), lesson: h.state().lesson }).includes('secret upstream'));
  assert.ok(h.state().lesson!.observerError || h.events().some(event => /observer/.test(event.type) && /failed|unavailable/.test(JSON.stringify(event.payload))));
});

test('a finding during learner speech updates the HUD and defers its spoken cue without consuming the cooldown', async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame();
  h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'Can I ask about my hands?'});
  h.requests[0].resolve({...correct,placement:'too_low'}); await settle();
  assert.match(h.state().hud.card!.body,/up/);
  assert.equal(h.state().lesson!.lastCorrectionAt,undefined);
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').at(-1)?.payload.delivery,'hud_only');
  assert.ok(!h.events().some(event=>event.type==='playback.flushed'&&event.payload.reason==='lesson_observer_feedback'));
  assert.equal(h.events().find(event=>event.type==='lesson.observer.started')?.payload.frameSha256,createHash('sha256').update(pixels).digest('hex'));
  assert.equal(h.coordinator.export(h.id).evidenceCoverage.liveVideoInterpretation,'lesson_observer_model_text_without_retained_images');
  h.advance(2001); await h.frame(); h.requests[1].resolve({...correct,placement:'too_low'}); await settle();
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').at(-1)?.payload.delivery,'requested');
  assert.equal(h.state().lesson!.lastCorrectionAt,Date.now());
});

test('only an explicit device control can continue without a visual placement check', async t => {
  const h = await setup(t); h.enterPlacement();
  h.instances[0].callbacks.tool({id:'skip-camera',name:'lesson_action',args:{action:'continue'}}); await settle();
  assert.equal(h.instances[0].results.at(-1)?.result.status,'rejected');
  assert.equal(h.state().lesson!.phase,'placement');
  h.action('continue');
  assert.equal(h.state().lesson!.phase,'practice');
  assert.equal(h.state().lesson!.completed.find(step=>step.step==='placement')?.evidence,'learner_confirmed');
});

test('losing camera freshness replaces the old correction card with a waiting cue', async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame();
  h.requests[0].resolve({...correct,placement:'too_low'}); await settle();
  assert.match(h.state().hud.card!.body,/up/);
  h.advance(5001);
  (h.coordinator as unknown as {sweep:()=>void}).sweep();
  assert.equal(h.state().lesson!.observerStatus,'waiting_for_camera');
  assert.doesNotMatch(h.state().hud.card!.body,/Move up/);
  assert.equal(h.state().lesson!.lastObservation?.placement,'too_low');
});

test('replacing a camera epoch starts fresh placement evidence rather than combining both sides of a seek', async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame(); h.requests[0].resolve(correct); await settle();
  assert.equal(h.state().lesson!.correctStreak, 1);
  h.command('set_live_video', { enabled: false }); h.command('set_live_video', { enabled: true });
  h.advance(); await h.frame(); h.requests[1].resolve(correct); await settle();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().lesson!.correctStreak, 1);
  h.advance(); await h.frame(); h.requests[2].resolve(correct); await settle();
  assert.equal(h.state().lesson!.phase, 'practice');
});

test('overview video completion advances once, while a semantic hand-placement replay retains phase and resumes the camera', async t => {
  const h = await setup(t); h.advertise(); h.action('continue'); h.command('play_training_video', { clipId: 'overview' });
  const overview = h.state().demonstration!;
  assert.ok(overview); assert.equal(overview.lessonKey, 'overview'); assert.equal(h.state().lesson!.phase, 'demonstration');
  h.report('demo.playback', { requestId: overview.requestId, status: 'playing' });
  h.report('demo.playback', { requestId: overview.requestId, status: 'ended' }); await settle();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().liveVideo, true);
  assert.equal(h.state().lesson!.completed.find(step => step.step === 'demonstration')?.evidence, 'video_ended');
  h.advertise();
  const instance = h.instances.at(-1)!;
  instance.callbacks.tool({ id: 'hand-replay', name: 'play_training_video', args: { clipId: 'hand-placement' } }); await settle();
  const replay = h.state().demonstration!;
  assert.ok(replay); assert.equal(replay.assetId, h.assets[1].id); assert.equal(replay.lessonKey, 'hand-placement');
  instance.callbacks.tool({ id: 'hand-replay', name: 'play_training_video', args: { clipId: 'hand-placement' } }); await settle();
  assert.equal(h.state().demonstration?.requestId, replay.requestId);
  assert.equal(h.events().filter(event => event.type === 'demo.started' && event.payload.requestId === replay.requestId).length, 1);
  assert.equal(h.state().liveVideo, false); assert.equal(h.state().lesson!.phase, 'placement');
  await assert.rejects(h.frame(), /suspended/);
  h.report('demo.playback', { requestId: replay.requestId, status: 'ended' }); await settle();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().liveVideo, true);
  assert.equal(h.state().lesson!.completed.filter(step => step.step === 'demonstration').length, 1);
  assert.equal(h.state().lesson!.completed.some(step => step.step === 'placement'), false);
});

test('failed and stopped demonstration playback never check off watching the overview', async t => {
  const h = await setup(t); h.advertise(); h.action('continue'); h.command('play_training_video', { clipId: 'overview' });
  const failed = h.state().demonstration!;
  h.report('demo.playback', { requestId: failed.requestId, status: 'failed', reason: 'Decode failure' }); await settle();
  assert.equal(h.state().lesson!.phase, 'demonstration');
  assert.ok(!h.state().lesson!.completed.some(step => step.step === 'demonstration'));
  h.advertise(); h.command('start_demo', { assetId: h.assets[0].id });
  h.command('stop_demo', { requestId: h.state().demonstration!.requestId }); await settle();
  assert.equal(h.state().lesson!.phase, 'demonstration');
  assert.ok(!h.state().lesson!.completed.some(step => step.step === 'demonstration'));
});

for (const cameraEnabled of [true, false]) test(`short replay resets placement evidence and restores explicit camera ${cameraEnabled ? 'on' : 'off'} state`, async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame(); h.requests[0].resolve(correct); await settle();
  assert.equal(h.state().lesson!.correctStreak, 1);
  if (!cameraEnabled) h.command('set_live_video', { enabled: false });
  h.advertise(); h.command('play_training_video', { clipId: 'hand-placement' });
  assert.equal(h.state().lesson!.correctStreak, 0);
  h.report('demo.playback', { requestId: h.state().demonstration!.requestId, status: 'ended' }); await settle();
  assert.equal(h.state().liveVideo, cameraEnabled); assert.equal(h.state().lesson!.phase, 'placement');
  if (!cameraEnabled) h.command('set_live_video', { enabled: true });
  h.advance(); await h.frame(); h.requests[1].resolve(correct); await settle();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().lesson!.correctStreak, 1);
  h.advance(); await h.frame(); h.requests[2].resolve(correct); await settle();
  assert.equal(h.state().lesson!.phase, 'practice');
});

test('native finish requires a recent affirmative learner confirmation after placement', async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame(); h.requests[0].resolve(correct); await settle();
  h.advance(); await h.frame(); h.requests[1].resolve(correct); await settle();
  assert.equal(h.state().lesson!.phase, 'practice');
  const instance = h.instances[0];
  const finish = async () => {
    instance.callbacks.tool({ id: randomUUID(), name: 'lesson_action', args: { action: 'finish_practice' } }); await settle();
    return instance.results.at(-1)!.result;
  };
  assert.equal((await finish()).status, 'rejected'); assert.equal(h.state().lesson!.phase, 'practice');
  h.command('send_text', { text: "I'm not done yet." });
  assert.equal((await finish()).status, 'rejected'); assert.equal(h.state().lesson!.phase, 'practice');
  h.command('send_text', { text: "I'm done." });
  assert.equal((await finish()).status, 'applied'); assert.equal(h.state().lesson!.phase, 'complete');
  assert.equal(h.state().lesson!.completed.at(-1)?.evidence, 'learner_confirmed');
  assert.ok(h.events().some(event => event.type === 'lesson.learner_confirmation'));
});
