import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { Store } from '../src/store.ts';
import type { Command } from '../../contracts/index.ts';
import type { createProvider, observeFrame } from '../src/providers/index.ts';
import type { ProviderCallbacks } from '../src/providers/types.ts';

type Observation = Awaited<ReturnType<typeof observeFrame>>;
const evidence: Observation = { visibility:'partial', claims:Array.from({length:5},(_,i)=>String(i)+'界'.repeat(239)), limitations:Array.from({length:5},(_,i)=>String(i)+'l'.repeat(239)), model:'test-observer',usage:{totalTokenCount:12},promptVersion:'test-v1',attribution:'Inference from the supplied frame only.' };
const pixels=Buffer.from('89504e470d0a1a0a00000000','hex');
const settle=async()=>{for(let i=0;i<6;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
const wait=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.fail('Expected asynchronous state was not reached');};

async function setup(t:TestContext,provider:'gemini'|'openai'='gemini') {
  const dir=mkdtempSync(join(tmpdir(),'coach-inspection-')),store=new Store(join(dir,'test.sqlite'));
  const requests:Array<{bytes:Buffer;mime:string;question:string;signal:AbortSignal;resolve:(value:Observation)=>void;reject:(error:Error)=>void}>=[];
  const instances:Array<{callbacks:ProviderCallbacks;contexts:Array<{text:string;spoken?:boolean}>;results:Array<{id:string;result:unknown}>;inspections:number}>=[];
  const factory:typeof createProvider=(_config,callbacks)=>{
    const instance={callbacks,contexts:[] as Array<{text:string;spoken?:boolean}>,results:[] as Array<{id:string;result:unknown}>,inspections:0};
    instances.push(instance);
    return{inputRate:16000,outputRate:24000,connect:async()=>{},close:async()=>{},sendAudio:()=>{},sendText:()=>{},activity:()=>{},inspect:()=>{instance.inspections++;},appendContext:(text,_id,spoken)=>{instance.contexts.push({text,spoken});},toolResult:(id,result)=>{instance.results.push({id,result});}};
  };
  const observer:typeof observeFrame=(bytes,mime,question,signal)=>new Promise((resolve,reject)=>{requests.push({bytes,mime,question,signal,resolve,reject});});
  const coordinator=new Coordinator(store,dir,{createProvider:factory,observeFrame:observer});
  t.after(async()=>{requests.forEach(request=>request.resolve(evidence));await settle();await coordinator.close();rmSync(dir,{recursive:true,force:true});});
  const {id}=coordinator.create(randomUUID(),{provider,model:provider==='gemini'?'gemini-3.8-live':'gpt-live-1',device:'mock',maxFrameAgeMs:1000});
  await wait(()=>coordinator.get(id).status==='active');
  const command=(type:Command['type'],payload:Record<string,unknown>={})=>coordinator.command(id,{schemaVersion:1,sessionId:id,generation:coordinator.get(id).generation,messageId:randomUUID(),commandId:randomUUID(),type,payload});
  const inspect=async(nativeId?:string,knownCaptureTime=true)=>{
    const question='Which object is visible?';
    let workId:string;
    if(nativeId){instances.at(-1)!.callbacks.tool({id:nativeId,name:'inspect_frame',args:{question}});await settle();workId=coordinator.get(id).work.find(work=>work.input.nativeCallId===nativeId)!.id;}
    else workId=String(command('inspect_frame',{question}).workId);
    const frameId=randomUUID();
    await coordinator.frame(id,frameId,pixels,'image/png',{generation:coordinator.get(id).generation,workId,cameraSource:'mock',captureTimeBasis:'test',...(knownCaptureTime?{capturedAt:Date.now(),clockUncertaintyMs:0}:{})});
    return{workId,frameId,question};
  };
  return{coordinator,store,id,requests,instances,command,inspect,work:(workId:string)=>coordinator.get(id).work.find(work=>work.id===workId)!,events:()=>store.events(id)};
}

for(const provider of ['gemini','openai'] as const)test(`${provider} inspection delivers complete attributed evidence through the observer`,async t=>{
  const h=await setup(t,provider),request=await h.inspect();
  assert.equal(h.requests.length,1);assert.equal(h.instances[0].inspections,0);
  assert.deepEqual(h.requests[0].bytes,pixels);assert.equal(h.requests[0].mime,'image/png');assert.equal(h.requests[0].question,request.question);
  h.requests[0].resolve(evidence);await settle();
  assert.equal(h.work(request.workId).status,'completed');
  const result=h.work(request.workId).result as Record<string,unknown>;
  assert.deepEqual(result.observation,evidence);assert.equal(result.frameId,request.frameId);assert.equal(result.captureFreshness,'fresh');assert.ok(Number(result.elapsedMs)>=0);
  assert.deepEqual(h.instances[0].contexts.map(context=>context.spoken),provider==='openai'?[false,true]:[true]);assert.equal(h.instances[0].results.length,0);
  if(provider==='openai')assert.ok(!h.instances[0].contexts[1].text.includes(evidence.claims[0]));
  const text=h.instances[0].contexts[0].text;
  for(const field of [...evidence.claims,...evidence.limitations])assert.ok(text.includes(field),'Complete evidence text survives transport');
  assert.ok(text.includes(request.frameId));assert.ok(text.includes(evidence.attribution));
  for(const type of ['observation.started','observation.completed']){
    const event=h.events().find(event=>event.type===type);assert.ok(event);assert.equal(event.payload.workId,request.workId);assert.equal(event.payload.frameId,request.frameId);assert.ok(Number(event.payload.elapsedMs)>=0);
  }
});

test('native inspection returns evidence once through its tool response without a second speech trigger',async t=>{
  const h=await setup(t),request=await h.inspect('native-one');h.requests[0].resolve(evidence);await settle();
  assert.equal(h.instances[0].results.length,1);assert.equal(h.instances[0].results[0].id,'native-one');
  const result=h.instances[0].results[0].result as Record<string,unknown>;
  assert.deepEqual(result.observation,evidence);assert.equal(result.frameId,request.frameId);assert.equal(h.instances[0].contexts.length,0);
});

test('camera failure tells the coach no image arrived, without inventing visual limitations',async t=>{
  const h=await setup(t),instance=h.instances[0];
  instance.callbacks.tool({id:'camera-failure',name:'inspect_frame',args:{question:'Describe my socks'}});await settle();
  const work=h.coordinator.get(h.id).work[0];
  h.coordinator.report(h.id,1,randomUUID(),'capture.failed',{workId:work.id,cameraSource:'meta_display'});await settle();
  assert.equal(h.requests.length,0);assert.equal(instance.results.length,1);
  const result=instance.results[0].result as Record<string,unknown>;
  assert.equal(result.reason,'capture_failed');assert.match(String(result.instruction),/No image/);
  assert.match(String(result.instruction),/camera/);assert.equal(result.observation,undefined);
});

for(const action of ['typed request','activity start','provider interruption','new native inspection','new direct inspection','end','reconnect'] as const)test(`${action} fences a late observer response`,async t=>{
  const h=await setup(t),request=await h.inspect('obsolete'),old=h.instances[0];
  if(action==='typed request')h.command('send_text',{text:'Actually, help me with something else.'});
  if(action==='activity start')h.command('activity',{active:true});
  if(action==='provider interruption')old.callbacks.interrupted();
  if(action==='new native inspection')old.callbacks.tool({id:'newer',name:'inspect_frame',args:{question:'Look at the new object.'}});
  if(action==='new direct inspection')h.command('inspect_frame',{question:'Look at the new object.'});
  if(action==='end')await h.coordinator.end(h.id);
  if(action==='reconnect')h.coordinator.reconnect(h.id,1,randomUUID());
  await settle();assert.equal(h.work(request.workId).status,'cancelled');assert.equal(h.requests[0].signal.aborted,true);
  h.requests[0].resolve(evidence);await settle();
  assert.equal(h.instances.flatMap(instance=>instance.contexts).length,0);
  assert.equal(old.results.filter(entry=>entry.id==='obsolete').length,action==='reconnect'||action==='end'?0:1);
  assert.ok(old.results.every(entry=>!(entry.result as Record<string,unknown>).observation));
  const rejected=h.events().find(event=>event.type==='observation.rejected'&&event.payload.workId===request.workId);
  assert.ok(rejected);assert.equal(rejected.payload.frameId,request.frameId);assert.ok(Number(rejected.payload.elapsedMs)>=0);
});

test('transcript fragments and activity end do not mistake the requesting utterance for a new turn',async t=>{
  const h=await setup(t),request=await h.inspect();
  for(const text of ['Which ','object ','is visible?'])h.instances[0].callbacks.event('transcript.fragment',{speaker:'user',text});
  h.command('activity',{active:false});
  assert.equal(h.requests[0].signal.aborted,false);assert.equal(h.work(request.workId).status,'running');
  h.requests[0].resolve(evidence);await settle();assert.equal(h.work(request.workId).status,'completed');assert.equal(h.instances[0].contexts.length,1);
});

test('an observation that ages out while inference runs is rejected before dispatch',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const h=await setup(t),request=await h.inspect();now+=1001;h.requests[0].resolve(evidence);await settle();
  assert.equal(h.work(request.workId).status,'failed');assert.equal(h.instances[0].contexts.length,0);
  assert.ok(!h.events().some(event=>event.type==='observation.completed'));
  const rejected=h.events().find(event=>event.type==='observation.rejected');assert.ok(rejected);assert.equal(rejected.payload.frameId,request.frameId);assert.equal(rejected.payload.elapsedMs,1001);
});

