import { useEffect, useRef, useState } from 'react';
import type { Demonstration } from '../../contracts/index.ts';
import type { CachedLessonClip } from './lesson-media.ts';

// A spectator player: only device reports advance or end the lesson.
export function MirrorVideo({ demo, clip, now, mediaError, retryMedia, sound }: {
  demo: Demonstration; clip?: CachedLessonClip; now: number; mediaError: string; retryMedia: () => void;
  sound?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null), clockOffset = useRef(0);
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [muted, setMuted] = useState(true);
  clockOffset.current = now - Date.now();
  useEffect(() => {
    const player = video.current;
    if (!player || !clip) return;
    let cancelled = false;
    setError('');
    const sync = () => {
      if (player.readyState < 1 || demo.status !== 'playing') return;
      const elapsed = Math.max(0, (Date.now() + clockOffset.current - (demo.playbackStartedAt ?? demo.startedAt)) / 1000);
      const target = Math.min(elapsed, Math.max(0, player.duration - 0.05));
      if (Number.isFinite(target) && Math.abs(player.currentTime - target) > 0.75) player.currentTime = target;
    };
    const play = () => {
      sync();
      if (demo.status === 'playing') void player.play().catch(() => { if (!cancelled) setError('Video playback could not start in this browser.'); });
    };
    player.onloadedmetadata = play;
    player.onerror = () => setError('The mirror could not play this video.');
    if (attempt) player.load();
    play();
    const timer = setInterval(sync, 1000);
    return () => { cancelled = true; clearInterval(timer); player.pause(); player.onloadedmetadata = null; player.onerror = null; };
  }, [demo.status, demo.startedAt, demo.playbackStartedAt, clip?.localUrl, attempt]);
  const failure = mediaError || error;
  return <div className="mirror-video">
    {clip && <video ref={video} src={clip.localUrl} muted={sound === undefined ? muted : !sound} playsInline preload="auto" aria-label="Mirrored lesson video" />}
    {(failure || !clip || demo.status !== 'playing') && <div className="mirror-video-status" role="status">
      <p>{failure || (demo.status !== 'playing' ? 'Waiting for video to start on the glasses…' : 'Loading the lesson video…')}</p>
      {failure && <button className="secondary" onClick={() => mediaError ? retryMedia() : setAttempt(value => value + 1)}>Retry mirror video</button>}
    </div>}
    {sound === undefined && clip && demo.status === 'playing' && <button className="mirror-video-sound secondary" onClick={() => setMuted(value => !value)}>{muted ? 'Enable video sound' : 'Mute video sound'}</button>}
  </div>;
}
