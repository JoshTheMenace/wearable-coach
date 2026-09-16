import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { Store } from '../src/store.ts';
import type { Command, SessionConfig } from '../../contracts/index.ts';
import type { ProviderCallbacks, ProviderOptions } from '../src/providers/types.ts';

const pixels=Buffer.from('89504e470d0a1a0a00000000','hex');
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const capabilities={video:true,source:'device-local',maxWidth:400,maxHeight:400,maxPixels:70000};
async function setup(t:TestContext,device:SessionConfig['device']='mock') {
  const dir=mkdtempSync(join(tmpdir(),'coach-demonstration-')),store=new Store(join(dir,'test.sqlite'));
  const instances:{callbacks:ProviderCallbacks;options?:ProviderOptions;input:number;videos:number;sequence:string[];results:unknown[]}[]=[];
  const coordinator=new Coordinator(store,dir,{createProvider:(_config,callbacks,options)=>{
    const instance={callbacks,options,input:0,videos:0,sequence:[] as string[],results:[] as unknown[]};instances.push(instance);
    return{inputRate:16000,outputRate:24000,resumeHandle:'test-resumption',connect:async()=>{},close:async()=>{},sendAudio:()=>{instance.input++;},sendVideo:()=>{instance.videos++;instance.sequence.push('VIDEO');return true;},sendText:()=>{},activity:()=>{},inspect:()=>{},toolResult:(_id,result)=>instance.results.push(result),appendContext:text=>instance.sequence.push(text)};
  },observeFrame:async()=>({visibility:'partial',claims:['A training prop is visible.'],limitations:['Motion cannot be measured.'],model:'test',usage:{},promptVersion:'test',attribution:'Frame inference'})});
  t.after(async()=>{await coordinator.close();rmSync(dir,{recursive:true,force:true});});
  const {id}=coordinator.create(randomUUID(),{provider:'gemini',model:'gemini-3.8-live',device});await settle();
  const state=()=>coordinator.get(id);
  const command=(type:Command['type'],payload:Record<string,unknown>={},commandId=randomUUID())=>coordinator.command(id,{schemaVersion:1,sessionId:id,generation:state().generation,messageId:randomUUID(),commandId,type,payload});
  const report=(type:string,payload:Record<string,unknown>,generation=state().generation)=>coordinator.report(id,generation,randomUUID(),type,payload);
  const asset={id:randomUUID(),width:320,height:180,durationMs:10000,mime:'video/mp4'};
  const advertise=(assetChanges:Record<string,unknown>={},caps:Record<string,unknown>=capabilities)=>report('device.status',{displayCapabilities:caps,demoAssets:[{...asset,...assetChanges}]});
  const start=()=>{advertise();command('start_demo',{assetId:asset.id});return state().demonstration!;};
  const frame=(meta:Record<string,unknown>={})=>coordinator.frame(id,randomUUID(),pixels,'image/png',{generation:state().generation,liveVideo:true,liveVideoEpoch:state().liveVideoEpoch,frameAgeMs:0,...meta});
  return{coordinator,store,id,state,instances,command,report,asset,advertise,start,frame};
}

