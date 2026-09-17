import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { Store } from '../src/store.ts';
import { lessonVideoStarted, lessonVideoEnded } from '../src/lesson.ts';
import type { Command, SessionConfig } from '../../contracts/index.ts';
import type { observeLessonFrame } from '../src/lesson-observer.ts';
import type { ProviderCallbacks, ProviderOptions } from '../src/providers/types.ts';

type Observation = Awaited<ReturnType<typeof observeLessonFrame>>;
const correct: Observation = { placement: 'correct', confidence: 0.95, reason: 'The hand heel is visible on the marked manikin target.',
  landmarksVisible: true, manikinVisible: true, model: 'test-observer', usage: { totalTokenCount: 12 }, promptVersion: 'fixture-v1' };
const pixels = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const capabilities = { video: true, source: 'device-local', maxWidth: 400, maxHeight: 400, maxPixels: 70000 };

async function setup(t: TestContext, config: Partial<SessionConfig> = {}) {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const dir = mkdtempSync(join(tmpdir(), 'coach-lesson-')), store = new Store(join(dir, 'test.sqlite'));
  const requests: Array<{ bytes: Buffer; mime: string; fact: string; signal: AbortSignal; resolve: (value: Observation) => void; reject: (error: Error) => void }> = [];
  const instances: Array<{ callbacks: ProviderCallbacks; options?: ProviderOptions; audio: Buffer[]; videos: Buffer[]; contexts: Array<{ text: string; spoken?: boolean }>; results: Array<{ id: string; result: any }> }> = [];
  const coordinator = new Coordinator(store, dir, {
    createProvider: (_config, callbacks, options) => {
      const instance = { callbacks, options, audio: [] as Buffer[], videos: [] as Buffer[], contexts: [] as Array<{ text: string; spoken?: boolean }>, results: [] as Array<{ id: string; result: any }> };
      instances.push(instance);
      return { inputRate: 16000, outputRate: 24000, connect: async () => {}, close: async () => {}, sendAudio: pcm => instance.audio.push(pcm), sendText: () => {},
        activity: () => {}, inspect: () => {}, sendVideo: bytes => {instance.videos.push(bytes);return true;},
        appendContext: (text, _id, spoken) => instance.contexts.push({ text, spoken }), toolResult: (id, result) => instance.results.push({ id, result }) };
    },
    observeLessonFrame: (bytes, mime, fact, signal) => new Promise((resolve, reject) => requests.push({ bytes, mime, fact, signal, resolve, reject })),
  });
  t.after(async () => { requests.forEach(request => request.resolve(correct)); await settle(); await coordinator.close(); rmSync(dir, { recursive: true, force: true }); });
  const { id } = coordinator.create(randomUUID(), { provider: 'gemini', model: 'gemini-3.8-live', device: 'mock', lessonId: 'adult-cpr-demo-v1', ...config });
  await settle();
  const state = () => coordinator.get(id);
  const command = (type: Command['type'], payload: Record<string, unknown> = {}) => coordinator.command(id, {
    schemaVersion: 1, sessionId: id, generation: state().generation, messageId: randomUUID(), commandId: randomUUID(), type, payload,
  });
  const action = (action: string, revision = state().lesson!.revision) => command('lesson_action', { action, expectedRevision: revision });
  const report = (type: string, payload: Record<string, unknown>) => coordinator.report(id, state().generation, randomUUID(), type, payload);
  const assets = (['overview', 'hand-placement'] as const).map(lessonKey => ({ id: randomUUID(), lessonKey, width: 320, height: 180, durationMs: lessonKey === 'overview' ? 10_000 : 4000, mime: 'video/mp4' }));
  const advertise = () => report('device.status', { displayCapabilities: capabilities, demoAssets: assets });
  const enterPlacement = (ready=true) => {
    coordinator.mutate(id,s=>{s.lesson=lessonVideoEnded(lessonVideoStarted(s.lesson!,'overview',now-2),'overview',true,now-1);});
    if(ready)action('ready');now+=1001;
  };
  const visible=()=>report('hud.receipt',{hudRevision:state().hudRevision,rendererInstanceId:'fixture',target:'glasses',status:'sdk_submitted'});
  const cue=()=>{
    visible();coordinator.audio(id,state().generation,Buffer.alloc(640));
    const current=instances.at(-1)!;current.callbacks.audio(Buffer.alloc(1600));current.callbacks.event('provider.utterance_complete',{});
    report('playback.metric',{speechEpoch:state().speechEpoch,metrics:{pendingMs:0,writtenSamples:800}});
    assert.equal(state().demonstration?.status,'starting');
  };
  const frame = (meta: Record<string, unknown> = {}) => coordinator.frame(id, randomUUID(), pixels, 'image/png', {
    generation: state().generation, liveVideo: true, liveVideoEpoch: state().liveVideoEpoch, frameAgeMs: 0, cameraSource: 'mock', ...meta,
  });
  return { coordinator, store, id, state, requests, instances, command, action, report, assets, advertise, enterPlacement, frame,
    visible,cue,advance: (ms = 1001) => { now += ms; }, events: () => store.events(id) };
}

for (const device of ['phone', 'meta_display', 'mock'] as const)
  test(`${device} authored opening waits for readiness and is not repeated on reconnect`, async t => {
    const h=await setup(t,{device}),spoken=()=>h.instances.at(-1)!.contexts.filter(context=>context.spoken);
    assert.equal(spoken().length,device==='mock'?1:0);
    h.command('set_mic',{muted:true});h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640,7));
    assert.equal(spoken().length,device==='meta_display'?0:1);
    if(device==='meta_display'){
      h.report('hud.receipt',{hudRevision:0,rendererInstanceId:'fixture',target:'glasses',status:'sdk_submitted'});
      assert.equal(spoken().length,0);h.visible();
    }
    assert.equal(spoken().length,1);assert.match(spoken()[0].text,/We’ll practise the basics/);
    assert.deepEqual(h.instances.at(-1)!.audio[0],Buffer.alloc(640));
    assert.ok(h.state().lesson!.narratedPages!.includes('cpr-opening'));
    const oldGeneration=h.state().generation;h.coordinator.reconnect(h.id,oldGeneration,randomUUID());await settle();
    assert.throws(()=>h.coordinator.audio(h.id,oldGeneration,Buffer.alloc(640)),/Stale/);
    h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));h.visible();
    assert.equal(spoken().length,0);assert.ok(h.instances.at(-1)!.contexts.some(context=>/Restore the same page silently/.test(context.text)));
    h.action('repeat');h.visible();assert.equal(spoken().length,1);
    h.action('restart');h.visible();assert.equal(spoken().length,2);assert.match(spoken().at(-1)!.text,/We’ll practise the basics/);
  });

test('paused native lesson defers its authored explanation until resume and current display receipt',async t=>{
  const h=await setup(t,{device:'meta_display'});h.action('pause');h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));
  h.visible();assert.ok(!h.instances[0].contexts.some(context=>context.spoken));
  h.action('resume');assert.ok(!h.instances[0].contexts.some(context=>context.spoken));
  h.visible();assert.equal(h.instances[0].contexts.filter(context=>context.spoken).length,1);
});

test('video waits for visible preparing page, generated cue and playback drain before native playback',async t=>{
  const h=await setup(t,{device:'meta_display'});h.advertise();h.command('play_training_video',{clipId:'overview'});
  const requestId=h.state().demonstration!.requestId;
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));
  assert.ok(!h.instances[0].contexts.some(context=>context.spoken));
  h.report('demo.playback',{requestId,status:'ended'});assert.equal(h.state().demonstration!.status,'cueing');
  assert.equal(h.state().lesson!.phase,'demonstration');assert.equal(h.state().hud.lessonPage!.body,'Preparing your video…');
  h.visible();assert.equal(h.instances[0].contexts.filter(context=>context.spoken).length,1);
  h.instances[0].callbacks.audio(Buffer.alloc(1600));h.instances[0].callbacks.event('provider.utterance_complete',{});
  h.report('playback.metric',{speechEpoch:h.state().speechEpoch-1,metrics:{pendingMs:0,writtenSamples:800}});assert.equal(h.state().demonstration!.status,'cueing');
  h.report('playback.metric',{speechEpoch:h.state().speechEpoch,metrics:{pendingMs:40,writtenSamples:800}});assert.equal(h.state().demonstration!.status,'cueing');
  h.report('playback.metric',{speechEpoch:h.state().speechEpoch,metrics:{pendingMs:0,writtenSamples:800}});assert.equal(h.state().demonstration!.status,'starting');
  assert.ok(h.events().some(event=>event.type==='demo.cue.finished'));
});

test('an interrupted video cue waits for the answer then restarts before playback',async t=>{
  const h=await setup(t,{device:'meta_display'});h.advertise();h.command('play_training_video',{clipId:'overview'});
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));h.visible();
  const instance=h.instances[0],spoken=()=>instance.contexts.filter(context=>context.spoken).length;
  const requestId=h.state().demonstration!.requestId;
  instance.callbacks.audio(Buffer.alloc(1600));instance.callbacks.interrupted();
  instance.callbacks.event('provider.utterance_complete',{});
  assert.equal(spoken(),1);assert.equal(h.state().demonstration!.status,'cueing');
  h.advance(30001);(h.coordinator as any).sweep();
  assert.equal(h.state().status,'active');assert.equal(h.state().demonstration!.requestId,requestId);
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'What should I watch for?'});
  instance.callbacks.event('transcript.fragment',{speaker:'assistant',text:'Watch the lower hand’s contact point.'});
  instance.callbacks.audio(Buffer.alloc(3200));instance.callbacks.event('provider.utterance_complete',{});
  assert.equal(spoken(),2);assert.equal(h.state().demonstration!.requestId,requestId);
  h.report('playback.metric',{speechEpoch:h.state().speechEpoch,metrics:{pendingMs:0,writtenSamples:1600}});
  assert.equal(h.state().demonstration!.status,'cueing');
  h.cue();assert.equal(h.state().demonstration!.status,'starting');
});

