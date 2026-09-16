import { useEffect, useState } from 'react';
import { validateDemo } from './device-simulator.ts';
import type { DemoAsset } from '../../contracts/index.ts';

export type LessonIntro = { title: string; scope: string; facts: { id: string; text: string; source: { title: string; url: string } }[] };
export type LessonClip = DemoAsset & { lessonKey: 'overview' | 'hand-placement'; title: string; sha256: string; bytes: number; url: string };
export type CachedLessonClip = LessonClip & { localUrl: string };
type Manifest = { clips: LessonClip[]; intro?: LessonIntro };

export function useLessonMedia(sessionId: string | undefined, token: string | undefined, enabled: boolean, cacheClips: boolean) {
  const [manifest, setManifest] = useState<Manifest | null>(null), [clips, setClips] = useState<CachedLessonClip[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setManifest(null); setClips([]); setError('');
    if (!sessionId || !token || !enabled) { setLoading(false); return; }
    const controller = new AbortController(), urls: string[] = [];
    const timeout = setTimeout(() => controller.abort(new Error('Lesson media took too long to load. Try again.')), 30000);
    let cancelled = false;
    const load = async (path: string) => {
      if (!path.startsWith(`/api/sessions/${sessionId}/lesson-media`)) throw new Error('Lesson media must come from this session.');
      const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) throw new Error(`Lesson media unavailable (${response.status}).`);
      return response;
    };
    setLoading(true);
    void (async () => {
      try {
        const data = await (await load(`/api/sessions/${sessionId}/lesson-media`)).json() as Manifest;
        if (cancelled) return;
        if (!Array.isArray(data.clips) || data.clips.length > 20) throw new Error('The lesson media list is invalid.');
        if (!data.intro?.facts?.length) throw new Error('The CPR lesson references are unavailable. Check the training dataset and reload.');
        setManifest(data);
        if (cacheClips) {
          const cached: CachedLessonClip[] = [];
          for (const clip of data.clips) {
            validateDemo(clip.width, clip.height, clip.durationMs / 1000, clip.mime);
            if (!Number.isInteger(clip.bytes) || clip.bytes <= 0 || clip.bytes > 32 * 1024 * 1024 || !/^[a-f\d]{64}$/i.test(clip.sha256)) throw new Error('The lesson clip metadata is invalid.');
            const blob = await (await load(clip.url)).blob();
            if (blob.size !== clip.bytes) throw new Error('The downloaded clip is incomplete. Try loading it again.');
            const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
            if (digest !== clip.sha256.toLowerCase()) throw new Error('The lesson clip changed during download. Try loading it again.');
            if (cancelled) return;
            const localUrl = URL.createObjectURL(new Blob([blob], { type: 'video/mp4' }));
            urls.push(localUrl); cached.push({ ...clip, localUrl });
          }
          if (!cancelled) setClips(cached);
        }
      } catch (error) { if (!cancelled) setError(controller.signal.aborted ? 'Lesson media took too long to load. Try again.' : error instanceof Error ? error.message : String(error)); }
      finally { clearTimeout(timeout); if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [sessionId, token, enabled, cacheClips, attempt]);
  return { manifest, clips, loading, error, retry: () => setAttempt(value => value + 1) };
}
