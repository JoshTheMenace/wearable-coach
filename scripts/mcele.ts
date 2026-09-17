import { config } from 'dotenv';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { searchCatalog, playlistVideos, findTrainingMedia, resolveMedia } from '../server/src/mcele.ts';
import { inspectCourse } from '../server/src/mcele-courses.ts';
import { resolveCoursePackage, downloadCourseVideos } from '../server/src/mcele-course-package.ts';

config({ quiet: true });
const { loginMcele, mceleRequest, mceleStatePath, mceleDirectory, downloadMcele, prepareMcele } = await import('../server/src/mcele-session.ts');
const { downloadLibraryItem, downloadLibraryFolder } = await import('../server/src/mcele-library.ts');
const [command, ...args] = process.argv.slice(2);
const usage = 'Usage: mcele login [--headed] | search <media|courses|documents> <query> [page] | find <query> | playlist <id> [page] | resolve <videoId> | download <videoId> | prepare <videoId> [startSeconds=0] [durationSeconds=60] | course <courseId> | course-package <courseId> [--refresh] | course-videos <courseId> | document <id> | folder <folderId>';

async function run() {
  if (command === 'login') return loginMcele(args.includes('--headed'));
  if (['course-package', 'course-videos'].includes(command) && !args.includes('--refresh')) {
    const courseId = z.string().uuid().parse(args[0]);
    const saved = await readFile(join(mceleDirectory, 'courses', courseId, 'package.json'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (saved) {
      const course = JSON.parse(saved);
      if (course.courseId !== courseId) throw new Error('MCeLE cached course ID does not match the request.');
      if (command === 'course-package') return course;
      const client = await mceleRequest();
      try { return await downloadCourseVideos(client, course); } finally { await client.dispose(); }
    }
  }
  if (['resolve', 'course', 'course-package', 'course-videos'].includes(command)) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext({ storageState: mceleStatePath });
      if (command === 'course-package' || command === 'course-videos') {
        const course = await resolveCoursePackage(context, args[0]);
        return command === 'course-videos' ? await downloadCourseVideos(context.request, course) : course;
      }
      return await (command === 'course' ? inspectCourse(context, args[0]) : resolveMedia(context, args[0]));
    } finally { await browser.close(); }
  }
  if (!['search', 'find', 'playlist', 'download', 'prepare', 'document', 'folder'].includes(command)) throw new Error(usage);
  const client = await mceleRequest();
  try {
    if (command === 'search') return await searchCatalog(client, args[0] as 'media' | 'courses' | 'documents', args[1], Number(args[2] ?? 1));
    if (command === 'document') return await downloadLibraryItem(client, args[0]);
    if (command === 'folder') return await downloadLibraryFolder(client, args[0]);
    if (command === 'playlist') return await playlistVideos(client, args[0], Number(args[1] ?? 1));
    if (command === 'download') return await downloadMcele(client, args[0]);
    if (command === 'prepare') return await prepareMcele(client, args[0], Number(args[1] ?? 0), Number(args[2] ?? 60));
    return await findTrainingMedia(client, args.join(' '));
  } finally { await client.dispose(); }
}

try { console.log(JSON.stringify(await run(), null, 2)); }
catch (error) {
  // Playwright errors can include request headers or form values; keep them out of CLI output.
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Usage:|MCeLE |Expected |Choose |Run npm|Set MCELE_|The returned|The clip)/.test(message)
    ? message : 'MCeLE operation failed. Check the arguments, login session, Chrome, and ffmpeg installation.');
  process.exitCode = 1;
}