test('native audio does not invent a lesson or welcome in a general session', async t => {
  const h = await setup(t, { device: 'phone', lessonId: undefined });
  h.coordinator.audio(h.id, h.state().generation, Buffer.alloc(640));
  assert.equal(h.state().lesson, undefined);
  assert.equal(h.instances[0].audio.length, 1);
  assert.equal(h.instances[0].contexts.length, 0);
});

test('questions hold the authored page and explicit Next displays each page before narration and final overview',async t=>{
  const h=await setup(t,{device:'meta_display'}),instance=h.instances[0];h.advertise();
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));h.visible();
  const spoken=()=>instance.contexts.filter(context=>context.spoken).length;
  const navigate=async(text:string,action='next')=>{h.command('send_text',{text});instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action}});await settle();return instance.results.at(-1)!.result;};
  assert.equal((await navigate('Why should I release my weight?')).status,'rejected');
  assert.equal(h.state().lesson!.teachingPage,'opening');assert.equal(spoken(),1);
  assert.equal((await navigate('Next')).status,'applied');
  assert.equal(h.state().hud.lessonPage!.id,'cpr-hand-placement');assert.equal(spoken(),1);h.visible();assert.equal(spoken(),2);
  assert.equal((await navigate('Next')).status,'applied');
  assert.equal(h.state().hud.lessonPage!.id,'cpr-compression-pattern');assert.equal(spoken(),2);h.visible();assert.equal(spoken(),3);
  assert.equal(h.state().lesson!.completed.length,0);
  assert.equal((await navigate('Next')).status,'applied');
  assert.equal(h.state().demonstration!.status,'cueing');assert.deepEqual(h.state().lesson!.skippedTeachingPages,[]);
  assert.equal(h.state().hud.lessonPage!.template,'show');h.cue();
  assert.equal(h.state().demonstration!.status,'starting');
});

test('Ready arms placement checks without claiming completion and requires two subsequent observations',async t=>{
  const h=await setup(t);h.enterPlacement(false);assert.equal(h.state().lesson!.ready,false);
  h.command('set_live_video',{enabled:true});await h.frame();assert.equal(h.requests.length,0);
  h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'Ready.'});
  h.instances[0].callbacks.tool({id:'ready',name:'lesson_action',args:{action:'ready'}});await settle();
  assert.equal(h.state().lesson!.ready,true);assert.equal(h.state().lesson!.phase,'placement');
  assert.ok(!h.state().lesson!.completed.some(step=>step.step==='placement'));
  h.advance(2001);await h.frame();h.requests[0].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'placement');
  h.advance();await h.frame();h.requests[1].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'practice');
});

test('CPR lesson starts with seeded facts and a durable intro; stale commands and free-form checkoffs cannot alter progress', async t => {
  const h = await setup(t);
  assert.equal(h.state().lesson?.phase, 'intro'); assert.equal(h.state().liveVideo, false);
  assert.match(h.instances[0].options?.instructions ?? '', /sternum/);
  const introduction=h.instances[0].contexts.find(context=>context.spoken)!.text;
  assert.match(introduction,/We’ll practise the basics/);
  assert.match(introduction,/Current authored page/);
  assert.equal(h.state().hud.lessonPage!.id,'cpr-opening');
  assert.doesNotMatch(introduction,/choose Continue|read the short reference/);
  assert.equal(h.events()[0].payload.coachPrompt,h.instances[0].options?.instructions);
  assert.equal(h.events()[0].payload.promptVersion,'coach-v10-course-navigation');
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

test('observer overlaps two submitted frames and delivers bounded correction before two-frame progression', async t => {
  const h = await setup(t); h.enterPlacement();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().liveVideo, true);
  await h.frame(); assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].bytes, pixels); assert.equal(h.requests[0].mime, 'image/png'); assert.match(h.requests[0].fact, /sternum/);
  h.advance(); await h.frame(); assert.equal(h.requests.length, 2);
  h.requests[0].resolve({ ...correct, placement: 'too_low', reason: 'The heel is visibly below the manikin target.' }); await settle();
  assert.equal(h.state().lesson!.lastObservation?.placement, 'too_low');
  assert.ok(!('usage' in h.state().lesson!.lastObservation!));
  assert.equal(h.state().lesson!.pendingCorrection,undefined);
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').length,0);
  h.requests[1].resolve({ ...correct, placement: 'too_low', reason: 'The heel remains below the manikin target.' }); await settle();
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
  assert.match(h.state().hud.lessonPage?.body ?? '', /observed in simulation/);
});

for (const reason of ['pause', 'restart', 'demonstration', 'video epoch', 'reconnect', 'end'] as const)
  test(`${reason} aborts and fences a late lesson observation`, async t => {
    const h = await setup(t); h.enterPlacement(); await h.frame();h.advance();await h.frame();
    assert.equal(h.requests.length, 2);
    if (reason === 'pause') h.action('pause');
    if (reason === 'restart') h.action('restart');
    if (reason === 'demonstration') { h.advertise(); h.command('start_demo', { assetId: h.assets[1].id }); }
    if (reason === 'video epoch') { h.command('set_live_video', { enabled: false }); h.command('set_live_video', { enabled: true }); }
    if (reason === 'reconnect') h.coordinator.reconnect(h.id, h.state().generation, randomUUID());
    if (reason === 'end') await h.coordinator.end(h.id);
    await settle();
    for(const request of h.requests){assert.equal(request.signal.aborted,true);request.resolve({...correct,placement:'too_low'});}await settle();
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

for(const input of ['voice','typed'] as const)test(`${input} question preserves placement checks while suppressing unsolicited speech`,async t=>{
  const h=await setup(t);h.enterPlacement();await h.frame();
  if(input==='typed')h.command('send_text',{text:'How is this?'});
  else {h.instances[0].callbacks.interrupted();h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'How is this?'});}
  assert.equal(h.requests[0].signal.aborted,false);
  h.requests[0].resolve(correct);await settle();assert.equal(h.state().lesson!.correctStreak,1);
  h.advance();await h.frame();assert.equal(h.requests.length,2);
  assert.ok(!h.events().some(event=>event.type==='lesson.cue'&&event.payload.delivery==='requested'));
});

test('a finding during learner speech updates evidence and a fresh finding can deliver its deferred correction', async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame();
  h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'Can I ask about my hands?'});
  h.requests[0].resolve({...correct,placement:'too_low'}); await settle();
  h.advance();await h.frame();h.requests[1].resolve({...correct,placement:'too_low'});await settle();
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').at(-1)?.payload.delivery,'hud_only');
  assert.equal(h.state().lesson!.lastObservation?.placement,'too_low');
  assert.equal(h.state().lesson!.lastCorrectionAt,undefined);
  assert.equal(h.events().filter(event=>event.type==='lesson.cue'&&event.payload.delivery==='requested').length,0);
  assert.ok(!h.events().some(event=>event.type==='playback.flushed'&&event.payload.reason==='lesson_observer_feedback'));
  assert.equal(h.events().find(event=>event.type==='lesson.observer.started')?.payload.frameSha256,createHash('sha256').update(pixels).digest('hex'));
  assert.equal(h.coordinator.export(h.id).evidenceCoverage.liveVideoInterpretation,'lesson_observer_model_text_without_retained_images');
  h.advance(1000); await h.frame(); h.requests[2].resolve({...correct,placement:'too_low'}); await settle();
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').at(-1)?.payload.delivery,'requested');
  assert.equal(h.state().lesson!.lastCorrectionAt,Date.now());
});

test('deferred speech never repeats a correction contradicted by the next fresh frame',async t=>{
  const h=await setup(t);h.enterPlacement();await h.frame();
  h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'How is this?'});
  h.requests[0].resolve({...correct,placement:'too_low'});await settle();
  h.advance();await h.frame();h.requests[1].resolve({...correct,placement:'too_low'});await settle();
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').at(-1)?.payload.delivery,'hud_only');
  h.advance(1000);await h.frame();h.requests[2].resolve(correct);await settle();
  assert.equal(h.state().lesson!.lastObservation!.placement,'correct');
  assert.ok(!h.events().some(event=>event.type==='lesson.cue'&&event.payload.delivery==='requested'));
});

test('placement verified during speech stops camera and gives the practice cue once the learner is quiet',async t=>{
  const h=await setup(t);h.enterPlacement();await h.frame();h.requests[0].resolve(correct);await settle();
  h.advance();await h.frame();h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'How is this?'});
  h.requests[1].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'practice');
  assert.equal(h.state().liveVideo,false);
  const progressCues=()=>h.events().filter(event=>event.type==='lesson.cue'&&event.payload.delivery==='requested'&&String(event.payload.cue).includes('Begin a short practice round'));
  (h.coordinator as any).sweep();assert.equal(progressCues().length,0);
  h.advance(2001);(h.coordinator as any).sweep();assert.equal(progressCues().length,1);
  h.advance(6000);(h.coordinator as any).sweep();assert.equal(progressCues().length,1);
  assert.equal(h.requests.length,2);assert.equal(h.state().lesson!.observerStatus,'idle');
  assert.doesNotMatch(h.instances[0].contexts.at(-1)!.text,/will watch/i);
});

