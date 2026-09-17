import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PresentationAudio} from '../../web/src/PresentationAudio.ts';
import {encodeAudio} from '../../contracts/index.ts';

test('presentation PCM respects mute, generation, epoch, order, and interruption',async t=>{
  const played:{stopped:boolean;at:number;buffer?:any}[]=[];
  class Context {
    state='running';currentTime=0;destination={};
    async resume() {} async close() {}
    createBuffer(_channels:number,length:number,rate:number){const samples=new Float32Array(length);return{duration:length/rate,getChannelData:()=>samples};}
    createBufferSource(){const item={stopped:false,at:0,buffer:undefined as any,connect(){},start(at:number){this.at=at;played.push(this);},stop(){this.stopped=true;},onended:null};return item;}
  }
  const original=Object.getOwnPropertyDescriptor(globalThis,'AudioContext');
  Object.defineProperty(globalThis,'AudioContext',{value:Context,configurable:true});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'AudioContext',original);else Reflect.deleteProperty(globalThis,'AudioContext');});
  const audio=new PresentationAudio();audio.bind(2,3);
  const play=(seq:number,generation=2,epoch=3)=>audio.play(Uint8Array.from(encodeAudio(new Uint8Array([0,64,0,128]),generation,epoch,seq)).buffer,24000);
  play(0);assert.equal(played.length,0);await audio.enable();play(0);
  assert.equal(played.length,1);assert.deepEqual([...played[0].buffer.getChannelData(0)],[0.5,-1]);
  play(0);play(1,1);play(1,2,2);assert.equal(played.length,1);
  play(1);assert.equal(played.length,2);assert.ok(played[1].at>played[0].at);
  audio.bind(2,4);assert.ok(played.every(s=>s.stopped));play(2);assert.equal(played.length,2);
  audio.bind(1,0);audio.bind(2,3);play(0,2,4);assert.equal(played.length,3);audio.mute();assert.equal(played[2].stopped,true);
  play(1,2,4);assert.equal(played.length,3);await audio.enable();play(1,2,4);assert.equal(played.length,4);
  for(let seq=2;seq<8;seq++)audio.play(Uint8Array.from(encodeAudio(new Uint8Array(48000),2,4,seq)).buffer,24000);
  assert.ok(played.slice(3).every(s=>!s.stopped),'Faster-than-realtime speech must stay queued without dropping words');
  assert.ok(audio.progress().pendingMs>6000,'Progress measures queued playback, not provider generation');
  assert.equal(audio.progress().generation,2);assert.equal(audio.progress().speechEpoch,4);
  audio.reset();assert.ok(played.every(s=>s.stopped));assert.equal(audio.progress().pendingMs,0);
  audio.bind(1,0);play(0,1,0);assert.equal(played.at(-1)?.stopped,false);
  audio.close();assert.ok(played.every(s=>s.stopped));
});
