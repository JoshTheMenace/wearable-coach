import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Store } from '../src/store.ts';
import type { ProviderCallbacks } from '../src/providers/types.ts';
import type { Command } from '../../contracts/index.ts';

const wait = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Expected asynchronous state was not reached');
};
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-knowledge-'));
  const app = createApp({ dataDir: dir, operatorToken: 'knowledge-test-operator' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const request = (path: string, body?: unknown, token = app.operatorToken) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const create = async () => {
    const response = await request('/sessions', { createKey: randomUUID(), config: { provider: 'mock', model: 'mock-coach', device: 'mock' } });
    assert.equal(response.status, 201);
    const session = await response.json() as { sessionId: string; token: string; spectatorToken: string };
    await wait(() => app.coordinator.get(session.sessionId).status === 'active');
    return session;
  };
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = await create(), id = session.sessionId;
  const command = (type: Command['type'], payload: Record<string, unknown> = {}) => app.coordinator.command(id, {
    schemaVersion: 1, sessionId: id, generation: app.coordinator.get(id).generation,
    commandId: randomUUID(), messageId: randomUUID(), type, payload,
  });
  return { app, request, create, session, id, command, path: `/sessions/${id}/knowledge` };
}

test('reference endpoints enforce operator and session scopes including read-only spectators', async t => {
  const h = await setup(t), other = await h.create();
  assert.equal((await h.request('/knowledge', undefined, '')).status, 401);
  assert.equal((await h.request('/knowledge', undefined, h.session.token)).status, 401);
  const metadata = await (await h.request('/knowledge')).json() as any;
  assert.equal(metadata.status, 'ready'); assert.equal(metadata.indexedFactCount, 20);
  assert.equal((await h.request(h.path, undefined, h.session.spectatorToken)).status, 200);
  assert.equal((await h.request(h.path, { query: 'depth' }, h.session.spectatorToken)).status, 401);
  assert.equal((await h.request(h.path, { query: 'depth' }, other.token)).status, 401);
  assert.equal((await h.request(h.path, { query: 'depth' }, h.session.token)).status, 200);
});

test('manual lookup retains exact evidence and provenance without asking the coach or changing HUD', async t => {
  const h = await setup(t), before = structuredClone(h.app.coordinator.get(h.id).hud);
  const response = await h.request(h.path, { query: 'How deep should compressions be?', limit: 1 }, h.session.token);
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.status, 'found'); assert.equal(result.results[0].factId, 'depth');
  assert.match(result.results[0].source.url, /^https:\/\/cpr\.heart\.org\//);
  assert.match(result.dataset.hash, /^[a-f0-9]{64}$/);
  const event = h.app.store.events(h.id).find(event => event.type === 'knowledge.retrieved')!;
  assert.equal(event.payload.origin, 'manual'); assert.deepEqual(event.payload.result, result);
  assert.equal(event.payload.applicationEffect, 'reference_only'); assert.ok(Number(event.payload.elapsedMs) >= 0);
  assert.deepEqual(h.app.coordinator.get(h.id).hud, before);
  assert.equal(h.app.store.events(h.id).filter(event => event.type === 'provider.tool_result').length, 0);
  const exported = await (await h.request(`/sessions/${h.id}/export`, undefined, h.session.token)).json() as any;
  assert.ok(JSON.stringify(exported).includes(result.dataset.hash));
  assert.ok(JSON.stringify(exported).includes(result.results[0].text));
  assert.ok(!JSON.stringify(exported).includes(h.session.token));
});

test('mock coach invokes native lookup without changing learner evidence', async t => {
  const h = await setup(t);
  h.command('send_text', { text: 'lookup How fast should compressions be?' });
  await wait(() => h.app.store.events(h.id).some(event => event.type === 'provider.tool_result'));
  const event = h.app.store.events(h.id).find(event => event.type === 'knowledge.retrieved')!;
  assert.equal(event.payload.origin, 'coach');
  const work = h.app.coordinator.get(h.id).work.find(work => work.input.nativeCallId)!;
  assert.equal(work.status, 'completed');
  assert.equal((work.result as any).results[0].factId, 'rate');
  assert.equal(h.app.coordinator.get(h.id).hudRevision, 0);
});

test('repeated native call ID retrieves once and returns the committed result', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reference-dedupe-')), store = new Store(join(dir, 'test.sqlite'));
  let callbacks: ProviderCallbacks;
  const results: unknown[] = [];
  const coordinator = new Coordinator(store, dir, { createProvider: (_config, cb) => {
    callbacks = cb;
    return { inputRate: 16000, outputRate: 24000, connect: async () => {}, close: async () => {}, sendAudio: () => {},
      sendText: () => {}, activity: () => {}, inspect: () => {}, appendContext: () => {}, toolResult: (_id, result) => { results.push(result); } };
  } });
  t.after(async () => { await coordinator.close(); rmSync(dir, { recursive: true, force: true }); });
  const { id } = coordinator.create(randomUUID(), { provider: 'gemini', model: 'gemini-3.8-live', device: 'mock' });
  await wait(() => coordinator.get(id).status === 'active');
  const call = { id: 'repeat-reference', name: 'lookup_training_reference', args: { query: 'compression rate' } };
  callbacks!.tool(call); await wait(() => results.length === 1);
  callbacks!.tool(call); await wait(() => results.length === 2);
  assert.deepEqual(results[0], results[1]);
  assert.equal(store.events(id).filter(event => event.type === 'knowledge.retrieved').length, 1);
});

test('invalid, unsupported and ended-session searches fail without creating misleading references', async t => {
  const h = await setup(t);
  for (const body of [{ query: '' }, { query: 'x'.repeat(1201) }, { query: 'rate', limit: 6 }, { query: 'rate', arbitrary: true }])
    assert.equal((await h.request(h.path, body)).status, 400);
  for (const [query, status] of [['quasar astronomy', 'no_match'], ['infant CPR', 'out_of_scope'], ['rescue breaths ratio', 'out_of_scope']]) {
    const result = await (await h.request(h.path, { query })).json() as any;
    assert.equal(result.status, status); assert.deepEqual(result.results, []);
  }
  const count = h.app.store.events(h.id).filter(event => event.type === 'knowledge.retrieved').length;
  await h.app.coordinator.end(h.id);
  assert.equal((await h.request(h.path, { query: 'rate' })).status, 409);
  assert.equal(h.app.store.events(h.id).filter(event => event.type === 'knowledge.retrieved').length, count);
});

test('demo playback suspends reference questions along with the live coach', async t => {
  const h = await setup(t), assetId = randomUUID();
  h.app.coordinator.report(h.id, 1, randomUUID(), 'device.status', {
    displayCapabilities: { video: true, source: 'device-local', maxWidth: 400, maxHeight: 400, maxPixels: 70000 },
    demoAssets: [{ id: assetId, width: 320, height: 180, durationMs: 10000, mime: 'video/mp4' }],
  });
  h.command('start_demo', { assetId });
  assert.equal((await h.request(h.path, { query: 'rate' })).status, 409);
  assert.equal(h.app.store.events(h.id).filter(event => event.type === 'knowledge.retrieved').length, 0);
});
