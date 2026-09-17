import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hudSchema, type LessonState } from '../../contracts/index.ts';
import { applyLessonObservation, createLesson, lessonAction, lessonHud, lessonVideoStarted, lessonVideoEnded, type LessonObservation } from '../src/lesson.ts';
import { lessonPresentation, lessonTeachingPages, teachingPageOrder, placementCorrection, offTargetCorrection } from '../src/lesson-content.ts';
import { createKnowledgeBase } from '../src/knowledge.ts';
import { observeLessonFrame } from '../src/lesson-observer.ts';

const placement=(ready=true)=>{
  const waiting=lessonVideoEnded(lessonVideoStarted(createLesson(1000),'overview',2000),'overview',true,3000);
  return ready?lessonAction(waiting,'ready',3500):waiting;
};
const observation=(at:number,overrides:Partial<LessonObservation>={}):LessonObservation=>({placement:'correct',confidence:0.95,reason:'Heel is visible on the target area.',landmarksVisible:true,manikinVisible:true,at,cameraSource:'meta_glasses',...overrides});
const checked=()=>applyLessonObservation(applyLessonObservation(placement(),observation(4000),4000).lesson,observation(5000),5000).lesson;
const confirmedNegative=(lesson:LessonState,at:number,overrides:Partial<LessonObservation>={})=>{
  const first=applyLessonObservation(lesson,observation(at-500,{placement:'too_low',...overrides}),at-500);
  return applyLessonObservation(first.lesson,observation(at,{placement:'too_low',...overrides}),at);
};

test('one false negative pauses verification without directional advice and two positives clear the recheck',()=>{
  const first=applyLessonObservation(checked(),observation(6000,{placement:'off_target',reason:'Possibly too high.'}),6000);
  assert.equal(first.accepted,true);assert.equal(first.lesson.needsPlacementCheck,true);
  assert.equal(first.lesson.lastObservation!.placement,'off_target');assert.equal(first.lesson.lastObservation!.reason,'Possibly too high.');
  assert.equal(first.feedback,undefined);assert.equal(first.lesson.feedback,undefined);assert.equal(first.lesson.pendingCorrection,undefined);
  assert.equal(lessonHud(first.lesson).lessonPage!.id,'cpr-placement-check');
  const one=applyLessonObservation(first.lesson,observation(7000),7000),two=applyLessonObservation(one.lesson,observation(8000),8000);
  assert.equal(one.feedback,undefined);assert.equal(one.lesson.needsPlacementCheck,true);
  assert.equal(two.lesson.needsPlacementCheck,false);assert.equal(two.lesson.placementAdjustments,undefined);
});

test('two matching negatives produce one correction and one contradictory frame cannot change its direction',()=>{
  const low=confirmedNegative(checked(),6000);
  assert.match(low.feedback!,/Move.*up/);assert.equal(low.lesson.pendingCorrection!.kind,'too_low');
  const repeat=applyLessonObservation(low.lesson,observation(7000,{placement:'too_low'}),7000);
  assert.equal(repeat.feedback,undefined);assert.equal(lessonHud(repeat.lesson).lessonPage!.id,'cpr-correction');
  const firstHigh=applyLessonObservation(repeat.lesson,observation(8000,{placement:'off_target'}),8000);
  assert.equal(firstHigh.feedback,undefined);assert.equal(firstHigh.lesson.pendingCorrection!.kind,'too_low');
  assert.equal(lessonHud(firstHigh.lesson).lessonPage!.id,'cpr-placement-check');
  const secondHigh=applyLessonObservation(firstHigh.lesson,observation(9000,{placement:'off_target'}),9000);
  assert.ok(secondHigh.feedback);assert.equal(secondHigh.lesson.pendingCorrection!.kind,'off_target');
  assert.equal(secondHigh.lesson.pendingCorrection!.at,low.lesson.pendingCorrection!.at);
  assert.equal(lessonHud(secondHigh.lesson).lessonPage!.id,'cpr-off-target');
});

test('negative confirmation requires adjacent same-source frames within five seconds',()=>{
  const first=applyLessonObservation(checked(),observation(6000,{placement:'too_low'}),6000).lesson;
  const source=applyLessonObservation(first,observation(7000,{placement:'too_low',cameraSource:'recorded_video'}),7000);
  const gap=applyLessonObservation(first,observation(11001,{placement:'too_low'}),11001);
  const unknown=applyLessonObservation(first,observation(6500,{placement:'unknown'}),6500).lesson;
  const interrupted=applyLessonObservation(unknown,observation(7000,{placement:'too_low'}),7000);
  const reset=applyLessonObservation({...first,lastObservation:undefined},observation(7000,{placement:'too_low'}),7000);
  for(const result of [source,gap,interrupted,reset]){
    assert.equal(result.feedback,undefined);assert.equal(result.lesson.pendingCorrection,undefined);
    assert.equal(result.lesson.needsPlacementCheck,true);assert.equal(lessonHud(result.lesson).lessonPage!.id,'cpr-placement-check');
  }
  assert.ok(applyLessonObservation(first,observation(11000,{placement:'too_low'}),11000).feedback);
});

