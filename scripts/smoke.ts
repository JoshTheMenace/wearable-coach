import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/src/app.ts';
import { decodeAudio } from '../contracts/index.ts';

const dir=mkdtempSync(join(tmpdir(),'coach-smoke-'));
const app=createApp({dataDir:dir,operatorToken:randomUUID()});
const sockets:WebSocket[]=[];
try {
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const request=async(path:string,body?:unknown)=>{
    const response=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+app.operatorToken,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.ok(response.ok,await response.clone().text());return response.json() as Promise<any>;
  };
  const session=await request('/sessions',{createKey:randomUUID(),config:{provider:'mock',model:'mock-coach',device:'mock',recordFrames:true}});
  const id=session.sessionId;let generation=1,audioBytes=0;const events:any[]=[];
  const wait=async(check:()=>boolean)=>{for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Smoke assertion timed out');};
  const socket=async(channel:string)=>{const ws=new WebSocket(base.replace('http','ws')+`/api/sessions/${id}/${channel}`);sockets.push(ws);await new Promise(r=>ws.once('open',r));ws.send(JSON.stringify({type:'hello',token:session.token,generation}));return ws;};
  const control=await socket('control');control.on('message',raw=>{
    const message=JSON.parse(raw.toString());events.push(message);
    if(message.type==='capture')void (async()=>{
      const body=readFileSync('fixtures/zone-a.png');const response=await fetch(`${base}/api/sessions/${id}/frames/${randomUUID()}`,{method:'POST',headers:{authorization:'Bearer '+session.token,'content-type':'image/png','x-frame-meta':JSON.stringify({generation,workId:message.workId,cameraSource:'mock',capturedAt:Date.now(),clockUncertaintyMs:0,captureTimeBasis:'synthetic',width:640,height:480})},body});assert.ok(response.ok);
    })();
  });
  const audio=await socket('audio');audio.on('message',(raw,binary)=>{if(binary)audioBytes+=decodeAudio(Buffer.from(raw as Buffer)).pcm.length;});
  const command=(type:string,payload:unknown={})=>request(`/sessions/${id}/commands`,{schemaVersion:1,sessionId:id,generation,messageId:randomUUID(),commandId:randomUUID(),type,payload});
  await wait(()=>app.coordinator.get(id).status==='active');
  await command('send_text',{text:'show card'});await wait(()=>app.coordinator.get(id).hudRevision>0&&audioBytes>0);
  const inspection=await command('inspect_frame',{question:'Describe the fixture'});await wait(()=>app.coordinator.get(id).work.find(w=>w.id===inspection.workId)?.status==='completed');
  await command('stop_speech');await wait(()=>app.coordinator.get(id).generation===2);generation=2;
  const exported=await request(`/sessions/${id}/export`);assert.equal(exported.evidenceCoverage.rawAudio,'not_recorded');assert.ok(exported.assets.some((a:any)=>a.base64));assert.ok(!JSON.stringify(exported).includes(session.token));
  await command('end_session');await wait(()=>app.coordinator.get(id).status==='ended');
  console.log(JSON.stringify({result:'PASS',provider:'mock',audioBytes,hud:true,pinnedFrame:true,reconnectGeneration:generation,exportIncludesSelectedImage:true,sessionEnded:true},null,2));
} finally {for(const ws of sockets)ws.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