test('duplicate Ready leaves the current camera check and narration untouched',async t=>{
  const h=await setup(t);h.enterPlacement();await h.frame();
  const before=h.state(),eventCount=h.events().length,spoken=h.instances[0].contexts.filter(c=>c.spoken).length;
  h.action('ready');
  assert.equal(h.requests[0].signal.aborted,false);assert.equal(h.state().lesson!.observerStatus,'observing');
  assert.equal(h.state().lesson!.revision,before.lesson!.revision);assert.equal(h.state().speechEpoch,before.speechEpoch);
  assert.equal(h.events().length,eventCount);assert.equal(h.instances[0].contexts.filter(c=>c.spoken).length,spoken);
  h.requests[0].resolve(correct);await settle();assert.equal(h.state().lesson!.correctStreak,1);
});

for(const provider of ['gemini','mock','openai'] as const)test(`${provider} camera-off lesson does not promise camera recovery during maintenance`,async t=>{
  const h=await setup(t,{provider,model:{gemini:'gemini-3.8-live',mock:'mock-coach',openai:'gpt-live-1'}[provider]});h.enterPlacement();
  if(provider==='gemini')h.command('set_live_video',{enabled:false});
  h.advance(6000);(h.coordinator as any).sweep();
  assert.equal(h.state().liveVideo,false);assert.notEqual(h.state().lesson!.observerStatus,'waiting_for_camera');
  assert.doesNotMatch(JSON.stringify(h.state().hud),/Camera connecting/i);
});

test('verification during a recheck retains its correction-specific cue until the learner is quiet',async t=>{
  const h=await setup(t);h.enterPlacement();h.action('skip_placement');h.advertise();
  h.command('play_training_video',{clipId:'hand-placement'});h.cue();
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'ended'});await settle();h.advance();
  for(const placement of ['too_low','too_low','correct'] as const){await h.frame();h.requests.at(-1)!.resolve({...correct,placement});await settle();h.advance();}
  await h.frame();h.instances.at(-1)!.callbacks.event('transcript.fragment',{speaker:'user',text:'Is that better?'});
  h.requests.at(-1)!.resolve(correct);await settle();
  const held=h.events().filter(e=>e.type==='lesson.cue'&&e.payload.delivery==='hud_only').at(-1)!.payload.cue;
  assert.match(String(held),/now appear.*Try another/);assert.equal(h.state().liveVideo,false);
  h.advance(2001);(h.coordinator as any).sweep();
  const delivered=h.events().filter(e=>e.type==='lesson.cue'&&e.payload.delivery==='requested').at(-1)!.payload.cue;
  assert.equal(delivered,held);assert.match(h.instances.at(-1)!.contexts.at(-1)!.text,/now appear.*Try another/);
});

test('verified practice stays camera-free through pause, resume and reconnect; a replay starts a fresh check',async t=>{
  const h=await setup(t);h.enterPlacement();
  for(let i=0;i<2;i++){await h.frame();h.requests.at(-1)!.resolve(correct);await settle();h.advance();}
  const evidence=h.state().lesson!.placementEvidence,epoch=h.state().liveVideoEpoch;
  assert.equal(h.state().lesson!.phase,'practice');assert.equal(h.state().liveVideo,false);
  assert.equal(h.state().lesson!.lastObservation!.placement,'correct');
  assert.match(h.instances[0].contexts.filter(c=>c.text.startsWith('Practice view update:')).at(-1)!.text,/"camera":"off"/);
  await assert.rejects(h.frame(),/Live video is not active/);
  assert.throws(()=>h.command('set_live_video',{enabled:true}),/placement check/i);
  h.action('pause');h.action('resume');h.action('repeat');
  h.coordinator.reconnect(h.id,h.state().generation,randomUUID());await settle();
  h.advance(6000);(h.coordinator as any).sweep();
  assert.equal(h.state().liveVideo,false);assert.equal(h.state().lesson!.observerStatus,'idle');
  assert.deepEqual(h.state().lesson!.placementEvidence,evidence);
  assert.equal(h.requests.length,2);
  h.advertise();h.command('play_training_video',{clipId:'hand-placement'});h.cue();
  assert.equal(h.state().lesson!.needsPlacementCheck,true);assert.equal(h.state().liveVideo,false);
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'ended'});await settle();
  assert.equal(h.state().lesson!.phase,'practice');assert.equal(h.state().liveVideo,true);
  assert.ok(h.state().liveVideoEpoch>epoch);assert.equal(h.state().lesson!.lastObservation,undefined);
  h.advance();await h.frame();h.requests.at(-1)!.resolve(correct);await settle();
  assert.equal(h.state().liveVideo,true);assert.equal(h.state().lesson!.needsPlacementCheck,true);
  h.advance();await h.frame();h.requests.at(-1)!.resolve(correct);await settle();
  assert.equal(h.state().liveVideo,false);assert.equal(h.state().lesson!.needsPlacementCheck,false);
  assert.ok(h.state().lesson!.placementEvidence!.at>evidence!.at);
});

test('unverified voice continuation requires a fresh explicit learner request and never fabricates visual completion', async t => {
  const h = await setup(t); h.enterPlacement();
  const skip=async()=>{h.instances[0].callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'skip_placement'}});await settle();return h.instances[0].results.at(-1)!.result;};
  assert.equal((await skip()).status,'rejected');
  for(const text of ['Continue', 'Skip the demonstration', "Don't skip the visual check", 'What happens if I skip the camera check?']) {
    h.command('send_text',{text});assert.equal((await skip()).status,'rejected');
  }
  h.command('send_text',{text:'Continue without camera'});h.advance(30001);
  assert.equal((await skip()).status,'rejected');
  h.instances[0].callbacks.event('transcript.fragment',{speaker:'assistant',text:'What would you like to do?'});
  h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'Please skip the visual check.'});
  assert.equal((await skip()).status,'applied');
  assert.equal(h.state().lesson!.phase,'practice');
  assert.equal(h.state().lesson!.completed.find(step=>step.step==='placement')?.evidence,'learner_confirmed');
  assert.ok(h.events().some(event=>event.type==='lesson.learner_confirmation'&&event.payload.step==='placement'));
});

