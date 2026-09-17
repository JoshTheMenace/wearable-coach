import type { APIRequestContext, APIResponse, BrowserContext } from 'playwright';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { mceleConfig, mceleUrl } from './mcele-config.ts';
const quotedString = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
const moduleSchema = z.object({ title: z.string().max(1000), launchUrl: z.string(), modelUrl: z.string(),
  modelAvailable: z.boolean(), unavailableVideoCount: z.number().int().nonnegative(), videos: z.array(z.string()).max(16) });
const packageSchema = z.object({ courseId: z.string().uuid(), title: z.string().min(1).max(1000), rootUrl: z.string(),
  manifestUrl: z.string(), manifestAvailable: z.boolean(), modules: z.array(moduleSchema).min(1).max(32) });
export type CoursePackage = z.infer<typeof packageSchema>;

function courseRoot(value: string) {
  const { origins: { content }, paths: { coursePrefix } } = mceleConfig();
  const url = new URL(value, content);
  const suffix = url.pathname.slice(coursePrefix.length);
  if (url.origin !== content || !url.pathname.startsWith(coursePrefix) || !/^[\da-f-]{36}\/\d+\/$/i.test(suffix) ||
      url.search || url.hash || url.username || url.password) throw new Error('MCeLE returned an unsupported course package root.');
  z.string().uuid().parse(suffix.split('/')[0]);
  return url;
}

function assetUrl(value: string, root: URL, base = root.href) {
  const url = new URL(value, base);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash ||
      url.username || url.password || /%2f|%5c|%2e|\\/i.test(url.pathname)) throw new Error('MCeLE returned an unsupported course asset URL.');
  return url.href;
}