test('authored teaching navigation is learner paced, repeat holds content, and early video records unvisited pages',()=>{
  const opening=createLesson(1000),before=structuredClone(opening);
  assert.equal(lessonHud({...opening,teachingPage:undefined}).lessonPage!.id,'cpr-opening');
  const hands=lessonAction(opening,'next',2000),pattern=lessonAction(hands,'continue',3000);
  assert.deepEqual(opening,before);assert.equal(hands.teachingPage,'hand-placement');assert.equal(pattern.teachingPage,'compression-pattern');
  assert.deepEqual(pattern.completed,[]);assert.deepEqual(pattern.visitedTeachingPages,[...teachingPageOrder]);
  assert.equal(lessonAction(pattern,'back').teachingPage,'hand-placement');
  const repeat=lessonAction(pattern,'repeat');assert.equal(repeat.teachingPage,pattern.teachingPage);assert.equal(repeat.revision,pattern.revision+1);
  assert.throws(()=>lessonAction(pattern,'next'),/overview video/);
  const early=lessonVideoStarted(opening,'overview',4000);
  assert.deepEqual(early.skippedTeachingPages,['hand-placement','compression-pattern']);assert.equal(early.phase,'demonstration');
  assert.deepEqual(lessonVideoStarted(pattern,'overview').skippedTeachingPages,[]);
  assert.equal(lessonHud(early).lessonPage!.template,'show');
});

test('overview completion waits for Ready and then two fresh supported observations',()=>{
  const waiting=placement(false),before=structuredClone(waiting);
  assert.equal(waiting.completed.at(-1)!.evidence,'video_ended');assert.equal(waiting.ready,false);
  assert.equal(applyLessonObservation(waiting,observation(4000),4000).accepted,false);
  assert.match(lessonHud(waiting).lessonPage!.hint,/Ready/);
  const ready=lessonAction(waiting,'ready',4500);
  assert.deepEqual(waiting,before);assert.equal(ready.phase,'placement');assert.equal(ready.ready,true);
  assert.equal(applyLessonObservation(ready,observation(4400),4500).accepted,false);
  assert.equal(applyLessonObservation(ready,observation(4500),4500).accepted,false);
  const one=applyLessonObservation(ready,observation(5000),5000),two=applyLessonObservation(one.lesson,observation(6000),6000);
  assert.equal(one.advanced,false);assert.equal(two.advanced,true);assert.equal(two.lesson.phase,'practice');
  assert.equal(two.lesson.completed.at(-1)!.evidence,'visual_observation');
  assert.equal(two.lesson.needsPlacementCheck,false);
  assert.throws(()=>lessonAction(two.lesson,'next'),/not available/);
  const done=lessonAction(two.lesson,'finish_practice',7000);
  assert.equal(done.completed.at(-1)!.evidence,'learner_confirmed');assert.equal(done.phase,'complete');
  assert.equal(applyLessonObservation(done,observation(8000),8000).accepted,false);
});

test('a hand-placement reminder during teaching returns to the same page without completing the introduction',()=>{
  const page=lessonAction(createLesson(),'next'),video=lessonVideoStarted(page,'hand-placement',2000);
  assert.equal(video.phase,'intro');assert.equal(video.teachingPage,'hand-placement');assert.deepEqual(video.completed,[]);
  assert.equal(video.skippedTeachingPages,undefined);assert.equal(lessonHud(video).lessonPage!.template,'show');
  const ended=lessonVideoEnded(video,'hand-placement',true,7000);
  assert.equal(ended.phase,'intro');assert.equal(ended.teachingPage,'hand-placement');assert.deepEqual(ended.completed,[]);
  assert.equal(lessonHud(ended).lessonPage!.template,'teach');
});

test('explicit skips apply to only their named step and never fabricate observed performance',()=>{
  const demonstration=lessonVideoStarted(createLesson(),'overview');
  const stopped=lessonVideoEnded(demonstration,'overview',false);
  assert.equal(stopped.phase,'demonstration');assert.ok(!stopped.completed.some(item=>item.step==='demonstration'));
  const hands=lessonAction(stopped,'skip_demo');
  assert.equal(hands.phase,'placement');assert.equal(hands.ready,false);assert.equal(hands.completed.at(-1)!.evidence,'learner_confirmed');
  for(const action of ['next','continue','skip_demo'] as const)assert.throws(()=>lessonAction(hands,action),/not available/);
  const practice=lessonAction(hands,'skip_placement');
  assert.equal(practice.phase,'practice');assert.equal(practice.ready,true);assert.equal(practice.completed.at(-1)!.evidence,'learner_confirmed');
  assert.equal(practice.placementEvidence,undefined);assert.match(lessonHud(practice).lessonPage!.support!.body,/not verified/);
  const done=lessonAction(practice,'finish_practice');assert.match(lessonHud(done).lessonPage!.body,/Demonstration skipped.*Placement not verified/);
});

