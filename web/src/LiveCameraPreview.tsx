import { useEffect, useRef, useState } from 'react';
import './camera-preview.css';

export function LiveCameraPreview({ sessionId, token, active, assessing, playingVideo }: { sessionId:string;token:string;active:boolean;assessing:boolean;playingVideo:boolean }) {
  const [image, setImage] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    setImage('');
    if (!active || playingVideo) return;
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
  }, [sessionId,token,active,playingVideo]);
  return <section ref={panel} className="live-camera-preview" aria-label="Glasses camera preview">
    <header><div><strong>Through your eyes</strong><span>{playingVideo?'Playing a lesson video':image?'Live from glasses':'Waiting for the glasses camera'}</span></div>
      <button className="plain" onClick={()=>void panel.current?.requestFullscreen().catch(()=>{})}>Full screen</button></header>
    <div className="live-camera-picture">{playingVideo?<p>Camera preview pauses while the glasses play video. It resumes automatically afterward.</p>:image?<img src={image} alt="Current view from the glasses camera"/>:<p>{active?'The camera preview will appear here.':'Camera session ended.'}</p>}</div>
    <footer>{assessing?'Coach is checking hand placement':'Camera preview only · AI assessment is off'}<span>Sampled live view · not recorded</span></footer>
  </section>;
}