test('demonstration keeps latest HUD, suppresses media, then fences old output with a fresh connection',async t=>{
  const h=await setup(t),old=h.instances[0],output:unknown[]=[],flush:unknown[]=[];
  h.coordinator.on('audio',packet=>output.push(packet));h.coordinator.on('flush',packet=>flush.push(packet));
  h.command('set_hud',{hud:{card:{body:'Current practice step'}}});
  h.command('set_live_video',{enabled:true});await h.frame();
  const pending=h.command('inspect_frame',{question:'Pending view'});
  const demo=h.start();assert.equal(demo.status,'starting');assert.equal(flush.length,1);
  assert.equal(h.state().liveVideo,false);assert.equal(h.state().liveVideoEpoch,2);
  assert.equal(h.state().work.find(work=>work.id===pending.workId)?.status,'cancelled');
  assert.equal(h.state().hud.card?.body,'Current practice step');
  old.callbacks.audio(Buffer.alloc(960));h.coordinator.audio(h.id,1,Buffer.alloc(640));
  assert.equal(old.input,0);assert.equal(output.length,0);
  await assert.rejects(h.frame(),/suspended/);assert.equal(old.videos,1);
  assert.throws(()=>h.command('inspect_frame',{question:'During demonstration'}),/suspended/);
  assert.throws(()=>h.command('send_text',{text:'Continue'}),/suspended/);
  old.callbacks.tool({id:'during-demo-inspection',name:'inspect_frame',args:{question:'No frame'}});
  await settle();assert.ok(old.results.some(result=>(result as {status?:string}).status==='rejected'));
  old.callbacks.tool({id:'during-demo-hud',name:'set_hud',args:{card:{body:'Latest practice step'}}});await settle();
  assert.equal(h.state().hud.card?.body,'Latest practice step');
  assert.ok(h.store.events(h.id).some(event=>event.type==='hud.accepted'&&event.payload.deferred===true));
  h.report('demo.playback',{requestId:demo.requestId,status:'playing'});assert.equal(h.state().demonstration?.status,'playing');
  h.report('demo.playback',{requestId:demo.requestId,status:'ended'});await settle();
  assert.equal(h.state().generation,2);assert.equal(h.state().demonstration,undefined);assert.equal(h.state().liveVideo,false);
  assert.equal(h.state().hud.card?.body,'Latest practice step');assert.equal(h.state().device?.demoAssets,undefined);
  assert.equal(h.instances[1].options?.resumeHandle,undefined);
  old.callbacks.audio(Buffer.alloc(960));old.callbacks.tool({id:'late-hud',name:'clear_hud',args:{}});await settle();
  assert.equal(output.length,0);assert.equal(h.state().hud.card?.body,'Latest practice step');
  h.instances[1].callbacks.audio(Buffer.alloc(960));assert.equal(output.length,1);
});

test('start is idempotent and stale callbacks cannot stop a newer request',async t=>{
  const h=await setup(t);h.advertise();const commandId=randomUUID();
  const first=h.command('start_demo',{assetId:h.asset.id},commandId);
  assert.deepEqual(h.command('start_demo',{assetId:h.asset.id},commandId),first);
  assert.throws(()=>h.command('start_demo',{assetId:h.asset.id}),/already active/);
  h.report('demo.playback',{requestId:randomUUID(),status:'ended'});assert.equal(h.state().generation,1);
  assert.equal(h.state().demonstration?.requestId,first.requestId);
  h.command('stop_demo',{requestId:first.requestId});await settle();
  assert.throws(()=>h.report('demo.playback',{requestId:first.requestId,status:'ended'},1),/Stale/);
  assert.throws(()=>h.command('start_demo',{assetId:h.asset.id}),/unsupported/);
  const second=h.start();h.report('demo.playback',{requestId:first.requestId,status:'failed'});
  assert.equal(h.state().demonstration?.requestId,second.requestId);assert.equal(h.state().generation,2);
  assert.throws(()=>h.command('stop_demo',{requestId:first.requestId}),/no longer active/);
});

for(const reason of ['failed','reconnect','end'] as const)test(`${reason} cancels demonstration without stale playback effects`,async t=>{
  const h=await setup(t);h.command('set_hud',{hud:{card:{body:'Retained'}}});const demo=h.start();
  if(reason==='failed')h.report('demo.playback',{requestId:demo.requestId,status:'failed',reason:'Decoder error'});
  if(reason==='reconnect')h.coordinator.reconnect(h.id,1,randomUUID());
  if(reason==='end')await h.coordinator.end(h.id);
  await settle();assert.equal(h.state().demonstration,undefined);assert.equal(h.state().liveVideo,false);
  if(reason!=='end'){assert.equal(h.state().hud.card?.body,'Retained');assert.equal(h.state().device?.displayCapabilities,undefined);assert.equal(h.instances[1].options?.resumeHandle,undefined);}
  assert.ok(h.store.events(h.id).some(event=>event.type==='demo.finished'));
});

for(const status of ['starting','playing'] as const)test(`${status} demonstration timeout restores HUD and turns live video off`,async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:Date.now()});
  const h=await setup(t);h.command('set_hud',{hud:{card:{body:'Timed out clip'}}});const demo=h.start();
  if(status==='playing')h.report('demo.playback',{requestId:demo.requestId,status});
  t.mock.timers.tick(status==='starting'?16000:26000);await settle();
  assert.equal(h.state().demonstration,undefined);assert.equal(h.state().generation,2);assert.equal(h.state().liveVideo,false);
  assert.equal(h.state().hud.card?.body,'Timed out clip');
  assert.ok(h.store.events(h.id).some(event=>event.type==='demo.finished'&&event.payload.reason==='timeout'));
});