test('explicit unverified practice remains on the practice page during camera waiting or failure',()=>{
  const practice=lessonAction(placement(),'skip_placement',4000);
  const unclear=applyLessonObservation(practice,observation(5000,{placement:'unknown'}),5000);
  assert.equal(unclear.feedback,undefined);assert.equal(lessonHud(unclear.lesson).lessonPage!.id,'cpr-practice');
  for(const observerStatus of ['waiting_for_camera','unavailable'] as const){
    const content=lessonPresentation({...practice,observerStatus});
    assert.equal(content.page.id,'cpr-practice');assert.match(content.page.support!.body,/Placement not verified/);
    assert.doesNotMatch(content.spoken,/before checking placement|clear view/);
    const required=lessonPresentation({...practice,observerStatus,needsPlacementCheck:true});
    assert.equal(required.page.id,observerStatus==='waiting_for_camera'?'cpr-camera-starting':'cpr-placement-check');
    assert.doesNotMatch(required.spoken,/clear view|move.*up/i);
    const correction=lessonPresentation({...practice,observerStatus,pendingCorrection:{at:5000,cameraSource:'meta_display'},lastObservation:observation(5000,{placement:'too_low'})});
    assert.equal(correction.page.id,required.page.id);
    assert.doesNotMatch(correction.spoken,/move.*up/i);
  }
});

test('occlusion, low confidence, missing manikin and camera source changes break verification streaks',()=>{
  for(const uncertainty of [{landmarksVisible:false},{manikinVisible:false},{confidence:0.84},{confidence:NaN},{confidence:1.01}]){
    const first=applyLessonObservation(placement(),observation(4000),4000).lesson;
    const unclear=applyLessonObservation(first,observation(5000,uncertainty),5000);
    assert.equal(unclear.lesson.lastObservation!.placement,'unknown');assert.equal(unclear.lesson.correctStreak,0);
    assert.equal(applyLessonObservation(unclear.lesson,observation(6000),6000).advanced,false);
  }
  const first=applyLessonObservation(placement(),observation(4000),4000).lesson;
  const changed=applyLessonObservation(first,observation(5000,{cameraSource:'recorded_video'}),5000);
  assert.equal(changed.advanced,false);
  const second=applyLessonObservation(changed.lesson,observation(6000,{cameraSource:'recorded_video'}),6000);
  assert.equal(second.lesson.completed.at(-1)!.evidence,'simulated_observation');
});

test('stale, future and duplicate observations are ignored and large gaps restart the streak',()=>{
  const lesson=applyLessonObservation(placement(),observation(4000),4000).lesson;
  for(const [at,now] of [[3999,5000],[4000,5000],[6000,5000],[5000,10001]]){
    const result=applyLessonObservation(lesson,observation(at),now);assert.equal(result.accepted,false);assert.equal(result.lesson,lesson);
  }
  const afterGap=applyLessonObservation(lesson,observation(10000),10000);assert.equal(afterGap.advanced,false);assert.equal(afterGap.lesson.correctStreak,1);
});

test('occluded views replace directional advice once while preserving unresolved correction evidence',()=>{
  const first=applyLessonObservation(placement(),observation(4000,{placement:'unknown',landmarksVisible:false}),4000);
  assert.match(first.feedback!,/Tilt your view/);
  assert.equal(applyLessonObservation(first.lesson,observation(5000,{placement:'unknown',landmarksVisible:false}),5000).feedback,undefined);
  const low=confirmedNegative(first.lesson,6000);
  const obscured=applyLessonObservation(low.lesson,observation(7000,{placement:'unknown',landmarksVisible:false}),7000);
  assert.match(obscured.feedback!,/Tilt your view/);assert.doesNotMatch(obscured.lesson.feedback!,/Move.*up/);
  assert.deepEqual(obscured.lesson.pendingCorrection,low.lesson.pendingCorrection);
  assert.equal(lessonHud(obscured.lesson).lessonPage!.id,'cpr-camera-check');
  assert.doesNotMatch(lessonHud(obscured.lesson).card!.body,/Move.*up/);
  assert.equal(applyLessonObservation(obscured.lesson,observation(8000,{placement:'unknown',landmarksVisible:false}),8000).feedback,undefined);
});

