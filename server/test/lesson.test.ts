import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hudSchema } from '../../contracts/index.ts';
import { applyLessonObservation, createLesson, lessonAction, lessonHud, lessonVideoEnded, type LessonObservation } from '../src/lesson.ts';
import { observeLessonFrame } from '../src/lesson-observer.ts';

const placement = () => lessonVideoEnded(lessonAction(createLesson(1000), 'continue', 2000), 'overview', true, 3000);
const observation = (at: number, overrides: Partial<LessonObservation> = {}): LessonObservation => ({
  placement: 'correct', confidence: 0.95, reason: 'Heel is visible on the target area.',
  landmarksVisible: true, manikinVisible: true, at, cameraSource: 'meta_glasses', ...overrides,
});

test('lesson sequence persists distinct completion evidence and does not mutate previous snapshots', () => {
  const intro = createLesson(1000), before = structuredClone(intro);
  const demonstration = lessonAction(intro, 'continue', 2000);
  assert.deepEqual(intro, before);
  assert.deepEqual(demonstration.completed, [{ step: 'intro', evidence: 'learner_confirmed', at: 2000 }]);
  assert.equal(demonstration.revision, 2);
  assert.equal(lessonVideoEnded(demonstration, 'hand-placement', true, 3000), demonstration);
  assert.equal(lessonVideoEnded(demonstration, 'overview', false, 3000), demonstration);
  const hands = lessonVideoEnded(demonstration, 'overview', true, 3000);
  assert.equal(hands.phase, 'placement');
  assert.equal(hands.completed[1].evidence, 'video_ended');
  assert.throws(() => lessonAction(hands, 'finish_practice', 4000), /not available/);
  const one = applyLessonObservation(hands, observation(4000), 4000);
  assert.equal(one.lesson.phase, 'placement');
  assert.equal(one.lesson.revision, hands.revision);
  const two = applyLessonObservation(one.lesson, observation(5000), 5000);
  assert.equal(two.advanced, true); assert.equal(two.lesson.phase, 'practice');
  assert.equal(two.lesson.revision, hands.revision + 1);
  assert.deepEqual(two.lesson.completed[2], { step: 'placement', evidence: 'visual_observation', at: 5000 });
  const done = lessonAction(two.lesson, 'finish_practice', 6000);
  assert.equal(done.phase, 'complete');
  assert.deepEqual(done.completed[3], { step: 'practice', evidence: 'learner_confirmed', at: 6000 });
  assert.equal(applyLessonObservation(done, observation(7000), 7000).accepted, false);
  assert.match(lessonHud(done).card!.body, /not assessed/);
});

test('manual demonstration continuation is labeled learner confirmation, never video completion', () => {
  const lesson = lessonAction(lessonAction(createLesson(), 'continue'), 'continue');
  assert.equal(lesson.phase, 'placement');
  assert.equal(lesson.completed[1].evidence, 'learner_confirmed');
  assert.throws(() => lessonAction(lesson, 'finish_practice'), /not available/);
});

test('explicit placement continuation works without camera evidence and remains learner-confirmed', () => {
  for (const observerStatus of ['waiting_for_camera', 'unavailable'] as const) {
    const current = { ...placement(), observerStatus }, before = structuredClone(current);
    const continued = lessonAction(current, 'continue', 4000);
    assert.deepEqual(current, before); assert.equal(continued.phase, 'practice');
    assert.deepEqual(continued.completed.at(-1), { step: 'placement', evidence: 'learner_confirmed', at: 4000 });
    assert.equal(continued.lastObservation, undefined); assert.equal(continued.correctStreak, 0);
    assert.equal(continued.revision, current.revision + 1); assert.equal(continued.observationSeq, 0);
    assert.throws(() => lessonAction({ ...current, status: 'paused' }, 'continue', 4000), /Resume/);
  }
});

test('occlusion, non-manikin scenes, low confidence and source changes break consecutive visual evidence', () => {
  for (const uncertainty of [{ landmarksVisible: false }, { manikinVisible: false }, { confidence: 0.84 }, { confidence: NaN }, { confidence: 1.01 }]) {
    const first = applyLessonObservation(placement(), observation(4000), 4000).lesson;
    const unclear = applyLessonObservation(first, observation(5000, uncertainty), 5000);
    assert.equal(unclear.lesson.lastObservation!.placement, 'unknown');
    assert.equal(unclear.lesson.correctStreak, 0);
    assert.equal(applyLessonObservation(unclear.lesson, observation(6000), 6000).advanced, false);
  }
  const first = applyLessonObservation(placement(), observation(4000), 4000).lesson;
  const changed = applyLessonObservation(first, observation(5000, { cameraSource: 'recorded_video' }), 5000);
  assert.equal(changed.advanced, false);
  const second = applyLessonObservation(changed.lesson, observation(6000, { cameraSource: 'recorded_video' }), 6000);
  assert.equal(second.lesson.completed[2].evidence, 'simulated_observation');
});

