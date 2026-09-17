import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlacementReferences, observeLessonFrame } from '../src/lesson-observer.ts';

const jpeg=Buffer.from('ffd8ffe000024546ffd9','hex'),low=Buffer.from('ffd8ffe000024748ffd9','hex');
const observation={placement:'correct',confidence:0.95,reason:'The current palm contact is visible on the manikin target.',landmarksVisible:true,manikinVisible:true};

test('reference loader requires a complete bounded JPEG pair and fingerprints its exact bytes',t=>{
  const dir=mkdtempSync(join(tmpdir(),'coach-reference-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  assert.equal(loadPlacementReferences(join(dir,'absent')),undefined);
  assert.throws(()=>loadPlacementReferences(dir));writeFileSync(join(dir,'correct.jpg'),jpeg);
  assert.throws(()=>loadPlacementReferences(dir));writeFileSync(join(dir,'too-low.jpg'),low);
  const references=loadPlacementReferences(dir)!;
  assert.deepEqual(references.map(r=>r.pose),['correct','too_low']);assert.deepEqual(references[0].bytes,jpeg);
  assert.equal(references[0].sha256,createHash('sha256').update(jpeg).digest('hex'));
  for(const invalid of [Buffer.alloc(256*1024+1),Buffer.from('not a jpeg'),jpeg.subarray(0,jpeg.length-2)]){
    writeFileSync(join(dir,'too-low.jpg'),invalid);assert.throws(()=>loadPlacementReferences(dir),/JPEG/);
  }
});

test('reference pose comparison binds each image, limits the schema and maps only supported pose matches',async t=>{
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;});
  const dir=mkdtempSync(join(tmpdir(),'coach-reference-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'correct.jpg'),jpeg);writeFileSync(join(dir,'too-low.jpg'),low);
  const references=loadPlacementReferences(dir),current=Buffer.from('distinct current image bytes');let body:any;
  const comparison={pose:'correct',confidence:0.95,handsVisible:true,manikinVisible:true};
  const run=(patch:Record<string,unknown>={},withReferences=true)=>observeLessonFrame(current,'image/png','Supplied clinical fact.',new AbortController().signal,{
    model:'gpt-5.6-luna',...(withReferences?{references}:{}),fetchImpl:async(_url,init)=>{
      body=JSON.parse(String(init?.body));
      return Response.json({model:'gpt-5.6-luna',service_tier:'priority',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({...(withReferences?comparison:observation),...patch})}]}]});
    },
  });
  const result=await run(),parts=body.input[0].content;
  assert.equal(parts.length,6);assert.match(parts[0].text,/^CORRECT reference/);
  assert.equal(parts[1].image_url,`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.match(parts[2].text,/^INCORRECT reference/);assert.equal(parts[3].image_url,`data:image/jpeg;base64,${low.toString('base64')}`);
  assert.match(parts[4].text,/CURRENT/);assert.equal(parts.at(-1).image_url,`data:image/png;base64,${current.toString('base64')}`);
  assert.deepEqual(body.text.format.schema.properties.pose.enum,['correct','incorrect','unclear']);
  assert.equal(body.text.format.schema.properties.reason,undefined);assert.equal(body.text.format.schema.properties.placement,undefined);assert.equal(body.text.format.schema.additionalProperties,false);
  assert.match(body.instructions,/allowing camera rotation/);assert.match(body.instructions,/cropped fingertips are acceptable/);assert.match(body.instructions,/incorrect only when it clearly matches the INCORRECT example/);
  assert.match(body.instructions,/Missing hands, wrong scenes, obscured contact, or an ambiguous match require unclear/);
  assert.ok(!JSON.stringify(body).includes('Supplied clinical fact'));assert.deepEqual(body.reasoning,{effort:'none'});assert.equal(body.service_tier,'priority');
  assert.equal(result.promptVersion,'manikin-pose-v6-verified');assert.equal(result.serviceTier,'priority');assert.equal(result.referenceEvidence?.provenance,'user_labeled_calibration');
  assert.deepEqual(result.referenceEvidence?.references,references!.map(({pose,sha256})=>({pose,sha256})));
  assert.ok(!JSON.stringify(result).includes(jpeg.toString('base64')));assert.ok(!('pose' in result));assert.ok(!('handsVisible' in result));
  const incorrect=await run({pose:'incorrect'});assert.equal(incorrect.placement,'too_low');assert.match(incorrect.reason,/matches the incorrect reference pose/);
  assert.equal((await run({pose:'unclear'})).placement,'unknown');
  for(const pose of ['correct','incorrect']){
    const absent=await run({pose,handsVisible:false});assert.equal(absent.placement,'unknown');assert.match(absent.reason,/does not support a clear comparison/);assert.ok(!absent.reason.includes('matches'));
    assert.equal((await run({pose,manikinVisible:false})).placement,'unknown');
  }
  await assert.rejects(run({pose:'high'}),/invalid structured result/);
  const noReference=await run({},false);
  assert.equal(noReference.promptVersion,'manikin-placement-v2');assert.equal(noReference.referenceEvidence,undefined);
  assert.equal(body.input[0].content.length,2);assert.equal(body.input[0].content[0].image_url,`data:image/png;base64,${current.toString('base64')}`);
  assert.match(body.input[0].content[1].text,/Supplied clinical fact/);assert.ok(!body.instructions.includes('reference-pose comparison'));
  assert.equal((await run({landmarksVisible:false},false)).placement,'unknown');
});

test('positive placement needs a separate model to agree on the same image within one deadline',async t=>{
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;});
  const run=async(primary:Record<string,unknown>,verifier:Record<string,unknown>|'timeout'|'failure',timeoutMs=1000,delayMs=0)=>{
    const bodies:any[]=[];
    const promise=observeLessonFrame(jpeg,'image/jpeg','Quoted fact.',new AbortController().signal,{
      model:'gpt-5.6-luna',timeoutMs,fetchImpl:async(_url,init)=>{
        const body=JSON.parse(String(init?.body));bodies.push(body);
        if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));
        if(bodies.length===2&&verifier==='failure')return new Response('',{status:503});
        if(bodies.length===2&&verifier==='timeout')await new Promise((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));
        return Response.json({model:body.model,status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({...observation,...(bodies.length===1?primary:typeof verifier==='object'?verifier:{})})}]}]});
      },
    });
    return {result:await promise,bodies};
  };
  const agreed=await run({},{});
  assert.equal(agreed.result.placement,'correct');assert.equal(agreed.bodies.length,2);
  assert.deepEqual(agreed.bodies.map(body=>body.model),['gpt-5.6-luna','gpt-5.6-terra']);
  assert.deepEqual(agreed.bodies[0].input,agreed.bodies[1].input);
  assert.equal(agreed.bodies[0].instructions,agreed.bodies[1].instructions);
  for(const patch of [{placement:'too_low'},{placement:'unknown'},{confidence:0.8},{landmarksVisible:false}]){
    const {result}=await run({},patch);assert.equal(result.placement,'unknown');assert.equal(result.confidence,0);
    assert.equal(result.verification?.model,'gpt-5.6-terra');
  }
  for(const patch of [{placement:'too_low'},{placement:'unknown'},{confidence:0.8}])assert.equal((await run(patch,{})).bodies.length,1);
  await assert.rejects(run({},'failure'),/503/);
  const keepAlive=setTimeout(()=>{},1000);
  try{await assert.rejects(run({},'timeout',30),/timed out|aborted/i);}finally{clearTimeout(keepAlive);}
  await assert.rejects(run({},{},90,60),/timed out|timeout/i);
});
