import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Coordinator} from '../src/coordinator.ts';
import {Store} from '../src/store.ts';
import type {ProviderCallbacks} from '../src/providers/types.ts';

const settle=async()=>{for(let i=0;i<6;i++)await new Promise<void>(resolve=>setImmediate(resolve));};

test('narration timing measures first provider PCM once after readiness, independently of transcript timing',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const dir=mkdtempSync(join(tmpdir(),'coach-narration-')),store=new Store(join(dir,'test.sqlite')),providers:ProviderCallbacks[]=[];
  const coordinator=new Coordinator(store,dir,{createProvider:(_config,callbacks)=>{
    providers.push(callbacks);
    return {inputRate:16000,outputRate:24000,connect:async()=>{},close:async()=>{},sendAudio:()=>{},sendText:()=>{},activity:()=>{},inspect:()=>{},appendContext:()=>{},toolResult:()=>{}};
  }});
  t.after(async()=>{await coordinator.close();rmSync(dir,{recursive:true,force:true});});
  const {id}=coordinator.create(randomUUID(),{provider:'gemini',model:'gemini-3.8-live',device:'meta_display',lessonId:'adult-cpr-demo-v1'});await settle();
  const state=()=>coordinator.get(id),timings=()=>store.events(id).filter(event=>event.type==='lesson.narration.first_audio');
  providers[0].audio(Buffer.alloc(640));assert.equal(timings().length,0);
  coordinator.audio(id,state().generation,Buffer.alloc(640));
  coordinator.report(id,state().generation,randomUUID(),'hud.receipt',{hudRevision:state().hudRevision,rendererInstanceId:'timing-fixture',target:'glasses',status:'sdk_submitted'});
  const requested=store.events(id).find(event=>event.type==='lesson.narration.requested')!;assert.ok(requested);
  now+=13;providers[0].event('transcript.fragment',{speaker:'assistant',text:'We’ll practise'});
  providers[0].audio(Buffer.alloc(0));assert.equal(timings().length,0);
  now+=110;providers[0].audio(Buffer.alloc(640));now+=50;providers[0].audio(Buffer.alloc(1280));
  assert.equal(timings().length,1);
  assert.deepEqual(timings()[0].payload,{narrationId:requested.payload.narrationId,pageId:'cpr-opening',elapsedMs:123,bytes:640,measurementBasis:'provider_pcm_received',heard:false});
  coordinator.command(id,{schemaVersion:1,sessionId:id,generation:state().generation,messageId:randomUUID(),commandId:randomUUID(),type:'lesson_action',payload:{action:'repeat'}});
  providers[0].audio(Buffer.alloc(640));assert.equal(timings().length,1);
  coordinator.report(id,state().generation,randomUUID(),'hud.receipt',{hudRevision:state().hudRevision,rendererInstanceId:'timing-fixture',target:'glasses',status:'sdk_submitted'});
  now+=75;providers[0].audio(Buffer.alloc(640));assert.equal(timings().length,2);assert.equal(timings()[1].payload.elapsedMs,75);
  assert.notEqual(timings()[1].payload.narrationId,timings()[0].payload.narrationId);
  coordinator.reconnect(id,state().generation,randomUUID());await settle();
  providers[0].audio(Buffer.alloc(640));providers[1].audio(Buffer.alloc(640));assert.equal(timings().length,2);
});

test('queued camera-starting narration is discarded when frames arrive before its display receipt',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'coach-narration-')),store=new Store(join(dir,'test.sqlite')),spoken:string[]=[];
  const coordinator=new Coordinator(store,dir,{
    createProvider:()=>({inputRate:16000,outputRate:24000,connect:async()=>{},close:async()=>{},sendAudio:()=>{},sendText:()=>{},
      activity:()=>{},inspect:()=>{},sendVideo:()=>true,appendContext:(text,_id,speak)=>{if(speak)spoken.push(text);},toolResult:()=>{}}),
    observeLessonFrame:(_bytes,_mime,_fact,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})),
  });
  t.after(async()=>{await coordinator.close();rmSync(dir,{recursive:true,force:true});});
  const {id}=coordinator.create(randomUUID(),{provider:'gemini',model:'gemini-3.8-live',device:'meta_display',lessonId:'adult-cpr-demo-v1'});await settle();
  const state=()=>coordinator.get(id);
  coordinator.audio(id,state().generation,Buffer.alloc(640));
  coordinator.mutate(id,s=>{s.lesson!.phase='placement';s.lesson!.observerStatus='waiting_for_camera';s.liveVideo=true;s.liveVideoEpoch=1;});
  coordinator.command(id,{schemaVersion:1,sessionId:id,generation:state().generation,messageId:randomUUID(),commandId:randomUUID(),type:'lesson_action',payload:{action:'ready'}});
  assert.equal(state().hud.lessonPage?.id,'cpr-camera-starting');
  const revision=state().hudRevision;
  await coordinator.frame(id,randomUUID(),Buffer.from('89504e470d0a1a0a00000000','hex'),'image/png',
    {generation:state().generation,liveVideo:true,liveVideoEpoch:state().liveVideoEpoch,frameAgeMs:0,cameraSource:'meta_display'});
  assert.equal(state().lesson!.observerStatus,'observing');assert.ok(state().hudRevision>revision);
  assert.equal(state().hud.lessonPage!.id,'cpr-placement-check');
  coordinator.report(id,state().generation,randomUUID(),'hud.receipt',{hudRevision:revision,rendererInstanceId:'timing-fixture',target:'glasses',status:'sdk_submitted'});
  assert.ok(!spoken.some(text=>text.includes('The camera is connecting.')));
  assert.ok(!store.events(id).some(event=>event.type==='lesson.narration.requested'&&event.payload.pageId==='cpr-camera-starting'));
});
