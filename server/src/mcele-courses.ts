import type { BrowserContext } from 'playwright';
import { z } from 'zod';
import { mceleConfig, mceleUrl } from './mcele-config.ts';

function referenceLinks(links: { title: string; url: string }[], sourceUrl: string) {
  const { portal, media, learning } = mceleConfig().origins;
  const origins = new Set([portal, media, learning]);
  return [...new Map(links.flatMap(link => {
    try {
      const url = new URL(link.url, sourceUrl);
      if (link.url.startsWith('#') || !origins.has(url.origin) || url.username || url.password ||
          /\/(?:user|login|enrol)(?:[/.]|$)|launch|player|scorm|logout/i.test(url.pathname) ||
          [...url.searchParams].some(([key, value]) => !/^(?:id|courseid|filename|forcedownload)$/i.test(key) ||
            !/^[\w.\-]{1,200}$/.test(value))) return [];
      url.hash = '';
      return [[url.href, { title: link.title.trim().slice(0, 1000), url: url.href }] as const];
    } catch { return []; }
  })).values()];
}

// Inspect descriptions and enrollment availability only; never launch or enroll a learner.
export async function inspectCourse(context: BrowserContext, courseId: string) {
  courseId = z.union([z.string().uuid(), z.string().regex(/^[1-9]\d{0,9}$/)]).parse(courseId);
  const platform = /^\d+$/.test(courseId) ? 'moodle' : 'marinenet';
  const sourceUrl = platform === 'moodle' ? mceleUrl('learning', 'learningCourse', { courseId }) :
    mceleUrl('portal', 'courseDetail', { courseId });
  const enrollmentUrl = platform === 'moodle' ? mceleUrl('learning', 'learningEnrollment', { courseId }) :
    mceleUrl('portal', 'courseEnrollment', { courseId });
  const page = await context.newPage();
  try {
    const response = await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const actual = new URL(page.url());
    if (!response?.ok() || (platform === 'moodle' ? actual.origin !== mceleConfig().origins.learning ||
        ![sourceUrl, enrollmentUrl].some(url => new URL(url).pathname === actual.pathname) || actual.searchParams.get('id') !== courseId :
        actual.href !== sourceUrl)) throw new Error('MCeLE course access requires a current signed-in session.');
    await page.locator(platform === 'moodle' ? '.page-header-headings h1' : '.mn-course-titlecode').waitFor({ timeout: 15_000 });
    const details = await page.evaluate(platform => {
      const sections = Object.fromEntries([...document.querySelectorAll('.course-details h5')]
        .map(heading => [heading.textContent?.trim(), heading.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim() || null]));
      const scope = platform === 'moodle' ? '#region-main .summary, #region-main .course-content' : '.course-details';
      return {
        title: document.querySelector(platform === 'moodle' ? '.page-header-headings h1' : '.mn-course-titlecode')?.textContent?.trim(),
        description: platform === 'moodle' ? document.querySelector('#region-main .summary')?.textContent?.trim() || null : sections.Description ?? null,
        learningObjectives: sections['Learning Objectives'] ?? null,
        eligibility: platform === 'moodle' ? document.querySelector('#notice')?.textContent?.trim() || null : sections.Eligibility ?? null,
        contentSummary: document.querySelector(platform === 'moodle' ? '#region-main .course-content' : '#mn_detail_content')?.textContent?.replace(/\s+/g, ' ').trim() || null,
        links: [...document.querySelectorAll(scope.split(',').map(selector => `${selector.trim()} a[href]`).join(','))]
          .map(anchor => ({ title: anchor.textContent?.trim() ?? '', url: anchor.getAttribute('href') ?? '' })),
      };
    }, platform);
    let enrollmentRequired: boolean | null = platform === 'moodle' ? actual.pathname === new URL(enrollmentUrl).pathname : null;
    let launchAvailable: boolean | null = null;
    let content: { title: string | null; status: string | null; availability: string | null }[] = [];
    if (platform === 'marinenet') {
      const response = await page.goto(enrollmentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!response?.ok() || page.url() !== enrollmentUrl) throw new Error('MCeLE enrollment details require a current signed-in session.');
      const enrollment = await page.evaluate(() => {
        const status = [...document.querySelectorAll('.mn_enroll-overview-label')]
          .find(label => label.textContent?.trim() === 'Enrollment Status')?.nextElementSibling;
        return {
          status: status?.textContent?.trim() ?? null, missing: /No enrollment was found\./i.test(document.querySelector('.container-tabbed')?.textContent ?? ''),
          launchAvailable: [...document.querySelectorAll<HTMLButtonElement>('.mn_enroll-go-btn')].some(button => !button.disabled),
          content: [...document.querySelectorAll('section[id^="rptEnrollmentItems"]')].map(section => ({
            title: section.querySelector('#lblName')?.textContent?.trim() || null,
            status: section.querySelector('#tdStatus label')?.textContent?.trim() || null,
            availability: section.querySelector('#lblStatus')?.textContent?.trim() || null,
          })),
        };
      });
      enrollmentRequired = enrollment.status === 'Enrolled' ? false : enrollment.missing ? true : null;
      launchAvailable = enrollment.status || enrollment.missing ? enrollment.launchAvailable : null;
      content = enrollment.content;
    }
    return { courseId, platform, title: z.string().min(1).max(1000).parse(details.title), sourceUrl,
      description: details.description, learningObjectives: details.learningObjectives, eligibility: details.eligibility,
      contentSummary: details.contentSummary, enrollmentRequired, launchAvailable, content,
      links: referenceLinks(details.links, sourceUrl) };
  } catch (error) {
    if (error instanceof Error && /^MCeLE (?:course access|enrollment details)/.test(error.message)) throw error;
    throw new Error('MCeLE course inspection failed; refresh the session or check the course ID.');
  } finally { await page.close(); }
}