test('paused practice keeps voice conversation available so the learner can resume while camera work stays blocked', async t => {
  const h=await setup(t,{device:'meta_display'});h.enterPlacement();h.advertise();
  await h.frame();assert.equal(h.requests.length,1);
  const instance=h.instances[0],output:Buffer[]=[];h.coordinator.on('audio',packet=>output.push(packet.pcm));
  instance.callbacks.tool({id:'voice-pause',name:'lesson_action',args:{action:'pause'}});await settle();
  assert.equal(h.state().lesson!.status,'paused');assert.equal(h.state().liveVideo,false);assert.equal(h.requests[0].signal.aborted,true);
  await assert.rejects(h.frame(),/paused/);
  assert.throws(()=>h.command('play_training_video',{clipId:'hand-placement'}),/resume/i);
  assert.throws(()=>h.command('inspect_frame',{question:'Check my hands'}),/paused/);
  instance.callbacks.tool({id:'bad-paused-continue',name:'lesson_action',args:{action:'continue'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'rejected');
  const pcm=Buffer.alloc(640,1);h.coordinator.audio(h.id,h.state().generation,pcm);
  assert.deepEqual(instance.audio.at(-1),pcm);
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Please resume the practice.'});
  instance.callbacks.event('transcript.fragment',{speaker:'assistant',text:'Resuming practice.'});
  instance.callbacks.audio(pcm);assert.deepEqual(output,[pcm]);
  assert.ok(h.state().transcripts.some(fragment=>fragment.text==='Please resume the practice.'));
  assert.ok(h.state().transcripts.some(fragment=>fragment.text==='Resuming practice.'));
  instance.callbacks.tool({id:'voice-resume',name:'lesson_action',args:{action:'resume'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'applied');
  assert.equal(h.state().lesson!.status,'active');assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().liveVideo,true);
  h.requests[0].resolve(correct);await settle();assert.equal(h.state().lesson!.observationSeq,0);
  h.advance(2001);await h.frame();assert.equal(h.requests.length,2);
});

test('video listens for scoped voice controls while suppressing coach speech, captions and other tools',async t=>{
  const h=await setup(t,{device:'meta_display'});h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  const instance=h.instances[0],demo=h.state().demonstration!,output:Buffer[]=[];h.coordinator.on('audio',packet=>output.push(packet.pcm));
  assert.ok(instance.contexts.some(context=>!context.spoken&&/Use lesson_action next to skip or move on/.test(context.text)));
  const pcm=Buffer.alloc(640,1);h.coordinator.audio(h.id,h.state().generation,pcm);assert.deepEqual(instance.audio.at(-1),pcm);
  instance.callbacks.audio(pcm);instance.callbacks.event('transcript.fragment',{speaker:'assistant',text:'Unwanted narration over the video.'});
  assert.deepEqual(output,[]);assert.ok(!h.state().transcripts.some(fragment=>fragment.text==='Unwanted narration over the video.'));
  for(const [name,args] of [['lesson_action',{action:'continue'}],['lookup_training_reference',{query:'hand placement'}],['inspect_frame',{question:'Check my hands'}]] as const){
    instance.callbacks.tool({id:randomUUID(),name,args});await settle();assert.equal(instance.results.at(-1)!.result.status,'rejected');
  }
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Do not stop compressions.'});
  instance.callbacks.tool({id:'not-a-playback-request',name:'lesson_action',args:{action:'pause'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'rejected');assert.equal(h.state().demonstration!.requestId,demo.requestId);
  instance.callbacks.event('provider.utterance_complete',{});
  h.advance(1234);instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Please pause the video.'});
  const requestSeq=h.state().throughSeq;
  instance.callbacks.event('provider.utterance_complete',{});
  instance.callbacks.tool({id:'voice-stop-video',name:'lesson_action',args:{action:'pause'}});await settle();
  assert.equal(h.state().demonstration,undefined);assert.equal(h.state().lesson!.status,'paused');assert.equal(h.state().lesson!.phase,'demonstration');
  assert.ok(!h.state().lesson!.completed.some(step=>step.step==='demonstration'));
  const confirmation=h.events().find(event=>event.type==='lesson.learner_confirmation'&&event.payload.step==='video_pause')!;
  assert.equal(confirmation.payload.requestId,demo.requestId);assert.equal(confirmation.payload.elapsedMs,1234);
  assert.deepEqual(confirmation.payload.eventSeqs,[requestSeq]);
  h.advertise();const resumed=h.instances.at(-1)!;resumed.callbacks.event('transcript.fragment',{speaker:'user',text:'Resume the lesson.'});
  resumed.callbacks.tool({id:'resume-after-video-pause',name:'lesson_action',args:{action:'resume'}});await settle();
  assert.equal(h.state().lesson!.status,'active');assert.equal(h.state().demonstration!.status,'cueing');assert.equal(h.state().lesson!.activeClip,'overview');
});

test('display recovery speaks only after a spoken loss and flapping stays quiet across provider rebinds',async t=>{
  const h=await setup(t,{device:'meta_display'}),before=structuredClone(h.state().lesson);
  const report=(glassesDisplayAvailable:boolean)=>h.report('device.status',{glassesDisplayAvailable});
  const notices=()=>h.instances.flatMap(instance=>instance.contexts).filter(context=>context.spoken&&/glasses display connection/.test(context.text));
  report(false);report(false);assert.equal(notices().length,0);
  report(true);report(true);assert.equal(notices().length,0);
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));
  report(false);report(false);assert.equal(notices().length,1);assert.match(notices()[0].text,/lost/);
  h.advance(10000);report(true);report(true);assert.equal(notices().length,2);assert.match(notices()[1].text,/restored/);
  h.advance(10000);h.coordinator.reconnect(h.id,h.state().generation,randomUUID());await settle();
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));
  report(false);h.advance(10000);report(true);assert.equal(notices().length,2);
  h.advance(30001);report(false);report(true);assert.equal(notices().length,4);
  assert.ok(notices().every(context=>/app handles display and camera recovery automatically/.test(context.text)));
  assert.deepEqual(h.state().lesson,before);
});

test('display loss during video and its recovery do not add spoken connection chatter',async t=>{
  const h=await setup(t,{device:'meta_display'});h.advertise();h.report('device.status',{glassesDisplayAvailable:true});
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));
  h.command('play_training_video',{clipId:'overview'});h.cue();
  h.report('device.status',{glassesDisplayAvailable:false});
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'failed',reason:'Glasses video display is unavailable'});await settle();
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));h.visible();
  h.report('device.status',{glassesDisplayAvailable:true});
  assert.ok(!h.instances.flatMap(instance=>instance.contexts).some(context=>context.spoken&&/glasses display connection/.test(context.text)));
  assert.match(h.instances.at(-1)!.contexts.find(context=>context.spoken)!.text,/video couldn’t play/);
});

test('losing camera freshness replaces the old correction card with a waiting cue', async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame();
  h.requests[0].resolve({...correct,placement:'too_low'}); await settle();
  h.advance();await h.frame();h.requests[1].resolve({...correct,placement:'too_low'});await settle();
  assert.match(h.state().hud.card!.body,/up/);
  h.advance(5001);
  (h.coordinator as unknown as {sweep:()=>void}).sweep();
  assert.equal(h.state().lesson!.observerStatus,'waiting_for_camera');
  assert.doesNotMatch(h.state().hud.card!.body,/Move up/);
  assert.equal(h.state().lesson!.lastObservation?.placement,'too_low');
  assert.match(h.instances[0].contexts.at(-1)!.text,/app handles camera recovery automatically/);
  await h.frame();
  assert.match(h.instances[0].contexts.at(-1)!.text,/Fresh camera frames are arriving/);
  assert.equal(h.instances[0].contexts.at(-1)!.spoken,false);
  assert.equal(h.state().lesson!.phase,'placement');
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
  const h = await setup(t);
  h.instances[0].callbacks.tool({id:'uncached-overview',name:'play_training_video',args:{clipId:'overview'}});await settle();
  assert.equal(h.instances[0].results.at(-1)!.result.status,'rejected');assert.equal(h.state().lesson!.phase,'intro');
  assert.equal(h.state().lesson!.completed.length,0);
  h.advertise();h.action('next');h.action('next');
  h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text:'Show the demonstration.'});
  h.instances[0].callbacks.tool({id:'voice-overview',name:'lesson_action',args:{action:'next'}});await settle();
  assert.equal(h.instances[0].results.at(-1)!.result.applicationEffect,'lesson_changed');
  const overview = h.state().demonstration!;
  assert.ok(overview); assert.equal(overview.lessonKey, 'overview'); assert.equal(h.state().lesson!.phase, 'demonstration');
  assert.equal(overview.status,'cueing');h.cue();
  assert.equal(h.state().lesson!.completed.find(step=>step.step==='intro')?.evidence,'learner_confirmed');
  h.report('demo.playback', { requestId: overview.requestId, status: 'playing' });
  assert.equal(h.state().demonstration!.status,'playing');
  h.report('demo.playback', { requestId: overview.requestId, status: 'ended' }); await settle();
  assert.equal(h.state().lesson!.phase, 'placement');assert.equal(h.state().lesson!.ready,false);assert.equal(h.state().liveVideo,true);
  h.action('ready');assert.equal(h.state().liveVideo,true);
  assert.equal(h.state().lesson!.completed.find(step => step.step === 'demonstration')?.evidence, 'video_ended');
  h.advertise();
  const instance = h.instances.at(-1)!;
  instance.callbacks.tool({id:'historical-overview',name:'play_training_video',args:{clipId:'overview'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'rejected');assert.equal(h.state().demonstration,undefined);
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Can I see the hand placement again?'});
  instance.callbacks.tool({ id: 'hand-replay', name: 'play_training_video', args: { clipId: 'hand-placement' } }); await settle();
  const replay = h.state().demonstration!;
  assert.ok(replay); assert.equal(replay.assetId, h.assets[1].id); assert.equal(replay.lessonKey, 'hand-placement');
  instance.callbacks.tool({ id: 'hand-replay', name: 'play_training_video', args: { clipId: 'hand-placement' } }); await settle();
  assert.equal(h.state().demonstration?.requestId, replay.requestId);
  assert.equal(h.events().filter(event => event.type === 'demo.started' && event.payload.requestId === replay.requestId).length, 1);
  assert.equal(h.state().liveVideo, false); assert.equal(h.state().lesson!.phase, 'placement');
  await assert.rejects(h.frame(), /suspended/);
  h.cue();h.report('demo.playback', { requestId: replay.requestId, status: 'ended' }); await settle();
  assert.equal(h.state().lesson!.phase, 'placement'); assert.equal(h.state().liveVideo, true);
  assert.equal(h.state().lesson!.completed.filter(step => step.step === 'demonstration').length, 1);
  assert.equal(h.state().lesson!.completed.some(step => step.step === 'placement'), false);
  h.advertise();const restored=h.instances.at(-1)!;
  restored.callbacks.tool({id:'historical-replay',name:'play_training_video',args:{clipId:'hand-placement'}});await settle();
  assert.equal(restored.results.at(-1)!.result.status,'rejected');assert.equal(h.state().demonstration,undefined);
  restored.callbacks.event('transcript.fragment',{speaker:'user',text:'Play hand placement once more.'});
  restored.callbacks.tool({id:'fresh-replay',name:'play_training_video',args:{clipId:'hand-placement'}});await settle();
  assert.equal(restored.results.at(-1)!.result.applicationEffect,'video_requested');
});

test('failed and stopped demonstration playback never check off watching the overview', async t => {
  const h = await setup(t); h.advertise(); h.action('continue'); h.command('play_training_video', { clipId: 'overview' });
  const failed = h.state().demonstration!;h.cue();
  h.report('demo.playback', { requestId: failed.requestId, status: 'failed', reason: 'Decode failure' }); await settle();
  assert.equal(h.state().lesson!.phase, 'demonstration');
  assert.ok(!h.state().lesson!.completed.some(step => step.step === 'demonstration'));
  h.advertise(); h.command('start_demo', { assetId: h.assets[0].id });
  h.command('stop_demo', { requestId: h.state().demonstration!.requestId }); await settle();
  assert.equal(h.state().lesson!.phase, 'demonstration');
  assert.ok(!h.state().lesson!.completed.some(step => step.step === 'demonstration'));
});