test('unknown with visible landmarks asks for another check without falsely claiming the scene is hidden',()=>{
  const initial=applyLessonObservation(placement(),observation(4000,{placement:'unknown'}),4000);
  assert.equal(initial.feedback,'Let me check that position.');
  assert.equal(lessonHud(initial.lesson).lessonPage!.id,'cpr-position-check');
  assert.doesNotMatch(lessonPresentation(initial.lesson).spoken,/view|see|look|tilt/i);
  assert.equal(applyLessonObservation(initial.lesson,observation(5000,{placement:'unknown'}),5000).feedback,undefined);
  const noManikin=applyLessonObservation(initial.lesson,observation(5000,{placement:'unknown',manikinVisible:false}),5000);
  assert.match(noManikin.feedback!,/Look down/);
  const occluded=applyLessonObservation(noManikin.lesson,observation(6000,{placement:'unknown',landmarksVisible:false}),6000);
  assert.match(occluded.feedback!,/Tilt your view/);
  const visible=applyLessonObservation(occluded.lesson,observation(7000,{placement:'correct',confidence:0.8}),7000);
  assert.equal(visible.lesson.lastObservation!.placement,'unknown');assert.equal(visible.feedback,'Let me check that position.');
  assert.equal(visible.lesson.correctStreak,0);assert.equal(visible.advanced,false);
});

test('off-target guidance uses no inferred direction and preserves the original correction through type changes',()=>{
  const low=confirmedNegative(checked(),6000).lesson;
  const legacy={...low,pendingCorrection:{at:6000,cameraSource:'meta_glasses'}};
  assert.equal(applyLessonObservation(legacy,observation(7000,{placement:'too_low'}),7000).feedback,undefined);
  const target=confirmedNegative(legacy,7000,{placement:'off_target'});
  assert.match(target.feedback!,/lower half of the breastbone/);assert.doesNotMatch(target.feedback!,/\b(up|down|high|low|left|right)\b/);
  assert.equal(target.lesson.pendingCorrection!.kind,'off_target');assert.equal(target.lesson.pendingCorrection!.at,6000);
  assert.equal(target.lesson.needsPlacementCheck,true);assert.equal(lessonHud(target.lesson).lessonPage!.id,'cpr-off-target');
  assert.equal(applyLessonObservation(target.lesson,observation(8000,{placement:'off_target'}),8000).feedback,undefined);
  const one=applyLessonObservation(target.lesson,observation(8000),8000);
  assert.equal(one.lesson.needsPlacementCheck,true);assert.equal(one.lesson.placementAdjustments,undefined);
  const two=applyLessonObservation(one.lesson,observation(9000),9000);
  assert.equal(two.lesson.needsPlacementCheck,false);assert.equal(two.lesson.pendingCorrection,undefined);
  assert.deepEqual(two.lesson.placementAdjustments,[{detectedAt:6000,correctedAt:9000,cameraSource:'meta_glasses',evidence:'visual_observation'}]);
  const lowAgain=confirmedNegative(target.lesson,8000);
  assert.match(lowAgain.feedback!,/Move.*up/);assert.equal(lowAgain.lesson.pendingCorrection!.at,6000);
  for(const unsupported of [{confidence:0.84},{landmarksVisible:false},{manikinVisible:false}]){
    const result=applyLessonObservation(checked(),observation(6000,{placement:'off_target',...unsupported}),6000);
    assert.equal(result.lesson.lastObservation!.placement,'unknown');assert.equal(result.lesson.pendingCorrection,undefined);
  }
});

test('watching a later full overview replaces skipped viewing evidence without restarting practice',()=>{
  const skipped=lessonAction(lessonAction(lessonVideoEnded(lessonVideoStarted(createLesson(),'overview'),'overview',false),'skip_demo'),'skip_placement');
  const ended=lessonVideoEnded(lessonVideoStarted(skipped,'overview'),'overview',true);
  assert.equal(ended.phase,'practice');assert.equal(ended.completed.find(item=>item.step==='demonstration')!.evidence,'video_ended');
  assert.match(lessonHud(lessonAction(ended,'finish_practice')).lessonPage!.body,/Demonstration watched/);
});