function literal(value: string) {
  const text = value.slice(1, -1).replace(/\\(['"\\/])/g, '$1');
  if (text.includes('\\')) throw new Error('MCeLE course configuration uses an unsupported string encoding.');
  return text;
}

async function body(response: APIResponse, maxBytes: number) {
  try {
    if (!response.ok()) throw new Error(`MCeLE course asset request failed (HTTP ${response.status()}).`);
    const bytes = await response.body();
    if (bytes.length > maxBytes) throw new Error('MCeLE course asset exceeds the supported size.');
    return bytes;
  } finally { await response.dispose(); }
}

async function pairs<T, R>(items: T[], work: (item: T, index: number) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 2) {
    const batch = await Promise.allSettled(items.slice(index, index + 2).map((item, offset) => work(item, index + offset)));
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

function packageDirectory(courseId: string) {
  return resolve(process.env.COACH_DATA_DIR || '.runtime', 'mcele', 'courses', courseId);
}

// Launching an enrolled course can record ordinary LMS access; never enroll or submit assessments.
export async function resolveCoursePackage(context: BrowserContext, courseId: string): Promise<CoursePackage> {
  z.string().uuid().parse(courseId);
  const existingPages = new Set(context.pages());
  const page = await context.newPage();
  let configuration: string;
  let title: string;
  try {
    const url = mceleUrl('portal', 'courseEnrollment', { courseId });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response?.ok() || page.url() !== url) throw new Error('MCeLE course launch requires a current signed-in session.');
    title = await page.locator('.mn-course-titlecode').innerText();
    const launch = page.locator('.mn_enroll-go-btn[data-type="Course"]:enabled').first();
    if (!await launch.count()) throw new Error('MCeLE course has no available launch; enrollment or prerequisites may be required.');
    const [config] = await Promise.all([
      context.waitForEvent('response', { timeout: 45_000, predicate: response => {
        const url = new URL(response.url());
        return url.origin === mceleConfig().origins.content && [mceleConfig().paths.playerConfiguration,
          mceleConfig().paths.concurrentLaunch].includes(url.pathname);
      } }), launch.click(),
    ]);
    if (new URL(config.url()).pathname === mceleConfig().paths.concurrentLaunch)
      throw new Error('MCeLE reports an active course player session. Use the cached package for downloads or close the previous player and retry after its session expires.');
    if (!config.ok()) throw new Error('MCeLE did not return the course player configuration.');
    configuration = await config.text();
    if (configuration.length > 1_000_000) throw new Error('MCeLE course configuration exceeds the supported size.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MCeLE ')) throw error;
    throw new Error('MCeLE course launch failed; refresh the session or inspect enrollment requirements.');
  } finally { await Promise.all(context.pages().filter(page => !existingPages.has(page)).map(page => page.close())); }

  const path = configuration.match(/pathToCourse\s*:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/)?.[1];
  if (!path) throw new Error('MCeLE course player did not expose a supported package root.');
  const root = courseRoot(`${literal(path).replace(/\/$/, '')}/`);
  const modules = [...configuration.matchAll(/new\s+LearningObject\s*\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*,\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)]
    .filter(match => literal(match[2])).map(match => ({ title: literal(match[1]), launchUrl: assetUrl(literal(match[2]), root) }));
  if (!modules.length || modules.length > 32) throw new Error('MCeLE course does not contain a supported number of modules.');
  const options = { maxRedirects: 0, timeout: 30_000 };
  const manifestUrl = assetUrl('imsmanifest.xml', root);
  const manifest = await context.request.get(manifestUrl, options);
  const manifestAvailable = manifest.ok();
  await manifest.dispose();
  const resolvedModules = await pairs(modules, async module => {
    const modelUrl = assetUrl('assets/js/CPM.js', root, module.launchUrl);
    const response = await context.request.get(modelUrl, options);
    if (response.status() === 404) {
      await response.dispose();
      return { ...module, modelUrl, modelAvailable: false, videos: [] };
    }
    const model = (await body(response, 8 * 1024 * 1024)).toString();
    // Captivate may list stale videos and place slide videos outside cp.model.videos.
    const videos = [...model.matchAll(quotedString)].filter(match => /\.mp4['"]$/i.test(match[0]))
      .map(match => assetUrl(literal(match[0]), root, module.launchUrl));
    return { ...module, modelUrl, modelAvailable: /\bcp\.model\b/.test(model), videos: [...new Set(videos)] };
  });
  const candidates = [...new Set(resolvedModules.flatMap(module => module.videos))];
  if (candidates.length > 64) throw new Error('MCeLE course contains more than 64 candidate video references.');
  const available = new Set((await pairs(candidates, async url => {
    const response = await context.request.head(url, options);
    const status = response.status();
    await response.dispose();
    if (status === 404) return null;
    if (status !== 200) throw new Error(`MCeLE course video verification failed (HTTP ${status}).`);
    return url;
  })).filter(url => url !== null));
  const result = packageSchema.parse({ courseId, title, rootUrl: root.href, manifestUrl, manifestAvailable,
    modules: resolvedModules.map(module => ({ ...module, videos: module.videos.filter(url => available.has(url)),
      unavailableVideoCount: module.videos.filter(url => !available.has(url)).length })) });
  if (result.modules.flatMap(module => module.videos).length > 16) throw new Error('MCeLE course contains more than 16 downloadable videos.');
  const directory = packageDirectory(courseId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'package.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

export async function downloadCourseVideos(request: APIRequestContext, packageInfo: CoursePackage) {
  const info = packageSchema.parse(packageInfo);
  const root = courseRoot(info.rootUrl);
  const videos = info.modules.flatMap((module, moduleIndex) => module.videos.map((value, videoIndex) => {
    const url = assetUrl(value, root), hash = createHash('sha256').update(url).digest('hex').slice(0, 20);
    return { title: module.title, url, filename: `${String(moduleIndex + 1).padStart(2, '0')}-${videoIndex + 1}-${hash}.mp4` };
  }));
  if (!videos.length || videos.length > 16) throw new Error('MCeLE course must contain between 1 and 16 downloadable videos.');
  const directory = join(packageDirectory(info.courseId), root.pathname.split('/').slice(-3, -1).join('-'), 'videos');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { inspectMedia } = await import('./mcele-session.ts');
  const downloads = await pairs(videos, async video => {
    const path = join(directory, video.filename);
    const partial = `${path}.${randomUUID()}.partial`;
    const cached = await stat(path).then(() => true, () => false);
    try {
      if (!cached) {
        const bytes = await body(await request.get(video.url, { maxRedirects: 0, timeout: 120_000 }), 256 * 1024 * 1024);
        if (bytes.subarray(4, 8).toString() !== 'ftyp') throw new Error('MCeLE course asset is not an MP4.');
        await writeFile(partial, bytes, { mode: 0o600, flag: 'wx' });
      }
      const media = await inspectMedia(cached ? path : partial);
      if (!media.streams.some(stream => stream.codec_type === 'video')) throw new Error('MCeLE course asset has no video stream.');
      if (!cached) await rename(partial, path);
      return { title: video.title, path, cached, ...media };
    } finally { await unlink(partial).catch(() => {}); }
  });
  return { courseId: info.courseId, title: info.title, videos: downloads };
}
