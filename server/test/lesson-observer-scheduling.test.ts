import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { Store } from '../src/store.ts';
import { observeLessonFrame } from '../src/lesson-observer.ts';

type Observation = Awaited<ReturnType<typeof observeLessonFrame>>;
const correct: Observation = { placement:'correct', confidence:0.95, reason:'Lower hand heel is visible on the manikin target.',
  landmarksVisible:true, manikinVisible:true, model:'test-observer', usage:{}, promptVersion:'fixture-v1' };
const settle = async () => { for(let i=0;i<6;i++)await new Promise<void>(resolve=>setImmediate(resolve)); };

async function setup(t:TestContext,withReferences=false) {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const dir=mkdtempSync(join(tmpdir(),'coach-observer-')),store=new Store(join(dir,'test.sqlite'));
  if(withReferences){const path=join(dir,'cpr-placement-reference');mkdirSync(path);for(const file of ['correct.jpg','too-low.jpg'])writeFileSync(join(path,file),Buffer.from('ffd8ffe0ffd9','hex'));}
  const requests:Array<{signal:AbortSignal;options:Parameters<typeof observeLessonFrame>[4];resolve:(value:Observation)=>void;reject:(error:Error)=>void}>=[];
  const contexts:Array<{text:string;spoken?:boolean}>=[];
  const coordinator=new Coordinator(store,dir,{
    createProvider:()=>({inputRate:16000,outputRate:24000,connect:async()=>{},close:async()=>{},sendAudio:()=>{},sendText:()=>{},
      activity:()=>{},inspect:()=>{},sendVideo:()=>true,appendContext:(text,_id,spoken)=>contexts.push({text,spoken}),toolResult:()=>{}}),
    observeLessonFrame:(_bytes,_mime,_fact,signal,options)=>new Promise((resolve,reject)=>requests.push({signal,options,resolve,reject})),
  });
  t.after(async()=>{requests.forEach(request=>request.resolve(correct));await settle();await coordinator.close();rmSync(dir,{recursive:true,force:true});});
  const {id}=coordinator.create(randomUUID(),{provider:'gemini',model:'gemini-3.8-live',device:'mock',lessonId:'adult-cpr-demo-v1'});
  await settle();
  coordinator.mutate(id,s=>{s.lesson!.phase='placement';s.lesson!.ready=true;s.lesson!.needsPlacementCheck=true;s.liveVideo=true;s.liveVideoEpoch=1;});
  const state=()=>coordinator.get(id);
  const frame=()=>coordinator.frame(id,randomUUID(),Buffer.from('89504e470d0a1a0a00000000','hex'),'image/png',
    {generation:state().generation,liveVideo:true,liveVideoEpoch:state().liveVideoEpoch,frameAgeMs:0,cameraSource:'meta_display'});
  return {coordinator,id,state,frame,requests,contexts,advance:(ms:number)=>{now+=ms;},events:()=>store.events(id)};
}

test('placement loads calibration references and keeps their provenance out of learner observation state',async t=>{
  const previous=process.env.PLACEMENT_OBSERVER_MODEL;process.env.PLACEMENT_OBSERVER_MODEL='gpt-5.6-terra';
  t.after(()=>{if(previous===undefined)delete process.env.PLACEMENT_OBSERVER_MODEL;else process.env.PLACEMENT_OBSERVER_MODEL=previous;});
  const h=await setup(t,true);await h.frame();
  assert.equal(h.requests[0].options?.model,'gpt-5.6-terra');
  assert.equal(h.requests[0].options?.timeoutMs,4500);
  const references=h.requests[0].options!.references!;assert.deepEqual(references.map(r=>r.pose),['correct','too_low']);
  const referenceEvidence={provenance:'user_labeled_calibration' as const,references:references.map(({pose,sha256})=>({pose,sha256}))};
  h.requests[0].resolve({...correct,serviceTier:'priority',referenceEvidence});await settle();
  assert.deepEqual(h.events().find(e=>e.type==='lesson.observer.completed')!.payload.referenceEvidence,referenceEvidence);
  assert.ok(!('referenceEvidence' in h.state().lesson!.lastObservation!));
  assert.equal(h.events().find(e=>e.type==='lesson.observer.completed')!.payload.serviceTier,'priority');
  assert.ok(!('serviceTier' in h.state().lesson!.lastObservation!));
  assert.ok(!JSON.stringify(h.contexts).includes('sha256'));
  h.coordinator.mutate(h.id,s=>{s.config.observerModel='gemini-3.8-flash';});h.advance(1001);await h.frame();
  assert.equal(h.requests[1].options?.model,'gemini-3.8-flash');
});