test('a failed overview can be skipped explicitly without skipping the pending placement check',async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'failed',reason:'Glasses video display is unavailable'});await settle();
  const instance=h.instances.at(-1)!;
  const skip=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'skip_demo'}});await settle();return instance.results.at(-1)!.result;};
  assert.match(instance.contexts.find(context=>context.spoken)!.text,/try it again or move on/);
  for(const text of ['Continue without camera', "Don't skip the demonstration", 'What happens if I skip the video?']){
    h.command('send_text',{text});const rejected=await skip();
    assert.equal(rejected.status,'rejected');assert.match(rejected.reason,/skip the current video/);
    assert.equal(h.state().lesson!.phase,'demonstration');
  }
  h.command('send_text',{text:'Skip the video'});h.advance(30001);assert.equal((await skip()).status,'rejected');
  h.command('send_text',{text:'Please skip the demonstration.'});
  const result=await skip();assert.equal(result.status,'applied');assert.match(result.instruction,/hand-placement check is still pending/);
  assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().liveVideo,true);
  assert.equal(h.state().lesson!.completed.find(step=>step.step==='demonstration')?.evidence,'learner_confirmed');
  assert.ok(!h.state().lesson!.completed.some(step=>step.step==='placement'));
  assert.ok(h.events().some(event=>event.type==='lesson.learner_confirmation'&&event.payload.step==='demonstration'));
  assert.equal((await skip()).status,'rejected');assert.equal(h.state().lesson!.phase,'placement');
  h.action('ready');h.advance(3000);await h.frame();assert.equal(h.requests.length,1);
});

test('tool failures retain safe actionable causes and sanitize unknown errors',async t=>{
  const h=await setup(t),instance=h.instances[0];
  const call=async(name:string,args:Record<string,unknown>,id:string=randomUUID())=>{
    instance.callbacks.tool({id,name,args});await settle();return instance.results.at(-1)!.result;
  };
  h.command('send_text',{text:'Show the demonstration'});
  const rejection=await call('play_training_video',{clipId:'hand-placement'},'uncached');
  assert.equal(rejection.status,'rejected');assert.match(rejection.reason,/not cached/);
  assert.deepEqual(await call('play_training_video',{clipId:'hand-placement'},'uncached'),rejection);
  assert.equal(h.events().filter(event=>event.type==='work.failed').length,1);
  assert.equal(h.events().find(event=>event.type==='work.failed')!.payload.name,'play_training_video');
  assert.match((await call('lesson_action',{action:'invented'})).reason,/Invalid tool arguments/);
  t.mock.method(h.coordinator.knowledge,'search',()=>{throw new Error('vendor-key-secret');});
  const unknown=await call('lookup_training_reference',{query:'hand placement'});
  assert.equal(unknown.reason,'Tool request failed; no action was applied.');
  assert.doesNotMatch(JSON.stringify(h.events()),/vendor-key-secret/);
  assert.equal(h.state().lesson!.phase,'intro');
});

for (const cameraEnabled of [true, false]) test(`short replay starts a fresh placement check after camera was ${cameraEnabled ? 'on' : 'off'}`, async t => {
  const h = await setup(t); h.enterPlacement(); await h.frame(); h.requests[0].resolve(correct); await settle();
  assert.equal(h.state().lesson!.correctStreak, 1);
  if (!cameraEnabled) h.command('set_live_video', { enabled: false });
  h.advertise(); h.command('play_training_video', { clipId: 'hand-placement' });
  assert.equal(h.state().lesson!.correctStreak, 0);
  h.cue();h.report('demo.playback', { requestId: h.state().demonstration!.requestId, status: 'ended' }); await settle();
  assert.equal(h.state().liveVideo, true); assert.equal(h.state().lesson!.phase, 'placement');
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

test('misclassified voice done opens an honest recap and keeps the session active',async t=>{
  const h=await setup(t);h.enterPlacement();h.action('skip_placement');
  const instance=h.instances[0];
  const end=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'end_session'}});await settle();return instance.results.at(-1)!.result;};
  h.command('send_text',{text:"I'm not done yet."});assert.equal((await end()).status,'rejected');
  h.command('send_text',{text:"I'm done."});h.advance(30001);assert.equal((await end()).status,'rejected');
  h.command('send_text',{text:"I'm done."});
  assert.equal((await end()).action,'finish_practice');
  assert.equal(h.state().lesson!.phase,'complete');assert.equal(h.state().status,'active');
  assert.match(h.state().hud.lessonPage!.body,/Placement not verified/);
  assert.ok(h.events().some(event=>event.type==='lesson.intent_corrected'));
});

test('voice end requires explicit session intent and closes coaching without a device button',async t=>{
  const h=await setup(t);h.enterPlacement();await h.frame();
  const instance=h.instances[0];
  const end=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'end_session'}});await settle();return instance.results.at(-1)!.result;};
  assert.equal((await end()).status,'rejected');
  for(const text of ["I'm done", "Don't end the session", 'What happens if I stop coaching?']){
    h.command('send_text',{text});assert.equal((await end()).status,'rejected');assert.equal(h.state().status,'active');
  }
  h.command('send_text',{text:'End the session'});h.advance(30001);assert.equal((await end()).status,'rejected');
  instance.callbacks.event('transcript.fragment',{speaker:'assistant',text:'Let me know when to close coaching.'});
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Please end the session.'});
  assert.equal((await end()).applicationEffect,'session_end_requested');
  assert.equal(h.state().status,'ended');assert.equal(h.state().liveVideo,false);assert.equal(h.requests[0].signal.aborted,true);
  assert.ok(h.events().some(event=>event.type==='session.ended'));
});

test('one learner Next request cannot advance two pages through different model call IDs',async t=>{
  const h=await setup(t),instance=h.instances[0];
  const next=async(id:string)=>{instance.callbacks.tool({id,name:'lesson_action',args:{action:'next'}});await settle();return instance.results.at(-1)!.result;};
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Next'});
  assert.equal((await next('next-first')).status,'applied');assert.equal(h.state().lesson!.teachingPage,'hand-placement');
  assert.equal((await next('next-duplicate')).status,'rejected');assert.equal(h.state().lesson!.teachingPage,'hand-placement');
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:' please.'});
  assert.equal((await next('next-old-fragment')).status,'rejected');
  h.command('send_text',{text:'Next'});
  assert.equal((await next('next-new-request')).status,'applied');assert.equal(h.state().lesson!.teachingPage,'compression-pattern');
  assert.equal(h.events().filter(event=>event.type==='lesson.navigation_intent').length,2);
});

for(const movieFailed of [false,true])for(const boundary of ['turn complete','barge-in'])test(`contextual next skips one video then waits for ${boundary} ${movieFailed?'in the same connection':'after reconnect'}`,async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  if(movieFailed){h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'failed',reason:'Display unavailable'});await settle();}
  let instance=h.instances.at(-1)!;
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'For the sake of time, let’s skip this and move on.'});
  instance.callbacks.tool({id:'skip-once',name:'lesson_action',args:{action:'next'}});await settle();
  assert.equal(instance.results.at(-1)!.result.action,'skip_demo');assert.equal(h.state().lesson!.phase,'placement');
  assert.equal(h.state().lesson!.ready,false);assert.equal(h.state().hud.lessonPage!.id,'cpr-placement');
  instance=h.instances.at(-1)!;
  instance.callbacks.tool({id:'duplicate-next',name:'lesson_action',args:{action:'next'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'rejected');assert.equal(h.state().lesson!.ready,false);
  if(movieFailed){
    instance.callbacks.event('transcript.fragment',{speaker:'user',text:' and move on.'});
    instance.callbacks.tool({id:'late-fragment-next',name:'lesson_action',args:{action:'next'}});await settle();
    assert.equal(instance.results.at(-1)!.result.status,'rejected');assert.equal(h.state().lesson!.ready,false);
  }
  if(boundary==='barge-in')instance.callbacks.interrupted();else instance.callbacks.event('provider.utterance_complete',{});
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'I’m ready.'});
  instance.callbacks.tool({id:'fresh-ready',name:'lesson_action',args:{action:'next'}});await settle();
  assert.equal(instance.results.at(-1)!.result.action,'ready');assert.equal(h.state().lesson!.ready,true);
  assert.equal(h.state().lesson!.phase,'placement');assert.ok(!h.state().lesson!.completed.some(step=>step.step==='placement'));
});

test('contextual next opens an honest recap only on a fresh request to finish practice',async t=>{
  const h=await setup(t);h.enterPlacement();h.action('skip_placement');const instance=h.instances[0];
  const next=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'next'}});await settle();return instance.results.at(-1)!.result;};
  for(const text of ['How do I continue?', 'Do not move on', 'I’m not done yet']){
    h.command('send_text',{text});assert.equal((await next()).status,'rejected');assert.equal(h.state().lesson!.phase,'practice');
  }
  h.command('send_text',{text:'Let’s move on to the recap.'});assert.equal((await next()).action,'finish_practice');
  assert.equal(h.state().lesson!.phase,'complete');assert.equal(h.state().lesson!.placementEvidence,undefined);
  assert.match(h.state().hud.lessonPage!.body,/Placement not verified/);
  assert.equal((await next()).status,'rejected');assert.equal(h.state().lesson!.recapPage,0);
});

