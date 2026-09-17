import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, HttpError } from '../src/coordinator.ts';
import { Store } from '../src/store.ts';
import type { Command } from '../../contracts/index.ts';

const pixels=Buffer.from('89504e470d0a1a0a00000000','hex');
async function setup(t:TestContext,provider:'gemini'|'openai'='gemini') {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const dir=mkdtempSync(join(tmpdir(),'coach-video-')),store=new Store(join(dir,'test.sqlite'));
  const videos:Buffer[]=[],contexts:string[]=[],texts:string[]=[];let backpressure=false;
  const coordinator=new Coordinator(store,dir,{createProvider:()=>({inputRate:16000,outputRate:24000,connect:async()=>{},close:async()=>{},sendAudio:()=>{},sendText:text=>texts.push(text),activity:()=>{},inspect:()=>{},toolResult:()=>{},appendContext:text=>contexts.push(text),sendVideo:bytes=>{if(backpressure)return false;videos.push(bytes);return true;}})});
  t.after(async()=>{await coordinator.close();rmSync(dir,{recursive:true,force:true});});
  const {id}=coordinator.create(randomUUID(),{provider,model:provider==='gemini'?'gemini-3.8-live':'gpt-live-1',device:'meta_display'});
  await new Promise<void>(resolve=>setImmediate(resolve));
  const command=(type:Command['type'],payload:Record<string,unknown>={})=>coordinator.command(id,{schemaVersion:1,sessionId:id,generation:coordinator.get(id).generation,messageId:randomUUID(),commandId:randomUUID(),type,payload});
  const frame=(meta:Record<string,unknown>={},bytes=pixels,frameId=randomUUID())=>coordinator.frame(id,frameId,bytes,'image/png',{generation:coordinator.get(id).generation,liveVideo:true,liveVideoEpoch:coordinator.get(id).liveVideoEpoch,frameAgeMs:0,...meta});
  return{coordinator,store,id,videos,contexts,texts,command,frame,advance:(ms:number)=>{now+=ms;},congest:()=>{backpressure=true;},snapshot:()=>coordinator.get(id)};
}

test('live video is explicit, Gemini-only, generation-fenced and off after reconnect',async t=>{
  const h=await setup(t);assert.equal(h.snapshot().liveVideo,false);
  await assert.rejects(h.frame(),/not active/);
  assert.deepEqual(h.command('set_live_video',{enabled:true}),{status:'accepted',liveVideo:true,liveVideoEpoch:1});
  await assert.rejects(h.frame({generation:0}),/Stale connection/);
  await assert.rejects(h.frame({liveVideoEpoch:0}),/replaced/);
  await h.frame();assert.equal(h.videos.length,1);
  h.command('set_live_video',{enabled:false});h.command('set_live_video',{enabled:true});
  await assert.rejects(h.frame({liveVideoEpoch:1}),/replaced/);
  h.coordinator.reconnect(h.id,1,randomUUID());assert.equal(h.snapshot().liveVideo,false);
  await assert.rejects(h.frame(),/not active/);
});

test('GPT Live rejects video mode without mutating state',async t=>{
  const h=await setup(t,'openai');assert.throws(()=>h.command('set_live_video',{enabled:true}),/requires Gemini/);
  assert.equal(h.snapshot().liveVideo,false);
});

test('spectator preview stays ephemeral and never reaches the live model',async t=>{
  const h=await setup(t);
  const preview=(meta:Record<string,unknown>={},bytes=pixels)=>h.frame({preview:true,liveVideo:false,cameraSource:'meta_display',...meta},bytes);
  assert.equal((await preview()).status,'previewed');
  assert.deepEqual(h.coordinator.cameraPreview(h.id)?.bytes,pixels);
  h.advance(250);await preview({liveVideo:true}); // A preview must not enable general Gemini vision.
  assert.equal(h.videos.length,0);assert.equal(h.store.assets(h.id).length,0);
  assert.equal(h.snapshot().latestFrame,undefined);
  await assert.rejects(preview({generation:0}),/Stale connection/);
  await assert.rejects(preview({},Buffer.concat([pixels,Buffer.alloc(256*1024)])),/size/);
  h.advance(2001);assert.equal(h.coordinator.cameraPreview(h.id),undefined);
  await preview();await h.coordinator.end(h.id);assert.equal(h.coordinator.cameraPreview(h.id),undefined);
});