test('live coach receives camera recovery and first placement evidence without announcing completion',async t=>{
  const h=await setup(t);h.contexts.length=0;await h.frame();
  assert.ok(h.contexts.some(context=>!context.spoken&&context.text.includes('"camera":"receiving"')));
  h.requests[0].resolve(correct);await settle();
  const update=h.contexts.find(context=>context.text.includes('"placement":"correct"'))!;
  assert.ok(update);assert.equal(update.spoken,false);assert.match(update.text,/"placementConfirmed":false/);
  assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().lesson!.correctStreak,1);
  assert.ok(!h.contexts.some(context=>context.spoken));
});

test('inference timeout is reported as a checking delay while camera frames are arriving',async t=>{
  const h=await setup(t);await h.frame();h.advance(4000);await h.frame();h.advance(500);
  h.requests[0].reject(new Error('Inference timed out'));await settle();
  const update=h.contexts.find(context=>context.text.includes('"placementCheck":"retrying"'))!;
  assert.ok(update);assert.match(update.text,/"camera":"receiving"/);assert.equal(update.spoken,false);
});

test('one slow check does not block fresh evidence and concurrency stays bounded',async t=>{
  const h=await setup(t);await h.frame();h.advance(1001);await h.frame();assert.equal(h.requests.length,2);
  h.advance(1001);await h.frame();assert.equal(h.requests.length,2);
  h.requests[1].resolve(correct);await settle();assert.equal(h.state().lesson!.correctStreak,1);
  h.advance(1001);await h.frame();assert.equal(h.requests.length,3);
  h.requests[2].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'practice');
  assert.equal(h.state().lesson!.placementEvidence!.evidence,'visual_observation');
  assert.equal(h.state().liveVideo,false);assert.equal(h.requests[0].signal.aborted,true);
  h.requests[0].resolve({...correct,placement:'too_low'});await settle();
  assert.equal(h.state().lesson!.needsPlacementCheck,false);assert.equal(h.state().lesson!.lastObservation!.placement,'correct');
  assert.equal(Math.max(...h.events().filter(e=>e.type==='lesson.observer.started').map(e=>Number(e.payload.inFlight))),2);
});

test('out-of-order older findings cannot overwrite a newer frame or issue a correction',async t=>{
  const h=await setup(t);await h.frame();h.advance(1001);await h.frame();
  h.requests[1].resolve(correct);await settle();
  h.requests[0].resolve({...correct,placement:'too_low'});await settle();
  assert.equal(h.state().lesson!.lastObservation!.placement,'correct');assert.equal(h.state().lesson!.correctStreak,1);
  assert.ok(!h.events().some(e=>e.type==='lesson.cue'));
  assert.ok(h.events().some(e=>e.type==='lesson.observer.discarded'&&e.payload.reason==='newer_frame_applied'));
});

test('failure of an older check does not replace a newer valid finding with an unavailable state',async t=>{
  const h=await setup(t);await h.frame();h.advance(1001);await h.frame();
  h.requests[1].resolve(correct);await settle();h.contexts.length=0;
  h.requests[0].reject(new Error('Inference timed out'));await settle();
  assert.equal(h.state().lesson!.observerStatus,'idle');assert.equal(h.state().lesson!.correctStreak,1);
  assert.ok(!h.contexts.some(context=>context.text.includes('retrying')));
  assert.ok(h.events().some(e=>e.type==='lesson.observer.failed'&&e.payload.superseded===true));
});

test('a newer successful check clears the error from an overlapping failed check',async t=>{
  const h=await setup(t);await h.frame();h.advance(1001);await h.frame();
  h.requests[0].reject(new Error('Inference timed out'));await settle();assert.ok(h.state().lesson!.observerError);
  h.requests[1].resolve(correct);await settle();
  assert.equal(h.state().lesson!.observerError,undefined);assert.equal(h.state().lesson!.observerStatus,'idle');
});

test('a concurrent timeout does not remove rate-limit backoff',async t=>{
  const h=await setup(t);await h.frame();h.advance(1001);await h.frame();
  h.requests[1].reject(new Error('Inference request failed (HTTP 429)'));await settle();
  h.advance(1001);h.requests[0].reject(new Error('Inference timed out'));await settle();
  await h.frame();assert.equal(h.requests.length,2);
  h.advance(1999);await h.frame();assert.equal(h.requests.length,3);
});

test('observer timeout retries the next fresh frame and still requires two supported observations',async t=>{
  const h=await setup(t);await h.frame();h.advance(4500);h.requests[0].reject(new Error('Inference timed out'));await settle();
  const failure=h.events().find(event=>event.type==='lesson.observer.failed')!;
  assert.equal(failure.payload.category,'timeout');assert.equal(failure.payload.retryAfterMs,0);
  assert.equal(h.state().lesson!.observerError,'Placement check unavailable; retrying automatically.');
  await h.frame();assert.equal(h.requests.length,2);
  h.requests[1].resolve(correct);await settle();assert.equal(h.state().lesson!.phase,'placement');
  h.advance(1001);await h.frame();h.requests[2].resolve(correct);await settle();
  assert.equal(h.state().lesson!.phase,'practice');assert.equal(h.state().lesson!.placementEvidence!.evidence,'visual_observation');
});

