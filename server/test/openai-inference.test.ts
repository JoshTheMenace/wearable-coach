import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { generateStructured, type InferenceOptions } from '../src/providers/inference.ts';

const schema=z.object({placement:z.enum(['correct','unknown']),confidence:z.number().min(0).max(1)}).strict();
const value={placement:'correct',confidence:0.9};
const message={type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]};
const response=(patch:Record<string,unknown>={})=>({status:'completed',model:'gpt-5.6-terra',service_tier:'default',output:[message],usage:{input_tokens:120,output_tokens:12,total_tokens:132},...patch});
function setup(t:TestContext){
  const saved={OPENAI_API_KEY:process.env.OPENAI_API_KEY,GEMINI_KEY:process.env.GEMINI_KEY,GEMINI_API_KEY:process.env.GEMINI_API_KEY};
  process.env.OPENAI_API_KEY='test-openai';delete process.env.GEMINI_KEY;delete process.env.GEMINI_API_KEY;
  t.after(()=>{for(const [name,key] of Object.entries(saved)){if(key===undefined)delete process.env[name];else process.env[name]=key;}});
  return (fetchImpl:typeof fetch,options:InferenceOptions={},signal=new AbortController().signal,parts:unknown[]=[{text:'Current frame'}])=>
    generateStructured(schema,'Assess only the final image.',parts,signal,{model:'gpt-5.6-terra',fetchImpl,...options});
}

test('OpenAI structured inference preserves reference/image order and reports the actual tier',async t=>{
  const run=setup(t);let request:any,address:unknown,headers:Headers;
  const result=await run(async(url,init)=>{address=url;headers=new Headers(init?.headers);request=JSON.parse(String(init?.body));return Response.json(response());},{},undefined,
    [{text:'Labeled reference'},{inlineData:{mimeType:'image/jpeg',data:'cmVm'}},{text:'CURRENT image'},{inlineData:{mimeType:'image/png',data:'bm93'}}]);
  assert.equal(address,'https://api.openai.com/v1/responses');assert.equal(headers!.get('authorization'),'Bearer test-openai');assert.equal(headers!.has('x-goog-api-key'),false);
  assert.equal(request.model,'gpt-5.6-terra');assert.equal(request.service_tier,'priority');assert.equal(request.store,false);
  assert.deepEqual(request.reasoning,{effort:'none'});assert.equal(request.instructions,'Assess only the final image.');
  assert.deepEqual(request.input,[{role:'user',content:[{type:'input_text',text:'Labeled reference'},{type:'input_image',image_url:'data:image/jpeg;base64,cmVm',detail:'high'},{type:'input_text',text:'CURRENT image'},{type:'input_image',image_url:'data:image/png;base64,bm93',detail:'high'}]}]);
  assert.equal(request.text.format.type,'json_schema');assert.equal(request.text.format.strict,true);assert.deepEqual(request.text.format.schema,z.toJSONSchema(schema));
  assert.deepEqual(result.value,value);assert.equal(result.model,'gpt-5.6-terra');assert.equal(result.serviceTier,'default');
  assert.deepEqual(result.usage,{input_tokens:120,output_tokens:12,total_tokens:132});
});

test('OpenAI requested tier is configurable and missing response tier stays unknown',async t=>{
  const run=setup(t);let request:any;
  const result=await run(async(_url,init)=>{request=JSON.parse(String(init?.body));return Response.json(response({service_tier:undefined}));},{serviceTier:'default'});
  assert.equal(request.service_tier,'default');assert.equal(result.serviceTier,undefined);
});

for(const [name,body] of Object.entries({
  refusal:response({output:[{...message,content:[...message.content,{type:'refusal',refusal:'Refused'}]}]}),
  incomplete:response({status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),
  partialMessage:response({output:[{...message,status:'incomplete'}]}),
  schemaMismatch:response({output:[{...message,content:[{type:'output_text',text:JSON.stringify({...value,confidence:2})}]}]}),
  unexpectedField:response({output:[{...message,content:[{type:'output_text',text:JSON.stringify({...value,extra:true})}]}]}),
  invalidJson:response({output:[{...message,content:[{type:'output_text',text:'not JSON'}]}]}),
  absentOutput:response({output:[]}),
  wrongRole:response({output:[{...message,role:'user'}]}),
}))test(`OpenAI rejects ${name} without accepting partial evidence`,async t=>{
  const run=setup(t);await assert.rejects(run(async()=>Response.json(body)),/incomplete or invalid structured result/);
});

test('OpenAI transport errors and oversized responses are bounded and sanitized',async t=>{
  const run=setup(t);
  await assert.rejects(run(async()=>new Response('upstream-secret',{status:429})),/^Error: Inference request failed \(HTTP 429\)$/);
  await assert.rejects(run(async()=>{throw new Error('upstream-secret');}),/^Error: Inference connection failed$/);
  await assert.rejects(run(async()=>new Response('x'.repeat(256*1024+1))),/within limits/);
});

test('OpenAI respects fetch deadlines, body-read deadlines and caller cancellation',async t=>{
  const run=setup(t);
  await assert.rejects(run(async(_url,init)=>{await delay(100,undefined,{signal:init?.signal??undefined});return Response.json(response());},{timeoutMs:5}),/Inference timed out/);
  const keepAlive=setTimeout(()=>{},1000);t.after(()=>clearTimeout(keepAlive));
  let cancelled=false;
  await assert.rejects(run(async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>{cancelled=true;}})),{timeoutMs:5}),/Inference timed out/);
  assert.equal(cancelled,true);
  const abort=new AbortController();abort.abort();let fetched=false;
  await assert.rejects(run(async()=>{fetched=true;return Response.json(response());},{},abort.signal),{name:'AbortError'});assert.equal(fetched,false);
});

test('OpenAI key selection does not fall back to a Gemini credential',async t=>{
  const run=setup(t);delete process.env.OPENAI_API_KEY;process.env.GEMINI_KEY='test-gemini';let fetched=false;
  await assert.rejects(run(async()=>{fetched=true;return Response.json(response());}),/OPENAI_API_KEY/);assert.equal(fetched,false);
});

test('Gemini structured inference retains its existing request and response behavior',async t=>{
  const run=setup(t);process.env.GEMINI_KEY='test-gemini';let request:any,address:unknown,headers:Headers;
  const result=await run(async(url,init)=>{address=url;request=JSON.parse(String(init?.body));headers=new Headers(init?.headers);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'ignore'},{text:JSON.stringify(value)}]}}],usageMetadata:{totalTokenCount:9}});},{model:'gemini-3.8-flash',thinkingLevel:'LOW'});
  assert.equal(address,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');assert.equal(headers!.get('x-goog-api-key'),'test-gemini');
  assert.deepEqual(request.contents,[{role:'user',parts:[{text:'Current frame'}]}]);assert.deepEqual(request.generationConfig.thinkingConfig,{thinkingLevel:'LOW'});
  assert.deepEqual(result,{value,model:'gemini-3.8-flash',usage:{totalTokenCount:9}});
});