test('next while placement is already checking preserves the active observation',async t=>{
  const h=await setup(t);h.enterPlacement();await h.frame();const instance=h.instances[0];
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Next, please.'});
  instance.callbacks.tool({id:'already-ready',name:'lesson_action',args:{action:'next'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'waiting');assert.equal(h.requests[0].signal.aborted,false);
  assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().lesson!.correctStreak,0);
});

test('first demonstration uses contextual next, while reference playback cannot skip teaching pages',async t=>{
  const h=await setup(t);h.advertise();const instance=h.instances[0];
  h.command('send_text',{text:'Show the demonstration.'});
  instance.callbacks.tool({id:'wrong-path',name:'play_training_video',args:{clipId:'overview'}});await settle();
  assert.match(instance.results.at(-1)!.result.reason,/lesson_action next/);assert.equal(h.state().lesson!.teachingPage,'opening');
  h.action('next');h.action('next');
  instance.callbacks.tool({id:'right-path',name:'lesson_action',args:{action:'next'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'applied');assert.equal(h.state().demonstration?.lessonKey,'overview');
  assert.deepEqual(h.state().lesson!.skippedTeachingPages,[]);
});

test('reference video can replay the current movie once without changing course progress',async t=>{
  const h=await setup(t);h.enterPlacement();h.advertise();h.command('play_training_video',{clipId:'hand-placement'});h.cue();
  const original=h.state().demonstration!.requestId,instance=h.instances[0];
  h.command('send_text',{text:'Show that hand placement clip again.'});
  const replay=async()=>{instance.callbacks.tool({id:randomUUID(),name:'play_training_video',args:{clipId:'hand-placement'}});await settle();return instance.results.at(-1)!.result;};
  assert.equal((await replay()).status,'starting');assert.notEqual(h.state().demonstration!.requestId,original);
  assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().demonstration!.resumeLiveVideo,true);
  const restarted=h.state().demonstration!.requestId;
  assert.equal((await replay()).status,'rejected');assert.equal(h.state().demonstration!.requestId,restarted);
});

test('replay_video requires a new request after the current clip started and consumes that request once',async t=>{
  const h=await setup(t);h.advertise();const instance=h.instances[0];
  const replay=async(id:string)=>{instance.callbacks.tool({id,name:'lesson_action',args:{action:'replay_video'}});await settle();return instance.results.at(-1)!.result;};
  h.command('send_text',{text:'Play the video'});
  h.command('play_training_video',{clipId:'overview'});await settle();
  const original=h.state().demonstration!.requestId;
  assert.equal((await replay('reuse-initial-video-request')).status,'rejected');assert.equal(h.state().demonstration!.requestId,original);
  instance.callbacks.event('provider.utterance_complete',{});
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Replay the video.'});
  assert.equal((await replay('replay-new-request')).status,'applied');
  const restarted=h.state().demonstration!.requestId;assert.notEqual(restarted,original);
  assert.equal((await replay('replay-duplicate')).status,'rejected');assert.equal(h.state().demonstration!.requestId,restarted);
  assert.equal(h.events().filter(event=>event.type==='demo.started').length,2);
});

test('retrying a failed overview uses the new authored cue rather than repeating the previous failure',async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'failed',reason:'Display unavailable'});await settle();
  const instance=h.instances.at(-1)!;
  assert.match(instance.contexts.find(context=>context.spoken)!.text,/video couldn’t play/);
  h.advertise();h.command('play_training_video',{clipId:'overview'});
  const cue=instance.contexts.filter(context=>context.spoken).at(-1)!.text;
  assert.match(cue,/I’ll pull that up/);assert.doesNotMatch(cue,/video couldn’t play/);
  assert.equal(h.state().demonstration!.status,'cueing');h.cue();assert.equal(h.state().demonstration!.status,'starting');
});

for(const [status,text,action] of [
  ['cueing','skip','skip_demo'],['starting','Let’s skip this.','skip_demo'],['playing','Next','next'],
  ['failed','Continue','continue'],['cueing','Move on','skip_demo'],['playing','Okay, skip. Go to next part.','next'],['playing','Stop. We’ll skip this.','skip_demo'],['playing','Stop. We’ll skip this.','pause'],
])test(`natural ${text} skips only the ${status} overview`,async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});
  if(status!=='cueing')h.cue();
  if(['playing','failed'].includes(status)){h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status});await settle();}
  h.command('send_text',{text});const instance=h.instances.at(-1)!;
  instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action}});await settle();
  assert.equal(instance.results.at(-1)!.result.action,'skip_demo');
  assert.equal(h.state().demonstration,undefined);assert.equal(h.state().lesson!.phase,'placement');
  assert.equal(h.state().lesson!.ready,false);assert.ok(!h.state().lesson!.completed.some(step=>step.step==='placement'));
  assert.equal(h.state().lesson!.completed.find(step=>step.step==='demonstration')?.evidence,'learner_confirmed');
});

for(const text of [
  "Okay, for the sake of time, let's skip this.", "Hey, let's skip this.",
  "Could you please skip the rest of this video?", "I've seen enough, let's move on to practice.",
  "I don't have time for the whole video, let's skip it.", "No need to finish this video, let's continue.",
])test(`spoken video control accepts natural context: ${text}`,async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'playing'});
  const instance=h.instances.at(-1)!;
  // Exercise the actual voice path, including provider transcription fragments.
  for(const fragment of [text.slice(0,10),text.slice(10)])instance.callbacks.event('transcript.fragment',{speaker:'user',text:fragment});
  instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'skip_demo'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'applied');assert.equal(h.state().demonstration,undefined);
  assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().lesson!.needsPlacementCheck,true);
  assert.ok(!h.state().lesson!.completed.some(step=>step.step==='placement'));
});

test('moving on from a short replay restores practice with placement still pending',async t=>{
  const h=await setup(t);h.enterPlacement();h.action('skip_placement');h.advertise();
  h.command('play_training_video',{clipId:'hand-placement'});h.cue();
  h.command('send_text',{text:'Move on'});const instance=h.instances.at(-1)!;
  instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'continue'}});await settle();
  assert.equal(instance.results.at(-1)!.result.action,'skip_demo');assert.equal(h.state().demonstration,undefined);
  assert.equal(h.state().lesson!.phase,'practice');assert.equal(h.state().lesson!.needsPlacementCheck,true);
  assert.equal(h.state().lesson!.placementEvidence,undefined);
});

test('video skip rejects negated, hypothetical, stale and pre-video requests',async t=>{
  const h=await setup(t);h.advertise();h.command('send_text',{text:'Next'});h.command('play_training_video',{clipId:'overview'});
  const instance=h.instances[0],requestId=h.state().demonstration!.requestId;
  const skip=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'next'}});await settle();return instance.results.at(-1)!.result;};
  assert.equal((await skip()).status,'rejected');
  for(const text of ['Do not skip','What happens if we move on?','Maybe next','Continue without camera','Skip. Actually do not skip.','What if I skip. Next.', "I don't want to skip this", 'Please skip the placement check', 'Can you explain how to skip this video?', 'I never asked you to skip this video']){
    h.command('send_text',{text});assert.equal((await skip()).status,'rejected');assert.equal(h.state().demonstration!.requestId,requestId);
  }
  h.command('send_text',{text:'Skip'});h.advance(30001);assert.equal((await skip()).status,'rejected');
});

test('a natural declaration finishes an unverified practice round without ending coaching',async t=>{
  const h=await setup(t);h.enterPlacement();h.action('skip_placement');const instance=h.instances[0];
  const finish=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'end_session'}});await settle();return instance.results.at(-1)!.result;};
  for(const text of ["We're not done",'What if we are about done?',"We aren't done"]){h.command('send_text',{text});assert.equal((await finish()).status,'rejected');}
  h.command('send_text',{text:"Okay, let's skip this, I think. We're about done."});
  assert.equal((await finish()).action,'finish_practice');assert.equal(h.state().lesson!.phase,'complete');assert.equal(h.state().status,'active');
  assert.match(h.state().hud.lessonPage!.body,/Placement not verified/);
});

test('Yes confirms the immediately preceding end-session question',async t=>{
  const h=await setup(t),instance=h.instances[0];
  for(const text of ['To confirm, would you ','like to end the training session?'])instance.callbacks.event('transcript.fragment',{speaker:'assistant',text});
  instance.callbacks.event('provider.utterance_complete',{});
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Yes.'});
  instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'end_session'}});await settle();
  assert.equal(instance.results.at(-1)!.result.applicationEffect,'session_end_requested');assert.equal(h.state().status,'ended');
});

for(const scenario of ['missing','ambiguous','intervening answer','stale','prior generation'])
  test(`Yes cannot end coaching with ${scenario} confirmation`,async t=>{
    const h=await setup(t);let instance=h.instances[0];
    if(scenario!=='missing')instance.callbacks.event('transcript.fragment',{speaker:'assistant',text:scenario==='ambiguous'?'Would you like to practise again or end the session?':'Would you like to end the training session?'});
    if(scenario==='intervening answer'){
      instance.callbacks.event('transcript.fragment',{speaker:'user',text:'No, wait.'});instance.callbacks.event('provider.utterance_complete',{});
    }
    if(scenario==='stale')h.advance(30001);
    if(scenario==='prior generation'){h.coordinator.reconnect(h.id,h.state().generation,randomUUID());await settle();instance=h.instances.at(-1)!;}
    h.command('send_text',{text:'Yes'});instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'end_session'}});await settle();
    assert.equal(instance.results.at(-1)!.result.status,'rejected');assert.equal(h.state().status,'active');
  });

