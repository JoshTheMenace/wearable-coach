import type { APIRequestContext, APIResponse, BrowserContext } from 'playwright';
import { z } from 'zod';

import { mceleConfig, mceleUrl } from './mcele-config.ts';
const shortIdSchema = z.string().regex(/^[A-F\d]{12}$/i);
const uuidSchema = z.string().uuid();
const pageSchema = z.number().int().min(1).max(1000);
const itemSchema = z.object({
  Id: z.union([z.string().max(100), z.number()]), Title: z.string().max(1000),
  ContentType: z.string().max(100), URL: z.string().max(2000),
  ShortId: shortIdSchema.nullish(), Description: z.string().max(50_000).nullish(),
  ChannelId: z.number().int().nonnegative().nullish(), ChannelTitle: z.string().max(1000).nullish(),
  Duration: z.number().nonnegative().nullish(), IsAudioOnly: z.boolean().nullish(),
  FOUO: z.boolean().nullish(), CUI: z.boolean().nullish(), IsPrivate: z.boolean().nullish(), Private: z.boolean().nullish(),
});
const catalogSchema = z.object({
  status: z.boolean(), total: z.number().int().nonnegative(), catItems: z.array(itemSchema).max(100),
});

function officialUrl(value: string) {
  const { portal, media, learning } = mceleConfig().origins;
  const officialOrigins = new Set([portal, media, learning]);
  const url = new URL(value, portal);
  if (!officialOrigins.has(url.origin) || url.username || url.password ||
      [...url.searchParams.keys()].some(key => /token|password|secret|authorization/i.test(key))) {
    throw new Error('MCeLE returned an unsupported URL.');
  }
  return url;
}

async function readJson(response: APIResponse): Promise<unknown> {
  try {
    if (!response.ok()) throw new Error(`MCeLE request failed (HTTP ${response.status()}); the session may need renewal.`);
    const body = await response.body();
    if (body.length > 1_000_000) throw new Error('MCeLE response exceeds the supported size.');
    try { return JSON.parse(body.toString()); } catch { throw new Error('MCeLE returned no JSON; the session may need renewal.'); }
  } finally { await response.dispose(); }
}

async function postCatalog(request: APIRequestContext, url: string, form: Record<string, string>, page: number) {
  const options = { timeout: 30_000, maxRedirects: 0 };
  const csrf = z.object({ token: z.string().optional() }).parse(
    await readJson(await request.get(mceleUrl('portal', 'csrf'), options)),
  );
  const data = catalogSchema.parse(await readJson(await request.post(url, {
    ...options, form, headers: csrf.token ? { 'CSRF-Token': csrf.token } : {},
  })));
  if (!data.status) throw new Error('MCeLE could not complete the catalog request.');
  const items = data.catItems.map(item => {
    const url = officialUrl(item.URL);
    const shortId = item.ShortId ?? (url.pathname === new URL(mceleUrl('portal', 'mediaDetail', { shortId: 'placeholder' })).pathname ? url.searchParams.get('Id') : null);
    return {
      id: String(item.Id), shortId: shortId ? shortIdSchema.parse(shortId) : null,
      title: item.Title, description: (item.Description ?? '').slice(0, 2000), contentType: item.ContentType,
      url: url.href, channelId: item.ChannelId ?? null, channelTitle: item.ChannelTitle ?? null,
      durationSeconds: item.Duration ?? null, audioOnly: item.IsAudioOnly ?? null,
      cui: item.FOUO === true || item.CUI === true ? true : item.FOUO ?? item.CUI ?? null,
      private: item.IsPrivate === true || item.Private === true ? true : item.IsPrivate ?? item.Private ?? null,
    };
  });
  return { items, total: data.total, page, pageSize: 21, hasMore: items.length > 0 && (page - 1) * 21 + items.length < data.total };
}

export async function searchCatalog(request: APIRequestContext, kind: 'media' | 'courses' | 'documents', query: string, page = 1) {
  z.enum(['media', 'courses', 'documents']).parse(kind);
  query = z.string().trim().min(1).max(300).parse(query);
  pageSchema.parse(page);
  // Every page needs the query; sending pageNum alone resets the server's search.
  return { kind, query, ...await postCatalog(request, mceleUrl('portal', 'catalog', { kind }), {
    searchResult: JSON.stringify({ searchText: query, sort: '2', pageNum: page }),
  }, page) };
}

export async function playlistVideos(request: APIRequestContext, playlistId: string, page = 1) {
  uuidSchema.parse(playlistId);
  pageSchema.parse(page);
  return { playlistId, ...await postCatalog(request, mceleUrl('portal', 'playlist'), {
    PlaylistId: playlistId, init: 'true', searchResult: JSON.stringify({ pageNum: page }),
  }, page) };
}

export async function findTrainingMedia(request: APIRequestContext, query: string) {
  const catalog = await searchCatalog(request, 'media', query);
  const playlists = catalog.items.filter(item => item.contentType === 'MVSPlaylist');
  const expanded = await Promise.all(playlists.slice(0, 3).map(playlist => playlistVideos(request, playlist.id)));
  const videos = new Map([...catalog.items, ...expanded.flatMap(playlist => playlist.items)]
    .filter(item => item.shortId && !item.audioOnly).map(item => [item.shortId, item]));
  return { query: catalog.query, videos: [...videos.values()], expandedPlaylists: expanded.length,
    moreAvailable: catalog.hasMore || expanded.some(playlist => playlist.hasMore) || playlists.length > 3 };
}

export async function resolveMedia(context: BrowserContext, shortId: string) {
  shortIdSchema.parse(shortId);
  const detailUrl = mceleUrl('portal', 'mediaDetail', { shortId });
  const page = await context.newPage();
  try {
    const response = await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response?.ok() || page.url() !== detailUrl) throw new Error('MCeLE media requires a current signed-in session.');
    const heading = page.locator('#media_detail h1.my-auto');
    const source = page.locator('video source[src]').first();
    await Promise.all([heading.waitFor({ timeout: 15_000 }), source.waitFor({ state: 'attached', timeout: 15_000 })]);
    const title = z.string().trim().min(1).max(1000).parse(await heading.innerText());
    const videoId = uuidSchema.parse(await page.locator('#VideoIdField').inputValue());
    const channelId = z.coerce.number().int().positive().parse(await page.locator('#ChannelIdField').inputValue());
    const flags = await page.locator('input[id$="IsFOUOField"]').evaluateAll(inputs =>
      inputs.map(input => (input as HTMLInputElement).value.toLowerCase()),
    );
    const manifestUrl = officialUrl((await source.getAttribute('src')) ?? '');
    if (manifestUrl.origin !== mceleConfig().origins.media || !manifestUrl.pathname.startsWith(mceleConfig().paths.mediaPrefix) ||
        !manifestUrl.pathname.endsWith(`/${videoId}.mpd`) && !manifestUrl.pathname.endsWith(`/${videoId}.mp3`)) {
      throw new Error('MCeLE returned an unexpected media source.');
    }
    const audioOnly = manifestUrl.pathname.endsWith('.mp3');
    return { shortId, title, detailUrl, manifestUrl: manifestUrl.href, videoId, channelId, audioOnly,
      cui: flags.includes('true') ? true : flags.length > 0 && flags.every(flag => flag === 'false') ? false : null,
      originalUrl: mceleUrl('media', 'mediaDownload', { shortId, extension: audioOnly ? '.mp3' : '.mp4' }) };
  } finally { await page.close(); }
}
