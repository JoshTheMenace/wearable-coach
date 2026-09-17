import { useEffect, useRef, useState } from 'react';
import type { Demonstration } from '../../contracts/index.ts';
import type { CachedLessonClip } from './lesson-media.ts';

export type PlaybackReport = (requestId: string, status: 'playing'|'ended'|'failed', reason?: string) => void;

export function PresentationVideo({ demo, clip, sound, report }: { demo: Demonstration; clip?: CachedLessonClip; sound: boolean; report: PlaybackReport }) {
  const video = useRef<HTMLVideoElement>(null), sent = useRef(false), callback = useRef(report);
  const [error, setError] = useState(''); callback.current = report;
  useEffect(() => {
    const player = video.current;
    if (!player || !clip) return;
    let cancelled = false;
    const failed = () => { if (!cancelled) { setError('Video could not start.'); callback.current(demo.requestId, 'failed', 'Presentation video playback failed'); } };
    player.onplaying = () => { if (!sent.current) { sent.current = true; callback.current(demo.requestId, 'playing'); } };
    player.onended = () => { if (sent.current) callback.current(demo.requestId, 'ended'); };
    player.onerror = failed;
    // A replacement presentation window joins the current movie instead of replaying it.
    player.onloadedmetadata = () => {
      if (demo.status === 'playing' && demo.playbackStartedAt)
        player.currentTime = Math.min(player.duration, Math.max(0, (Date.now() - demo.playbackStartedAt) / 1000));
    };
    if (player.readyState >= 1) player.onloadedmetadata(new Event('loadedmetadata'));
    void player.play().catch(failed);
    return () => { cancelled = true; player.onplaying = null; player.onended = null; player.onerror = null; player.onloadedmetadata = null; player.pause(); };
  }, [demo.requestId, clip?.localUrl]);
  return <div className="presentation-video">
    {clip && <video ref={video} src={clip.localUrl} muted={!sound} playsInline preload="auto" aria-label="Presentation lesson video" />}
    {(!clip || error) && <p role="status">{error || 'Preparing video…'}</p>}
  </div>;
}
