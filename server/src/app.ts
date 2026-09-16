import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { commandSchema, configSchema, decodeAudio, encodeAudio, idSchema, type SessionEvent } from '../../contracts/index.ts';
import { Coordinator, HttpError } from './coordinator.ts';
import { Store } from './store.ts';
import { Diagnostics } from './diagnostics.ts';
import { availability } from './providers/index.ts';

const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const loopback=(address?:string)=>address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
export function createApp(options:{dataDir?:string;operatorToken?:string;staticDir?:string;deviceGraceMs?:number;tls?:{cert:string;key:string}}={}) {
  let shuttingDown=false;
  const deviceGraceMs=z.number().int().min(1).max(120000).parse(options.deviceGraceMs??120000);
  const dataDir=resolve(options.dataDir??'.runtime');mkdirSync(dataDir,{recursive:true});
  const tokenFile=join(dataDir,'operator-token');
  const operatorToken=options.operatorToken??(process.env.COACH_TOKEN||undefined)??(existsSync(tokenFile)?readFileSync(tokenFile,'utf8').trim():randomBytes(32).toString('base64url'));
  if(!options.operatorToken&&!process.env.COACH_TOKEN&&!existsSync(tokenFile))writeFileSync(tokenFile,operatorToken+'\n',{mode:0o600});
  const store=new Store(join(dataDir,'coach.sqlite'));const coordinator=new Coordinator(store,dataDir);const diagnostics=new Diagnostics(store.db);
  const token=(id:string,role:string)=>createHmac('sha256',operatorToken).update(id+':'+role).digest('base64url');
  const authorize=(credential:string,id?:string,write=false)=>{
    if(equal(credential,operatorToken))return 'operator';
    if(id&&store.get(id)&&equal(credential,token(id,'operator')))return 'operator';
    if(!write&&id&&store.get(id)&&equal(credential,token(id,'spectator')))return 'spectator';
    throw new HttpError(401,'Missing or invalid access token');
  };
  const controls=new Map<string,WebSocket>(),audios=new Map<string,WebSocket>();
  const spectators=new Map<string,Set<WebSocket>>();
  const deviceGrace=new Map<string,NodeJS.Timeout>(),pendingEnds=new Set<Promise<void>>();
  const clearGrace=(id:string)=>{clearTimeout(deviceGrace.get(id));deviceGrace.delete(id);};
  const armGrace=(id:string)=>{
    if(shuttingDown||deviceGrace.has(id)||controls.get(id)?.readyState===WebSocket.OPEN)return;
    if(!['starting','active','reconnecting'].includes(store.get(id)?.status??''))return;
    const timer=setTimeout(()=>{
      deviceGrace.delete(id);
      if(shuttingDown||controls.get(id)?.readyState===WebSocket.OPEN||!['starting','active','reconnecting'].includes(store.get(id)?.status??''))return;
      coordinator.mutate(id,(_,emit)=>emit('device.grace_expired',{graceMs:deviceGraceMs,reason:'control_not_attached'}));
      const task=coordinator.end(id);pendingEnds.add(task);
      void task.then(()=>pendingEnds.delete(task),()=>{pendingEnds.delete(task);coordinator.emit('diagnostic','Ending an orphaned session failed');});
    },deviceGraceMs);timer.unref();deviceGrace.set(id,timer);
  };
  const send=(ws:WebSocket|undefined,value:unknown)=>{if(ws?.readyState===WebSocket.OPEN){if(ws.bufferedAmount>256*1024){ws.close(1013,'Slow consumer; reconnect for snapshot');return;}ws.send(JSON.stringify(value));}};
  const snapshot=(id:string)=>({type:'snapshot',snapshot:coordinator.get(id),serverTime:Date.now()});
  const broadcast=(id:string,value:unknown)=>{send(controls.get(id),value);for(const ws of spectators.get(id)??[])send(ws,value);};
  const listener=(event:SessionEvent)=>{if(['session.ending','session.ended','session.interrupted','connection.failed'].includes(event.type))clearGrace(event.sessionId);broadcast(event.sessionId,{type:'event',event});if(event.type==='hud.accepted'&&!coordinator.get(event.sessionId).demonstration)send(controls.get(event.sessionId),{type:'hud',generation:event.generation,...event.payload});};
  coordinator.on('event',listener);
  coordinator.on('snapshot',(id:string)=>broadcast(id,snapshot(id)));
  coordinator.on('capture',({id,...message})=>send(controls.get(id),{type:'capture',...message}));
  coordinator.on('flush',({id,...message})=>send(controls.get(id),{type:'flush',...message}));
  coordinator.on('rebind',(id:string)=>{
    const ws=controls.get(id);send(ws,{type:'rebind',snapshot:coordinator.get(id),serverTime:Date.now()});
    controls.delete(id);audios.get(id)?.close(4001,'Binding replaced');audios.delete(id);ws?.close(4001,'Binding replaced');
    armGrace(id);
  });
  coordinator.on('deleted',(id:string)=>{clearGrace(id);diagnostics.deleteSession(id);controls.get(id)?.close(4004,'Deleted');audios.get(id)?.close(4004,'Deleted');for(const ws of spectators.get(id)??[])ws.close(4004,'Deleted');});
  coordinator.on('audio',({id,generation,speechEpoch,seq,pcm})=>{
    const ws=audios.get(id);if(!ws||ws.readyState!==WebSocket.OPEN)return;
    if(ws.bufferedAmount>24000){coordinator.flush(id,'output_backpressure');ws.close(1013,'Output discontinuity');return;}
    ws.send(encodeAudio(pcm,generation,speechEpoch,seq));
  });
  const read=async(req:IncomingMessage,max=65536)=>{const parts:Buffer[]=[];let size=0;for await(const part of req){if(shuttingDown)throw new HttpError(503,'Server is shutting down');size+=part.length;if(size>max)throw new HttpError(413,'Request too large');parts.push(part);}if(shuttingDown)throw new HttpError(503,'Server is shutting down');return Buffer.concat(parts);};
  const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  const handler=async(req:IncomingMessage,res:ServerResponse)=>{
    try{
      if(shuttingDown)throw new HttpError(503,'Server is shutting down');
      const url=new URL(req.url??'/', 'http://localhost');const route=url.pathname.split('/').filter(Boolean);
      if(route[0]!=='api'){
        if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
        const root=resolve(options.staticDir??'dist/web');const requested=resolve(root,'.'+decodeURIComponent(url.pathname));
        if(!requested.startsWith(root+sep)&&requested!==root)throw new HttpError(404,'Not found');
        const path=existsSync(requested)&&extname(requested)?requested:join(root,'index.html');
        if(!existsSync(path)){res.writeHead(200,{'content-type':'text/plain'});res.end('Wearable Coach backend is running. Run npm run build to build the dashboard.');return;}
        const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
        res.writeHead(200,{'content-type':mime[extname(path)]??'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; script-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"});res.end(readFileSync(path));return;
      }
      if(route[1]==='health'){json(res,200,{ok:true,version:1});return;}
      const credential=req.headers.authorization?.replace(/^Bearer /,'')??'';
      const id=route[1]==='sessions'&&route[2]?idSchema.parse(route[2]):undefined;
      // USB adb reverse reaches a loopback-only listener. Bootstrap the native app;
      // all existing-session operations still require their scoped credentials.
      const address=server.address();
      const localSetup=!credential&&req.headers['x-coach-local']==='1'&&!req.headers.origin
        &&typeof address==='object'&&address!==null&&loopback(address.address)&&loopback(req.socket.remoteAddress)
        &&((url.pathname==='/api/providers'&&req.method==='GET')||(url.pathname==='/api/sessions'&&req.method==='POST')||(url.pathname==='/api/diagnostics'&&req.method==='POST'));
      if(!localSetup)authorize(credential,id,req.method!=='GET'||['export','diagnostics'].includes(route[3]));
      if(url.pathname==='/api/diagnostics'){
        if(req.method==='POST'){const body=JSON.parse((await read(req,128*1024)).toString());json(res,200,diagnostics.ingest(body.reports));return;}
        if(req.method==='GET'){json(res,200,{reports:diagnostics.list({limit:1000}),counts:diagnostics.counts()});return;}
        throw new HttpError(405,'Method not allowed');
      }
      if(route[1]==='time'){json(res,200,{serverTime:Date.now()});return;}
      if(route[1]==='providers'){json(res,200,{providers:availability()});return;}
      if(route[1]!=='sessions')throw new HttpError(404,'Unknown endpoint');
      if(!id){
        if(req.method==='GET'){json(res,200,{sessions:store.list()});return;}
        if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
        const body=JSON.parse((await read(req)).toString());const config=configSchema.parse(body.config);const key=idSchema.parse(body.createKey);
        const info=availability().find((p:any)=>(p.id??p.provider)===config.provider);if(!info?.available)throw new HttpError(409,'Selected provider is not configured');
        const s=coordinator.create(key,config);armGrace(s.id);json(res,201,{sessionId:s.id,token:token(s.id,'operator'),spectatorToken:token(s.id,'spectator'),snapshot:s,serverTime:Date.now()});return;
      }
      if(route.length===3){if(req.method==='GET'){json(res,200,snapshot(id));return;}if(req.method==='DELETE'){await coordinator.delete(id);json(res,200,{deleted:true});return;}}
      if(route[3]==='reconnect'&&req.method==='POST'){const body=JSON.parse((await read(req)).toString());const s=coordinator.reconnect(id,z.number().int().positive().parse(body.generation),idSchema.parse(body.requestId));json(res,200,{snapshot:s,serverTime:Date.now()});return;}
      if(route[3]==='commands'&&req.method==='POST'){const command=commandSchema.parse(JSON.parse((await read(req)).toString()));json(res,200,coordinator.command(id,command));return;}
      if(route[3]==='frames'&&req.method==='POST'){
        const frameId=idSchema.parse(route[4]);const header=req.headers['x-frame-meta'];if(typeof header!=='string')throw new HttpError(400,'Missing frame metadata');
        const meta=JSON.parse(header),uploadStartedAt=Date.now();const bytes=await read(req,2*1024*1024);
        if(meta.liveVideo===true&&typeof meta.frameAgeMs==='number')meta.frameAgeMs+=Date.now()-uploadStartedAt;
        const result=await coordinator.frame(id,frameId,bytes,String(req.headers['content-type']??''),meta);json(res,201,result);return;
      }
      if(route[3]==='assets'&&req.method==='GET'){const data=coordinator.assetBytes(id,idSchema.parse(route[4]));res.writeHead(200,{'content-type':data.mime,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(data.bytes);return;}
      if(route[3]==='diagnostics'&&req.method==='GET'){coordinator.get(id);json(res,200,{reports:diagnostics.list({sessionId:id,limit:1000}),counts:diagnostics.counts({sessionId:id})});return;}
      if(route[3]==='export'&&req.method==='GET'){res.setHeader('content-disposition',`attachment; filename="coach-${id}.json"`);json(res,200,{...coordinator.export(id),diagnostics:diagnostics.list({sessionId:id,limit:1000}),diagnosticCounts:diagnostics.counts({sessionId:id}),diagnosticLimit:1000});return;}
      throw new HttpError(404,'Unknown endpoint');
    }catch(error){if(!res.headersSent)json(res,error instanceof HttpError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,{error:error instanceof HttpError?error.message:error instanceof z.ZodError?'Invalid request: '+error.issues.map(i=>i.path.join('.')+' '+i.message).join(';'):error instanceof SyntaxError?'Invalid JSON':'Internal server error'});else res.end();}
  };
  const server=options.tls?createHttpsServer({key:readFileSync(options.tls.key),cert:readFileSync(options.tls.cert)},handler):createServer(handler);
  const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    if(shuttingDown){socket.destroy();return;}
    const pathname=new URL(req.url??'/','http://localhost').pathname;
    if(!/^\/api\/sessions\/[\da-f-]+\/(control|audio|events)$/.test(pathname)){socket.destroy();return;}
    if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host&&!process.env.COACH_ALLOWED_ORIGINS?.split(',').includes(origin.origin)){socket.destroy();return;}}catch{socket.destroy();return;}}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',(ws,req)=>{
    const [, , ,id,channel]=new URL(req.url??'/','http://localhost').pathname.split('/');
    let authenticated=false,generation=0,lastAudioSeq=-1;let intervalBytes=0,intervalStart=Date.now();
    const timeout=setTimeout(()=>ws.close(4003,'Authentication timeout'),5000);timeout.unref();
    ws.on('message',(data,binary)=>{
      try{
        if(shuttingDown)return;
        if(!authenticated){
          if(binary)throw new HttpError(401,'Authenticate first');const hello=JSON.parse(data.toString());if(hello.type!=='hello'||typeof hello.token!=='string')throw new HttpError(401,'Authenticate first');
          authorize(hello.token,id,channel!=='events');const s=coordinator.get(id);
          if(channel!=='events'){generation=z.number().int().positive().parse(hello.generation);coordinator.checkGeneration(s,generation);const map=channel==='control'?controls:audios;const prior=map.get(id);if(prior&&prior.readyState===WebSocket.OPEN)throw new HttpError(409,'Device channel already bound');map.set(id,ws);}
          else {const set=spectators.get(id)??new Set();set.add(ws);spectators.set(id,set);}
          authenticated=true;clearTimeout(timeout);send(ws,snapshot(id));
          if(channel==='control'){clearGrace(id);if(!s.demonstration)send(ws,{type:'hud',generation:s.generation,hud:s.hud,hudRevision:s.hudRevision});}return;
        }
        if(channel==='events')throw new HttpError(403,'Read-only stream');
        if(binary){
          if(channel!=='audio')throw new HttpError(400,'Binary only on audio channel');const bytes=Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer);const packet=decodeAudio(bytes);
          if(packet.generation!==generation||packet.seq<=lastAudioSeq)throw new HttpError(409,'Stale audio packet');lastAudioSeq=packet.seq;
          const now=Date.now();if(now-intervalStart>1000){intervalStart=now;intervalBytes=0;}intervalBytes+=packet.pcm.byteLength;
          if(intervalBytes>coordinator.get(id).inputRate*4)throw new HttpError(429,'Audio is not paced in real time');coordinator.audio(id,generation,Buffer.from(packet.pcm));return;
        }
        const message=JSON.parse(data.toString());if(channel==='audio')throw new HttpError(400,'Expected PCM');
        if(message.type==='ping'){send(ws,{type:'pong',clientTime:message.clientTime,serverTime:Date.now()});return;}
        if(message.commandId){const c=commandSchema.parse(message);if(c.generation!==generation)throw new HttpError(409,'Socket lease mismatch');send(ws,{type:'command.result',commandId:c.commandId,...coordinator.command(id,c)});}
        else {if(message.generation!==generation||message.sessionId!==id)throw new HttpError(409,'Report lease mismatch');const messageId=idSchema.parse(message.messageId);const payload=z.record(z.string(),z.unknown()).parse(message.payload);coordinator.report(id,generation,messageId,z.string().parse(message.type),payload);}
      }catch(error){send(ws,{type:'error',code:error instanceof HttpError?error.status:400,message:error instanceof HttpError?error.message:'Invalid message'});if(!authenticated||binary)ws.close(4003,'Protocol rejected');}
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{clearTimeout(timeout);spectators.get(id)?.delete(ws);
      if(shuttingDown)return;
      const bound=controls.get(id)===ws||audios.get(id)===ws;
      if(controls.get(id)===ws)controls.delete(id);
      if(audios.get(id)===ws)audios.delete(id);
      const state=store.get(id);
      if(bound&&state&&state.generation===generation&&['active','starting','reconnecting'].includes(state.status))coordinator.reconnect(id,generation,'transport:'+randomUUID());
    });
  });
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){const socket=ws as WebSocket&{alive?:boolean};if(socket.alive===false){socket.terminate();continue;}socket.alive=false;socket.ping();}},15000);heartbeat.unref();
  wss.on('connection',ws=>ws.on('pong',()=>{(ws as WebSocket&{alive?:boolean}).alive=true;}));
  let closePromise:Promise<void>|undefined;
  const close=()=>closePromise??=(async()=>{
    shuttingDown=true;clearInterval(heartbeat);for(const id of deviceGrace.keys())clearGrace(id);
    const drained=new Promise<void>(resolve=>server.close(()=>resolve()));
    await Promise.allSettled([...pendingEnds,...store.list().filter(s=>['starting','active','reconnecting'].includes(s.status)).map(s=>coordinator.end(s.id))]);
    // A command may already be awaiting the provider's bounded close; let its terminal event reach clients too.
    const endingDeadline=Date.now()+3000;
    while(store.list().some(s=>s.status==='ending')&&Date.now()<endingDeadline)await new Promise(resolve=>setTimeout(resolve,10));
    await Promise.all([...wss.clients].map(ws=>new Promise<void>(resolve=>{
      const timeout=setTimeout(()=>{ws.terminate();resolve();},250);
      ws.once('close',()=>{clearTimeout(timeout);resolve();});ws.close(1001,'Server shutdown');
    })));
    // Bound incomplete HTTP bodies while letting completed responses drain before the database closes.
    const httpDeadline=setTimeout(()=>server.closeAllConnections(),1000);
    await drained;clearTimeout(httpDeadline);
    await coordinator.close();await new Promise<void>(resolve=>wss.close(()=>resolve()));
  })();
  return{server,coordinator,store,diagnostics,operatorToken,token,close};
}