test('unknown capture time remains explicitly historical in delivered evidence and speech instructions',async t=>{
  const h=await setup(t),request=await h.inspect(undefined,false);h.requests[0].resolve(evidence);await settle();
  const result=h.work(request.workId).result as Record<string,unknown>;
  assert.equal(result.captureFreshness,'unknown');assert.equal(result.capturedAt,undefined);assert.match(String(result.instruction),/age is unknown/);
  assert.match(String(result.instruction),/last received image/);assert.equal(JSON.parse(h.instances[0].contexts[0].text).instruction,result.instruction);
});

test('observer failures return one safe terminal tool result with matching rejection diagnostics',async t=>{
  const h=await setup(t),request=await h.inspect('failed');h.requests[0].reject(new Error('private upstream text must not escape'));await settle();
  assert.equal(h.work(request.workId).status,'failed');assert.equal(h.instances[0].contexts.length,0);assert.equal(h.instances[0].results.length,1);
  assert.ok(h.events().some(event=>event.type==='observation.rejected'&&event.payload.frameId===request.frameId));
  assert.ok(!JSON.stringify({events:h.events(),results:h.instances[0].results}).includes('private upstream'));
});

test('provider cancellation aborts inspection without replying to the cancelled native call',async t=>{
  const h=await setup(t),request=await h.inspect('cancelled');
  h.instances[0].callbacks.event('provider.tools_cancelled',{ids:['cancelled']});await settle();
  assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.work(request.workId).status,'cancelled');
  h.requests[0].resolve(evidence);await settle();assert.equal(h.instances[0].results.length,0);assert.equal(h.instances[0].contexts.length,0);
});

