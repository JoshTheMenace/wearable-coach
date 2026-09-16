import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createApp } from '../src/app.ts';
import { encodeAudio, decodeAudio } from '../../contracts/index.ts';

const wait=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out');};
async function setup(t:any,host='127.0.0.1'){
  const dir=mkdtempSync(join(tmpdir(),'coach-test-'));const app=createApp({dataDir:dir,operatorToken:'test-operator-token-0123456789'});
  await new Promise<void>(r=>app.server.listen(0,host,r));const base=`http://127.0.0.1:${(app.server.address() as any).port}`;
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const request=async(path:string,body?:unknown,token=app.operatorToken,method=body===undefined?'GET':'POST')=>fetch(base+'/api'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const create=async()=>{const r=await request('/sessions',{createKey:randomUUID(),config:{provider:'mock',model:'mock-coach',device:'mock'}});assert.equal(r.status,201);const created=await r.json() as any;await wait(()=>app.store.get(created.sessionId)?.status==='active');return created;};
  const command=(id:string,type:string,payload:unknown={},generation=1,commandId=randomUUID())=>({schemaVersion:1,sessionId:id,generation,messageId:randomUUID(),commandId,type,payload});
  return{app,base,request,create,command,dir};
}

test('native local setup needs no credential but cannot bypass session auth or a LAN listener',async t=>{
  const {base,request}=await setup(t);
  const headers={'x-coach-local':'1','content-type':'application/json'};
  assert.equal((await fetch(base+'/api/providers',{headers})).status,200);
  assert.equal((await fetch(base+'/api/providers')).status,401);
  assert.equal((await fetch(base+'/api/providers',{headers:{...headers,origin:'https://example.com'}})).status,401);
  assert.equal((await fetch(base+'/api/sessions',{headers})).status,401);
  const response=await fetch(base+'/api/sessions',{method:'POST',headers,body:JSON.stringify({createKey:randomUUID(),config:{provider:'mock',model:'mock-coach',device:'mock'}})});
  assert.equal(response.status,201);
  const session=await response.json() as any;
  assert.equal((await fetch(base+`/api/sessions/${session.sessionId}`,{headers})).status,401);
  assert.equal((await request(`/sessions/${session.sessionId}`,undefined,session.token)).status,200);
  const lan=await setup(t,'0.0.0.0');
  assert.equal((await fetch(lan.base+'/api/providers',{headers})).status,401);
});

test('session creation and commands are idempotent; conflicting reuse does not mutate state',async t=>{
  const {app,request,command}=await setup(t);const body={createKey:randomUUID(),config:{provider:'mock',model:'mock-coach',device:'mock'}};
  const first=await(await request('/sessions',body)).json() as any;const second=await(await request('/sessions',body)).json() as any;assert.equal(first.sessionId,second.sessionId);
  assert.equal((await request('/sessions',{...body,config:{...body.config,manualActivity:true}})).status,409);
  const cmd=command(first.sessionId,'set_hud',{hud:{card:{body:'Ready'}}});
  const a=await(await request(`/sessions/${first.sessionId}/commands`,cmd)).json();const b=await(await request(`/sessions/${first.sessionId}/commands`,cmd)).json();assert.deepEqual(a,b);assert.equal(app.coordinator.get(first.sessionId).hudRevision,1);
  assert.equal((await request(`/sessions/${first.sessionId}/commands`,{...cmd,payload:{hud:{card:{body:'Different'}}}})).status,409);
  assert.equal(app.store.events(first.sessionId).filter(e=>e.type==='hud.accepted').length,1);
});

test('device diagnostics survive ended sessions, are scoped in exports and cannot be read through local bootstrap',async t=>{
  const {app,base,request,create}=await setup(t);const a=await create(),b=await create();
  await app.coordinator.end(a.sessionId);
  const report={eventId:randomUUID(),deviceInstallId:randomUUID(),runId:randomUUID(),occurredAt:Date.now(),sessionId:a.sessionId,generation:1,code:'audio.discontinuity',severity:'warning',stage:'audio',recovery:'retrying',details:{queuedBytes:30000}};
  const headers={'x-coach-local':'1','content-type':'application/json'};
  const upload=()=>fetch(base+'/api/diagnostics',{method:'POST',headers,body:JSON.stringify({reports:[report]})});
  assert.equal((await upload()).status,200);assert.equal((await(await upload()).json() as any).duplicates,1);
  assert.equal((await fetch(base+'/api/diagnostics',{headers})).status,401);
  assert.equal((await request(`/sessions/${a.sessionId}/diagnostics`,undefined,a.spectatorToken)).status,401);
  assert.equal((await request(`/sessions/${a.sessionId}/diagnostics`,undefined,b.token)).status,401);
  const exported=await(await request(`/sessions/${a.sessionId}/export`,undefined,a.token)).json() as any;
  assert.equal(exported.diagnostics.length,1);assert.equal(exported.diagnosticCounts.bySeverity.warning,1);
  await request(`/sessions/${a.sessionId}`,undefined,a.token,'DELETE');assert.equal(app.diagnostics.counts().total,0);
});

test('end retry returns its committed receipt while finalization is still pending',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();
  const cmd=command(id,'end_session');
  const first=await(await request(`/sessions/${id}/commands`,cmd)).json();
  const retry=await(await request(`/sessions/${id}/commands`,cmd)).json();
  assert.deepEqual(retry,first);await wait(()=>app.coordinator.get(id).status==='ended');
  assert.equal(app.store.events(id).filter(e=>e.type==='session.ending').length,1);
});

