import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Coordinator} from '../src/coordinator.ts';
import {Store} from '../src/store.ts';
import type {ProviderCallbacks} from '../src/providers/types.ts';

test('presentation microphone excludes tutor playback, its echo tail, and video audio',async t=>{
  let now=100000;t.mock.method(Date,'now',()=>now);
  const dir=mkdtempSync(join(tmpdir(),'coach-echo-')),input:Buffer[]=[];
  let callbacks:ProviderCallbacks;
  const coordinator=new Coordinator(new Store(join(dir,'test.sqlite')),dir,{createProvider:(_config,cb)=>{
    callbacks=cb;return{inputRate:16000,outputRate:24000,connect:async()=>{},close:async()=>{},sendAudio:pcm=>input.push(pcm),sendText:()=>{},activity:()=>{},inspect:()=>{},appendContext:()=>{},toolResult:()=>{}};
  }});
  t.after(async()=>{await coordinator.close();rmSync(dir,{recursive:true,force:true});});
  const {id}=coordinator.create(randomUUID(),{provider:'gemini',model:'gemini-3.8-live',videoTarget:'presentation'});
  await new Promise(resolve=>setImmediate(resolve));
  const microphone=Buffer.alloc(640,7),send=()=>{coordinator.audio(id,1,microphone);return input.at(-1)!;};
  assert.deepEqual(send(),microphone);
  callbacks!.audio(Buffer.alloc(48000));callbacks!.audio(Buffer.alloc(48000));
  callbacks!.event('provider.utterance_complete',{});
  assert.deepEqual(send(),Buffer.alloc(640),'Generation completion is not playback completion');
  now+=1800;assert.deepEqual(send(),Buffer.alloc(640));
  now+=1000;assert.deepEqual(send(),microphone);
  coordinator.playbackProgress(id,0,0,50000);coordinator.playbackProgress(id,1,9,50000);
  assert.deepEqual(send(),microphone,'Stale playback reports must not mute a new speech epoch');
  coordinator.playbackProgress(id,1,0,2000);
  assert.deepEqual(send(),Buffer.alloc(640),'A delayed speaker queue must extend the gate');
  now+=2100;assert.deepEqual(send(),Buffer.alloc(640),'Allow the TV echo to decay after draining');
  now+=700;assert.deepEqual(send(),microphone);
  callbacks!.audio(Buffer.alloc(48000*10));coordinator.flush(id,'operator');
  assert.deepEqual(send(),Buffer.alloc(640));now+=800;assert.deepEqual(send(),microphone,'Flushing must discard the old ten-second gate');
  coordinator.mutate(id,s=>{s.lesson={phase:'demonstration'} as any;s.demonstration={requestId:randomUUID(),assetId:randomUUID(),status:'playing',target:'presentation',startedAt:now,deadlineAt:now+30000};});
  callbacks!.audio(Buffer.alloc(48000)); // Gemini output is suppressed during the movie.
  assert.deepEqual(send(),Buffer.alloc(640),'Video narration must never reach Gemini');
  assert.ok(coordinator.store.events(id).some(e=>e.type==='microphone.echo_gate'&&e.payload.blocked===true));
  coordinator.mutate(id,s=>{delete s.demonstration;s.config.videoTarget='glasses';});
  callbacks!.audio(Buffer.alloc(48000));assert.deepEqual(send(),microphone,'Normal headset conversation retains barge-in');
});