test('inspection summaries count only audio emitted while pending and remain single after late cancelled results',async t=>{
  const h=await setup(t),callbacks=h.instances[0].callbacks;
  callbacks.audio(Buffer.alloc(4800));
  const first=await h.inspect();callbacks.audio(Buffer.alloc(2400));callbacks.audio(Buffer.alloc(2400));
  h.requests[0].resolve(evidence);await settle();
  const completed=h.events().filter(event=>event.type==='inspection.summary'&&event.payload.workId===first.workId);
  assert.equal(completed.length,1);assert.equal(completed[0].payload.audioWhilePendingMs,100);assert.ok(Number(completed[0].payload.elapsedMs)>=0);assert.equal(completed[0].payload.status,'completed');
  const second=await h.inspect();callbacks.audio(Buffer.alloc(960));h.command('cancel_work',{workId:second.workId});
  callbacks.audio(Buffer.alloc(4800));h.requests[1].resolve(evidence);await settle();
  const cancelled=h.events().filter(event=>event.type==='inspection.summary'&&event.payload.workId===second.workId);
  assert.equal(cancelled.length,1);assert.equal(cancelled[0].payload.audioWhilePendingMs,20);assert.equal(cancelled[0].payload.status,'cancelled');assert.equal(cancelled[0].payload.frameId,second.frameId);
});
