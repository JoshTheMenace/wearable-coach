import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configSchema, hudSchema, type Command, type Frame, type SessionEvent, type Snapshot, type Work } from '../../contracts/index.ts';
import { Store } from './store.ts';
import { createProvider, observeFrame, inferTask } from './providers/index.ts';
import { COACH_PROMPT } from './providers/shared.ts';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const hash = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const active = (s: Snapshot) => ['starting','active','reconnecting'].includes(s.status);
const pending = (w: Work) => ['reserved','running'].includes(w.status);
type Adapter = ReturnType<typeof createProvider>;
type Runtime = { provider: Adapter; generation: number; conversation: string; outputSeq: number; ready: boolean; aborts: Map<string,AbortController> };
type Emit = (type: string, payload: Record<string,unknown>, source?: string, messageId?: string) => void;

export class Coordinator extends EventEmitter {
  readonly runtime = new Map<string,Runtime>();
  private closing=false;
  private readonly tasks=new Set<Promise<unknown>>();
  readonly transient = new Map<string,{bytes:Buffer; mime:string; at:number}>();
  private sweepTimer: NodeJS.Timeout;
  constructor(readonly store: Store, readonly dataDir: string) {
    super(); mkdirSync(join(dataDir,'media'),{recursive:true});
    for (const snapshot of store.list()) if (active(snapshot) || snapshot.status === 'ending') this.mutate(snapshot.id,(s,emit)=>{
      s.status='interrupted'; s.endedAt=Date.now(); s.finalization='incomplete';
      for (const w of s.work.filter(pending)) this.finishIn(s,w,'aborted',{reason:'server_restarted',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);
      emit('session.interrupted',{reason:'server_restarted'});
    });
    this.sweepTimer=setInterval(()=>{try{this.sweep();}catch{this.emit('diagnostic','Maintenance failed; check disk space and permissions');}},1000); this.sweepTimer.unref();
  }
  private background(task:Promise<unknown>) {this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>{this.tasks.delete(task);this.emit('diagnostic','Background operation failed');});}
  get(id:string) { const s=this.store.get(id); if (!s) throw new HttpError(404,'Session not found'); return s; }
  mutate<T>(id:string, fn:(s:Snapshot,emit:Emit)=>T):T {
    const events:SessionEvent[]=[];
    const result=this.store.atomic(()=>{
      const s=this.get(id); const emit:Emit=(type,payload,source='server',messageId)=>events.push(this.store.append(s,type,payload,source,messageId));
      const result=fn(s,emit); this.store.save(s); return result;
    });
    for(const event of events) this.emit('event',event);
    return result;
  }
  create(key:string, raw:unknown) {
    if(this.closing)throw new HttpError(503,'Server is shutting down');
    const config=configSchema.parse(raw); const digest=hash(config);
    const prior=this.store.byCreate(key);
    if(prior){if(prior.create_hash!==digest)throw new HttpError(409,'Creation key reused with different configuration');return this.get(prior.id as string);}
    if(this.store.list().filter(active).length>=4)throw new HttpError(429,'At most four active sessions are allowed');
    const s:Snapshot={id:randomUUID(),config,status:'starting',generation:1,speechEpoch:0,throughSeq:0,hudRevision:0,hud:{},inputRate:config.provider==='openai'?24000:16000,outputRate:24000,createdAt:Date.now(),transcripts:[],work:[],receipts:[],usage:[],muted:false,finalization:'pending'};
    this.store.atomic(()=>{this.store.create(s,key,digest);this.store.connection(s.id,1,randomUUID(),{status:'starting'});this.store.append(s,'session.created',{config,appVersion:'0.1.0',contractVersion:1,promptVersion:'coach-v1',coachPrompt:COACH_PROMPT});this.store.save(s);});
    queueMicrotask(()=>{if(!this.closing)this.background(this.connect(s.id));}); return s;
  }
  async connect(id:string, resume?:{handle?:string;conversation?:string}, history?:string): Promise<void> {
    const s=this.get(id); if(!active(s))return;
    const generation=s.generation; const conversation=resume?.handle&&resume.conversation?resume.conversation:randomUUID();
    let runtime:Runtime;
    const current=()=>this.runtime.get(id)===runtime && this.store.get(id)?.generation===generation;
    const valid=()=>!this.closing && current() && active(this.get(id));
    const provider=createProvider(s.config,{
      event:(type,payload)=>{if(current())this.providerEvent(id,type,payload);},
      audio:(pcm)=>{if(valid())this.emit('audio',{id,generation,speechEpoch:this.get(id).speechEpoch,seq:++runtime.outputSeq,pcm});},
      interrupted:()=>{if(valid())this.flush(id,'provider_interruption');},
      tool:call=>{if(valid())this.background(this.tool(id,call));},
      delegation:(delegationId,offsetMs)=>{if(valid())this.background(this.delegate(id,delegationId,offsetMs).catch(()=>{try{provider.toolResult(delegationId,{status:'rejected',reason:'Work capacity reached',applicationEffect:'not_applied'});}catch{}}));},
      error:()=>{if(valid())this.mutate(id,(_,emit)=>emit('error',{code:'provider_error',message:'Provider request failed; verify access and configuration'}));},
      closed:reason=>{if(valid()&&runtime.ready)this.providerLost(id,reason);},
    },{resumeHandle:resume?.handle,history});
    runtime={provider,generation,conversation,outputSeq:0,ready:false,aborts:new Map()}; this.runtime.set(id,runtime);
    this.store.connection(id,generation,conversation,{status:'connecting',recoveryKind:resume?.handle?'resumed':history?'history_seeded':'new',openedAt:Date.now()});
    try {
      await provider.connect(); if(!valid()){await provider.close();return;}
      runtime.ready=true;
      this.mutate(id,(state,emit)=>{state.status='active';state.inputRate=provider.inputRate;state.outputRate=provider.outputRate;this.store.connection(id,generation,conversation,{status:'active',inputRate:state.inputRate,outputRate:state.outputRate,provider:state.config.provider,model:state.config.model,recoveryKind:resume?.handle?'resumed':history?'history_seeded':'new'});emit('connection.ready',{provider:state.config.provider,model:state.config.model,inputRate:state.inputRate,outputRate:state.outputRate,recoveryKind:resume?.handle?'resumed':history?'history_seeded':'new'});});
      this.emit('snapshot',id);
    } catch {
      if(valid() && resume?.handle) {this.runtime.delete(id);await provider.close().catch(()=>{});return this.connect(id,undefined,history);}
      if(current()){this.runtime.delete(id);await provider.close().catch(()=>{});this.mutate(id,(state,emit)=>{state.status='failed';state.finalization='incomplete';emit('connection.failed',{message:'Unable to start provider. Check configured model, credentials, and network.'});});}
      this.emit('snapshot',id);
    }
  }
  private providerEvent(id:string,type:string,payload:Record<string,unknown>) {
    this.mutate(id,(s,emit)=>{
      if(type==='transcript.fragment') {
        const text=String(payload.text??payload.delta??'');
        s.transcripts.push({speaker:payload.speaker==='user'?'learner':payload.speaker==='assistant'?'coach':String(payload.speaker??'coach'),text,...(typeof payload.startMs==='number'?{startMs:payload.startMs}:{}),...(typeof payload.endMs==='number'?{endMs:payload.endMs}:{}),seq:s.throughSeq+1});
        s.transcripts=s.transcripts.slice(-300);
      }
      if(type.startsWith('usage')) { s.usage.push(payload);s.usage=s.usage.slice(-100); }
      if(type==='provider.tools_cancelled'&&Array.isArray(payload.ids))for(const w of s.work.filter(w=>pending(w)&&(payload.ids as unknown[]).includes(w.input.nativeCallId))){this.runtime.get(id)?.aborts.get(w.id)?.abort();this.finishIn(s,w,'cancelled',{reason:'provider_cancelled',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);}
      emit(type,payload,'provider');
    });
    if(type==='provider.go_away'&&active(this.get(id)))this.reconnect(id,this.get(id).generation,randomUUID(),true);
  }
  private providerLost(id:string,reason:string) {
    const runtime=this.runtime.get(id);if(!runtime)return;
    runtime.ready=false;for(const a of runtime.aborts.values())a.abort();
    this.mutate(id,(s,emit)=>{s.status='reconnecting';for(const w of s.work.filter(pending))this.finishIn(s,w,'cancelled',{reason:'provider_disconnected',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);emit('connection.lost',{reason:reason.slice(0,80)});});
    this.flush(id,'provider_disconnected'); this.reconnect(id,this.get(id).generation,randomUUID(),true);
  }
  checkGeneration(s:Snapshot,generation:number) {if(!active(s))throw new HttpError(409,'Session is not active');if(s.generation!==generation)throw new HttpError(409,'Stale connection generation');}
  private reserve(s:Snapshot,kind:string,input:Record<string,unknown>,emit:Emit,nativeKey?:string):Work {
    if(s.work.filter(pending).length>=8)throw new HttpError(429,'Too much pending work');
    const w:Work={id:randomUUID(),generation:s.generation,kind,status:'reserved',createdAt:Date.now(),deadlineAt:Date.now()+30000,expectedHudRevision:s.hudRevision,input,...(nativeKey?{nativeKey}:{})};
    s.work.push(w);s.work=[...s.work.filter(pending),...s.work.filter(w=>!pending(w)).slice(-92)];this.store.work(s.id,w);emit('work.reserved',{...w});return w;
  }
  private finishIn(s:Snapshot,w:Work,status:string,result:unknown,emit:Emit) {
    w.status=status;w.result=result;this.store.work(s.id,w);emit('work.'+status,{workId:w.id,kind:w.kind,result});
    const requestId=w.input.nativeCallId??w.input.delegationId;
    if(requestId&&['failed','cancelled','aborted'].includes(status)&&(result as any)?.reason!=='provider_cancelled')queueMicrotask(()=>{
      if(this.closing)return;
      const rt=this.runtime.get(s.id);const state=this.store.get(s.id);
      if(!rt||rt.generation!==w.generation||!state||!active(state))return;
      try{rt.provider.toolResult(String(requestId),result);this.mutate(s.id,(_,emit)=>emit('work.result_dispatched',{workId:w.id,status,acknowledged:false}));}catch{/* Stored outcome remains available for a verified provider retry. */}
    });
  }
  private setHud(s:Snapshot,raw:unknown,emit:Emit,expected?:number) {
    if(expected!==undefined&&s.hudRevision!==expected)throw new HttpError(409,'HUD was superseded');
    const hud=hudSchema.parse(raw);
    if(hud.imageAssetId&&!this.store.asset(s.id,hud.imageAssetId))throw new HttpError(400,'Unknown image asset');
    if(hud.timer){hud.timer={id:randomUUID(),startedAt:Date.now(),durationMs:hud.timer.durationMs};}
    s.hud=hud;s.hudRevision++;emit('hud.accepted',{hud,hudRevision:s.hudRevision});
  }
  command(id:string,c:Command) {
    if(c.sessionId!==id)throw new HttpError(400,'Session mismatch');
    const digest=hash({type:c.type,payload:c.payload,generation:c.generation}); const prior=this.store.command(id,c.commandId);
    if(prior){if(prior.hash!==digest)throw new HttpError(409,'Command ID reused');return prior.outcome;}
    let effect:()=>void=()=>{};
    const outcome=this.mutate(id,(s,emit)=>{
      // An authorized stop must still work after a lease change or completed end.
      if(c.type!=='end_session')this.checkGeneration(s,c.generation);let result:Record<string,unknown>={status:'accepted'};
      switch(c.type){
        case 'set_hud': this.setHud(s,c.payload.hud,emit);result.hudRevision=s.hudRevision;break;
        case 'clear_hud':this.setHud(s,{},emit);result.hudRevision=s.hudRevision;break;
        case 'set_mic':s.muted=z.boolean().parse(c.payload.muted);emit('microphone.changed',{muted:s.muted});break;
        case 'send_text': {
          const text=z.string().min(1).max(2000).parse(c.payload.text); if(s.status!=='active')throw new HttpError(409,'Provider is not ready');
          effect=()=>this.runtime.get(id)?.provider.sendText(text);emit('input.text',{text},'device');break;
        }
        case 'activity': {const value=z.boolean().parse(c.payload.active);effect=()=>this.runtime.get(id)?.provider.activity(value);emit('input.activity',{active:value});break;}
        case 'inspect_frame': {
          const question=z.string().min(1).max(1000).parse(c.payload.question);
          for(const w of s.work.filter(w=>pending(w)&&w.kind==='inspect'))this.finishIn(s,w,'cancelled',{reason:'new_inspection',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);
          const w=this.reserve(s,'inspect',{question},emit);result.workId=w.id;effect=()=>this.emit('capture',{id,generation:s.generation,workId:w.id,question});break;
        }
        case 'cancel_work': {const w=s.work.find(w=>w.id===c.payload.workId);if(!w)throw new HttpError(404,'Unknown work');if(pending(w))this.finishIn(s,w,'cancelled',{reason:'operator',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);effect=()=>this.runtime.get(id)?.aborts.get(w.id)?.abort();break;}
        case 'stop_speech':effect=()=>{this.flush(id,'operator');void this.reconnect(id,s.generation,'stop:'+c.commandId,false);};break;
        case 'end_session':effect=()=>this.background(this.end(id));break;
      }
      this.store.receipt(id,c.commandId,digest,result);return result;
    });
    try{effect();}catch{const failed={status:'effect_failed',commandId:c.commandId,reason:'Provider did not accept the command'};this.mutate(id,(_,emit)=>{this.store.updateReceipt(id,c.commandId,failed);emit('command.effect_failed',failed);});return failed;}return outcome;
  }
  flush(id:string,reason:string) {this.mutate(id,(s,emit)=>{s.speechEpoch++;emit('playback.flushed',{speechEpoch:s.speechEpoch,reason});});const s=this.get(id);this.emit('flush',{id,generation:s.generation,speechEpoch:s.speechEpoch});}
  reconnect(id:string,generation:number,requestId:string,resume=true) {
    const key='reconnect:'+requestId;const digest=hash({generation,resume});const prior=this.store.command(id,key);
    if(prior){if(prior.hash!==digest)throw new HttpError(409,'Reconnect ID reused');return this.get(id);}
    const old=this.runtime.get(id);const history=this.get(id).transcripts.slice(-50).map(t=>`${t.speaker}: ${t.text}`).join('\n');
    this.mutate(id,(s,emit)=>{this.checkGeneration(s,generation);s.status='reconnecting';s.generation++;s.speechEpoch++;
      for(const w of s.work.filter(pending))this.finishIn(s,w,'cancelled',{reason:'connection_replaced',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);
      this.store.connection(id,s.generation,old?.conversation??randomUUID(),{status:'starting'});s.receipts=[];
      emit('connection.replacing',{generation:s.generation});this.store.receipt(id,key,digest,{generation:s.generation});});
    this.runtime.delete(id);if(old){for(const a of old.aborts.values())a.abort();void old.provider.close().catch(()=>{});}
    this.emit('rebind',id);if(!this.closing)this.background(this.connect(id,resume?{handle:old?.provider.resumeHandle,conversation:old?.conversation}:undefined,history));
    return this.get(id);
  }
  audio(id:string,generation:number,pcm:Buffer) {const s=this.get(id);this.checkGeneration(s,generation);if(s.status==='active')this.runtime.get(id)?.provider.sendAudio(s.muted?Buffer.alloc(pcm.length):pcm);}
  report(id:string,generation:number,messageId:string,type:string,payload:Record<string,unknown>) {
    if(this.store.report(id,messageId))return;
    this.mutate(id,(s,emit)=>{if(type==='hud.receipt'&&s.generation===generation&&['ending','ended'].includes(s.status)){}else this.checkGeneration(s,generation);
      if(type==='hud.receipt') {
        payload=z.object({hudRevision:z.number().int().nonnegative(),rendererInstanceId:z.string().min(1).max(100),target:z.enum(['glasses','phone','mock']),status:z.enum(['phone_received','sdk_submitted','sdk_confirmed','failed','unsupported']),reason:z.string().max(300).optional()}).parse(payload);
        const renderer=s.receipts.find(r=>r.target===payload.target);
        if(renderer&&renderer.rendererInstanceId!==payload.rendererInstanceId){emit('hud.receipt.stale',payload,'device',messageId);return;}
        if(payload.hudRevision!==s.hudRevision) {emit('hud.receipt.stale',payload,'device',messageId);return;}s.receipts=[...s.receipts.filter(r=>r.target!==payload.target),payload];}
      else if(type==='device.status')s.device={...s.device,...payload};
      else if(type==='capture.failed'){const w=s.work.find(w=>w.id===payload.workId);if(w&&pending(w)){this.finishIn(s,w,'failed',{reason:'capture_failed',applicationEffect:'not_applied',providerOutcomeKnown:true},emit);}}
      else if(!['playback.metric','media.summary','clock.sample'].includes(type))throw new HttpError(400,'Unsupported device report');
      emit(type,payload,'device',messageId);
    });
  }
  async frame(id:string,frameId:string,bytes:Buffer,mime:string,meta:Record<string,unknown>) {
    const s=this.get(id);this.checkGeneration(s,z.number().int().parse(meta.generation));
    if(bytes.length>2*1024*1024||bytes.length<8)throw new HttpError(413,'Frame outside size limits');
    if(mime!=='image/jpeg'&&mime!=='image/png')throw new HttpError(415,'Only JPEG/PNG frames supported');
    if(mime==='image/jpeg'&&(bytes[0]!==255||bytes[1]!==216)||mime==='image/png'&&bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new HttpError(400,'Invalid image signature');
    const digest=hash(bytes.toString('base64'));const previous=this.store.asset(id,frameId);
    if(previous){if(previous.hash!==digest)throw new HttpError(409,'Frame ID reused');return previous.frame;}
    const w=typeof meta.workId==='string'?s.work.find(w=>w.id===meta.workId):undefined;
    if(meta.workId&&(!w||!pending(w)||w.generation!==s.generation||w.frameId&&w.frameId!==frameId))throw new HttpError(409,'Capture request obsolete');
    const receivedAt=Date.now();const capturedAt=typeof meta.capturedAt==='number'&&Number.isFinite(meta.capturedAt)?meta.capturedAt:undefined;
    const uncertainty=typeof meta.clockUncertaintyMs==='number'&&meta.clockUncertaintyMs>=0?meta.clockUncertaintyMs:undefined;
    const age=capturedAt===undefined||uncertainty===undefined?undefined:receivedAt-capturedAt+uncertainty;
    const freshness=age===undefined?'unknown':age<0||age>s.config.maxFrameAgeMs?'stale':'fresh';
    if(w&&capturedAt!==undefined&&uncertainty!==undefined&&capturedAt+uncertainty<w.createdAt)throw new HttpError(409,'Frame predates capture request');
    const frame:Frame={frameId,receivedAt,cameraSource:z.enum(['phone','meta_display','mock']).parse(meta.cameraSource),captureTimeBasis:z.string().max(100).parse(meta.captureTimeBasis),freshness,...(capturedAt!==undefined?{capturedAt,clockUncertaintyMs:uncertainty}:{}),...(w?{workId:w.id}:{}),...(typeof meta.width==='number'?{width:meta.width}:{}),...(typeof meta.height==='number'?{height:meta.height}:{})};
    let path:string|undefined;
    if(s.config.recordFrames&&w&&this.store.assets(id).filter(asset=>asset.storageState==='retained').reduce((total,asset)=>total+Number(asset.byteLength??0),0)+bytes.length<=64*1024*1024){const dir=join(this.dataDir,'media',id);mkdirSync(dir,{recursive:true});path=join(dir,frameId);writeFileSync(path+'.tmp',bytes);renameSync(path+'.tmp',path);}
    // Latest previews replace earlier bytes; at most four selected images / 8 MiB per session.
    const entries=()=>[...this.transient.entries()].filter(([key])=>key.startsWith(id+':'));
    if(!w)for(const [key]of entries()){const asset=this.store.asset(id,key.split(':')[1]);if(!asset?.frame.workId)this.transient.delete(key);}
    while(entries().length>=4||entries().reduce((sum,[,asset])=>sum+asset.bytes.length,0)+bytes.length>8*1024*1024)this.transient.delete(entries()[0][0]);
    while([...this.transient.values()].reduce((sum,asset)=>sum+asset.bytes.length,0)+bytes.length>64*1024*1024)this.transient.delete(this.transient.keys().next().value!);
    this.transient.set(id+':'+frameId,{bytes,mime,at:receivedAt});
    this.mutate(id,(state,emit)=>{this.checkGeneration(state,s.generation);const current=state.work.find(x=>x.id===w?.id);if(w&&(!current||!pending(current)))throw new HttpError(409,'Inspection cancelled');
      this.store.putAsset(id,frameId,digest,{frame,mime,path,storageState:path?'retained':'transient',byteLength:bytes.length,expiresAt:state.createdAt+86400000});
      state.latestFrame=frame;emit('frame.captured',{...frame});if(current){current.frameId=frameId;current.status='running';this.store.work(id,current);emit('work.running',{workId:current.id});}
    });
    if(w)this.background(this.inspect(id,w.id,frame,bytes,mime));return frame;
  }
  private async inspect(id:string,workId:string,frame:Frame,bytes:Buffer,mime:string) {
    const s=this.get(id),w=s.work.find(w=>w.id===workId),rt=this.runtime.get(id);if(!w||!rt)return;
    const guard=()=>{const now=this.store.get(id);const work=now?.work.find(w=>w.id===workId);return !this.closing&&this.runtime.get(id)===rt&&now&&active(now)&&now.generation===w.generation&&work&&pending(work)&&Date.now()<work.deadlineAt?work:undefined;};
    const question=String(w.input.question).slice(0,850); const historical=frame.freshness==='unknown'?'Capture time is unknown. Describe only this last received frame, never claim it is current. ':'';
    const abort=new AbortController();rt.aborts.set(workId,abort);
    try {
      if(frame.freshness==='stale')throw new HttpError(409,'Frame is stale; capture again');
      if(s.config.provider!=='openai') {
        if(!guard())return;rt.provider.inspect(bytes,mime,historical+question);
        this.mutate(id,(state,emit)=>{const current=state.work.find(x=>x.id===workId)!;emit('frame.dispatched',{frameId:frame.frameId,workId,question,captureFreshness:frame.freshness});this.finishIn(state,current,'completed',{status:'dispatched',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);});
      } else {
        const observation=await observeFrame(bytes,mime,question,abort.signal,{model:s.config.observerModel});
        if(!guard())return;
        const age=frame.capturedAt===undefined?undefined:Date.now()-frame.capturedAt+(frame.clockUncertaintyMs??0);
        this.mutate(id,(_,emit)=>emit('observation.completed',{workId,frameId:frame.frameId,...observation}));
        if(age!==undefined&&age>s.config.maxFrameAgeMs)throw new HttpError(409,'Observation expired; capture again');
        const context=JSON.stringify({frameId:frame.frameId,capturedAt:frame.capturedAt,freshness:frame.freshness,observation}).slice(0,1400);
        if(!guard())return;rt.provider.appendContext(historical+context,null,false);
        rt.provider.appendContext('Answer the learner question using only the supplied observation, acknowledging uncertainty: '+question,null,true);
        this.mutate(id,(state,emit)=>{emit('context.dispatched',{workId,frameId:frame.frameId,text:historical+context});const current=state.work.find(x=>x.id===workId)!;this.finishIn(state,current,'completed',{status:'context_dispatched',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);});
      }
      if(w.input.nativeCallId)rt.provider.toolResult(String(w.input.nativeCallId),{status:'dispatched',frameId:frame.frameId,captureFreshness:frame.freshness});
    } catch(error) {
      if(guard()){this.mutate(id,(state,emit)=>this.finishIn(state,state.work.find(x=>x.id===workId)!,'failed',{reason:error instanceof HttpError?error.message:'Observation failed',applicationEffect:'not_applied',providerOutcomeKnown:false},emit));}
    } finally {rt.aborts.delete(workId);}
  }
  private async tool(id:string,call:{id:string;name:string;args:Record<string,unknown>}) {
    const rt=this.runtime.get(id);if(!rt)return;const key=rt.conversation+':tool:'+call.id;const existing=this.store.native(id,key);
    if(existing){if(!pending(existing))rt.provider.toolResult(call.id,existing.result);return;}
    let result:unknown;let capture:Work|undefined;
    try{this.mutate(id,(s,emit)=>{this.checkGeneration(s,rt.generation);const w=this.reserve(s,'tool',{name:call.name,args:call.args,nativeCallId:call.id},emit,key);
      if(call.name==='set_hud'){this.setHud(s,call.args,emit,w.expectedHudRevision);result={status:'applied',hudRevision:s.hudRevision,applicationEffect:'applied',providerOutcomeKnown:true};}
      else if(call.name==='clear_hud'){this.setHud(s,{},emit);result={status:'applied',hudRevision:s.hudRevision,applicationEffect:'applied',providerOutcomeKnown:true};}
      else if(call.name==='inspect_frame'){w.kind='inspect';w.input={question:z.string().min(1).max(1000).parse(call.args.question),nativeCallId:call.id};this.store.work(id,w);capture=w;return;}
      else throw new HttpError(400,'Unknown tool');this.finishIn(s,w,'completed',result,emit);
    });}catch{result={status:'rejected',applicationEffect:'not_applied',reason:'Invalid or obsolete tool request'};this.mutate(id,(s,emit)=>{const w:Work={id:randomUUID(),generation:s.generation,kind:'tool',status:'failed',createdAt:Date.now(),deadlineAt:Date.now(),expectedHudRevision:s.hudRevision,input:{name:call.name},nativeKey:key,result};this.store.work(id,w);emit('work.failed',{workId:w.id,result});});}
    if(capture)this.emit('capture',{id,generation:rt.generation,workId:capture.id,question:capture.input.question});else rt.provider.toolResult(call.id,result);
  }
  private async delegate(id:string,delegationId:string,offsetMs?:number) {
    const rt=this.runtime.get(id);if(!rt)return;const key=rt.conversation+':delegation:'+delegationId;
    const prior=this.store.native(id,key);if(prior){if(!pending(prior))rt.provider.toolResult(delegationId,prior.result);return;}
    const s=this.get(id);const w=this.mutate(id,(state,emit)=>this.reserve(state,'delegation',{delegationId,offsetMs,inputThroughSeq:state.throughSeq},emit,key));
    const abort=new AbortController();rt.aborts.set(w.id,abort);
    try{
      const proposal=await inferTask(s.transcripts.map(t=>`${t.speaker}: ${t.text}`).join(''),{hud:s.hud,device:s.device,offsetMs},abort.signal,{model:s.config.observerModel});
      const current=this.get(id);if(this.runtime.get(id)!==rt||!current.work.some(x=>x.id===w.id&&pending(x))||Date.now()>w.deadlineAt)return;
      this.mutate(id,(_,emit)=>emit('delegation.inferred',{workId:w.id,delegationId,inputThroughSeq:w.input.inputThroughSeq,offsetMs,proposal}));
      if(proposal.action==='inspect_frame'){
        this.mutate(id,(state,emit)=>{const work=state.work.find(x=>x.id===w.id)!;work.kind='inspect';work.input={...work.input,question:z.string().min(1).max(1000).parse(proposal.args.question),nativeCallId:delegationId};this.store.work(id,work);emit('work.awaiting_frame',{workId:w.id});});
        this.emit('capture',{id,generation:rt.generation,workId:w.id,question:proposal.args.question});return;
      }
      const result=this.mutate(id,(state,emit)=>{let result:Record<string,unknown>={status:'clarification',message:proposal.message,applicationEffect:'not_applied'};
        if(proposal.action==='set_hud'||proposal.action==='clear_hud'){if(state.hudRevision!==w.expectedHudRevision)result={status:'not_applied',reason:'HUD superseded',applicationEffect:'not_applied'};else{this.setHud(state,proposal.action==='clear_hud'?{}:proposal.args,emit,w.expectedHudRevision);result={status:'applied',hudRevision:state.hudRevision,applicationEffect:'applied'};}}
        this.finishIn(state,state.work.find(x=>x.id===w.id)!,'completed',result,emit);return result;});
      rt.provider.toolResult(delegationId,result);
    } catch {const state=this.store.get(id);const current=state?.work.find(x=>x.id===w.id);if(current&&pending(current)&&this.runtime.get(id)===rt){this.mutate(id,(s,emit)=>this.finishIn(s,s.work.find(x=>x.id===w.id)!,'failed',{reason:'Delegated handler failed',applicationEffect:'not_applied',providerOutcomeKnown:false},emit));}}
    finally {rt.aborts.delete(w.id);}
  }
  async end(id:string) {
    const s=this.get(id);if(!active(s))return;
    const rt=this.runtime.get(id);if(rt)for(const a of rt.aborts.values())a.abort();
    this.mutate(id,(state,emit)=>{state.status='ending';state.speechEpoch++;this.setHud(state,{},emit);for(const w of state.work.filter(pending))this.finishIn(state,w,'cancelled',{reason:'session_ended',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);emit('session.ending',{});});
    this.emit('flush',{id,generation:s.generation,speechEpoch:this.get(id).speechEpoch});this.emit('snapshot',id);
    let finalization=rt?'complete':'incomplete';try{await rt?.provider.close();}catch{finalization='incomplete';}
    if(this.runtime.get(id)===rt)this.runtime.delete(id);
    if(!this.store.get(id))return;
    this.mutate(id,(state,emit)=>{state.status='ended';state.endedAt=Date.now();state.finalization=finalization;this.store.connection(id,state.generation,rt?.conversation??'unknown',{status:'closed',closedAt:state.endedAt,finalization});emit('session.ended',{finalization});});this.emit('snapshot',id);
  }
  assetBytes(id:string,assetId:string) {
    const asset=this.store.asset(id,assetId);if(!asset)throw new HttpError(404,'Unknown asset');const memory=this.transient.get(id+':'+assetId);if(memory)return memory;
    if(asset.path&&existsSync(asset.path))return{bytes:readFileSync(asset.path),mime:asset.mime as string};throw new HttpError(410,'Image was not retained or has expired');
  }
  export(id:string) {const snapshot=this.get(id);const assets=this.store.assets(id).map(({path,...asset})=>({...asset,...(typeof path==='string'&&existsSync(path)?{base64:readFileSync(path).toString('base64')}:{} )}));return{schemaVersion:1,exportedAt:Date.now(),snapshot,events:this.store.events(id,0,1000000),assets,evidenceCoverage:{rawAudio:'not_recorded',images:snapshot.config.recordFrames?'selected_frames':'transient_only',transcripts:'provider_estimates',playback:'device_reports_not_acoustic_proof'},jsonl:this.store.events(id,0,1000000).map(e=>JSON.stringify(e)).join('\n')};}
  async delete(id:string) {await this.end(id);this.emit('deleted',id);this.store.delete(id);rmSync(join(this.dataDir,'media',id),{recursive:true,force:true});for(const key of this.transient.keys())if(key.startsWith(id+':'))this.transient.delete(key);}
  private sweep() {
    const now=Date.now();for(const [key,value]of this.transient)if(now-value.at>60000){this.transient.delete(key);const [sessionId,assetId]=key.split(':');const asset=this.store.asset(sessionId,assetId);if(asset&&!asset.path)this.store.putAsset(sessionId,assetId,asset.hash,{...asset,storageState:'expired'});}
    for(const s of this.store.list()){
      if(now-s.createdAt>86400000){this.background(this.delete(s.id));continue;}
      if(!active(s))continue;
      if(now-s.createdAt>s.config.maxSessionMinutes*60000){this.background(this.end(s.id));continue;}
      const expired=s.work.filter(w=>pending(w)&&w.deadlineAt<now);const timer=s.hud.timer;const hudExpired=(s.hud.expiresAt??Infinity)<now||(timer&&timer.startedAt!+timer.durationMs<now);
      if(expired.length||hudExpired)this.mutate(s.id,(state,emit)=>{
        for(const w of state.work.filter(w=>expired.some(x=>x.id===w.id))){this.runtime.get(s.id)?.aborts.get(w.id)?.abort();this.finishIn(state,w,'failed',{reason:'deadline_exceeded',applicationEffect:'not_applied',providerOutcomeKnown:false},emit);}
        if(hudExpired&&state.hudRevision===s.hudRevision)this.setHud(state,{},emit);
      });
    }
  }
  async close(){this.closing=true;clearInterval(this.sweepTimer);for(const rt of this.runtime.values())for(const abort of rt.aborts.values())abort.abort();await Promise.all(this.store.list().filter(active).map(s=>this.end(s.id)));await Promise.allSettled([...this.tasks]);this.store.close();}
}