test('directional advice follows the latest evidence while its correction history survives until two supported checks',()=>{
  const initial=confirmedNegative(checked(),6000);
  assert.match(initial.feedback!,/Move.*up/);assert.equal(initial.lesson.phase,'practice');
  let lesson=initial.lesson;
  for(const [at,placement] of [[7000,'unknown'],[20000,'too_low'],[40000,'too_low']] as const){
    const next=applyLessonObservation(lesson,observation(at,{placement}),at);
    if(placement==='unknown'){
      assert.equal(next.feedback,'Let me check that position.');assert.equal(lessonHud(next.lesson).lessonPage!.id,'cpr-position-check');
    }else{
      assert.equal(next.feedback,undefined);assert.equal(next.lesson.feedback,undefined);assert.equal(lessonHud(next.lesson).lessonPage!.id,'cpr-placement-check');
    }
    assert.deepEqual(next.lesson.pendingCorrection,initial.lesson.pendingCorrection);lesson=next.lesson;
  }
  const one=applyLessonObservation(lesson,observation(41000),41000);
  assert.equal(one.lesson.feedback,undefined);assert.equal(one.lesson.placementAdjustments,undefined);
  assert.equal(one.lesson.needsPlacementCheck,true);assert.deepEqual(one.lesson.pendingCorrection,initial.lesson.pendingCorrection);
  assert.equal(lessonHud(one.lesson).lessonPage!.id,'cpr-placement-check');assert.doesNotMatch(lessonPresentation(one.lesson).spoken,/Move.*up/);
  const two=applyLessonObservation(one.lesson,observation(42000),42000);
  assert.equal(two.lesson.feedback,undefined);assert.equal(two.lesson.pendingCorrection,undefined);
  assert.match(two.feedback!,/Good, that’s the right spot/);
  assert.equal(applyLessonObservation(two.lesson,observation(42500),42500).feedback,undefined);
  assert.deepEqual(two.lesson.placementAdjustments,[{detectedAt:6000,correctedAt:42000,cameraSource:'meta_glasses',evidence:'visual_observation'}]);
  assert.ok(confirmedNegative(two.lesson,44000).feedback);
});

test('micro-replay preserves practice and its correction history but requires new observations',()=>{
  const corrected=confirmedNegative(checked(),6000).lesson;
  const replay=lessonVideoStarted(corrected,'hand-placement',7000);
  assert.equal(replay.phase,'practice');assert.equal(replay.ready,true);assert.equal(replay.needsPlacementCheck,true);
  assert.equal(replay.lastObservation,undefined);assert.equal(lessonHud(replay).lessonPage!.id,'cpr-hand-replay');
  assert.equal(applyLessonObservation(replay,observation(7100),7100).accepted,false);
  const ended=lessonVideoEnded(replay,'hand-placement',true,12000);
  assert.equal(ended.phase,'practice');assert.equal(ended.ready,true);assert.equal(lessonHud(ended).lessonPage!.id,'cpr-recheck');
  assert.equal(applyLessonObservation(ended,observation(11000),12000).accepted,false);
  const one=applyLessonObservation(ended,observation(13000),13000);
  assert.equal(one.lesson.needsPlacementCheck,true);assert.equal(one.feedback,undefined);
  const two=applyLessonObservation(one.lesson,observation(14000),14000);
  assert.equal(two.lesson.needsPlacementCheck,false);assert.equal(two.lesson.placementAdjustments!.length,1);
  assert.match(two.feedback!,/Good, that’s the right spot/);
  assert.equal(two.lesson.completed.length,corrected.completed.length);
  const bypass=lessonAction(ended,'skip_placement',13000);
  assert.match(lessonHud(lessonAction(bypass,'finish_practice',14000)).lessonPage!.body,/Placement not verified/);
});

test('pausedClip identifies only an interrupted video and successful playback clears restart intent',()=>{
  const video=lessonVideoStarted(checked(),'hand-placement',6000),paused=lessonAction(video,'pause',6100);
  const stopped=lessonVideoEnded(paused,'hand-placement',false,6200);
  assert.equal(stopped.pausedClip,'hand-placement');assert.equal(stopped.activeClip,undefined);
  const restart=lessonVideoStarted(lessonAction(stopped,'resume',6300),'hand-placement',6400);
  assert.equal(restart.pausedClip,undefined);assert.equal(restart.phase,'practice');
  const ended=lessonVideoEnded(restart,'hand-placement',true,11400);
  assert.equal(ended.pausedClip,undefined);assert.equal(ended.lastClip,'hand-placement');
});

test('pause preserves the correction, fences evidence and restart resets narration and progress',()=>{
  const current=confirmedNegative(checked(),6000).lesson;
  const paused=lessonAction({...current,narratedPages:['cpr-opening']},'pause',7000);
  assert.equal(paused.correctStreak,0);assert.equal(paused.feedback,undefined);assert.deepEqual(paused.pendingCorrection,current.pendingCorrection);
  assert.equal(applyLessonObservation(paused,observation(8000),8000).accepted,false);
  assert.throws(()=>lessonAction(paused,'next'),/Resume/);
  const resumed=lessonAction(paused,'resume',9000);assert.equal(resumed.feedback,undefined);
  assert.deepEqual(resumed.pendingCorrection,current.pendingCorrection);assert.doesNotMatch(lessonPresentation(resumed).spoken,/Move.*up/);
  assert.equal(applyLessonObservation(resumed,observation(8500),9000).accepted,false);
  const restart=lessonAction(resumed,'restart',10000);
  assert.equal(restart.id,current.id);assert.notEqual(restart.attemptId,current.attemptId);assert.deepEqual(restart.narratedPages,[]);
  assert.deepEqual(restart.completed,[]);assert.equal(restart.ready,false);assert.equal(restart.teachingPage,'opening');
});

