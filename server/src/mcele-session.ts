import { chromium, request, type APIRequestContext, type Frame } from 'playwright';
import { mkdir, chmod, writeFile, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mceleConfig, mceleUrl } from './mcele-config.ts';

const exec = promisify(execFile);
export const mceleDirectory = resolve(process.env.COACH_DATA_DIR || '.runtime', 'mcele');
export const mceleStatePath = join(mceleDirectory, 'state.json');


export async function loginMcele(headed = false) {
  const { origins, paths } = mceleConfig();
  await mkdir(mceleDirectory, { recursive: true, mode: 0o700 });
  const storageState = await stat(mceleStatePath).then(() => mceleStatePath, () => undefined);
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  let usedCredentials = false;
  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto(mceleUrl('portal', 'studentMedia'));
    if (new URL(page.url()).pathname === paths.consent) {
      if (!headed) throw new Error('MCeLE consent is required. Run login --headed and accept the banner in Chrome.');
      console.log('Accept the DoD consent banner in Chrome to continue.');
      await page.waitForURL(url => url.pathname !== paths.consent, { timeout: 180_000 });
    }
    await page.waitForURL(url => url.origin === origins.portal || url.pathname.toLowerCase().endsWith(paths.signIn.toLowerCase()), { timeout: 45_000 });
    if (new URL(page.url()).origin !== origins.portal) {
      const { MCELE_USERNAME: username, MCELE_PASSWORD: password } = process.env;
      if (!username || !password) throw new Error('Set MCELE_USERNAME and MCELE_PASSWORD in .env.');
      let frame: Frame | undefined;
      for (let attempt = 0; attempt < 150 && !frame; attempt++) {
        for (const candidate of page.frames()) {
          if (new URL(candidate.url()).origin === origins.media &&
              await candidate.getByRole('textbox', { name: 'Username *', exact: true }).count()) frame = candidate;
        }
        if (!frame) await page.waitForTimeout(100);
      }
      if (!frame) throw new Error('MCeLE did not expose the expected sign-in form.');
      await frame.getByRole('textbox', { name: 'Username *', exact: true }).fill(username);
      await frame.getByRole('textbox', { name: 'Password *', exact: true }).fill(password);
      await frame.getByRole('button', { name: 'SIGN IN', exact: true }).click();
      usedCredentials = true;
      await page.waitForURL(url => url.origin === origins.portal, { timeout: 45_000 });
    }
    await page.locator('#iptSearch').waitFor();
    await context.storageState({ path: mceleStatePath });
    await chmod(mceleStatePath, 0o600);
    return { authenticated: true, usedCredentials, statePath: mceleStatePath };
  } catch (error) {
    if (error instanceof Error && /^(MCeLE consent|Set MCELE_|MCeLE did not expose)/.test(error.message)) throw error;
    throw new Error('MCeLE sign-in did not complete. Check credentials or retry login --headed for any interactive step.');
  } finally { await browser.close(); }
}

export async function mceleRequest(): Promise<APIRequestContext> {
  if (!await stat(mceleStatePath).then(() => true, () => false)) throw new Error('Run npm run mcele -- login --headed first.');
  return request.newContext({ storageState: mceleStatePath, timeout: 30_000 });
}

export async function inspectMedia(path: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,width,height,sample_rate,channels', '-of', 'json', path]);
  return JSON.parse(stdout) as { format: { duration: string; size: string }; streams: {
    codec_type: string; codec_name: string; width?: number; height?: number; sample_rate?: string; channels?: number;
  }[] };
}

export async function downloadMcele(client: APIRequestContext, shortId: string) {
  if (!/^[A-F0-9]{12}$/i.test(shortId)) throw new Error('Expected an MCeLE video short ID.');
  const directory = join(mceleDirectory, 'media');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${shortId.toUpperCase()}.mp4`);
  if (await stat(path).then(() => true, () => false)) return { path, cached: true, ...await inspectMedia(path) };
  const response = await client.get(mceleUrl('media', 'mediaDownload', { shortId, extension: '.mp4' }), { maxRedirects: 0, timeout: 120_000 });
  try {
    if ([301, 302, 303, 401, 403].includes(response.status())) throw new Error('MCeLE session expired or video access denied. Run login to refresh the session.');
    if (!response.ok()) throw new Error(`MCeLE download failed with HTTP ${response.status()}.`);
    const bytes = await response.body();
    if (bytes.length > 256 * 1024 * 1024 || bytes.subarray(4, 8).toString() !== 'ftyp') throw new Error('MCeLE did not return an MP4 under 256 MiB.');
    await writeFile(`${path}.partial`, bytes, { mode: 0o600 });
    const info = await inspectMedia(`${path}.partial`);
    if (!info.streams.some(stream => stream.codec_type === 'video')) throw new Error('The returned MP4 has no video stream.');
    await rename(`${path}.partial`, path);
    return { path, cached: false, ...info };
  } finally { await response.dispose(); }
}

export async function prepareMcele(client: APIRequestContext, shortId: string, startSeconds = 0, durationSeconds = 60) {
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300)
    throw new Error('Choose a nonnegative start and a duration greater than 0 and at most 300 seconds.');
  const source = await downloadMcele(client, shortId);
  if (startSeconds >= Number(source.format.duration)) throw new Error('The clip starts after the source video ends.');
  const path = source.path.replace(/\.mp4$/, `-${startSeconds}-${durationSeconds}-320x180.mp4`);
  if (!await stat(path).then(() => true, () => false)) {
    await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(startSeconds), '-i', source.path, '-t', String(durationSeconds),
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-crf', '25', '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart', '-f', 'mp4', `${path}.partial`], { timeout: 120_000 });
    await chmod(`${path}.partial`, 0o600);
    await rename(`${path}.partial`, path);
  }
  return { path, sourceId: shortId, startSeconds, ...await inspectMedia(path) };
}
