import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Diagnostics } from '../src/diagnostics.ts';

const report = (overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), deviceInstallId: randomUUID(), runId: randomUUID(), occurredAt: Date.now() - 60000,
  sessionId: null, generation: null, code: 'session.failed', severity: 'error', stage: 'bootstrap',
  recovery: 'retrying', details: { attempt: 2, httpStatus: 503 }, ...overrides,
});

test('offline pre-session reports persist and repeated event IDs do not duplicate evidence', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const diagnostics = new Diagnostics(db), event = report();
  assert.deepEqual(diagnostics.ingest([event]), { accepted: 1, duplicates: 0, dropped: 0 });
  assert.deepEqual(diagnostics.ingest([event]), { accepted: 0, duplicates: 1, dropped: 0 });
  const rows = new Diagnostics(db).list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventId, event.eventId);
  assert.equal(rows[0].sessionId, null);
  assert.equal(rows[0].occurredAt, event.occurredAt);
  assert.ok(Number(rows[0].receivedAt) >= Number(rows[0].occurredAt));
});

test('invalid batches are rejected atomically and credentials/raw content never become diagnostic text', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const diagnostics = new Diagnostics(db);
  assert.throws(() => diagnostics.ingest([report(), report({ details: { transcript: 'private learner words' } })]));
  assert.equal(diagnostics.list().length, 0);
  assert.throws(() => diagnostics.ingest(Array.from({ length: 51 }, () => report())));
  assert.throws(() => diagnostics.ingest([report({ details: { attempt: -1 } })]));
  assert.throws(() => diagnostics.ingest([report({ message: 'x'.repeat(301) })]));
  const key = 'sk-proj-privateCredentialValue123456';
  diagnostics.ingest([report({ message: `Authorization: Bearer ${key}; transcript: private learner words`, details: { model: key } })]);
  const stored = diagnostics.list()[0];
  assert.equal(stored.message, 'The device could not start or continue the session.');
  assert.deepEqual(stored.details, { model: '[redacted]' });
  assert.doesNotMatch(JSON.stringify(stored), /privateCredential|private learner|Authorization|Bearer/);
});

test('retention bounds rows and ages using server receipt time rather than an offline device clock', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let now = 10000;
  const diagnostics = new Diagnostics(db, { now: () => now, retentionMs: 1000, maxRows: 2 });
  const first = report({ occurredAt: 0 }), second = report(), third = report();
  diagnostics.ingest([first, second, third]);
  assert.deepEqual(diagnostics.list().map(row => row.eventId), [third.eventId, second.eventId]);
  now += 1001;
  assert.equal(diagnostics.list().length, 0);
  diagnostics.ingest([report({ occurredAt: 0 })]);
  assert.equal(diagnostics.list().length, 1);
});

test('scoped list, aggregate counts and deletion keep unrelated and pre-session diagnostics separate', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const diagnostics = new Diagnostics(db), sessionA = randomUUID(), sessionB = randomUUID();
  const first = report({ sessionId: sessionA, generation: 1, code: 'session.active', severity: 'info', stage: 'session' });
  diagnostics.ingest([first, report({ sessionId: sessionA, generation: 1, severity: 'warning' }),
    report({ sessionId: sessionB, generation: 2 }), report()]);
  assert.deepEqual(diagnostics.counts({ sessionId: sessionA }), {
    total: 2, bySeverity: { info: 1, warning: 1, error: 0 }, byCode: { 'session.active': 1, 'session.failed': 1 },
  });
  assert.equal(diagnostics.counts().total, 4);
  assert.equal(diagnostics.list({ sessionId: null }).length, 1);
  assert.equal(diagnostics.list({ sessionId: sessionA, limit: 1 }).length, 1);
  assert.throws(() => diagnostics.list({ limit: 1001 }));
  assert.throws(() => diagnostics.list({ sessionId: 'not-a-session' }));
  diagnostics.ingest([{ ...first, severity: 'error', sessionId: sessionB }]);
  assert.equal(diagnostics.counts({ sessionId: sessionA }).bySeverity.info, 1);
  assert.equal(diagnostics.counts({ sessionId: sessionB }).total, 1);
  assert.equal(diagnostics.deleteSession(sessionA), 2);
  assert.equal(diagnostics.counts().total, 2);
  assert.equal(diagnostics.list({ sessionId: sessionB }).length, 1);
});

test('database failures roll back the whole batch instead of leaving a partial device log', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const diagnostics = new Diagnostics(db);
  db.exec("CREATE TRIGGER fail_diagnostic BEFORE INSERT ON device_diagnostics WHEN NEW.code='app.error' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
  assert.throws(() => diagnostics.ingest([report(), report({ code: 'app.error' })]), /fixture write failure/);
  assert.equal(diagnostics.counts().total, 0);
  db.exec('DROP TRIGGER fail_diagnostic');
  assert.equal(diagnostics.ingest([report()]).accepted, 1);
});

test('audio diagnostics retain only bounded structural measurements', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const diagnostics = new Diagnostics(db);
  const details = { provider: 'gemini', model: 'gemini-3.8-live', device: 'phone', appVersion: '1.0', deviceModel: 'Pixel 9 Pro',
    androidApi: 35, inputRate: 16000, outputRate: 24000, queuedBytes: 640, droppedSamples: 0, underruns: 1,
    routeType: 7, durationMs: 500, capturedBytes: 32000, receivedBytes: 48000, writtenSamples: 24000,
    pendingMs: 20, queueHighWaterMs: 80, queueBudgetMs: 250, shortWrites: 2, errorClass: 'java.io.IOException' };
  diagnostics.ingest([report({ code: 'audio.status', stage: 'audio', details })]);
  assert.deepEqual(diagnostics.list()[0].details, details);
  for (const value of [-1, Infinity, NaN, 1e13]) assert.throws(() => diagnostics.ingest([report({ details: { capturedBytes: value } })]));
  assert.throws(() => diagnostics.ingest([report({ details: { authorization: 'Bearer opaque' } })]));
  assert.throws(() => diagnostics.ingest([report({ details: { model: 'https://example.test?key=secret' } })]));
});
