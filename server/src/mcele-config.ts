import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const origin = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.hostname.endsWith('.invalid');
  } catch { return false; }
});
const path = z.string().startsWith('/').refine(value => !/^\/\/|[\\#]|%2[ef]|%5c|(?:^|\/)\.{1,2}(?:\/|\?|$)/i.test(value));
const schema = z.object({
  origins: z.object({ portal: origin, media: origin, learning: origin, content: origin }),
  paths: z.object({
    studentMedia: path, consent: path, signIn: path, csrf: path, catalog: path, playlist: path,
    mediaDetail: path, mediaDownload: path, mediaPrefix: path, learningCourse: path, learningEnrollment: path,
    courseDetail: path, courseEnrollment: path, playerConfiguration: path, concurrentLaunch: path, coursePrefix: path,
    libraryDocument: path, libraryMetadata: path, libraryDownload: path,
  }),
});
type MceleConfig = z.infer<typeof schema>;
let saved: MceleConfig | undefined;

export function parseMceleConfig(value: unknown): MceleConfig {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('MCeLE configuration is invalid; use HTTPS origins and root-relative endpoint paths.');
  return result.data;
}

// Read lazily so the CLI can load .env before importing any adapter.
export function mceleConfig() {
  if (saved) return saved;
  try {
    return saved = parseMceleConfig(JSON.parse(readFileSync(resolve(process.env.COACH_DATA_DIR || '.runtime', 'mcele', 'config.json'), 'utf8')));
  } catch {
    throw new Error('MCeLE private configuration is missing or invalid. See docs/mcele-toolkit.md for setup.');
  }
}

export function mceleUrl(site: keyof MceleConfig['origins'], route: keyof MceleConfig['paths'], values: Record<string, string> = {}) {
  const { origins, paths } = mceleConfig();
  const path = paths[route].replace(/\{(\w+)\}/g, (_, key: string) => {
    if (values[key] === undefined) throw new Error('MCeLE endpoint template needs a missing parameter.');
    return encodeURIComponent(values[key]);
  });
  const url = new URL(path, origins[site]);
  if (url.origin !== origins[site]) throw new Error('MCeLE endpoint must stay on its configured origin.');
  return url.href;
}