test('authorized end succeeds with an obsolete generation and remains harmless after completion',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();
  app.coordinator.reconnect(id,1,randomUUID());
  assert.equal((await request(`/sessions/${id}/commands`,command(id,'end_session',{},1))).status,200);
  await wait(()=>app.coordinator.get(id).status==='ended');
  assert.equal((await request(`/sessions/${id}/commands`,command(id,'end_session',{},1))).status,200);
  assert.equal(app.store.events(id).filter(e=>e.type==='session.ended').length,1);
});

test('scoped tokens cannot mutate, export or cross sessions; missing provider is unavailable',async t=>{
  const {request,create,command}=await setup(t);const a=await create(),b=await create();
  assert.equal((await request(`/sessions/${a.sessionId}`,undefined,a.spectatorToken)).status,200);
  assert.equal((await request(`/sessions/${a.sessionId}/commands`,command(a.sessionId,'clear_hud'),a.spectatorToken)).status,401);
  assert.equal((await request(`/sessions/${a.sessionId}/export`,undefined,a.spectatorToken)).status,401);
  assert.equal((await request(`/sessions/${b.sessionId}`,undefined,a.token)).status,401);
  assert.equal((await request('/sessions',undefined,a.token)).status,401);
});

test('lost reconnect reply is retried once and stale commands cannot change new lease',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();const body={generation:1,requestId:randomUUID()};
  const a=await(await request(`/sessions/${id}/reconnect`,body)).json() as any;const b=await(await request(`/sessions/${id}/reconnect`,body)).json() as any;
  assert.equal(a.snapshot.generation,2);assert.equal(b.snapshot.generation,2);
  assert.equal((await request(`/sessions/${id}/reconnect`,{...body,requestId:randomUUID()})).status,409);
  assert.equal((await request(`/sessions/${id}/commands`,command(id,'set_hud',{hud:{card:{body:'Stale'}}}))).status,409);assert.equal(app.coordinator.get(id).hudRevision,0);
});

test('malformed HUD is rejected and mock native tools validate before mutation',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();
  assert.equal((await request(`/sessions/${id}/commands`,command(id,'set_hud',{hud:{card:{body:'x'.repeat(241)}}}))).status,400);
  await request(`/sessions/${id}/commands`,command(id,'send_text',{text:'invalid tool'}));await wait(()=>app.store.events(id).some(e=>e.type==='work.failed'));assert.equal(app.coordinator.get(id).hudRevision,0);
  await request(`/sessions/${id}/commands`,command(id,'send_text',{text:'show card'}));await wait(()=>app.coordinator.get(id).hudRevision===1);assert.match(app.coordinator.get(id).hud.card!.body,/Pause/);
});