test('only explicitly capable devices can play registered, bounded assets',async t=>{
  const h=await setup(t);assert.throws(()=>h.command('start_demo',{assetId:h.asset.id}),/unsupported/);
  h.advertise({}, {...capabilities,video:false});assert.throws(()=>h.command('start_demo',{assetId:h.asset.id}),/unsupported/);
  h.advertise();assert.throws(()=>h.command('start_demo',{assetId:randomUUID()}),/not registered/);
  for(const dimensions of [{width:401,height:100},{width:100,height:401},{width:300,height:300}]){
    h.advertise(dimensions);assert.throws(()=>h.command('start_demo',{assetId:h.asset.id}),/dimensions/);
  }
  h.advertise({}, {...capabilities,maxWidth:100});assert.throws(()=>h.command('start_demo',{assetId:h.asset.id}),/dimensions/);
  assert.throws(()=>h.advertise({durationMs:Infinity}));assert.throws(()=>h.advertise({mime:'video/webm'}));
  assert.throws(()=>h.report('device.status',{demoAssets:[h.asset,h.asset]}));
  assert.equal(h.state().demonstration,undefined);
  const phone=await setup(t,'phone');phone.advertise({}, {...capabilities,video:false});assert.throws(()=>phone.command('start_demo',{assetId:phone.asset.id}),/unsupported/);
  const glasses=await setup(t,'meta_display');glasses.advertise();glasses.command('start_demo',{assetId:glasses.asset.id});assert.equal(glasses.state().demonstration?.assetId,glasses.asset.id);
});

test('recorded video attribution precedes pixels, position is retained, and source changes require a new epoch',async t=>{
  const h=await setup(t),provider=h.instances[0];h.command('set_live_video',{enabled:true});
  const recorded={cameraSource:'recorded_video',captureTimeBasis:'recorded_media',sourcePositionMs:3400};
  await h.frame(recorded);
  const notice=provider.sequence.findIndex(text=>text.includes('prerecorded footage'));
  assert.ok(notice>=0&&notice<provider.sequence.indexOf('VIDEO'));assert.match(provider.sequence[notice],/cannot confirm learner completion/);
  assert.equal(h.state().liveVideoStats?.sourcePositionMs,3400);assert.equal(h.state().liveVideoStats?.cameraSource,'recorded_video');
  assert.ok(h.store.events(h.id).some(event=>event.type==='video.summary'&&event.payload.sourcePositionMs===3400));
  await assert.rejects(h.frame({cameraSource:'mock'}),/source changed/);
  await assert.rejects(h.frame({...recorded,capturedAt:Date.now()}),/must not claim/);
  await assert.rejects(h.frame({...recorded,sourcePositionMs:-1}));await assert.rejects(h.frame({...recorded,sourcePositionMs:Infinity}));
  const oldEpoch=h.state().liveVideoEpoch;h.command('set_live_video',{enabled:false});h.command('set_live_video',{enabled:true});
  await assert.rejects(h.frame({liveVideoEpoch:oldEpoch}),/replaced/);
  await h.frame({cameraSource:'mock'});assert.equal(provider.videos,2);
});

test('recorded still inspection retains source metadata and does not describe it as current learner evidence',async t=>{
  const h=await setup(t),workId=h.command('inspect_frame',{question:'Describe this recording'}).workId;
  const frame=await h.coordinator.frame(h.id,randomUUID(),pixels,'image/png',{generation:1,workId,cameraSource:'recorded_video',captureTimeBasis:'recorded_media',sourcePositionMs:1200});await settle();
  assert.equal(frame.freshness,'unknown');assert.equal(frame.capturedAt,undefined);assert.equal(frame.sourcePositionMs,1200);
  const work=h.state().work.find(work=>work.id===workId);assert.equal(work?.status,'completed');
  const result=work?.result as {instruction:string};assert.match(result.instruction,/prerecorded media/);assert.match(result.instruction,/cannot confirm learner completion/);
});

test('session duration limit still ends a playing demonstration',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:Date.now()});
  const h=await setup(t);h.coordinator.mutate(h.id,state=>{state.config.maxSessionMinutes=1;});
  h.advertise({durationMs:300000});h.command('start_demo',{assetId:h.asset.id});
  h.report('demo.playback',{requestId:h.state().demonstration!.requestId,status:'playing'});
  t.mock.timers.tick(61000);await settle();
  assert.equal(h.state().status,'ended');assert.equal(h.state().demonstration,undefined);
  assert.ok(h.store.events(h.id).some(event=>event.type==='demo.finished'&&event.payload.reason==='session_ended'));
});
