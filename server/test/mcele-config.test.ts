import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mceleConfig, mceleUrl, parseMceleConfig } from '../src/mcele-config.ts';

const example = JSON.parse(readFileSync(new URL('../../mcele.config.example.json', import.meta.url), 'utf8'));
function profile() {
  return {
    origins: Object.fromEntries(Object.keys(example.origins).map(key => [key, `https://${key}.example.test`])),
    paths: Object.fromEntries(Object.entries(example.paths).map(([key, value]) => [key, String(value).replace('/REPLACE_', '/demo/')])),
  };
}

test('public placeholders fail closed and a complete private profile validates', () => {
  assert.throws(() => parseMceleConfig(example), /^Error: MCeLE configuration is invalid;/);
  assert.throws(() => parseMceleConfig({ ...profile(), paths: example.paths }));
  assert.deepEqual(parseMceleConfig(profile()), profile());
});

test('invalid origins and paths never appear in configuration errors', () => {
  for (const value of ['not a URL', 'http://portal.example.test', 'https://user:private-value@example.test',
    'https://portal.example.test/path', 'https://portal.example.test?token=private-value']) {
    const config = profile();
    config.origins.portal = value;
    assert.throws(() => parseMceleConfig(config), error => error instanceof Error &&
      error.message === 'MCeLE configuration is invalid; use HTTPS origins and root-relative endpoint paths.');
  }
  for (const value of ['//other.example.test/path', '/\\other.example.test/path', '/a/../b', '/a/%2e%2e/b', '/a#fragment', 'relative']) {
    const config = profile();
    config.paths.catalog = value;
    assert.throws(() => parseMceleConfig(config), /^Error: MCeLE configuration is invalid;/);
  }
});

test('configuration loads lazily, hides parse errors, and encodes URL parameters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcele-config-'));
  const previous = process.env.COACH_DATA_DIR;
  process.env.COACH_DATA_DIR = directory;
  try {
    assert.throws(() => mceleConfig(), /^Error: MCeLE private configuration is missing or invalid\./);
    mkdirSync(join(directory, 'mcele'));
    const path = join(directory, 'mcele', 'config.json');
    writeFileSync(path, 'invalid json private-value');
    assert.throws(() => mceleConfig(), error => error instanceof Error && !error.message.includes('private-value'));
    writeFileSync(path, JSON.stringify(profile()));
    assert.equal(mceleUrl('portal', 'catalog', { kind: 'a/b?x=1&y=2' }),
      'https://portal.example.test/demo/catalog?kind=a%2Fb%3Fx%3D1%26y%3D2');
    assert.throws(() => mceleUrl('portal', 'catalog'), /^Error: MCeLE endpoint template needs a missing parameter\./);
    assert.equal(mceleUrl('media', 'mediaDownload', { shortId: '000000000000', extension: '.mp4' }),
      'https://media.example.test/demo/mediaDownload?shortId=000000000000&extension=.mp4');
  } finally {
    if (previous === undefined) delete process.env.COACH_DATA_DIR;
    else process.env.COACH_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
