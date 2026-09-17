import type { LessonObservation, LessonPage, LessonState } from '../../contracts/index.ts';

export type LessonPresentation = { page:LessonPage; spoken:string; sourceFactIds:string[] };
export const teachingPageOrder = ['opening','hand-placement','compression-pattern'] as const;
export const lessonTeachingPages:Record<typeof teachingPageOrder[number],LessonPresentation> = {
  opening: {
    page:{id:'cpr-opening',template:'teach',chapter:'ADULT CPR · MANIKIN PRACTICE',title:'Compression skills',
      body:'Hand position. Chest compressions. Letting the chest rise between presses.',support:{body:'Learn the technique, watch a demo, then practise together.'},hint:'Say “Next”'},
    spoken:'We’ll practise the basics of adult CPR on your manikin: hand position, chest compressions, and letting the chest rise between presses. We’ll learn the technique, watch a demonstration, then try it together.',
    sourceFactIds:['hands_only','hand_location','recoil'],
  },
  'hand-placement': {
    page:{id:'cpr-hand-placement',template:'teach',chapter:'LEARN · 1 OF 2',title:'Start with your hands',
      body:'Centre of the chest, on the lower half of the breastbone.',support:{body:'Rest the firm base of your palm, just above the wrist, here. Stack your other hand on top.'},hint:'Say “Next” or “Back”'},
    spoken:'Start with one hand in the centre of the manikin’s chest, on the lower half of the breastbone. Rest the firm base of your palm, just above your wrist, on that spot. Stack your other hand on top.',
    sourceFactIds:['hand_location'],
  },
  'compression-pattern': {
    page:{id:'cpr-compression-pattern',template:'teach',chapter:'LEARN · 2 OF 2',title:'Press, release, repeat',
      body:'100–120/min · Depth: 2–2.4 inches',support:{body:'Press down, then release your weight so the chest can rise fully before the next compression.'},hint:'Say “Show the demo”'},
    spoken:'Keep your shoulders above your hands and your arms straight. Aim for 100 to 120 compressions a minute. Press straight down at least two inches, then let the chest rise fully between presses. Next we’ll watch how those movements fit together.',
    sourceFactIds:['position','depth','rate','recoil'],
  },
};
export const placementCorrection='Pause your practice. Your hands appear too low. Move the heel of your lower hand up onto the lower half of the breastbone.';
export const offTargetCorrection='Pause for a moment. Set the firm base of your lower palm on the lower half of the breastbone, in the centre of the chest.';
export function placementUncertainty(observation:LessonObservation):string {
  return !observation.manikinVisible?'Look down so the manikin’s chest is in view.':!observation.landmarksVisible?'Tilt your view slightly so I can see where your lower palm meets the chest.':'Let me check that position.';
}

