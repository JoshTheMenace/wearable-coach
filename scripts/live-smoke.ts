import 'dotenv/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/src/app.ts';
import { decodeAudio, encodeAudio } from '../contracts/index.ts';

if(!process.argv.includes('--gemini'))throw new Error('This makes paid synthetic Gemini requests. Run with --gemini.');
if(!process.env.GEMINI_KEY&&!process.env.GEMINI_API_KEY)throw new Error('Set GEMINI_KEY in .env');
const dir=mkdtempSync(join(tmpdir(),'coach-live-'));const app=createApp({dataDir:dir,operatorToken:randomUUID()});
const sockets:WebSocket[]=[];const report:Record<string,unknown>={date:new Date().toISOString(),model:'gemini-3.8-live',hardware:'synthetic fixture, no physical glasses'};
try {
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const request=async(path:string,body?:unknown)=>{const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+app.operatorToken,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw new Error(`Request failed ${r.status}: ${await r.text()}`);return r.json() as Promise<any>;};
  const created=await request('/sessions',{createKey:randomUUID(),config:{provider:'gemini',model:'gemini-3.8-live',device:'mock',manualActivity:true,maxSessionMinutes:2}});const id=created.sessionId;
  const wait=async(check:()=>boolean,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,25));}throw new Error('Live smoke timed out');};
  await wait(()=>app.coordinator.get(id).status==='active');report.connected=true;
  let audioBytes=0;const events:any[]=[];
  const connect=async(channel:string)=>{const ws=new WebSocket(base.replace('http','ws')+`/api/sessions/${id}/${channel}`);sockets.push(ws);ws.on('message',(data,binary)=>{if(binary)audioBytes+=decodeAudio(Buffer.from(data as Buffer)).pcm.length;else events.push(JSON.parse(data.toString()));});await new Promise(r=>ws.once('open',r));ws.send(JSON.stringify({type:'hello',token:created.token,generation:1}));return ws;};
  await connect('control');const audio=await connect('audio');await new Promise(r=>setTimeout(r,50));
  const command=(type:string,payload:unknown={})=>request(`/sessions/${id}/commands`,{schemaVersion:1,sessionId:id,generation:1,messageId:randomUUID(),commandId:randomUUID(),type,payload});
  const inspection=await command('inspect_frame',{question:'Look at the board. Tell me the letter above the blue rectangle.'});
  const image=readFileSync('fixtures/zone-b.png');
  const uploaded=await fetch(`${base}/api/sessions/${id}/frames/${randomUUID()}`,{method:'POST',headers:{authorization:'Bearer '+created.token,'content-type':'image/png','x-frame-meta':JSON.stringify({generation:1,workId:inspection.workId,cameraSource:'mock',capturedAt:Date.now(),clockUncertaintyMs:0,captureTimeBasis:'synthetic'})},body:image});assert.ok(uploaded.ok);
  await wait(()=>app.store.events(id).some(e=>e.type==='provider.utterance_complete')&&audioBytes>0);
  const firstText=app.coordinator.get(id).transcripts.filter(t=>t.speaker==='coach').map(t=>t.text).join('');report.imageAnswer=firstText;report.imageAudioBytes=audioBytes;report.correctVisualAnswer=/\bB\b/.test(firstText);
  const marker=app.coordinator.get(id).throughSeq;await command('activity',{active:true});
  const speech=readFileSync('model-research/gemini38/fixtures/clear-question.pcm');const paced=Buffer.concat([speech,Buffer.alloc(12800)]);let seq=0;
  for(let offset=0;offset<paced.length;offset+=640){audio.send(encodeAudio(paced.subarray(offset,offset+640),1,0,++seq));await new Promise(r=>setTimeout(r,20));}
  await command('activity',{active:false});
  await wait(()=>app.store.events(id,marker).some(e=>e.type==='provider.utterance_complete'),25000);
  report.audioInputBytes=paced.length;report.audioReply=app.store.events(id,marker).filter(e=>e.type==='transcript.fragment').map(e=>e.payload);
  await command('send_text',{text:'Use set_hud to show a card titled Setup with body Inspect the blue block.'});
  await wait(()=>app.coordinator.get(id).hudRevision>0);report.hud=app.coordinator.get(id).hud;
  report.totalOutputAudioBytes=audioBytes;report.errors=app.store.events(id).filter(e=>e.type==='error').map(e=>e.payload);
  await command('end_session');await wait(()=>app.coordinator.get(id).status==='ended');report.ended=true;
  assert.equal(report.correctVisualAnswer,true);assert.ok(audioBytes>0);assert.equal((report.errors as unknown[]).length,0);
  writeFileSync('docs/live-relay-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {for(const ws of sockets)ws.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