test('old, future and duplicate observations are ignored, and large gaps restart the streak', () => {
  const lesson = applyLessonObservation(placement(), observation(4000), 4000).lesson;
  for (const [at, now] of [[3999, 5000], [4000, 5000], [6000, 5000], [5000, 10_001]]) {
    const result = applyLessonObservation(lesson, observation(at), now);
    assert.equal(result.accepted, false); assert.equal(result.lesson, lesson);
  }
  const afterGap = applyLessonObservation(lesson, observation(10_000), 10_000);
  assert.equal(afterGap.advanced, false); assert.equal(afterGap.lesson.correctStreak, 1);
});

test('too-low placement emits one correction per ten seconds and continues during practice', () => {
  let lesson = applyLessonObservation(placement(), observation(4000), 4000).lesson;
  lesson = applyLessonObservation(lesson, observation(5000), 5000).lesson;
  const initial = applyLessonObservation(lesson, observation(6000, { placement: 'too_low' }), 6000);
  assert.match(initial.feedback!, /Move.*up/);
  assert.equal(initial.lesson.phase, 'practice');
  assert.equal(initial.lesson.revision, lesson.revision);
  const repeated = applyLessonObservation(initial.lesson, observation(7000, { placement: 'too_low' }), 7000);
  assert.equal(repeated.feedback, undefined); assert.equal(repeated.lesson.correctStreak, 0);
  const unknown = applyLessonObservation(repeated.lesson, observation(8000, { placement: 'unknown' }), 8000);
  const flicker = applyLessonObservation(unknown.lesson, observation(9000, { placement: 'too_low' }), 9000);
  assert.equal(flicker.feedback, undefined);
  const later = applyLessonObservation(flicker.lesson, observation(16_000, { placement: 'too_low' }), 16_000);
  assert.ok(later.feedback);
  const corrected = applyLessonObservation(later.lesson, observation(17_000), 17_000);
  assert.equal(corrected.lesson.feedback, undefined);
  assert.equal(corrected.lesson.observationSeq, 8);
});

test('pause fences automatic progress and resume requires two new correct observations', () => {
  const first = applyLessonObservation(placement(), observation(4000), 4000).lesson;
  const paused = lessonAction(first, 'pause', 5000);
  assert.equal(paused.correctStreak, 0);
  assert.equal(applyLessonObservation(paused, observation(6000), 6000).accepted, false);
  assert.throws(() => lessonAction(paused, 'continue', 6000), /Resume/);
  assert.deepEqual(lessonAction(paused, 'pause'), paused);
  const resumed = lessonAction(paused, 'resume', 7000);
  assert.equal(applyLessonObservation(resumed, observation(8000), 8000).advanced, false);
  assert.equal(lessonVideoEnded({ ...paused, phase: 'demonstration' }, 'overview', true).phase, 'demonstration');
  const restart = lessonAction(resumed, 'restart', 9000);
  assert.equal(restart.id, resumed.id); assert.notEqual(restart.attemptId, resumed.attemptId);
  assert.equal(restart.phase, 'intro'); assert.deepEqual(restart.completed, []);
  assert.equal(restart.revision, resumed.revision + 1); assert.equal(restart.observationSeq, 0);
});

test('HUD fits four glasses rows including paused and correction states, retaining complete spoken guidance', () => {
  const lesson = placement();
  for (const phase of ['intro', 'demonstration', 'placement', 'practice', 'complete'] as const)
    for (const status of ['active', 'paused'] as const)
      for (const feedback of [undefined, 'too_low', 'unknown'] as const) {
      const hud = lessonHud({ ...lesson, phase, status, feedback,
        ...(feedback && { lastObservation: observation(4000, { placement: feedback }) }) });
      assert.ok(hudSchema.safeParse(hud).success);
      assert.ok(hud.card!.title!.length <= 18); assert.ok(hud.card!.body.length <= 26);
      assert.equal(hud.checklist!.length, 2); assert.ok(hud.checklist!.every(row => row.text.length <= 24));
    }
  const corrected = applyLessonObservation(lesson, observation(4000, { placement: 'too_low' }), 4000);
  assert.equal(corrected.feedback, 'Your hands appear too low. Move the heel of your lower hand up onto the lower half of the sternum.');
  assert.equal(corrected.lesson.feedback, corrected.feedback);
  const hud = lessonHud(JSON.parse(JSON.stringify(lesson)));
  assert.deepEqual(hud.checklist!.map(row => row.checked), [false, false]);
  assert.deepEqual(lessonHud({ ...lesson, phase: 'demonstration' }).checklist!.map(row => row.checked), [true, false]);
});

test('camera waiting and failure HUD messages replace historical placement corrections', () => {
  const corrected = applyLessonObservation(placement(), observation(4000, { placement: 'too_low' }), 4000).lesson;
  for (const phase of ['placement', 'practice'] as const)
    for (const observerStatus of ['waiting_for_camera', 'unavailable'] as const) {
      const lesson = { ...corrected, phase, observerStatus }, body = lessonHud(lesson).card!.body;
      assert.equal(body, observerStatus === 'waiting_for_camera' ? 'Show chest and both hands.' : 'Camera check unavailable.');
      assert.ok(body.length <= 26); assert.doesNotMatch(body, /move|sternum/i);
      assert.equal(lesson.feedback, corrected.feedback);
      assert.equal(lessonHud({ ...lesson, status: 'paused' }).card!.body, 'Resume when you are ready.');
    }
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
