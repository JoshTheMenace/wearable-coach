import { randomUUID } from 'node:crypto';
import type { Hud, LessonState, LessonAction as Action } from '../../contracts/index.ts';
import { lessonPresentation, offTargetCorrection, placementCorrection, placementUncertainty, teachingPageOrder } from './lesson-content.ts';

export type LessonAction = Exclude<Action,'start'>;
export type LessonObservation = NonNullable<LessonState['lastObservation']>;
export const LESSON_CONFIDENCE = 0.85;
export const LESSON_OBSERVATION_MAX_AGE_MS = 5000;

export function createLesson(_now = Date.now(),practiceMode:'live'|'scripted_demo'='live'): LessonState {
  return { id:randomUUID(),lessonId:'adult-cpr-demo-v1',revision:1,phase:'intro',status:'active',attemptId:randomUUID(),
    completed:[],observationSeq:0,correctStreak:0,teachingPage:'opening',visitedTeachingPages:['opening'],ready:false,narratedPages:[],...(practiceMode==='scripted_demo'?{scriptedStage:'awaiting_ready' as const}:{}) };
}
function complete(lesson:LessonState,step:LessonState['completed'][number]['step'],evidence:LessonState['completed'][number]['evidence'],at:number) {
  const prior=lesson.completed.find(item=>item.step===step);
  if(!prior)lesson.completed.push({step,evidence,at});
  else if(step==='demonstration'&&evidence==='video_ended')Object.assign(prior,{evidence,at});
}
function freshPlacement(lesson:LessonState,now:number) {
  lesson.correctStreak=0;lesson.observationAfter=now;delete lesson.lastObservation;delete lesson.feedback;
}
export function lessonAction(current:LessonState,action:LessonAction,now=Date.now()):LessonState {
  if(action==='restart')return {...createLesson(now,current.scriptedStage?'scripted_demo':'live'),id:current.id,revision:current.revision+1};
  const lesson=structuredClone(current);
  if(action==='repeat'){lesson.revision++;return lesson;}
  if(action==='pause'){
    if(lesson.status==='paused'||lesson.phase==='complete')return lesson;
    lesson.status='paused';freshPlacement(lesson,now);
  }else if(action==='resume'){
    if(lesson.status==='active')return lesson;
    lesson.status='active';freshPlacement(lesson,now);
  }else{
    if(lesson.status!=='active')throw new Error('Resume the lesson before continuing.');
    if(['next','continue','back'].includes(action)&&lesson.phase==='intro'){
      const index=teachingPageOrder.indexOf(lesson.teachingPage??'opening');
      const next=index+(action==='back'?-1:1);
      if(next<0)return lesson;
      if(next>=teachingPageOrder.length)throw new Error('Request the overview video from the final teaching page.');
      lesson.teachingPage=teachingPageOrder[next];
      lesson.visitedTeachingPages=[...new Set([...(lesson.visitedTeachingPages??['opening']),lesson.teachingPage])];
    }else if(['next','continue','back'].includes(action)&&lesson.phase==='complete'){
      const page=action==='back'?0:1;if((lesson.recapPage??0)===page)return lesson;lesson.recapPage=page;
    }else if(action==='ready'&&lesson.phase==='placement'&&lesson.scriptedStage){
      lesson.ready=true;lesson.needsPlacementCheck=false;
      if(lesson.scriptedStage==='awaiting_ready')lesson.scriptedStage='correction';
      else if(lesson.scriptedStage==='correction'){lesson.scriptedStage='practice';lesson.phase='practice';complete(lesson,'placement','scripted_demo',now);}
    }else if(action==='ready'&&(lesson.phase==='placement'||lesson.phase==='practice'&&lesson.needsPlacementCheck)){
      if(lesson.ready)return lesson;
      lesson.ready=true;lesson.needsPlacementCheck=true;freshPlacement(lesson,now);
    }else if(action==='skip_demo'&&lesson.phase==='demonstration'){
      complete(lesson,'demonstration','learner_confirmed',now);lesson.phase='placement';lesson.ready=false;lesson.needsPlacementCheck=!lesson.scriptedStage;
      delete lesson.activeClip;delete lesson.pausedClip;freshPlacement(lesson,now);
    }else if(action==='skip_placement'&&(lesson.phase==='placement'||lesson.phase==='practice'&&lesson.needsPlacementCheck)){
      if(lesson.scriptedStage)throw new Error('Use Ready to advance the scripted demonstration.');
      complete(lesson,'placement','learner_confirmed',now);lesson.phase='practice';lesson.ready=true;lesson.needsPlacementCheck=false;
      lesson.completed=lesson.completed.map(item=>item.step==='placement'?{...item,evidence:'learner_confirmed',at:now}:item);
      delete lesson.placementEvidence;delete lesson.pendingCorrection;delete lesson.feedback;freshPlacement(lesson,now);
    }else if(action==='finish_practice'&&lesson.phase==='practice'){
      complete(lesson,'practice',lesson.scriptedStage?'scripted_demo':'learner_confirmed',now);lesson.phase='complete';lesson.recapPage=0;
    }else throw new Error('That action is not available in the current lesson step.');
  }
  lesson.revision++;return lesson;
}
export function lessonVideoStarted(current:LessonState,key:string,now=Date.now()):LessonState {
  if(!['overview','hand-placement'].includes(key)||current.status!=='active')return current;
  const lesson=structuredClone(current);
  lesson.activeClip=key as 'overview'|'hand-placement';lesson.lastClip=lesson.activeClip;delete lesson.pausedClip;
  if(key==='overview'&&lesson.phase==='intro'){
    lesson.skippedTeachingPages=teachingPageOrder.filter(page=>!(lesson.visitedTeachingPages??['opening']).includes(page));
    complete(lesson,'intro','learner_confirmed',now);lesson.phase='demonstration';
  }
  if(!lesson.scriptedStage&&['placement','practice'].includes(lesson.phase))lesson.needsPlacementCheck=true;
  freshPlacement(lesson,now);lesson.revision++;return lesson;
}
export function lessonVideoEnded(current:LessonState,key:string,ended:boolean,now=Date.now()):LessonState {
  if(!['overview','hand-placement'].includes(key))return current;
  const overview=ended&&key==='overview'&&current.phase==='demonstration'&&current.status==='active';
  if(!current.activeClip&&!overview)return current;
  const lesson=structuredClone(current);delete lesson.activeClip;freshPlacement(lesson,now);
  if(!ended&&lesson.status==='paused')lesson.pausedClip=key as 'overview'|'hand-placement';else delete lesson.pausedClip;
  if(ended&&key==='overview'&&lesson.status==='active')complete(lesson,'demonstration','video_ended',now);
  if(overview){lesson.phase='placement';lesson.ready=false;lesson.needsPlacementCheck=!lesson.scriptedStage;}
  lesson.revision++;return lesson;
}
export function applyLessonObservation(current:LessonState,observation:LessonObservation,now=Date.now()):{
  lesson:LessonState;accepted:boolean;advanced:boolean;feedback?:string;
} {
  const ignored={lesson:current,accepted:false,advanced:false};
  if(current.scriptedStage||current.status!=='active'||!['placement','practice'].includes(current.phase)||!current.ready||current.activeClip||
    !Number.isFinite(observation.at)||observation.at>now||now-observation.at>LESSON_OBSERVATION_MAX_AGE_MS||
    observation.at<=(current.observationAfter??-Infinity)||observation.at<=(current.lastObservation?.at??-Infinity))return ignored;
  const lesson=structuredClone(current),previous=current.lastObservation;
  const confident=Number.isFinite(observation.confidence)&&observation.confidence>=LESSON_CONFIDENCE&&observation.confidence<=1;
  const placement=confident&&observation.landmarksVisible&&observation.manikinVisible?observation.placement:'unknown';
  const agrees=previous?.placement===placement&&previous.cameraSource===observation.cameraSource&&observation.at-previous.at<=LESSON_OBSERVATION_MAX_AGE_MS;
  lesson.lastObservation={...observation,placement,confidence:Number.isFinite(observation.confidence)&&observation.confidence>=0&&observation.confidence<=1?observation.confidence:0};
  lesson.observationSeq++;
  lesson.correctStreak=placement==='correct'?(agrees?current.correctStreak:0)+1:0;
  let feedback:string|undefined;
  if(placement==='too_low'||placement==='off_target'){
    lesson.needsPlacementCheck=true;
    if(agrees){
      lesson.feedback=placement==='too_low'?placementCorrection:offTargetCorrection;
      const pending=lesson.pendingCorrection;
      if(!pending||pending.cameraSource!==observation.cameraSource||(pending.kind??'too_low')!==placement){
        lesson.pendingCorrection={at:pending?.cameraSource===observation.cameraSource?pending.at:observation.at,cameraSource:observation.cameraSource,kind:placement};feedback=lesson.feedback;lesson.lastCorrectionAt=now;
      }
    }else delete lesson.feedback;
  }else if(lesson.correctStreak>=2){
    const evidence=/recorded|simulat|mock/.test(observation.cameraSource)?'simulated_observation':'visual_observation';
    lesson.placementEvidence={at:observation.at,cameraSource:observation.cameraSource,evidence};
    if(current.phase==='practice'&&(current.needsPlacementCheck||current.pendingCorrection))feedback=current.pendingCorrection?'Your hands now appear on the target area. Try another short practice round.':'Your hands appear on the target area. Continue your practice when ready.';
    if(lesson.pendingCorrection?.cameraSource===observation.cameraSource){
      lesson.placementAdjustments=[...(lesson.placementAdjustments??[]),{detectedAt:lesson.pendingCorrection.at,correctedAt:observation.at,cameraSource:observation.cameraSource,evidence}];
    }
    delete lesson.pendingCorrection;delete lesson.feedback;lesson.needsPlacementCheck=false;
  }else{
    if(placement==='unknown'){
      lesson.feedback=placementUncertainty(observation);
      if(current.feedback!==lesson.feedback&&(current.phase==='placement'||current.needsPlacementCheck))feedback=lesson.feedback;
    }
    else delete lesson.feedback;
  }
  const advanced=lesson.phase==='placement'&&lesson.correctStreak>=2;
  if(advanced){complete(lesson,'placement',lesson.placementEvidence!.evidence,observation.at);lesson.phase='practice';lesson.revision++;}
  return {lesson,accepted:true,advanced,...(feedback&&{feedback})};
}
export function lessonHud(lesson:LessonState):Hud {
  const page=lessonPresentation(lesson).page;
  const content={intro:['CPR ESSENTIALS','Say “Next” to learn.'],demonstration:['WATCH THE DEMO','Say “show the demo”.'],placement:['HAND PLACEMENT',lesson.ready?'Show chest and both hands.':'Say “Ready” to begin.'],practice:['LIVE PRACTICE',lesson.needsPlacementCheck?'Hold for placement check.':'Say “I’m done” to finish.'],complete:['PRACTICE COMPLETE','Review your practice.']} as const;
  const [title,body]=content[lesson.phase],start=Math.min(Object.keys(content).indexOf(lesson.phase),2);
  const camera=['placement','practice'].includes(lesson.phase)&&(lesson.observerStatus==='waiting_for_camera'?'Camera connecting…':lesson.observerStatus==='unavailable'?'Hold your hands in position.':undefined);
  return {lessonPage:page,card:{title:lesson.status==='paused'?'PRACTICE PAUSED':title,body:lesson.status==='paused'?'Say "resume" when ready.':camera||(lesson.feedback&&lesson.pendingCorrection&&lesson.lastObservation?.placement==='too_low'?'Move up to lower sternum.':body)},
    checklist:([['intro','Learn the essentials'],['demonstration','Watch the overview'],['placement','Position your hands'],['practice','Complete your practice']] as const).slice(start,start+2).map(([id,text])=>({id,text,checked:lesson.completed.some(item=>item.step===id)}))};
}
