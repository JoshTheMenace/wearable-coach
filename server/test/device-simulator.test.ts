import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameSampler, hudRows, validateDemo } from '../../web/src/device-simulator.ts';

test('demo dimensions enforce both side and total-pixel limits independently of camera recordings', () => {
  assert.doesNotThrow(() => validateDemo(320, 180, 12, 'video/mp4'));
  assert.throws(() => validateDemo(400, 400, 12, 'video/mp4'), /70,000/);
  assert.throws(() => validateDemo(401, 100, 12, 'video/mp4'), /400/);
  assert.throws(() => validateDemo(320, 180, Infinity, 'video/mp4'), /duration/);
  assert.throws(() => validateDemo(320, 180, 601, 'video/mp4'), /ten minutes/);
  assert.throws(() => validateDemo(320, 180, 12, 'video/webm'), /MP4/);
});

test('sampling has no backlog, duplicate paused frame, or faster-than-one-fps uploads', () => {
  const sampler = new FrameSampler();
  assert.equal(sampler.begin(0, 0, false), null);
  const first = sampler.begin(0, 0, true)!;
  assert.ok(first.current());
  assert.equal(sampler.begin(1, 1200, true), null);
  first.release();
  assert.equal(sampler.begin(0, 1200, true), null);
  sampler.invalidate();
  assert.equal(sampler.begin(1, 500, true), null);
  assert.equal(sampler.begin(1, 1000, true), null);
  assert.ok(sampler.begin(1, 1200, true));
});

test('source/generation invalidation rejects in-flight work and retains the single-operation fence', () => {
  const sampler = new FrameSampler(), old = sampler.begin(4, 1000, true)!;
  sampler.invalidate();
  assert.equal(old.current(), false);
  assert.equal(sampler.begin(0, 3000, true), null);
  old.release();
  const next = sampler.begin(0, 3000, true)!;
  assert.ok(next.current());
  assert.equal(old.current(), false);
});

test('simulated HUD stays within four rows without changing source checklist state', () => {
  const hud = { card: { title: 'CPR PRACTICE', body: 'Practice on your manikin' }, checklist: [{ id: 'one', text: 'Setup confirmed', checked: true }, { id: 'two', text: 'Review feedback', checked: false }] };
  assert.equal(hudRows(hud, 0).length, 4);
  assert.match(hudRows(hud, 0)[2].text, /^✓/);
  const long = hudRows({ card: { body: '🫀'.repeat(160) } }, 0);
  assert.equal(long.length, 4); assert.equal(long[3].text, '… More on phone');
  assert.ok(!long[0].text.includes('\ufffd'));
  assert.equal(hud.checklist[1].checked, false);
});
