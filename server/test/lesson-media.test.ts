import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { loadLessonMedia } from '../src/lesson-media.ts';

function fixture(t: TestContext, clean = true) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-lesson-media-')), media = join(dir, 'prepared');
  mkdirSync(media);
  if (clean) t.after(() => rmSync(dir, { recursive: true, force: true }));
  // HTTP/cache fixtures only: no decoder or physical playback is claimed by these bytes.
  const data = [Buffer.from('0000ftypisom' + 'overview0123456789'.repeat(16)), Buffer.from('0000ftypisom' + 'placement0123456789'.repeat(16))];
  const clips = (['overview', 'hand-placement'] as const).map((lessonKey, index) => ({
    id: randomUUID(), lessonKey, title: index ? 'Hand placement' : 'Overview', file: `${lessonKey}.mp4`,
    width: 320, height: 180, durationMs: index ? 4000 : 30000, mime: 'video/mp4' as const,
    sourceStartSeconds: index ? 83 : 60, bytes: data[index].length,
    sha256: createHash('sha256').update(data[index]).digest('hex'),
  }));
  const save = (manifest: unknown = { clips }) => {
    clips.forEach((clip, index) => writeFileSync(join(media, clip.file), data[index]));
    writeFileSync(join(media, 'manifest.json'), JSON.stringify(manifest));
  };
  save();
  return { dir, media, clips, data, save };
}

async function setup(t: TestContext) {
  const files = fixture(t, false), app = createApp({ dataDir: join(files.dir, 'runtime'), lessonMediaDir: files.media, operatorToken: 'lesson-media-test-operator' });
  t.after(async () => { try { await app.close(); } finally { rmSync(files.dir, { recursive: true, force: true }); } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, token = app.operatorToken, init: RequestInit = {}) => fetch(base + path, {
    ...init, headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  const create = async () => {
    const response = await request('/api/sessions', app.operatorToken, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ createKey: randomUUID(), config: { provider: 'mock', model: 'mock-coach', device: 'mock' } }) });
    assert.equal(response.status, 201);
    return await response.json() as { sessionId: string; token: string; spectatorToken: string };
  };
  const session = await create();
  return { ...files, app, request, create, session, path: `/api/sessions/${session.sessionId}/lesson-media` };
}

test('prepared lesson metadata retains source intervals and exposes only session-scoped delivery URLs', async t => {
  const h = await setup(t), other = await h.create();
  assert.equal((await h.request(h.path, '')).status, 401);
  assert.equal((await h.request(h.path, other.token)).status, 401);
  assert.equal((await h.request(h.path, other.spectatorToken)).status, 401);
  for (const token of [h.session.token, h.session.spectatorToken, h.app.operatorToken]) {
    const response = await h.request(h.path, token);
    assert.equal(response.status, 200);
    const metadata = await response.json() as { clips: Array<Record<string, unknown>>; intro: { facts: unknown[] } };
    assert.equal(metadata.clips.length, 2);
    for (const [index, clip] of metadata.clips.entries()) {
      const { file: _file, ...expected } = h.clips[index];
      assert.deepEqual(clip, { ...expected, url: `${h.path}/${expected.id}` });
      assert.ok(!('data' in clip) && !('file' in clip));
    }
    assert.ok(metadata.intro.facts.length > 0);
    assert.ok(!JSON.stringify(metadata).includes(h.dir));
  }
  const clip = `${h.path}/${h.clips[0].id}`;
  assert.equal((await h.request(clip, other.token)).status, 401);
  assert.equal((await h.request(`/api/sessions/${other.sessionId}/lesson-media/${h.clips[0].id}`, h.session.token)).status, 401);
  assert.equal((await h.request(`${h.path}/${randomUUID()}`, h.session.token)).status, 404);
});

test('lesson clip delivery supports exact GET, HEAD, byte ranges and rejects invalid ranges', async t => {
  const h = await setup(t), path = `${h.path}/${h.clips[0].id}`, bytes = h.data[0];
  const full = await h.request(path, h.session.token);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('content-length'), String(bytes.length));
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.match(full.headers.get('cache-control')!, /private/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const head = await h.request(path, h.session.token, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [['bytes=8-39', 8, 39], ['bytes=-32', bytes.length - 32, bytes.length - 1], ['bytes=16-', 16, bytes.length - 1]] as const) {
    const response = await h.request(path, h.session.token, { headers: { range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=9999-', 'bytes=39-8', 'bytes=-0', 'bytes=0-3,8-10', 'bytes=-', 'bytes=9007199254740993-']) {
    const response = await h.request(path, h.session.token, { headers: { range } });
    assert.equal(response.status, 416, range);
    assert.ok(!Buffer.from(await response.arrayBuffer()).equals(bytes));
  }
});

test('missing, malformed, corrupt and oversized lesson packages fail closed without publishing a partial catalog', t => {
  const h = fixture(t), sessionId = randomUUID();
  const unavailable = () => {
    const media = loadLessonMedia(h.media);
    assert.deepEqual(media.list(sessionId), []);
    h.clips.forEach(clip => assert.equal(media.get(clip.id), undefined));
  };
  assert.equal(loadLessonMedia(h.media).list(sessionId).length, 2);
  rmSync(join(h.media, 'manifest.json')); unavailable();
  h.save(); rmSync(join(h.media, h.clips[1].file)); unavailable();
  h.save(); writeFileSync(join(h.media, 'manifest.json'), '{'); unavailable();
  h.save(); writeFileSync(join(h.media, 'manifest.json'), ' '.repeat(16001)); unavailable();
  h.save({ clips: [h.clips[0], { ...h.clips[1], sha256: '0'.repeat(64) }] }); unavailable();
  h.save({ clips: [h.clips[0], { ...h.clips[1], bytes: 16 * 1024 * 1024 + 1 }] }); unavailable();
  h.save(); truncateSync(join(h.media, h.clips[1].file), 17 * 1024 * 1024); unavailable();
  h.save({ clips: [h.clips[0], { ...h.clips[1], width: 400, height: 400 }] }); unavailable();
  h.save({ clips: [h.clips[0], { ...h.clips[1], file: '../private.mp4' }] }); unavailable();
  h.save({ clips: [h.clips[0], { ...h.clips[1], lessonKey: 'overview' }] }); unavailable();
  h.save({ clips: [h.clips[0], { ...h.clips[1], id: h.clips[0].id }] }); unavailable();
});