test('stop replaces provider and rejects delayed old-provider work',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();
  await request(`/sessions/${id}/commands`,command(id,'send_text',{text:'delayed card'}));await request(`/sessions/${id}/commands`,command(id,'stop_speech'));
  await wait(()=>app.coordinator.get(id).generation===2);await new Promise(r=>setTimeout(r,2700));assert.equal(app.coordinator.get(id).hudRevision,0);
});

test('inspection pins its request; stale generations, old captures and duplicate bytes are rejected',async t=>{
  const {app,base,request,create,command}=await setup(t);const {sessionId:id,token}=await create();
  const result=await(await request(`/sessions/${id}/commands`,command(id,'inspect_frame',{question:'What is visible?'}))).json() as any;
  const bytes=readFileSync('model-research/gemini38/fixtures/left.png');const frameId=randomUUID();
  const upload=(generation:number,capturedAt:number,workId=result.workId,image=bytes)=>fetch(`${base}/api/sessions/${id}/frames/${frameId}`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'image/png','x-frame-meta':JSON.stringify({generation,workId,cameraSource:'mock',captureTimeBasis:'synthetic',capturedAt,clockUncertaintyMs:0,width:640,height:480})},body:image});
  assert.equal((await upload(2,Date.now())).status,409);assert.equal((await upload(1,Date.now()-60000)).status,409);
  assert.equal((await upload(1,Date.now())).status,201);await wait(()=>app.coordinator.get(id).work.find(w=>w.id===result.workId)?.status==='completed');
  assert.equal((await upload(1,Date.now())).status,201);
  const changed=Buffer.concat([bytes,Buffer.from([1])]);assert.equal((await upload(1,Date.now(),result.workId,changed)).status,409);
  const asset=await request(`/sessions/${id}/assets/${frameId}`,undefined,token);assert.equal(asset.status,200);
});

test('HUD timers survive reconnect and stale expiry cannot erase replacement',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();
  await request(`/sessions/${id}/commands`,command(id,'set_hud',{hud:{timer:{durationMs:1000},card:{body:'Countdown'}}}));
  await request(`/sessions/${id}/reconnect`,{requestId:randomUUID(),generation:1});assert.ok(app.coordinator.get(id).hud.timer);
  await request(`/sessions/${id}/commands`,command(id,'set_hud',{hud:{card:{body:'New guidance'}}},2));
  await new Promise(r=>setTimeout(r,1700));assert.equal(app.coordinator.get(id).hud.card?.body,'New guidance');
});

test('WebSocket requires scoped first-message authentication and snapshot cursor matches committed events',async t=>{
  const {app,base,create}=await setup(t);const {sessionId:id,spectatorToken}=await create();
  const ws=new WebSocket(base.replace('http','ws')+`/api/sessions/${id}/events`);t.after(()=>ws.terminate());
  const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));await new Promise(r=>ws.once('open',r));ws.send(JSON.stringify({type:'hello',token:spectatorToken,afterSeq:0}));
  await wait(()=>messages.some(x=>x.type==='snapshot'));const through=messages[0].snapshot.throughSeq;
  app.coordinator.mutate(id,(_,emit)=>emit('test.boundary',{value:1}));await wait(()=>messages.some(x=>x.type==='event'));
  assert.equal(messages.find(x=>x.type==='event').event.seq,through+1);
  ws.send(JSON.stringify({type:'clear_hud'}));await wait(()=>messages.some(x=>x.type==='error'));assert.equal(messages.find(x=>x.type==='error').code,403);
  const bad=new WebSocket(base.replace('http','ws')+`/api/sessions/${id}/control`);await new Promise(r=>bad.once('open',r));bad.send(JSON.stringify({type:'hello',token:spectatorToken,generation:1}));await new Promise(r=>bad.once('close',r));
});