for(const outcome of ['ended','skipped','failed then skipped'])test(`camera warms on ${outcome} overview, but Ready still gates fresh visual evidence`,async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  if(outcome==='skipped')h.action('skip_demo');
  else h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:outcome==='ended'?'ended':'failed'});
  await settle();if(outcome==='failed then skipped')h.action('skip_demo');
  assert.equal(h.state().liveVideo,true);assert.equal(h.state().lesson!.ready,false);
  h.advance(1001);await h.frame();assert.equal(h.requests.length,0);
  assert.equal(h.state().lesson!.observerStatus,'idle');
  assert.equal(h.instances.flatMap(instance=>instance.videos).length,0);
  h.action('repeat');assert.equal(h.state().liveVideo,true);assert.equal(h.state().lesson!.ready,false);
  h.action('ready');assert.notEqual(h.state().hud.lessonPage!.id,'cpr-camera-starting');
  h.advance(1001);await h.frame({frameAgeMs:1500});
  assert.equal(h.requests.length,0);assert.equal(h.instances.flatMap(instance=>instance.videos).length,0);
  h.advance(1001);await h.frame();assert.equal(h.requests.length,1);
  h.requests[0].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'placement');
  h.advance(1001);await h.frame();h.requests[1].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'practice');
});

test('an explicit camera-off after warmup survives repeat and reconnect until Ready',async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'ended'});await settle();
  assert.equal(h.state().liveVideo,true);h.command('set_live_video',{enabled:false});h.action('repeat');
  assert.equal(h.state().liveVideo,false);h.coordinator.reconnect(h.id,h.state().generation,randomUUID());await settle();
  assert.equal(h.state().liveVideo,false);assert.equal(h.state().lesson!.ready,false);assert.equal(h.requests.length,0);
  h.action('ready');assert.equal(h.state().liveVideo,true);
});

test('visible off-target placement gives one target reminder and still requires two fresh correct findings',async t=>{
  const h=await setup(t);h.enterPlacement();
  const offTarget={...correct,placement:'off_target' as const,reason:'The lower hand heel is visibly lateral to the sternum target.'};
  await h.frame();h.requests[0].resolve(offTarget);await settle();
  assert.equal(h.state().lesson!.pendingCorrection,undefined);
  h.advance();await h.frame();h.requests[1].resolve(offTarget);await settle();
  assert.equal(h.state().lesson!.pendingCorrection?.kind,'off_target');
  assert.equal(h.state().lesson!.lastObservation!.placement,'off_target');
  const cue=h.events().find(event=>event.type==='lesson.cue')!.payload.cue;
  assert.match(String(cue),/lower half|breastbone/);assert.doesNotMatch(String(cue),/too low|move.*up|clear view|cannot see/i);
  h.advance(1001);await h.frame();h.requests[2].resolve(offTarget);await settle();
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').length,1);
  h.advance(1001);await h.frame();h.requests[3].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'placement');
  h.advance(1001);await h.frame();h.requests[4].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'practice');
  assert.equal(h.state().lesson!.pendingCorrection,undefined);assert.equal(h.state().lesson!.placementAdjustments?.length,1);
});

for(const patch of [{confidence:0.84},{landmarksVisible:false},{manikinVisible:false}])
  test(`off-target classification cannot bypass evidence gates ${JSON.stringify(patch)}`,async t=>{
    const h=await setup(t);h.enterPlacement();await h.frame();
    h.requests[0].resolve({...correct,placement:'off_target',...patch});await settle();
    assert.equal(h.state().lesson!.lastObservation!.placement,'unknown');assert.equal(h.state().lesson!.pendingCorrection,undefined);
    assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().lesson!.placementEvidence,undefined);
  });

for(const device of ['phone','meta_display','mock'] as const)test(`${device} Marine lobby welcomes once after readiness and never starts a lesson or camera`,async t=>{
  const h=await setup(t,{device,lessonId:undefined,tutorMode:'marine'}),spoken=()=>h.instances.flatMap(instance=>instance.contexts).filter(context=>context.spoken);
  assert.equal(h.state().hud.brand,'marines');assert.equal(h.state().lesson,undefined);assert.equal(h.state().liveVideo,false);
  assert.equal(spoken().length,device==='mock'?1:0);
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));
  assert.equal(spoken().length,device==='meta_display'?0:1);
  if(device==='meta_display'){
    h.report('hud.receipt',{hudRevision:0,rendererInstanceId:'fixture',target:'glasses',status:'sdk_submitted'});
    assert.equal(spoken().length,0);h.visible();
  }
  assert.equal(spoken().length,1);assert.match(spoken()[0].text,/I’m your AI training coach\. What would you like to work on, Marine\?/);
  assert.ok(h.state().tutorWelcomeRequestedAt);assert.equal(h.events().find(event=>event.type==='tutor.welcome.requested')!.payload.heard,false);
  assert.ok(h.instances[0].options!.instructions!.length<2000);assert.doesNotMatch(h.instances[0].options!.instructions!,/Quoted CPR facts|We’ll practise the basics/);
  h.coordinator.reconnect(h.id,h.state().generation,randomUUID());await settle();
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));h.visible();
  assert.equal(spoken().length,1);assert.equal(h.state().lesson,undefined);assert.equal(h.state().liveVideo,false);
});

for(const request of ['Pull up some CPR training.','Can you teach me CPR?','I want to practice CPR.'])test(`${request} starts the prepared course once from the Marine lobby`,async t=>{
  const h=await setup(t,{lessonId:undefined,tutorMode:'marine'}),lobby=h.instances[0];
  assert.equal(lobby.options?.lessonActive,false);
  h.command('send_text',{text:request});lobby.callbacks.tool({id:'start',name:'lesson_action',args:{action:'start'}});await settle();
  assert.equal(lobby.results.at(-1)!.result.status,'applied');assert.equal(h.state().generation,2);
  assert.equal(h.state().lesson?.phase,'intro');assert.equal(h.state().hud.brand,undefined);assert.equal(h.state().hud.lessonPage?.id,'cpr-opening');
  assert.equal(h.state().liveVideo,false);assert.equal(h.events().filter(event=>event.type==='lesson.context_seeded').length,1);
  const course=h.instances.at(-1)!,instructions=course.options!.instructions!;
  assert.equal(course.options?.lessonActive,true);
  assert.match(instructions,/Quoted CPR facts/);assert.match(instructions,/sternum/);assert.doesNotMatch(instructions,/checkedDate|clinicalReviewStatus|Example dialogues/);
  assert.ok(instructions.length<7000);assert.equal(course.contexts.filter(context=>context.spoken).length,1);
  h.command('send_text',{text:request});course.callbacks.tool({id:'duplicate-start',name:'lesson_action',args:{action:'start'}});await settle();
  assert.equal(course.results.at(-1)!.result.status,'rejected');assert.equal(h.events().filter(event=>event.type==='lesson.context_seeded').length,1);
  h.coordinator.reconnect(h.id,h.state().generation,randomUUID());await settle();
  assert.equal(h.instances.at(-1)!.options?.lessonActive,true);
});

test('course start rejects unrelated, negated, informational, stale and previous-generation requests',async t=>{
  const h=await setup(t,{lessonId:undefined,tutorMode:'marine'});
  const start=async()=>{const instance=h.instances.at(-1)!;instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'start'}});await settle();return instance.results.at(-1)!.result;};
  for(const text of ['What is CPR?',"Don’t pull up CPR training.",'If I start CPR training, what happens?','Pull up weapons training.','What CPR training is available?']){
    h.command('send_text',{text});assert.equal((await start()).status,'rejected');assert.equal(h.state().lesson,undefined);
  }
  h.command('send_text',{text:'Pull up CPR training'});h.advance(30001);assert.equal((await start()).status,'rejected');
  h.command('send_text',{text:'Pull up CPR training'});h.coordinator.reconnect(h.id,h.state().generation,randomUUID());await settle();
  assert.equal((await start()).status,'rejected');assert.equal(h.state().liveVideo,false);
});

test('a request heard before the Marine welcome cannot start a course afterward',async t=>{
  const h=await setup(t,{lessonId:undefined,tutorMode:'marine',device:'meta_display'}),instance=h.instances[0];
  h.command('send_text',{text:'Pull up CPR training'});
  const start=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'start'}});await settle();return instance.results.at(-1)!.result;};
  assert.equal((await start()).status,'rejected');
  h.coordinator.audio(h.id,h.state().generation,Buffer.alloc(640));h.visible();
  assert.equal((await start()).status,'rejected');assert.equal(h.state().lesson,undefined);
});

for(const text of ['pause','Pause.','Stop.', 'Hey, pause for a moment.', 'Could you pause this video please?', 'Pause the video, I’ll continue later.'])test(`bare ${text} pauses only the active video and preserves pending placement`,async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  const instance=h.instances[0];instance.callbacks.event('transcript.fragment',{speaker:'user',text});
  instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'pause'}});await settle();
  assert.equal(instance.results.at(-1)!.result.status,'applied');assert.equal(h.state().demonstration,undefined);
  assert.equal(h.state().lesson!.phase,'demonstration');assert.equal(h.state().lesson!.status,'paused');
  assert.ok(!h.state().lesson!.completed.some(step=>step.step==='placement'));
});

