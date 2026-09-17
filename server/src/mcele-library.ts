import type { APIRequestContext } from 'playwright';
import { z } from 'zod';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mceleDirectory } from './mcele-session.ts';
import { mceleUrl } from './mcele-config.ts';

const maximumBytes = 128 * 1024 * 1024;
const shortIdSchema = z.string().regex(/^[A-F\d]{12}$/i);
const folderIdSchema = z.string().regex(/^[1-9]\d{0,9}$/);
const fileSchema = z.object({ Id: z.string().uuid(), ItemId: z.string().uuid(), FileName: z.string().max(500), FileSize: z.number().int().positive().max(maximumBytes) });
const signatures: Record<string, Buffer> = { '.pdf': Buffer.from('%PDF-'), '.docx': Buffer.from('504b0304', 'hex'), '.pptx': Buffer.from('504b0304', 'hex'), '.zip': Buffer.from('504b0304', 'hex') };

async function readBody(client: APIRequestContext, url: string) {
  const response = await client.get(url, { maxRedirects: 0, timeout: 30_000 });
  try {
    if (!response.ok()) throw new Error('MCeLE library access failed; renew the session or check access.');
    const body = await response.body();
    if (body.length > 2_000_000) throw new Error('MCeLE library metadata is too large.');
    return body.toString();
  } finally { await response.dispose(); }
}

async function download(client: APIRequestContext, data: Record<string, string>, name: string) {
  const directory = join(mceleDirectory, 'library');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, name), signature = signatures[extname(name)];
  if (!signature) throw new Error('MCeLE library supports PDF, DOCX, PPTX, and ZIP downloads.');
  const cached = await stat(path).catch(() => null);
  if (cached && cached.size > signature.length && cached.size <= maximumBytes) {
    const file = await open(path, 'r');
    try {
      const { buffer } = await file.read(Buffer.alloc(signature.length), 0, signature.length, 0);
      if (buffer.equals(signature)) return { path, bytes: cached.size, cached: true };
    } finally { await file.close(); }
  }
  const url = new URL(mceleUrl('portal', 'libraryDownload'));
  url.searchParams.set('data', JSON.stringify(data));
  // Send only cookies applicable to this exact HTTPS host/path; never follow a redirect.
  const { cookies } = await client.storageState();
  const cookie = cookies.filter(c => (c.domain.startsWith('.') ? url.hostname === c.domain.slice(1) || url.hostname.endsWith(c.domain) : url.hostname === c.domain)
    && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
    && (c.expires < 0 || c.expires > Date.now() / 1000)).map(c => `${c.name}=${c.value}`).join('; ');
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    const response = await fetch(url, { headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body || /^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length')) > maximumBytes) {
      await response.body?.cancel();
      throw new Error('MCeLE library returned no supported file under 128 MiB; check the session and access.');
    }
    let bytes = 0, prefix = Buffer.alloc(0);
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maximumBytes) return callback(new Error('MCeLE library download exceeds 128 MiB.'));
        if (prefix.length < signature.length) prefix = Buffer.concat([prefix, chunk.subarray(0, signature.length - prefix.length)]);
        if (prefix.length === signature.length && !prefix.equals(signature)) return callback(new Error('MCeLE library returned an unexpected file format.'));
        callback(null, chunk);
      },
    }), createWriteStream(partial, { mode: 0o600, flags: 'wx' }));
    if (bytes <= signature.length || !prefix.equals(signature)) throw new Error('MCeLE library returned an incomplete file.');
    await rename(partial, path);
    return { path, bytes, cached: false };
  } finally { await unlink(partial).catch(() => {}); }
}

export async function downloadLibraryItem(client: APIRequestContext, id: string) {
  z.union([shortIdSchema, z.string().uuid()]).parse(id);
  try {
    let shortId = id;
    if (id.includes('-')) {
      const html = await readBody(client, mceleUrl('portal', 'libraryDocument', { id }));
      const preview = html.match(/<[^>]+\bid=['"]previewItemContainer['"][^>]*>/i)?.[0];
      shortId = shortIdSchema.parse(preview?.match(/\bdata-shortid=['"]([^'"]+)['"]/i)?.[1]);
    }
    const file = fileSchema.parse(JSON.parse(await readBody(client, mceleUrl('portal', 'libraryMetadata', { shortId }))));
    return { id, shortId, filename: file.FileName, ...await download(client, { ItemId: file.ItemId, FileId: file.Id }, `${shortId.toUpperCase()}${extname(file.FileName).toLowerCase()}`) };
  } catch (error) { throw new Error(error instanceof Error && error.message.startsWith('MCeLE ') ? error.message : 'MCeLE library item download failed; check the session, ID, and supported file format.'); }
}

export async function downloadLibraryFolder(client: APIRequestContext, folderId: string) {
  folderIdSchema.parse(folderId);
  try { return { folderId, ...await download(client, { FolderId: folderId }, `folder-${folderId}.zip`) }; }
  catch (error) { throw new Error(error instanceof Error && error.message.startsWith('MCeLE ') ? error.message : 'MCeLE library folder download failed; check the session and folder access.'); }
}
