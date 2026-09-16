import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../src/app.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 150; attempt++) { if (check()) return; await pause(10); }
  throw new Error('Expected recovery state was not reached');
}
async function setup(t: TestContext, deviceGraceMs = 100) {
  const directory = mkdtempSync(join(tmpdir(), 'coach-disconnect-'));
  const app = createApp({ dataDir: directory, operatorToken: 'test-grace-operator-token', deviceGraceMs });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await fetch(base + '/api/sessions', { method: 'POST', headers: {
    authorization: `Bearer ${app.operatorToken}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ createKey: randomUUID(), config: { provider: 'mock', model: 'mock-coach', device: 'phone' } }) });
  assert.equal(response.status, 201);
  const session = await response.json() as { sessionId: string; token: string; spectatorToken: string };
  await until(() => app.store.get(session.sessionId)?.status === 'active');
  async function bind(channel = 'control', generation = app.coordinator.get(session.sessionId).generation) {
    const ws = new WebSocket(base.replace('http', 'ws') + `/api/sessions/${session.sessionId}/${channel}`);
    const messages: any[] = [];
    ws.on('message', value => messages.push(JSON.parse(value.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: channel === 'events' ? session.spectatorToken : session.token, generation }));
    await until(() => messages.some(message => message.type === 'snapshot'));
    return { ws, messages };
  }
  return { app, base, session, bind, close };
}

test('a created session that never attaches a device ends after the grace deadline', async t => {
  const { app, session } = await setup(t, 50);
  await until(() => app.store.get(session.sessionId)?.status === 'ended');
  assert.ok(app.store.events(session.sessionId).some(event => event.type === 'device.grace_expired'));
});

test('losing a bound device fences both channels and ends an unrecovered session', async t => {
  const { app, session, bind } = await setup(t);
  const control = await bind(), audio = await bind('audio');
  const audioClosed = once(audio.ws, 'close');
  control.ws.terminate();
  await audioClosed;
  await until(() => app.store.get(session.sessionId)?.status === 'ended');
  assert.equal(app.coordinator.get(session.sessionId).generation, 2);
  assert.ok(app.store.events(session.sessionId).some(event => event.type === 'device.grace_expired'));
});

test('reattaching control within the grace window clears the old orphan deadline', async t => {
  const { app, session, bind } = await setup(t, 180);
  const first = await bind(); first.ws.terminate();
  await until(() => app.store.get(session.sessionId)?.generation === 2);
  const resumed = await bind();
  await pause(240);
  assert.equal(app.coordinator.get(session.sessionId).status, 'active');
  assert.ok(!app.store.events(session.sessionId).some(event => event.type === 'device.grace_expired'));
  t.after(() => resumed.ws.terminate());
});

test('shutdown sends ended snapshots to control and spectator before closing their sockets', async t => {
  const { bind, close } = await setup(t, 1000);
  const control = await bind(), spectator = await bind('events');
  const controlClosed = once(control.ws, 'close'), spectatorClosed = once(spectator.ws, 'close');
  await close(); await Promise.all([controlClosed, spectatorClosed]);
  for (const peer of [control, spectator]) {
    assert.ok(peer.messages.some(message => message.type === 'event' && message.event.type === 'session.ended'));
    assert.ok(peer.messages.some(message => message.type === 'snapshot' && message.snapshot.status === 'ended'));
  }
});