function presentation(page:LessonPage,spoken:string,sourceFactIds:string[]=[]):LessonPresentation {return {page,spoken,sourceFactIds};}
export function lessonPresentation(lesson:LessonState):LessonPresentation {
  const practiceHint='Say “Pause” or “Show placement again”';
  if(lesson.status==='paused')return presentation({id:'cpr-paused',template:'practice',chapter:'PRACTICE PAUSED',title:'Take your time',body:'Your place is saved. Questions are welcome.',hint:'Say “Resume”'},'Take your time. Your place is saved.');
  if(lesson.activeClip)return presentation({id:lesson.activeClip==='overview'?'cpr-overview':'cpr-hand-replay',template:'show',chapter:lesson.activeClip==='overview'?'WATCH · DEMONSTRATION':'HAND PLACEMENT · 5-SECOND REPLAY',title:lesson.activeClip==='overview'?'Watch the hand contact point':'Review the contact point',body:'Preparing your video…',hint:'Say “Pause the video”'},'I’ll pull that up.',['hand_location','recoil']);
  if(lesson.scriptedStage&&['placement','practice','complete'].includes(lesson.phase)){
    const page={template:'practice' as const,chapter:'PRACTISE · HAND PLACEMENT',hint:'Say “Ready” to continue'};
    if(lesson.phase==='complete')return presentation({...page,id:'cpr-scripted-recap',template:'recap',chapter:'RECAP · CPR PRACTICE',title:'Practice complete',body:'You completed a short practice round. Review the hand placement whenever you need a reminder.',hint:'Say “End session”'},'You completed a short practice round. You can review the hand placement whenever you need a reminder.');
    if(lesson.phase==='practice')return presentation({...page,id:'cpr-scripted-practice',chapter:'PRACTISE · COMPRESSIONS',title:'Practise the movement',body:'Aim for 100–120 compressions/min.',hint:'Say “I’m done” when finished'},'Good. Now practise for a short round. Let me know when you’ve finished.',['rate']);
    if(lesson.scriptedStage==='correction')return presentation({...page,id:'cpr-scripted-correction',title:'Adjust your hands',body:'Move the firm base of your lower palm up onto the lower half of the breastbone.'},'Pause here. Move the firm base of your lower palm up onto the lower half of the breastbone. Let me know when you’re ready to continue.',['hand_location']);
    return presentation({...page,id:'cpr-scripted-setup',title:'Set your starting position',body:'Place both hands on the manikin’s chest and prepare for a short practice round.'},'Set your hands on the manikin and let me know when you’re ready.',['hand_location']);
  }
  if(lesson.phase==='intro')return structuredClone(lessonTeachingPages[lesson.teachingPage??'opening']);
  if(lesson.phase==='demonstration')return presentation({id:'cpr-overview',template:'show',chapter:'WATCH · DEMONSTRATION',title:'Watch the hand contact point',body:'Watch the overview, then try the starting position.',hint:'Say “Show the demo”'},'The demonstration is available when you’re ready.',['hand_location']);
  if(lesson.phase==='complete'){
    const demonstration=lesson.completed.find(item=>item.step==='demonstration')?.evidence;
    const viewing=demonstration==='video_ended'?'watched':demonstration==='learner_confirmed'?'skipped':'not recorded';
    const placement=lesson.placementEvidence?.evidence??lesson.completed.find(item=>item.step==='placement')?.evidence;
    const adjusted=lesson.placementAdjustments?.at(-1);
    const verified=!lesson.needsPlacementCheck&&!lesson.pendingCorrection&&placement==='visual_observation';
    const simulated=!lesson.needsPlacementCheck&&!lesson.pendingCorrection&&placement==='simulated_observation';
    const placementSummary=lesson.needsPlacementCheck||lesson.pendingCorrection?'Placement recheck pending':verified?'Hand position visually observed':simulated?'Placement observed in simulation':'Placement not verified';
    if(lesson.recapPage===1)return presentation({id:'cpr-recap-2',template:'recap',chapter:'PRACTICE RECAP · 2 OF 2',title:'Keep building the technique',body:'Hand position. Steady presses. Let the chest rise fully.',support:{body:'Depth, force and cadence were not measured.'},hint:'Say “Practise again” or “End session”'},'Keep focusing on hand position, steady presses, and letting the chest rise fully between them.',['hand_location','rate','recoil']);
    const adjustment=adjusted?`Hand adjustment ${adjusted.evidence==='simulated_observation'?'observed in simulation':'visually observed'}`:placementSummary;
    const finished=lesson.completed.some(item=>item.step==='practice'&&item.evidence==='learner_confirmed');
    const summary=adjusted?.evidence==='visual_observation'?`You adjusted your hand position${finished?' and completed a short practice round':''}.`:
      adjusted?'The recorded practice showed an adjustment to the hand position.':verified?`Your hand position looked on target${finished?', and you completed a short practice round':''}.`:
      simulated?'The hand position in the recorded practice looked on target.':finished?'You completed a short practice round.':'';
    const spoken=[summary,!verified&&!simulated?'Your hand position still needs another check.':''].filter(Boolean).join(' ');
    return presentation({id:'cpr-recap-1',template:'recap',chapter:'PRACTICE RECAP · 1 OF 2',title:adjusted?'You adjusted and tried again':'Your practice record',body:`Demonstration ${viewing}. ${adjustment}.`,support:{body:`${finished?'Practice finished · you confirmed':'Practice completion not confirmed'}${adjusted&&(!verified&&!simulated)?`. ${placementSummary}.`:'.'}`},hint:'Say “Next”'},spoken);
  }
  if(!lesson.ready)return presentation({id:'cpr-placement',template:'practice',chapter:'PRACTISE · STARTING POSITION',title:'Show your starting position',body:'Place both hands on the manikin. Hold before beginning compressions.',hint:'Say “Ready”'},'Your turn. Set your hands on the manikin and hold there. Let me know when you’re ready.',['hand_location']);
  const checking=lesson.phase==='placement'||lesson.needsPlacementCheck||lesson.pendingCorrection;
  if(checking&&lesson.observerStatus==='waiting_for_camera')return presentation({id:'cpr-camera-starting',template:'practice',chapter:'PRACTISE · CAMERA CONNECTING',title:'Connecting the camera',body:'Keep your position. The camera will reconnect automatically.',hint:practiceHint},'The camera is connecting. Keep your position; I’ll check once the video arrives.');
  if(checking&&lesson.observerStatus==='unavailable')return presentation({id:'cpr-placement-check',template:'practice',chapter:'PRACTISE · PLACEMENT CHECK',title:'Hold your starting position',body:'I’m checking the hand contact point before practice.',hint:practiceHint},'Hold your hands in place while I check the contact point.');
  if(lesson.needsPlacementCheck&&lesson.lastClip==='hand-placement'&&!lesson.lastObservation)return presentation({id:'cpr-recheck',template:'practice',chapter:'PRACTISE · RECHECK',title:'Set your hands again',body:'Hold your starting position while I check a fresh view.',hint:practiceHint},'Now set your hands on the manikin again. I’ll check the position before you continue.',['hand_location']);
  if(lesson.feedback&&lesson.pendingCorrection&&lesson.lastObservation?.placement==='too_low')return presentation({id:'cpr-correction',template:'practice',chapter:'PRACTISE · HAND POSITION',title:'Move your hands up',body:'Move the lower hand’s heel onto the lower half of the breastbone.',support:{body:'Hold there for a clear placement check.'},hint:practiceHint},placementCorrection,['hand_location']);
  if(lesson.feedback&&lesson.pendingCorrection&&lesson.lastObservation?.placement==='off_target')return presentation({id:'cpr-off-target',template:'practice',chapter:'PRACTISE · HAND POSITION',title:'Find the hand position',body:'Set the base of your lower palm on the lower half of the breastbone.',support:{body:'Hold there while I check again.'},hint:practiceHint},offTargetCorrection,['hand_location']);
  if(checking&&lesson.lastObservation?.placement==='unknown'){
    const observation=lesson.lastObservation,visible=observation.manikinVisible&&observation.landmarksVisible;
    return presentation({id:visible?'cpr-position-check':'cpr-camera-check',template:'practice',chapter:'PRACTISE · PLACEMENT CHECK',title:visible?'Checking your position':'Show the hand contact point',body:visible?'Hold your hands still for another check.':observation.manikinVisible?'Tilt your view slightly to show where your lower palm meets the chest.':'Look down so the manikin’s chest is in view.',hint:practiceHint},placementUncertainty(observation));
  }
  if(checking)return presentation({id:'cpr-placement-check',template:'practice',chapter:'PRACTISE · PLACEMENT CHECK',title:'Hold your starting position',body:'I’m checking the hand contact point before practice.',hint:practiceHint},'Hold your hands in place while I check the contact point.',['hand_location']);
  return presentation({id:'cpr-practice',template:'practice',chapter:'PRACTISE · COMPRESSIONS',title:'Practise the compression pattern',body:'Aim for 100–120 compressions/min.',support:{body:lesson.completed.find(item=>item.step==='placement')?.evidence==='learner_confirmed'&&!lesson.placementEvidence?'Placement not verified.':'This is a target, not a measured rate.'},hint:practiceHint},'Practise for a short round. Let me know when you’ve finished.',['rate']);
}
