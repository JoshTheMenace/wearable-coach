import { randomUUID } from 'node:crypto';
import type { Hud, LessonState } from '../../contracts/index.ts';

export type LessonAction = 'continue' | 'pause' | 'resume' | 'finish_practice' | 'restart';
export type LessonObservation = NonNullable<LessonState['lastObservation']>;
export const LESSON_CONFIDENCE = 0.85;
export const LESSON_OBSERVATION_MAX_AGE_MS = 5000;
const correction = 'Your hands appear too low. Move the heel of your lower hand up onto the lower half of the sternum.';

export function createLesson(_now = Date.now()): LessonState {
  return { id: randomUUID(), lessonId: 'adult-cpr-demo-v1', revision: 1, phase: 'intro', status: 'active',
    attemptId: randomUUID(), completed: [], observationSeq: 0, correctStreak: 0 };
}

function complete(lesson: LessonState, step: LessonState['completed'][number]['step'],
  evidence: LessonState['completed'][number]['evidence'], at: number) {
  if (!lesson.completed.some(item => item.step === step)) lesson.completed.push({ step, evidence, at });
}

export function lessonAction(current: LessonState, action: LessonAction, now = Date.now()): LessonState {
  if (action === 'restart') return { ...createLesson(now), id: current.id, revision: current.revision + 1 };
  const lesson = structuredClone(current);
  if (action === 'pause') {
    if (lesson.status === 'paused' || lesson.phase === 'complete') return lesson;
    lesson.status = 'paused'; lesson.correctStreak = 0;
  } else if (action === 'resume') {
    if (lesson.status === 'active') return lesson;
    lesson.status = 'active'; lesson.correctStreak = 0;
  } else {
    if (lesson.status !== 'active') throw new Error('Resume the lesson before continuing.');
    if (action === 'continue' && lesson.phase === 'intro') {
      complete(lesson, 'intro', 'learner_confirmed', now); lesson.phase = 'demonstration';
    } else if (action === 'continue' && lesson.phase === 'demonstration') {
      complete(lesson, 'demonstration', 'learner_confirmed', now); lesson.phase = 'placement';
    } else if (action === 'continue' && lesson.phase === 'placement') {
      complete(lesson, 'placement', 'learner_confirmed', now); lesson.phase = 'practice'; lesson.correctStreak = 0;
    } else if (action === 'finish_practice' && lesson.phase === 'practice') {
      complete(lesson, 'practice', 'learner_confirmed', now); lesson.phase = 'complete';
    } else throw new Error('That action is not available in the current lesson step.');
  }
  lesson.revision++;
  delete lesson.feedback;
  return lesson;
}

export function lessonVideoEnded(current: LessonState, key: string, ended: boolean, now = Date.now()): LessonState {
  if (!ended || key !== 'overview' || current.phase !== 'demonstration' || current.status !== 'active') return current;
  const lesson = structuredClone(current);
  complete(lesson, 'demonstration', 'video_ended', now);
  lesson.phase = 'placement'; lesson.revision++; lesson.correctStreak = 0;
  return lesson;
}

export function applyLessonObservation(current: LessonState, observation: LessonObservation, now = Date.now()): {
  lesson: LessonState; accepted: boolean; advanced: boolean; feedback?: string;
} {
  const ignored = { lesson: current, accepted: false, advanced: false };
  if (current.status !== 'active' || !['placement', 'practice'].includes(current.phase) ||
      !Number.isFinite(observation.at) || observation.at > now || now - observation.at > LESSON_OBSERVATION_MAX_AGE_MS ||
      observation.at <= (current.lastObservation?.at ?? -Infinity)) return ignored;
  const lesson = structuredClone(current), previous = current.lastObservation;
  const confident = Number.isFinite(observation.confidence) && observation.confidence >= LESSON_CONFIDENCE && observation.confidence <= 1;
  const placement = confident && observation.landmarksVisible && observation.manikinVisible ? observation.placement : 'unknown';
  lesson.lastObservation = { ...observation, placement,
    confidence: Number.isFinite(observation.confidence) && observation.confidence >= 0 && observation.confidence <= 1 ? observation.confidence : 0 };
  lesson.observationSeq++;
  lesson.correctStreak = placement === 'correct'
    ? (previous?.placement === 'correct' && previous.cameraSource === observation.cameraSource &&
        observation.at - previous.at <= LESSON_OBSERVATION_MAX_AGE_MS ? current.correctStreak : 0) + 1 : 0;
  let feedback: string | undefined;
  if (placement === 'too_low') {
    lesson.feedback = correction;
    if (lesson.lastCorrectionAt === undefined || now - lesson.lastCorrectionAt >= 10_000) {
      feedback = correction; lesson.lastCorrectionAt = now;
    }
  } else if (placement === 'unknown') lesson.feedback = 'I need a clear view of the manikin chest and both hands before checking placement.';
  else delete lesson.feedback;
  const advanced = lesson.phase === 'placement' && lesson.correctStreak >= 2;
  if (advanced) {
    complete(lesson, 'placement', /recorded|simulat|mock/.test(observation.cameraSource) ? 'simulated_observation' : 'visual_observation', observation.at);
    lesson.phase = 'practice'; lesson.revision++;
  }
  return { lesson, accepted: true, advanced, ...(feedback && { feedback }) };
}

export function lessonHud(lesson: LessonState): Hud {
  const content = {
    intro: ['CPR PRACTICE', 'Read the CPR reference.'],
    demonstration: ['WATCH THE DEMO', 'Watch, then try placement.'],
    placement: ['HAND PLACEMENT', 'Show chest and both hands.'],
    practice: ['LIVE PRACTICE', 'Practice; say when done.'],
    complete: ['PRACTICE COMPLETE', 'Depth/rate not assessed.'],
  } as const;
  const [title, body] = content[lesson.phase], start = Math.min(Object.keys(content).indexOf(lesson.phase), 2);
  const observerHint = ['placement', 'practice'].includes(lesson.phase) && (lesson.observerStatus === 'waiting_for_camera'
    ? 'Show chest and both hands.' : lesson.observerStatus === 'unavailable' ? 'Camera check unavailable.' : undefined);
  return { card: { title: lesson.status === 'paused' ? 'PRACTICE PAUSED' : title,
    body: lesson.status === 'paused' ? 'Resume when you are ready.' : observerHint || (lesson.feedback
      ? lesson.lastObservation?.placement === 'too_low' ? 'Move up to lower sternum.' : 'Show chest and both hands.' : body) },
    checklist: ([['intro', 'Read the reference'], ['demonstration', 'Watch the overview'], ['placement', 'Position your hands'], ['practice', 'Complete your practice']] as const)
      .slice(start, start + 2).map(([id, text]) => ({ id, text, checked: lesson.completed.some(item => item.step === id) })) };
}