test('recap reports only recorded viewing, placement, adjustment and learner completion evidence',()=>{
  const normal=lessonAction(checked(),'finish_practice',6000);
  const normalPage=lessonHud(normal).lessonPage!;assert.match(normalPage.body,/Demonstration watched.*visually observed/);assert.doesNotMatch(normalPage.title,/adjusted/);
  const low=confirmedNegative(checked(),6000,{cameraSource:'recorded_video'}).lesson;
  const corrected=applyLessonObservation(applyLessonObservation(low,observation(7000,{cameraSource:'recorded_video'}),7000).lesson,observation(8000,{cameraSource:'recorded_video'}),8000).lesson;
  const done=lessonAction(corrected,'finish_practice',9000),first=lessonHud(done).lessonPage!;
  assert.match(first.body,/adjustment observed in simulation/);assert.match(first.support!.body,/you confirmed/);
  const second=lessonAction(done,'next');assert.match(lessonHud(second).lessonPage!.support!.body,/Depth, force and cadence were not measured/);
  assert.doesNotMatch(lessonPresentation(second).spoken,/measur|certif|competence/i);
  assert.equal(lessonAction(second,'back').recapPage,0);assert.equal(lessonAction(second,'next').revision,second.revision);
  const missing=lessonPresentation({...createLesson(),phase:'complete'});assert.match(missing.page.body,/not recorded.*not verified/);assert.match(missing.page.support!.body,/not confirmed/);
});

test('spoken recap is natural and claims adjustment or completion only when supported',()=>{
  const low=confirmedNegative(checked(),6000).lesson;
  const corrected=applyLessonObservation(applyLessonObservation(low,observation(7000),7000).lesson,observation(8000),8000).lesson;
  assert.equal(lessonPresentation({...corrected,phase:'complete'}).spoken,'You adjusted your hand position.');
  const done=lessonAction(corrected,'finish_practice',9000);
  assert.equal(lessonPresentation(done).spoken,'You adjusted your hand position and completed a short practice round.');
  assert.equal(lessonPresentation({...done,needsPlacementCheck:true}).spoken,'You adjusted your hand position and completed a short practice round. Your hand position still needs another check.');
  const unverified=lessonPresentation({...createLesson(),phase:'complete'});
  assert.equal(unverified.spoken,'Your hand position still needs another check.');
  const skipped=lessonAction(lessonAction(placement(),'skip_placement'),'finish_practice');
  assert.equal(lessonPresentation(skipped).spoken,'You completed a short practice round. Your hand position still needs another check.');
  const simulation=lessonPresentation({...done,placementAdjustments:done.placementAdjustments!.map(adjustment=>({...adjustment,evidence:'simulated_observation'}))});
  assert.match(simulation.spoken,/recorded practice/);assert.doesNotMatch(simulation.spoken,/You adjusted/);
  for(const content of [unverified,simulation,lessonPresentation(done),lessonPresentation(skipped)])assert.doesNotMatch(content.spoken,/visually observed|you confirmed|not recorded|demonstration was/i);
});

test('authored pages have valid source IDs, text-only content, bounded paragraphs and stable schema',()=>{
  const factIds=new Set(createKnowledgeBase().lessonSeed()!.facts.map(fact=>fact.id));
  for(const content of Object.values(lessonTeachingPages)){
    assert.ok(content.sourceFactIds.every(id=>factIds.has(id)),content.sourceFactIds.join(','));
    assert.ok(hudSchema.safeParse({lessonPage:content.page}).success);
    assert.ok([content.page.body,content.page.support?.body].filter(Boolean).join(' ').split(/\s+/).length<=35);
    assert.doesNotMatch(content.spoken,/illustration|diagram|phone|certified/);
  }
  const variants=[createLesson(),...teachingPageOrder.map(teachingPage=>({...createLesson(),teachingPage})),placement(false),placement(),checked(),lessonAction(checked(),'finish_practice'),lessonAction(lessonAction(checked(),'finish_practice'),'next'),lessonAction(checked(),'pause'),lessonVideoStarted(checked(),'hand-placement')];
  for(const lesson of variants){const hud=lessonHud(lesson);assert.ok(hudSchema.safeParse(hud).success,JSON.stringify(hud));assert.ok(hud.card!.body.length<=26);assert.equal(hud.checklist!.length,2);assert.ok(hud.lessonPage!.hint.length<=80);assert.doesNotMatch(lessonPresentation(lesson).spoken,/\bsay\b|end the session|skip the demonstration/i);}
});

