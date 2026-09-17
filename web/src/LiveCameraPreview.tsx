import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Snapshot } from '../../contracts/index.ts';
import type { CachedLessonClip } from './lesson-media.ts';
import { HudContent } from './HudContent.tsx';
import { MirrorVideo } from './MirrorVideo.tsx';
import { PresentationVideo, type PlaybackReport } from './PresentationVideo.tsx';
import './camera-preview.css';

export function LiveCameraPreview({ snapshot, token, now, clips, mediaLoading, mediaError, retryMedia, sound, onPlayback }: {
  snapshot: Snapshot; token: string; now: number; clips: CachedLessonClip[]; mediaLoading: boolean; mediaError: string; retryMedia: () => void;
  sound?: boolean; onPlayback?: PlaybackReport;
}) {
  const { id: sessionId, hud, demonstration: demo } = snapshot;
  const active = !['ended', 'failed', 'interrupted'].includes(snapshot.status);
  const playingVideo = active && !!demo && demo.status !== 'cueing';
  const laptopVideo = demo?.target === 'presentation';
  const assessing = snapshot.liveVideo && snapshot.lesson?.ready && !demo;
  const clip = clips.find(clip => clip.id === demo?.assetId);
  const showHud = active && !playingVideo && (hud.expiresAt ?? Infinity) > now && !!(hud.brand || hud.lessonPage || hud.card || hud.checklist?.length || hud.timer);
  const [image, setImage] = useState('');
  const [aspect, setAspect] = useState(4 / 3);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    setImage('');
    if (!active || playingVideo && !laptopVideo) return;
    const abort = new AbortController();
    let timer:ReturnType<typeof setTimeout>, url='', receivedAt='';
    const clear = () => { if(url)URL.revokeObjectURL(url);url='';receivedAt='';setImage(''); };
    const poll = async () => {
      let delay = 250;
      try {
        const response = await fetch(`/api/sessions/${sessionId}/camera-preview`, {
          headers:{Authorization:`Bearer ${token}`}, cache:'no-store', signal:AbortSignal.any([abort.signal,AbortSignal.timeout(2000)]),
        });
        if(abort.signal.aborted)return;
        if(response.status===204)clear();
        else {
          if(!response.ok)throw new Error('Camera preview unavailable');
          const at=response.headers.get('x-frame-received-at')??'';
          if(at!==receivedAt){
            const blob=await response.blob();if(abort.signal.aborted)return;
            if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(blob);receivedAt=at;setImage(url);
          }
        }
      } catch { if(!abort.signal.aborted){clear();delay=1000;} }
      if(!abort.signal.aborted)timer=setTimeout(poll,delay);
    };
    void poll();
    return () => { abort.abort();clearTimeout(timer);if(url)URL.revokeObjectURL(url); };
  }, [sessionId,token,active,playingVideo,laptopVideo]);
  return <section ref={panel} className="live-camera-preview" aria-label="Glasses camera preview">
    <header><div><strong>Glasses mirror</strong><span>{!active?'Session ended':playingVideo?'Lesson video':image?'Live camera + coach display':'Waiting for the glasses camera'}</span></div>
      <button className="plain" onClick={()=>void panel.current?.requestFullscreen().catch(()=>{})}>Full screen</button></header>
    <div className="live-camera-picture">
      {playingVideo && !laptopVideo ? <MirrorVideo key={demo.requestId} demo={demo} clip={clip} now={now} sound={sound} mediaError={mediaError || (!mediaLoading && !clip ? 'This video is unavailable in the laptop mirror.' : '')} retryMedia={retryMedia} />
        : <div className="mirror-scene" style={{ '--camera-aspect': aspect } as CSSProperties}>
          {image ? <img className="mirror-camera-image" src={image} onLoad={event => setAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} alt="Current view from the glasses camera" /> : <p className="mirror-camera-empty">{active ? 'The camera preview will appear here.' : 'Camera session ended.'}</p>}
          {showHud && <aside className="mirror-hud" aria-label="Mirrored coach display"><HudContent hud={hud} now={now} /></aside>}
          {playingVideo && laptopVideo && <div className="mirror-movie-overlay" style={{ aspectRatio: clip ? clip.width / clip.height : 16 / 9 }}>{onPlayback
            ? <PresentationVideo key={demo.requestId} demo={demo} clip={clip} sound={!!sound} report={onPlayback} />
            : <MirrorVideo key={demo.requestId} demo={demo} clip={clip} now={now} mediaError={mediaError} retryMedia={retryMedia} sound={sound} />}</div>}
        </div>}
    </div>
    <footer>{playingVideo?laptopVideo?'Camera stays live during the video':'Camera resumes after the video':assessing?'Coach is checking hand placement':'Camera preview only · AI assessment is off'}<span>{playingVideo?'Lesson playback mirror':'Sampled camera · live coaching cards'}</span></footer>
  </section>;
}