test('audio header enforces lease, epoch and PCM alignment',()=>{
  const bytes=encodeAudio(new Uint8Array([1,0,2,0]),4,7,12,100);const decoded=decodeAudio(bytes);assert.equal(decoded.generation,4);assert.equal(decoded.speechEpoch,7);assert.equal(decoded.seq,12);assert.equal(decoded.timestamp,100);assert.deepEqual([...decoded.pcm],[1,0,2,0]);assert.throws(()=>decodeAudio(new Uint8Array(25)));
});

test('muting replaces microphone samples with paced silence instead of stalling the provider input clock',async t=>{
  const {app,create,request,command}=await setup(t);const {sessionId:id}=await create();
  const received:Buffer[]=[];app.coordinator.runtime.get(id)!.provider.sendAudio=pcm=>received.push(pcm);
  await request(`/sessions/${id}/commands`,command(id,'set_mic',{muted:true}));
  app.coordinator.audio(id,1,Buffer.from([1,2,3,4]));
  assert.equal(received.length,1);assert.deepEqual(received[0],Buffer.alloc(4));
});

test('exports disclose evidence gaps, exclude credentials and purge removes session evidence',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id,token,spectatorToken}=await create();
  await request(`/sessions/${id}/commands`,command(id,'set_hud',{hud:{card:{body:'Recorded evidence'}}}));
  const data=await(await request(`/sessions/${id}/export`)).json() as any;const serialized=JSON.stringify(data);for(const secret of [token,spectatorToken,app.operatorToken])assert.ok(!serialized.includes(secret));assert.equal(data.evidenceCoverage.rawAudio,'not_recorded');
  assert.equal((await request(`/sessions/${id}`,undefined,app.operatorToken,'DELETE')).status,200);assert.equal(app.store.get(id),undefined);assert.equal(app.store.events(id).length,0);assert.equal((await request(`/sessions/${id}`,undefined,token)).status,401);
});

test('device transport loss fences pending work and the old audio binding immediately',async t=>{
  const {app,base,create,request,command}=await setup(t);const {sessionId:id,token}=await create();
  const open=async(channel:string)=>{const ws=new WebSocket(base.replace('http','ws')+`/api/sessions/${id}/${channel}`);t.after(()=>ws.terminate());await new Promise(r=>ws.once('open',r));ws.send(JSON.stringify({type:'hello',token,generation:1}));await new Promise(r=>ws.once('message',r));return ws;};
  const control=await open('control'),audio=await open('audio');
  const inspection=await(await request(`/sessions/${id}/commands`,command(id,'inspect_frame',{question:'Pending image'}))).json() as any;
  control.terminate();await wait(()=>app.coordinator.get(id).generation===2);await wait(()=>audio.readyState===WebSocket.CLOSED);
  assert.equal(app.coordinator.get(id).work.find(w=>w.id===inspection.workId)?.status,'cancelled');
  assert.throws(()=>app.coordinator.audio(id,1,Buffer.alloc(640)),/Stale/);
});

test('native inspections keep only the newest request pending and return terminal outcomes for superseded calls',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();
  for(let n=0;n<9;n++)await request(`/sessions/${id}/commands`,command(id,'send_text',{text:'inspect the camera'}));
  await wait(()=>app.coordinator.get(id).work.filter(w=>w.kind==='inspect').length===9);
  const inspections=app.coordinator.get(id).work.filter(w=>w.kind==='inspect');
  assert.equal(inspections.filter(w=>w.status==='reserved'||w.status==='running').length,1);
  const work=inspections.find(w=>w.status==='reserved')!;assert.equal(work.input.nativeCallId,'mock-call-9');
  const superseded=inspections.filter(w=>w.id!==work.id);assert.ok(superseded.every(w=>w.status==='cancelled'));
  await wait(()=>app.store.events(id).filter(e=>e.type==='provider.tool_result').length===8);
  for(const previous of superseded)assert.equal(app.store.events(id).filter(e=>e.type==='provider.tool_result'&&e.payload.id===previous.input.nativeCallId).length,1);
  await request(`/sessions/${id}/commands`,command(id,'cancel_work',{workId:work.id}));
  await wait(()=>app.store.events(id).some(e=>e.type==='provider.tool_result'&&(e.payload.result as any)?.reason==='operator'));
  assert.equal(app.store.events(id).filter(e=>e.type==='provider.tool_result').length,9);
  assert.equal(app.coordinator.get(id).work.filter(w=>w.status==='reserved'||w.status==='running').length,0);
  assert.equal(app.coordinator.get(id).status,'active');
});