test('skills lesson defines the palm contact point, teaches inches and keeps video cues brief',()=>{
  assert.match(lessonTeachingPages.opening.spoken,/basics of adult CPR on your manikin/);
  assert.doesNotMatch(JSON.stringify(lessonTeachingPages.opening),/scenario|AED|emergency|collapse|unresponsive/i);
  assert.match(lessonTeachingPages['hand-placement'].spoken,/firm base of your palm, just above your wrist/);
  assert.doesNotMatch(lessonTeachingPages['hand-placement'].spoken,/video|watch|angle/i);
  const pattern=lessonTeachingPages['compression-pattern'];
  assert.match(pattern.spoken,/at least two inches/);assert.match(pattern.page.body,/2–2.4 inches/);
  assert.doesNotMatch(pattern.spoken,/centimet|measure|force|can.t/i);
  for(const key of ['overview','hand-placement'])assert.equal(lessonPresentation(lessonVideoStarted(createLesson(),key)).spoken,'I’ll pull that up.');
});

test('native layout fixtures match every authored page and conditional recap variant',()=>{
  const base=createLesson(),pages=Object.values(lessonTeachingPages).map(item=>item.page);
  const add=(change:Partial<LessonState>)=>pages.push(lessonPresentation({...base,...change}).page);
  add({status:'paused'});add({phase:'demonstration'});
  for(const activeClip of ['overview','hand-placement'] as const)add({activeClip});
  add({phase:'placement',ready:false});add({phase:'placement',ready:true,observerStatus:'observing'});
  add({phase:'practice',ready:true,needsPlacementCheck:true,lastClip:'hand-placement'});
  add({phase:'practice',ready:true,pendingCorrection:{at:1000,cameraSource:'meta_glasses'},feedback:placementCorrection,observerStatus:'observing',lastObservation:observation(1000,{placement:'too_low'})});
  add({phase:'practice',ready:true,pendingCorrection:{at:1000,cameraSource:'meta_glasses',kind:'off_target'},feedback:offTargetCorrection,observerStatus:'observing',lastObservation:observation(1000,{placement:'off_target'})});
  for(const observerStatus of ['unavailable','waiting_for_camera'] as const)add({phase:'practice',ready:true,needsPlacementCheck:true,observerStatus});
  add({phase:'practice',ready:true,needsPlacementCheck:true,lastObservation:observation(1000,{placement:'unknown'})});
  add({phase:'practice',ready:true,needsPlacementCheck:true,lastObservation:observation(1000,{placement:'unknown',landmarksVisible:false})});
  add({phase:'practice',ready:true,needsPlacementCheck:true,lastObservation:observation(1000,{placement:'unknown',manikinVisible:false})});
  add({phase:'practice',ready:true,observerStatus:'observing'});add({phase:'complete',recapPage:1});add({phase:'complete'});
  for(const evidence of ['visual_observation','simulated_observation'] as const){
    const placementAdjustments=[{detectedAt:1000,correctedAt:2000,cameraSource:'fixture',evidence}];
    add({phase:'complete',placementAdjustments,placementEvidence:{at:2000,cameraSource:'fixture',evidence},completed:[{step:'demonstration',evidence:'video_ended',at:500},{step:'practice',evidence:'learner_confirmed',at:3000}]});
    add({phase:'complete',placementAdjustments,needsPlacementCheck:true});
  }
  const fixtures=JSON.parse(readFileSync(new URL('../../android/app/src/test/resources/cpr-lesson-pages.json',import.meta.url),'utf8'));
  assert.deepEqual(pages,fixtures,'Update the native fixtures and rerun native layout checks after editing lesson copy.');
});

test('structured observer binds exact image and reference, and fails closed on absent landmarks', async t => {
  const previous = process.env.GEMINI_KEY;
  process.env.GEMINI_KEY = 'test-only-gemini';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_KEY; else process.env.GEMINI_KEY = previous; });
  let request: any;
  const run = (value: unknown, signal = new AbortController().signal) => observeLessonFrame(Buffer.from('exact-frame'), 'image/png', 'Quoted fixture hand-placement fact.', signal, {
    fetchImpl: async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { totalTokenCount: 40 } });
    },
  });
  const value = { placement: 'correct', confidence: 0.99, reason: 'Target visible.', landmarksVisible: false, manikinVisible: true };
  const result = await run(value);
  assert.equal(result.placement, 'unknown'); assert.equal(result.usage.totalTokenCount, 40);
  assert.equal(Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64').toString(), 'exact-frame');
  assert.match(request.contents[0].parts[1].text, /Quoted fixture/);
  assert.match(request.systemInstruction.parts[0].text, /never assess compressions on a real person/);
  assert.match(request.systemInstruction.parts[0].text, /Do not estimate compression depth/);
  assert.equal((await run({ ...value, landmarksVisible: true, manikinVisible: false })).placement, 'unknown');
  await assert.rejects(run({ ...value, confidence: 2 }), /invalid structured/);
  await assert.rejects(run({ ...value, reason: 'x'.repeat(241) }), /invalid structured/);
  await assert.rejects(run({ ...value, compressionDepth: 5 }), /invalid structured/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(run(value, cancelled.signal), { name: 'AbortError' });
});