test('rejected movie controls explicitly await new input without triggering a provider response loop',async t=>{
  const h=await setup(t);h.advertise();h.command('play_training_video',{clipId:'overview'});h.cue();
  const instance=h.instances[0],requestId=h.state().demonstration!.requestId;
  for(const text of ['Do not pause','What happens if I stop?', 'Stop compressions.', 'Pause practice.']){
    h.command('send_text',{text});instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'pause'}});await settle();
    const result=instance.results.at(-1)!.result;
    assert.equal(result.status,'rejected');assert.equal(result.retryable,false);assert.equal(result.silent,true);
    assert.equal(h.state().demonstration!.requestId,requestId);
  }
});


test('explicit scripted demo needs separate Ready turns, records simulation evidence, and never opens the observer',async t=>{
  const h=await setup(t,{practiceMode:'scripted_demo'});h.enterPlacement(false);
  assert.equal(h.state().config.practiceMode,'scripted_demo');assert.equal(h.state().lesson!.scriptedStage,'awaiting_ready');
  const instance=h.instances[0],next=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'next'}});await settle();return instance.results.at(-1)!.result;};
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:'I’m ready.'});
  assert.equal((await next()).status,'applied');assert.equal(h.state().lesson!.scriptedStage,'correction');
  assert.equal((await next()).status,'rejected');
  instance.callbacks.event('transcript.fragment',{speaker:'user',text:' to continue.'});
  assert.equal((await next()).status,'rejected');assert.equal(h.state().lesson!.phase,'placement');
  assert.equal(h.state().liveVideo,false);assert.equal(h.state().lesson!.observerStatus,undefined);
  assert.throws(()=>h.command('set_live_video',{enabled:true}),/Scripted demo/);
  assert.throws(()=>h.command('inspect_frame',{question:'What is visible?'}),/Scripted demo/);
  await assert.rejects(()=>h.frame(),/Live video is not active/);assert.equal(h.requests.length,0);
  h.advance(10000);(h.coordinator as any).sweep();assert.notEqual(h.state().lesson!.observerStatus,'waiting_for_camera');
  instance.callbacks.interrupted();instance.callbacks.event('transcript.fragment',{speaker:'user',text:'Now I’m ready.'});
  assert.equal((await next()).status,'applied');assert.equal(h.state().lesson!.phase,'practice');
  assert.equal((await next()).status,'rejected');
  h.command('send_text',{text:'I’m done.'});assert.equal((await next()).action,'finish_practice');
  assert.equal(h.state().lesson!.phase,'complete');
  assert.deepEqual(h.state().lesson!.completed.filter(step=>['placement','practice'].includes(step.step)).map(step=>step.evidence),['scripted_demo','scripted_demo']);
  assert.equal(h.state().lesson!.lastObservation,undefined);assert.equal(h.state().lesson!.placementEvidence,undefined);
  const transitions=h.events().filter(event=>event.type==='lesson.simulation.transition');
  assert.deepEqual(transitions.map(event=>event.payload.stage),['correction','practice','practice']);
  assert.ok(transitions.every(event=>event.payload.simulated===true&&event.payload.evidence==='scripted_demo'&&!('confidence' in event.payload)&&!('frameId' in event.payload)));
  assert.ok(!h.events().some(event=>event.type.startsWith('lesson.observer.')));
});

test('scripted reference replay and reconnect preserve the correction without repeating it or advancing',async t=>{
  const h=await setup(t,{practiceMode:'scripted_demo'});h.advertise();h.enterPlacement();
  assert.equal(h.state().lesson!.scriptedStage,'correction');
  const narrationCount=()=>h.events().filter(event=>event.type==='lesson.narration.requested'&&event.payload.pageId==='cpr-scripted-correction').length;
  assert.equal(narrationCount(),1);
  h.command('play_training_video',{clipId:'hand-placement'});h.cue();
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'ended'});await settle();
  assert.equal(h.state().lesson!.scriptedStage,'correction');assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().liveVideo,false);
  assert.equal(narrationCount(),1);
  const generation=h.state().generation;h.coordinator.reconnect(h.id,generation,randomUUID());await settle();
  assert.equal(h.state().lesson!.scriptedStage,'correction');assert.equal(narrationCount(),1);
  const instance=h.instances.at(-1)!;
  instance.callbacks.tool({id:'old-ready',name:'lesson_action',args:{action:'next'}});await settle();assert.equal(instance.results.at(-1)!.result.status,'rejected');
  h.command('send_text',{text:'I’m ready.'});instance.callbacks.tool({id:'new-ready',name:'lesson_action',args:{action:'next'}});await settle();
  assert.equal(h.state().lesson!.phase,'practice');
});

test('default live mode does not silently become scripted after an observation failure',async t=>{
  const h=await setup(t);h.enterPlacement();await h.frame();
  h.requests[0].reject(new Error('Inference deadline exceeded'));await settle();
  assert.equal(h.state().config.practiceMode,'live');assert.equal(h.state().lesson!.scriptedStage,undefined);
  assert.equal(h.state().lesson!.phase,'placement');assert.ok(!h.events().some(event=>event.type==='lesson.simulation.transition'));
  assert.equal(h.state().lesson!.observerStatus,'unavailable');assert.equal(h.state().liveVideo,true);
  assert.equal(h.state().hud.lessonPage!.id,'cpr-placement-check');
  assert.doesNotMatch(JSON.stringify(h.state().hud),/camera.*(?:unavailable|disconnect|connect|lost)/i);
  assert.equal(h.state().lesson!.lastObservation,undefined);
});


test('a recheck does not leak a single provisional negative direction to the speaking coach',async t=>{
  const h=await setup(t);h.enterPlacement();
  for(let i=0;i<2;i++){await h.frame();h.requests.at(-1)!.resolve(correct);await settle();h.advance();}
  assert.equal(h.state().lesson!.phase,'practice');
  h.advertise();h.command('play_training_video',{clipId:'hand-placement'});h.cue();
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'ended'});await settle();h.advance();
  const cues=h.events().filter(event=>event.type==='lesson.cue').length;
  const negative={...correct,placement:'too_low' as const,reason:'SINGLE_FRAME_LOW_SENTINEL'};
  await h.frame();h.requests.at(-1)!.resolve(negative);await settle();
  assert.equal(h.state().lesson!.needsPlacementCheck,true);assert.equal(h.state().lesson!.pendingCorrection,undefined);
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').length,cues);
  assert.equal(h.state().hud.lessonPage!.id,'cpr-placement-check');
  const updates=()=>h.instances.at(-1)!.contexts.filter(context=>context.text.startsWith('Practice view update:'));
  assert.doesNotMatch(updates().at(-1)!.text,/SINGLE_FRAME_LOW_SENTINEL|"placement":"too_low"/);
  h.advance();await h.frame();h.requests.at(-1)!.resolve(negative);await settle();
  assert.equal(h.state().lesson!.pendingCorrection?.kind,'too_low');
  assert.equal(h.events().filter(event=>event.type==='lesson.cue').length,cues+1);
  assert.match(updates().at(-1)!.text,/"placement":"too_low"/);
});


for(const action of ['next','end_session'])for(const text of ["I've finished the practice.","I'm done with the practice.",'I finished this round.','We have finished compressions.'])
  test(`${action} maps fresh completion “${text}” to the scripted recap without ending coaching`,async t=>{
    const h=await setup(t,{practiceMode:'scripted_demo'});h.enterPlacement();h.action('ready');
    const instance=h.instances[0];
    h.command('send_text',{text});instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action}});await settle();
    assert.equal(instance.results.at(-1)!.result.action,'finish_practice');
    assert.equal(h.state().lesson!.phase,'complete');assert.equal(h.state().status,'active');
    assert.equal(h.state().lesson!.completed.at(-1)!.evidence,'scripted_demo');
    assert.ok(!h.events().some(event=>event.type==='session.ending'));
  });

test('practice completion objects still reject negation, questions, other activities, other people and past or stale completion',async t=>{
  const h=await setup(t,{practiceMode:'scripted_demo'});h.enterPlacement();h.action('ready');
  const instance=h.instances[0],next=async()=>{instance.callbacks.tool({id:randomUUID(),name:'lesson_action',args:{action:'next'}});await settle();return instance.results.at(-1)!.result;};
  for(const text of ["I'm not finished with the practice.",'Have I finished the practice?',"I've finished the video.",'He finished the practice.',"I've finished their practice.","That's not mine. I've finished the practice.","I've finished the practice earlier.",'Earlier I finished this round.',"I've finished the session."]){
    h.command('send_text',{text});assert.equal((await next()).status,'rejected',text);
    assert.equal(h.state().lesson!.phase,'practice');assert.equal(h.state().status,'active');
  }
  h.command('send_text',{text:"I've finished the practice."});h.advance(30001);
  assert.equal((await next()).status,'rejected');assert.equal(h.state().lesson!.phase,'practice');
});


test('scripted presentation uses the ordinary learner welcome while retaining its configured mode',async t=>{
  const h=await setup(t,{practiceMode:'scripted_demo',lessonId:undefined,tutorMode:'marine'});
  assert.equal(h.state().config.practiceMode,'scripted_demo');
  assert.equal(h.state().hud.brand,'marines');
  assert.equal(h.state().hud.card!.title,'MARINE TRAINING');
  const welcome=h.instances[0].contexts.find(context=>context.spoken)!.text;
  assert.match(welcome,/I’m your AI training coach/);assert.doesNotMatch(welcome,/scripted|simulated|no visual assessment/i);
  assert.equal((h.events().find(event=>event.type==='session.created')!.payload.config as SessionConfig).practiceMode,'scripted_demo');
});
