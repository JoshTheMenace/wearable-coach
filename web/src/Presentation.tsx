import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../contracts/index.ts';
import { LiveCameraPreview } from './LiveCameraPreview.tsx';
import { PresentationAudio } from './PresentationAudio.ts';
import { useLessonMedia } from './lesson-media.ts';
import type { PlaybackReport } from './PresentationVideo.tsx';
import './presentation.css';

export function Presentation() {
  const [requestedMode, setRequestedMode] = useState<'live'|'scripted_demo'|null>(location.pathname.replace(/\/$/, '') === '/demo' ? 'scripted_demo' : null);
  const [token, setToken] = useState(''), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [armed, setArmed] = useState(false), [sound, setSound] = useState(false), [connected, setConnected] = useState(false);
  const [error, setError] = useState(''), [serverError, setServerError] = useState(''), [now, setNow] = useState(Date.now()), [activity, setActivity] = useState(true);
  const audio = useRef(new PresentationAudio()), socket = useRef<WebSocket | null>(null), state = useRef(snapshot);
  const takeover = useRef(false);
  const offset = useRef(0), root = useRef<HTMLElement>(null), hideControls = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  state.current = snapshot;
  const media = useLessonMedia(snapshot?.id, token, !!snapshot, true);
  const update = useCallback((s: Snapshot | null, serverTime?: number) => {
    if (serverTime) offset.current = serverTime - Date.now();
    setSnapshot(previous => previous?.id === s?.id && previous && s && previous.throughSeq > s.throughSeq ? previous : s);
  }, []);

  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>, credential = '';
    const poll = async () => {
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]);
        if (!credential) {
          const response = await fetch('/api/local-access', { headers: { 'x-coach-local': '1' }, signal });
          if (!response.ok) throw new Error('Open this page on the laptop running the coach.');
          credential = (await response.json()).token; if (!abort.signal.aborted) setToken(credential);
        }
        const response = await fetch('/api/presentation-session', { headers: { Authorization: `Bearer ${credential}` }, signal });
        if (!response.ok) throw new Error('The coach server is unavailable.');
        const data = await response.json();
        if (!abort.signal.aborted) { update(data.snapshot, data.serverTime); setServerError(''); }
      } catch (e) { if (!abort.signal.aborted) setServerError(e instanceof Error ? e.message : 'Reconnecting to the coach…'); }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1500);
    };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [update]);

  useEffect(() => {
    if (!snapshot?.id || !token) return;
    let closed = false, retry: ReturnType<typeof setTimeout>, refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const id = snapshot.id, abort = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
        if (response.ok && !closed) { const data = await response.json(); if (!closed) update(data.snapshot, data.serverTime); }
      } catch { /* The session poll also recovers snapshots. */ }
    };
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/sessions/${id}/events`);
      socket.current = ws; ws.binaryType = 'arraybuffer';
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', token, audio: true, presentation: armed, takeover: armed && takeover.current })); if (armed) takeover.current = false; };
      ws.onmessage = event => {
        if (closed) return;
        if (event.data instanceof ArrayBuffer) { try { audio.current.play(event.data, state.current?.outputRate ?? 24000); } catch { audio.current.flush(); } return; }
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') { audio.current.bind(data.snapshot.generation, data.snapshot.speechEpoch); setConnected(true); setError(''); update(data.snapshot, data.serverTime); }
        if (data.type === 'flush') audio.current.bind(data.generation, data.speechEpoch);
        if (data.type === 'event') {
          if (['connection.replacing','session.ending','session.ended','demo.cue.finished'].includes(data.event.type)) audio.current.flush();
          if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 80);
        }
        if (data.type === 'error') setError(data.message);
      };
      ws.onclose = event => {
        if (closed) return; audio.current.flush(); setConnected(false);
        if (event.code === 4001) { audio.current.mute(); setSound(false); setArmed(false); setError('Presentation moved to another window.'); return; }
        retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => { closed = true; abort.abort(); clearTimeout(retry); clearTimeout(refreshTimer); socket.current?.close(); socket.current = null; audio.current.reset(); setConnected(false); };
  }, [snapshot?.id, token, armed, update]);

  useEffect(() => { if (snapshot) audio.current.bind(snapshot.generation, snapshot.speechEpoch); }, [snapshot?.generation, snapshot?.speechEpoch]);
  useEffect(() => {
    if (armed && connected && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'presentation.ready', ready: !!media.manifest?.clips.length && media.clips.length === media.manifest.clips.length && !media.error }));
  }, [armed, connected, media.clips.length, media.manifest?.clips.length, media.error]);
  useEffect(() => {
    if (armed && connected && requestedMode && snapshot?.config.practiceMode !== requestedMode && socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({ type: 'presentation.practice_mode', mode: requestedMode, commandId: crypto.randomUUID() }));
  }, [armed, connected, requestedMode, snapshot?.id, snapshot?.config.practiceMode]);
  useEffect(() => {
    if (!armed || !connected) return;
    const timer = setInterval(() => {
      const progress = audio.current.progress();
      if (progress.pendingMs && socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: 'presentation.audio', ...progress }));
    }, 250);
    return () => clearInterval(timer);
  }, [armed, connected]);
  useEffect(() => {
    const sync = () => setRequestedMode(location.pathname.replace(/\/$/, '') === '/demo' ? 'scripted_demo' : 'live');
    window.addEventListener('popstate', sync); return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() + offset.current), 250); return () => clearInterval(timer); }, []);
  useEffect(() => () => { audio.current.close(); clearTimeout(hideControls.current); }, []);
  const report = useCallback<PlaybackReport>((requestId, status, reason) => {
    const current = state.current;
    if (socket.current?.readyState === WebSocket.OPEN && current?.demonstration?.requestId === requestId)
      socket.current.send(JSON.stringify({ type: 'demo.playback', generation: current.generation, messageId: crypto.randomUUID(), payload: { requestId, status, ...(reason ? { reason } : {}) } }));
  }, []);
  const enable = async () => {
    try { await audio.current.enable(); if (!armed) takeover.current = true; setArmed(true); setSound(true); setError(''); wakeControls(); }
    catch { setError('Click Enable presentation again to allow sound.'); }
  };
  const wakeControls = () => { setActivity(true); clearTimeout(hideControls.current); hideControls.current = setTimeout(() => setActivity(false), 3000); };
  const switchMode = (demo: boolean) => { history.pushState(null, '', demo ? '/demo' : '/'); setRequestedMode(demo ? 'scripted_demo' : 'live'); wakeControls(); };
  const caption = snapshot?.demonstration?.status !== 'playing' ? snapshot?.transcripts.at(-1) : undefined;
  const presentationMode = requestedMode === 'scripted_demo' || snapshot?.config.practiceMode === 'scripted_demo';
  const fragments = snapshot?.transcripts ?? [];
  const captionText = fragments.slice(fragments.findLastIndex(fragment => fragment.speaker !== caption?.speaker) + 1).map(fragment => fragment.text).join('').trim().slice(-220);
  return <main ref={root} className={`presentation ${activity || !snapshot || error || serverError ? 'controls-visible' : ''}`} onPointerMove={wakeControls} onKeyDown={wakeControls}>
    <header className="presentation-bar"><span className="presentation-brand">MARINE TUTOR</span><span className="presentation-status">{error || serverError || (!snapshot ? 'Ready for the phone' : connected ? 'LIVE' : 'Reconnecting…')}</span>
      {armed && <div><button onClick={() => switchMode(!presentationMode)}>{presentationMode ? 'Standard mode' : 'Presentation mode'}</button><button onClick={() => { if (sound) { audio.current.mute(); setSound(false); } else void enable(); }}>{sound ? 'Sound on' : 'Sound off'}</button><button onClick={() => void root.current?.requestFullscreen().catch(() => setError('Use the browser’s full-screen control.'))}>Full screen</button></div>}
    </header>
    {snapshot ? <LiveCameraPreview snapshot={snapshot} token={token} now={now} clips={media.clips} mediaLoading={media.loading} mediaError={media.error} retryMedia={media.retry} sound={sound} onPlayback={armed && connected ? report : undefined} />
      : <section className="presentation-wait"><img src="/marines-emblem.png" alt="United States Marine Corps seal" /><h1>Ready when you are.</h1><p>Tap <strong>Start coach</strong> on your phone.<br />Your glasses view will appear here automatically.</p></section>}
    {caption?.text && <div className="presentation-caption"><span>{['user', 'learner'].includes(caption.speaker) ? 'LEARNER' : 'COACH'}</span>{captionText}</div>}
    {!armed && <div className="presentation-enable"><div><h2>Let the room see and hear.</h2><p>Enable sound once, then start the coach on your phone.</p><button onClick={() => void enable()}>Enable presentation</button><small>Audio uses the laptop’s selected output, including HDMI / TV.</small></div></div>}
    {armed && !snapshot && <footer className="presentation-setup"><button onClick={() => void audio.current.test()}>Test TV sound</button><a href="/lab">Developer controls</a></footer>}
    {media.error && <div className="presentation-error" role="alert">{media.error}<button onClick={media.retry}>Reload video</button></div>}
  </main>;
}
