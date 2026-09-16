import { readFileSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { demoAssetsSchema } from '../../contracts/index.ts';

const clipSchema = demoAssetsSchema.element.extend({
  lessonKey: z.enum(['overview', 'hand-placement']), title: z.string().min(1).max(100),
  file: z.string().refine(name => basename(name) === name && name.endsWith('.mp4')),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(16 * 1024 * 1024),
  sourceStartSeconds: z.number().finite().min(0).optional(),
});
export function loadLessonMedia(dir = process.env.COACH_LESSON_MEDIA_DIR ?? '.runtime/lesson-media') {
  const clips: Array<z.infer<typeof clipSchema> & { data: Buffer }> = [];
  try {
    if(statSync(resolve(dir, 'manifest.json')).size>16000)throw new Error('Manifest too large');
    const manifest = z.object({ clips: z.array(clipSchema).max(2) }).parse(JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')));
    if ((['lessonKey', 'id'] as const).some(key => new Set(manifest.clips.map(clip => clip[key])).size !== manifest.clips.length)) throw new Error('Duplicate clip');
    for (const clip of manifest.clips) {
      if(statSync(resolve(dir, clip.file)).size!==clip.bytes)throw new Error('Invalid media size');
      const data = readFileSync(resolve(dir, clip.file));
      if (data.length !== clip.bytes || createHash('sha256').update(data).digest('hex') !== clip.sha256 || clip.width > 400 || clip.height > 400 || clip.width * clip.height > 70000) throw new Error('Invalid media');
      clips.push({ ...clip, data });
    }
  } catch { clips.length = 0; }
  return {
    list: (sessionId: string) => clips.map(({ data: _data, file: _file, ...clip }) => ({ ...clip, url: `/api/sessions/${sessionId}/lesson-media/${clip.id}` })),
    get: (id: string) => clips.find(clip => clip.id === id),
  };
}