test('scripted rehearsal retains honest internal evidence through replay and uses ordinary learner instructions',()=>{
  assert.equal(createLesson().scriptedStage,undefined);
  const opening=createLesson(1000,'scripted_demo');
  const setup=lessonVideoEnded(lessonVideoStarted(opening,'overview',2000),'overview',true,3000);
  assert.equal(setup.scriptedStage,'awaiting_ready');assert.equal(setup.needsPlacementCheck,false);
  const correction=lessonAction(setup,'ready',4000);
  assert.equal(correction.phase,'placement');assert.equal(correction.scriptedStage,'correction');
  assert.equal(applyLessonObservation(correction,observation(5000),5000).accepted,false);
  assert.equal(correction.lastObservation,undefined);assert.equal(correction.placementEvidence,undefined);assert.equal(correction.observationSeq,0);
  assert.throws(()=>lessonAction(correction,'skip_placement'),/scripted/);
  const replay=lessonVideoEnded(lessonVideoStarted(correction,'hand-placement',6000),'hand-placement',true,7000);
  assert.equal(replay.scriptedStage,'correction');assert.equal(replay.phase,'placement');assert.equal(replay.needsPlacementCheck,false);
  const practice=lessonAction(replay,'ready',8000),complete=lessonAction(practice,'finish_practice',9000);
  assert.equal(practice.phase,'practice');assert.equal(practice.scriptedStage,'practice');
  assert.deepEqual(complete.completed.filter(step=>['placement','practice'].includes(step.step)).map(step=>step.evidence),['scripted_demo','scripted_demo']);
  assert.equal(complete.placementEvidence,undefined);assert.equal(complete.lastObservation,undefined);
  assert.match(lessonPresentation(complete).spoken,/completed a short practice round/);
  for(const state of [opening,setup,correction,replay,practice,complete]){
    const hud=hudSchema.parse(lessonHud(state)),page=hud.lessonPage!;
    assert.doesNotMatch([page.chapter,page.title,page.body,hud.card!.title,hud.card!.body,lessonPresentation(state).spoken].join(' '),/scripted|simulated|visually verified|I (?:see|saw)/i);
  }
  const restarted=lessonAction(complete,'restart',10000);
  assert.equal(restarted.scriptedStage,'awaiting_ready');assert.equal(restarted.phase,'intro');assert.deepEqual(restarted.completed,[]);
});


test('scripted native fixture preserves the ordinary learner pages and replay states',()=>{
  const base=createLesson(1000,'scripted_demo');
  const states:LessonState[]=[...teachingPageOrder.map(teachingPage=>({...base,teachingPage})),
    {...base,status:'paused'},...(['overview','hand-placement'] as const).map(activeClip=>({...base,activeClip})),
    {...base,phase:'demonstration'},...(['awaiting_ready','correction','practice'] as const).map(scriptedStage=>({...base,scriptedStage,phase:scriptedStage==='practice'?'practice' as const:'placement' as const})),
    {...base,phase:'complete',scriptedStage:'practice'}];
  const pages=states.map(state=>lessonHud(state).lessonPage);
  const fixtures=JSON.parse(readFileSync(new URL('../../android/app/src/test/resources/cpr-scripted-pages.json',import.meta.url),'utf8'));
  assert.deepEqual(pages,fixtures,'Refresh the native scripted-page fixtures after editing demo content.');
  assert.ok(pages.every(page=>page&&!/scripted|simulated/i.test(page.chapter+page.title+page.body)));
});


test('inference unavailability retains the receiving-camera placement page',()=>{
  const current=placement();
  const checking=lessonPresentation({...current,observerStatus:'observing'});
  const unavailable={...current,observerStatus:'unavailable' as const};
  assert.deepEqual(lessonPresentation(unavailable).page,checking.page);
  assert.equal(lessonPresentation(unavailable).spoken,checking.spoken);
  assert.doesNotMatch(JSON.stringify(lessonHud(unavailable)),/camera.*(?:unavailable|disconnect|connect|lost)/i);
});


test('compression practice gives the target without claiming continued observation or measurements',()=>{
  const current=checked(),content=lessonPresentation(current);
  assert.equal(content.page.id,'cpr-practice');assert.match(content.page.body,/100–120/);
  assert.doesNotMatch(content.spoken,/watch|observ|measure|depth|force|your rate/i);
  assert.match(content.spoken,/let me know when you’ve finished/i);
});