test('sampled video is ephemeral, capped at one FPS, and telemetered without per-frame assets',async t=>{
  const h=await setup(t);h.command('set_live_video',{enabled:true});
  const first=await h.frame();assert.equal(first.status,'submitted');
  assert.equal((await h.frame()).reason,'frame_rate');
  h.advance(1000);assert.equal((await h.frame()).status,'submitted');
  h.advance(1000);assert.equal((await h.frame({frameAgeMs:2001})).reason,'stale_frame');
  h.congest();assert.equal((await h.frame()).reason,'provider_backpressure');
  assert.equal(h.videos.length,2);assert.deepEqual(h.videos[0],pixels);
  assert.equal(h.snapshot().liveVideoStats?.submitted,2);assert.equal(h.snapshot().liveVideoStats?.dropped,3);
  assert.equal(h.store.assets(h.id).length,0);assert.equal(h.coordinator.transient.size,0);assert.equal(h.snapshot().latestFrame,undefined);
  assert.equal(h.store.events(h.id).filter(e=>e.type==='video.summary').length,1);
  assert.ok(h.contexts.some(text=>/Sensor capture time is unknown/.test(text)));
});

test('live description rejects absent and stale video, and accepts recent received frames',async t=>{
  const h=await setup(t),describe=()=>h.command('send_text',{text:'Describe the live view',requireLiveVideo:true});
  assert.throws(describe,/no recent frames/);h.command('set_live_video',{enabled:true});assert.throws(describe,/no recent frames/);
  await h.frame();assert.equal(describe().status,'accepted');assert.equal(h.texts.length,1);
  h.advance(5001);assert.throws(describe,/no recent frames/);assert.equal(h.texts.length,1);
  h.command('set_live_video',{enabled:false});assert.throws(describe,/no recent frames/);
});

test('invalid video metadata, oversized frames, ended sessions and still-work reuse never reach Gemini',async t=>{
  const h=await setup(t);h.command('set_live_video',{enabled:true});
  await assert.rejects(h.frame({frameAgeMs:undefined}));
  await assert.rejects(h.frame({frameAgeMs:Infinity}));
  await assert.rejects(h.frame({workId:randomUUID()}),/still inspection/);
  await assert.rejects(h.frame({},Buffer.concat([pixels,Buffer.alloc(256*1024)])),/256 KiB/);
  await h.coordinator.end(h.id);await assert.rejects(h.frame(),/not active/);assert.equal(h.videos.length,0);
});

test('a stalled stream notifies Gemini once and fresh frames restore visual context',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const h=await setup(t);h.command('set_live_video',{enabled:true});await h.frame();
  h.advance(5001);t.mock.timers.tick(1000);t.mock.timers.tick(1000);
  assert.equal(h.contexts.filter(text=>/Live video is stale/.test(text)).length,1);
  assert.equal(h.store.events(h.id).filter(event=>event.type==='video.stale').length,1);
  await h.frame();assert.equal(h.contexts.filter(text=>/receiving recent/.test(text)).length,2);
  h.command('set_live_video',{enabled:false});
  assert.ok(h.store.events(h.id).some(event=>event.type==='video.summary'&&event.payload.reason==='mode_changed'&&event.payload.submitted===2));
});


test('stale live-description precondition returns 412 without replacing the provider connection',async t=>{
  const h=await setup(t);h.command('set_live_video',{enabled:true});await h.frame();h.advance(5001);
  const runtime=h.coordinator.runtime.get(h.id),generation=h.snapshot().generation;
  assert.throws(()=>h.command('send_text',{text:'Describe the current view',requireLiveVideo:true}),error=>error instanceof HttpError&&error.status===412);
  assert.equal(h.snapshot().status,'active');assert.equal(h.snapshot().generation,generation);
  assert.equal(h.coordinator.runtime.get(h.id),runtime);assert.equal(h.snapshot().liveVideo,true);
  assert.equal(h.texts.length,0);assert.ok(!h.store.events(h.id).some(event=>event.type==='connection.replacing'));
});