for(const [message,category] of [
  ['Inference request failed (HTTP 429)','rate_limit'],['Inference connection failed','network'],
  ['Inference returned an incomplete or invalid structured result','invalid_response'],['Unexpected failure','inference_error'],
])test(`observer ${category} retains backoff and records a bounded category`,async t=>{
  const h=await setup(t);await h.frame();h.requests[0].reject(new Error(message));await settle();
  const failure=h.events().find(event=>event.type==='lesson.observer.failed')!;
  assert.equal(failure.payload.category,category);assert.equal(failure.payload.retryAfterMs,3000);
  assert.ok(!JSON.stringify(failure.payload).includes(message));
  h.advance(1001);await h.frame();assert.equal(h.requests.length,1);
  h.advance(1999);await h.frame();assert.equal(h.requests.length,2);
});

test('cancelled observer work is not reported as an inference failure',async t=>{
  const h=await setup(t);await h.frame();h.advance(1001);await h.frame();assert.equal(h.requests.length,2);
  h.coordinator.command(h.id,{schemaVersion:1,sessionId:h.id,generation:h.state().generation,messageId:randomUUID(),commandId:randomUUID(),
    type:'lesson_action',payload:{action:'pause',expectedRevision:h.state().lesson!.revision}});
  for(const request of h.requests){assert.equal(request.signal.aborted,true);request.reject(new Error('Inference timed out'));}await settle();
  assert.ok(!h.events().some(event=>event.type==='lesson.observer.failed'));
  for(const started of h.events().filter(e=>e.type==='lesson.observer.started')){
    const terminal=h.events().filter(e=>['lesson.observer.completed','lesson.observer.failed','lesson.observer.discarded'].includes(e.type)&&e.payload.frameId===started.payload.frameId);
    assert.equal(terminal.length,1);assert.equal(terminal[0].type,'lesson.observer.discarded');assert.equal(terminal[0].payload.reason,'aborted');
  }
  assert.equal(h.state().lesson!.status,'paused');
});

test('retry scheduling never accepts an observer response older than five seconds',async t=>{
  const h=await setup(t);await h.frame();h.advance(5001);h.requests[0].resolve(correct);await settle();
  assert.equal(h.state().lesson!.phase,'placement');assert.equal(h.state().lesson!.correctStreak,0);
  assert.ok(h.events().some(event=>event.type==='lesson.observer.discarded'));
  assert.ok(!h.events().some(event=>event.type==='lesson.cue'));
});

test('structured placement distinguishes visible off-target hands and requires visible landmarks',async t=>{
  const previous=process.env.GEMINI_KEY;process.env.GEMINI_KEY='test-only';
  t.after(()=>{if(previous===undefined)delete process.env.GEMINI_KEY;else process.env.GEMINI_KEY=previous;});
  const value={placement:'off_target',confidence:0.95,reason:'The heel is clearly lateral to the quoted target.',landmarksVisible:true,manikinVisible:true};
  let body:any;
  const run=(patch:Record<string,unknown>={})=>observeLessonFrame(Buffer.from('fixture'),'image/png','Quoted target fact.',new AbortController().signal,{
    fetchImpl:async(_url,init)=>{
      body=JSON.parse(String(init?.body));
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...value,...patch})}]}}]});
    },
  });
  const result=await run();assert.equal(result.placement,'off_target');assert.equal(result.promptVersion,'manikin-placement-v2');
  assert.ok(body.generationConfig.responseJsonSchema.properties.placement.enum.includes('off_target'));
  assert.match(body.systemInstruction.parts[0].text,/outside that target but not below/);
  assert.match(body.systemInstruction.parts[0].text,/Clothing, occlusion, poor framing or ambiguous perspective require placement unknown/);
  assert.equal((await run({landmarksVisible:false})).placement,'unknown');
  assert.equal((await run({manikinVisible:false})).placement,'unknown');
  await assert.rejects(run({placement:'too_high'}),/invalid structured/);
});


test('a provider-context error after completed verification cannot record a second observer terminal event',async t=>{
  const h=await setup(t);await h.frame();h.requests[0].resolve(correct);await settle();
  h.advance(1001);await h.frame();
  t.mock.method(h.coordinator.runtime.get(h.id)!.provider,'appendContext',()=>{throw new Error('fixture dispatch failure');});
  h.requests[1].resolve(correct);await settle();
  const started=h.events().filter(e=>e.type==='lesson.observer.started').at(-1)!;
  const terminal=h.events().filter(e=>['lesson.observer.completed','lesson.observer.failed','lesson.observer.discarded'].includes(e.type)&&e.payload.frameId===started.payload.frameId);
  assert.equal(terminal.length,1);assert.equal(terminal[0].type,'lesson.observer.completed');
});