test('failed command effect stays failed on retry instead of reporting success',async t=>{
  const {app,request,create,command}=await setup(t);const {sessionId:id}=await create();
  app.coordinator.runtime.get(id)!.provider.sendText=()=>{throw new Error('Unavailable');};
  const cmd=command(id,'send_text',{text:'Hello'});
  const first=await(await request(`/sessions/${id}/commands`,cmd)).json() as any;
  const second=await(await request(`/sessions/${id}/commands`,cmd)).json();
  assert.equal(first.status,'effect_failed');assert.deepEqual(first,second);
});

test('preview replacement bounds memory and render receipts reject arbitrary targets',async t=>{
  const {app,base,request,create,command}=await setup(t);const {sessionId:id,token}=await create();const bytes=readFileSync('fixtures/zone-a.png');
  for(let n=0;n<7;n++)assert.equal((await fetch(`${base}/api/sessions/${id}/frames/${randomUUID()}`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'image/png','x-frame-meta':JSON.stringify({generation:1,cameraSource:'mock',captureTimeBasis:'synthetic',capturedAt:Date.now(),clockUncertaintyMs:0})},body:bytes})).status,201);
  assert.equal(app.coordinator.transient.size,1);
  await request(`/sessions/${id}/commands`,command(id,'set_hud',{hud:{card:{body:'One'}}}));
  assert.throws(()=>app.coordinator.report(id,1,randomUUID(),'hud.receipt',{hudRevision:1,target:'invented',rendererInstanceId:'r',status:'sdk_confirmed'}));
  app.coordinator.report(id,1,randomUUID(),'hud.receipt',{hudRevision:1,target:'mock',rendererInstanceId:'current',status:'sdk_submitted'});
  app.coordinator.report(id,1,randomUUID(),'hud.receipt',{hudRevision:1,target:'mock',rendererInstanceId:'old',status:'sdk_confirmed'});
  assert.equal(app.coordinator.get(id).receipts[0].rendererInstanceId,'current');assert.equal(app.coordinator.get(id).receipts.length,1);
});

test('crash recovery marks unfinished sessions and work interrupted without resuming effects',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {Store}=await import('../src/store.ts');const {Coordinator}=await import('../src/coordinator.ts');
  const dir=mkdtempSync(join(tmpdir(),'coach-crash-'));
  const script=`import {Store} from './server/src/store.ts';import {Coordinator} from './server/src/coordinator.ts';import {randomUUID} from 'node:crypto';const dir=${JSON.stringify(dir)};const c=new Coordinator(new Store(dir+'/coach.sqlite'),dir);const s=c.create(randomUUID(),{provider:'mock',model:'mock-coach',device:'mock'});c.command(s.id,{schemaVersion:1,sessionId:s.id,generation:1,messageId:randomUUID(),commandId:randomUUID(),type:'inspect_frame',payload:{question:'Pending capture'}});console.log(s.id);process.exit(0);`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
  const id=child.stdout.trim();const store=new Store(join(dir,'coach.sqlite'));const coordinator=new Coordinator(store,dir);
  assert.equal(coordinator.get(id).status,'interrupted');assert.equal(coordinator.get(id).work[0].status,'aborted');assert.equal(coordinator.runtime.size,0);
  assert.equal(store.events(id).filter(e=>e.type==='session.interrupted').length,1);
  await coordinator.close();rmSync(dir,{recursive:true,force:true});
});
