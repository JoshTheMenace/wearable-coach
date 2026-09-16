import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../contracts/index.ts';
import { captureRecordedFrame, FrameSampler, hudRows, inspectDemoFile, SIMULATED_DISPLAY, type CapturedFrame, type DemoAsset } from './device-simulator.ts';
import './simulator.css';

type Props = {
  snapshot: Snapshot; ready: boolean;
  send: (type: string, payload?: Record<string, unknown>) => void;
  report: (type: string, payload: Record<string, unknown>) => void;
  uploadFrame: (blob: Blob, meta: Record<string, unknown>) => Promise<{ status?: string; reason?: string }>;
  onCaptureReady: (capture: (() => Promise<CapturedFrame>) | null) => void;
  flushAudio: () => void;
};
type LocalVideo = { id: string; url: string; name: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function GlassesSimulator(props: Props) {
  const { snapshot, ready } = props, demonstration = snapshot.demonstration;
  const [camera, setCamera] = useState<LocalVideo | null>(null);
  const [demo, setDemo] = useState<(LocalVideo & DemoAsset) | null>(null);
  const [cameraError, setCameraError] = useState(''), [demoError, setDemoError] = useState('');
  const [cameraStatus, setCameraStatus] = useState('Choose a recording to simulate the camera.');
  const [demoStatus, setDemoStatus] = useState('No demonstration clip added.');
  const [decoded, setDecoded] = useState(false), [loadingDemo, setLoadingDemo] = useState(false);
  const [now, setNow] = useState(Date.now());
  const cameraVideo = useRef<HTMLVideoElement>(null), demoVideo = useRef<HTMLVideoElement>(null);
  const latest = useRef(props), sampler = useRef(new FrameSampler()), decodedFrames = useRef(0);
  const sourceEpoch = useRef(0), selection = useRef(0), mounted = useRef(true);
  const previousDemonstration = useRef<string | null>(null);
  latest.current = props;
  const allowed = ready && snapshot.status === 'active';
  const activeDemo = !!demonstration;

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selection.current++; sourceEpoch.current++; sampler.current.invalidate(); latest.current.onCaptureReady(null); }; }, []);
  useEffect(() => () => { if (camera) URL.revokeObjectURL(camera.url); }, [camera]);
  useEffect(() => () => { if (demo) URL.revokeObjectURL(demo.url); }, [demo]);

  useEffect(() => {
    decodedFrames.current = 0;
    const video = cameraVideo.current;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    let cancelled = false, callback = 0;
    const observe = (_now: number, frame: VideoFrameCallbackMetadata) => {
      if (cancelled) return;
      decodedFrames.current = frame.presentedFrames;
      callback = video.requestVideoFrameCallback(observe);
    };
    callback = video.requestVideoFrameCallback(observe);
    return () => { cancelled = true; video.cancelVideoFrameCallback(callback); };
  }, [camera]);

  useEffect(() => {
    sourceEpoch.current++; sampler.current.invalidate();
    if (!camera) { latest.current.onCaptureReady(null); return; }
    latest.current.onCaptureReady(async () => {
      const state = latest.current, epoch = sourceEpoch.current, video = cameraVideo.current;
      if (!state.ready || state.snapshot.status !== 'active') throw new Error('The simulator is disconnected. Reconnect before capturing.');
      if (state.snapshot.demonstration) throw new Error('Camera inspection is suspended while a demonstration plays.');
      if (!video) throw new Error('The camera recording is not ready.');
      return captureRecordedFrame(video, () => mounted.current && epoch === sourceEpoch.current && latest.current.ready && !latest.current.snapshot.demonstration);
    });
    return () => { sourceEpoch.current++; sampler.current.invalidate(); latest.current.onCaptureReady(null); };
  }, [camera, snapshot.id, snapshot.generation, ready, activeDemo]);

  useEffect(() => {
    if (!ready) return;
    const assets = demo ? [{ id: demo.id, width: demo.width, height: demo.height, durationMs: demo.durationMs, mime: demo.mime }] : [];
    latest.current.report('device.status', { displayCapabilities: SIMULATED_DISPLAY, demoAssets: assets, cameraSource: camera ? 'recorded_video' : 'mock', simulation: true });
  }, [ready, snapshot.id, snapshot.generation, camera, demo]);

  useEffect(() => {
    sampler.current.invalidate();
    if (!allowed || !camera || !snapshot.liveVideo || snapshot.config.provider !== 'gemini' || activeDemo) return;
    const sessionId = snapshot.id, generation = snapshot.generation, liveVideoEpoch = snapshot.liveVideoEpoch;
    const timer = setInterval(() => {
      const video = cameraVideo.current;
      if (!video) return;
      const frame = typeof video.requestVideoFrameCallback === 'function' ? decodedFrames.current : video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.currentTime;
      const lease = sampler.current.begin(frame, performance.now(), frame > 0 && !video.paused && !video.ended && !video.seeking && video.readyState >= 2);
      if (!lease) return;
      const current = () => lease.current() && mounted.current && latest.current.ready && latest.current.snapshot.id === sessionId && latest.current.snapshot.status === 'active' && latest.current.snapshot.liveVideo && latest.current.snapshot.generation === generation && latest.current.snapshot.liveVideoEpoch === liveVideoEpoch && !latest.current.snapshot.demonstration;
      void (async () => {
        try {
          const frame = await captureRecordedFrame(video, current);
          if (!current()) return;
          const result = await latest.current.uploadFrame(frame.blob, { ...frame.meta, generation, liveVideo: true, liveVideoEpoch });
          if (current()) { setCameraError(''); setCameraStatus(result.status === 'dropped' ? `Frame skipped: ${result.reason ?? 'provider busy'}.` : `Recorded frame sent · ${(Number(frame.meta.sourcePositionMs) / 1000).toFixed(1)}s into clip`); }
        } catch (error) { if (current()) { setCameraError(message(error)); latest.current.send('set_live_video', { enabled: false }); } }
        finally { lease.release(); }
      })();
    }, 150);
    return () => { clearInterval(timer); sampler.current.invalidate(); };
  }, [allowed, camera, snapshot.id, snapshot.generation, snapshot.liveVideo, snapshot.liveVideoEpoch, snapshot.config.provider, activeDemo]);

  useEffect(() => {
    if (!demonstration) {
      if (previousDemonstration.current) setDemoStatus('Demonstration closed. Resume the camera recording and enable uploads when ready.');
      previousDemonstration.current = null;
      return;
    }
    previousDemonstration.current = demonstration.requestId;
    if (!ready) { setDemoStatus('Demonstration paused while the simulator reconnects.'); return; }
    const request = demonstration, generation = snapshot.generation, video = demoVideo.current;
    let cancelled = false, terminal = false, playing = false;
    const current = () => !cancelled && mounted.current && latest.current.ready && latest.current.snapshot.generation === generation && latest.current.snapshot.demonstration?.requestId === request.requestId;
    const finish = (status: 'ended' | 'failed', reason?: string) => {
      if (!current() || terminal) return;
      terminal = true; clearTimeout(timeout); video?.pause();
      if (status === 'failed') setDemoError(reason ?? 'Demonstration playback failed.');
      setDemoStatus(status === 'ended' ? 'Demonstration finished; returning to the coaching card.' : 'Playback failed; the coaching card will return.');
      latest.current.report('demo.playback', { requestId: request.requestId, status, ...(reason ? { reason: reason.slice(0, 240) } : {}) });
    };
    const timeout = setTimeout(() => { if (!playing) finish('failed', 'Demonstration did not begin within 15 seconds.'); }, 15000);
    latest.current.flushAudio(); setDemoError(''); setDemoStatus('Starting demonstration…'); cameraVideo.current?.pause();
    if (!demo || demo.id !== request.assetId || !video) finish('failed', 'This demonstration file is unavailable in this browser. Choose it again.');
    else {
      video.currentTime = 0;
      video.onplaying = () => { if (current() && !terminal && !playing) { playing = true; clearTimeout(timeout); setDemoStatus('Demonstration playing · coach and camera uploads suspended'); latest.current.report('demo.playback', { requestId: request.requestId, status: 'playing' }); } };
      video.onended = () => finish('ended');
      video.onerror = () => finish('failed', 'The browser could not play this demonstration.');
      void video.play().catch(error => finish('failed', `Playback could not start: ${message(error)}`));
    }
    return () => { cancelled = true; clearTimeout(timeout); if (video) { video.pause(); video.onplaying = null; video.onended = null; video.onerror = null; } };
  }, [demonstration?.requestId, snapshot.generation, ready, demo]);

  const chooseCamera = (file?: File) => {
    sourceEpoch.current++; sampler.current.invalidate(); setDecoded(false); setCameraError('');
    if (snapshot.liveVideo) props.send('set_live_video', { enabled: false });
    setCamera(file ? { id: crypto.randomUUID(), url: URL.createObjectURL(file), name: file.name } : null);
    setCameraStatus(file ? 'Loading recording…' : 'Synthetic camera fixture selected.');
  };
  const chooseDemo = async (file?: File) => {
    const attempt = ++selection.current; setDemoError('');
    if (!file) { setLoadingDemo(false); setDemo(null); setDemoStatus('No demonstration clip added.'); return; }
    setLoadingDemo(true);
    try {
      const metadata = await inspectDemoFile(file);
      if (!mounted.current || attempt !== selection.current) return;
      setDemo({ ...metadata, id: crypto.randomUUID(), url: URL.createObjectURL(file), name: file.name });
      setDemoStatus('Demonstration ready. Use Play demo to test playback.');
    } catch (error) { if (mounted.current && attempt === selection.current) { setDemo(null); setDemoError(message(error)); } }
    finally { if (mounted.current && attempt === selection.current) setLoadingDemo(false); }
  };
  const rows = hudRows(snapshot.hud, now);
  return <section className="panel simulator-panel" aria-label="Glasses simulator">
    <div className="panel-head"><div><h2>Glasses simulator</h2><p>Local files stand in for the camera and requested demos. This is a browser simulation.</p></div><span className="badge">SIMULATED</span></div>
    <div className="simulator-grid">
      <div className="simulator-source">
        <h3>Recorded camera source</h3><p>The coach receives sampled frames from this recording, not a live scene. Camera files can use any video format your browser supports.</p>
        <label>Camera recording<input type="file" accept="video/*" disabled={!allowed || activeDemo} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) chooseCamera(file); }} /></label>
        {camera && <><video ref={cameraVideo} className="simulator-camera" src={camera.url} controls={!activeDemo} muted playsInline preload="auto" aria-label="Recorded camera preview" onLoadedData={() => { setDecoded(true); setCameraStatus('Recording ready. Play it to send changing frames.'); }} onPlay={() => { if (latest.current.snapshot.demonstration) cameraVideo.current?.pause(); else setCameraStatus('Camera recording playing.'); }} onPause={() => setCameraStatus('Camera recording paused · no continuous frames sent.')} onEnded={() => setCameraStatus('Camera recording ended · no continuous frames sent.')} onSeeking={() => { sourceEpoch.current++; decodedFrames.current = 0; sampler.current.invalidate(); }} onError={() => { setDecoded(false); setCameraError('This browser cannot decode the camera recording. Choose another file.'); if (snapshot.liveVideo) props.send('set_live_video', { enabled: false }); }} /><p className="simulator-filename">{camera.name}</p></>}
        <div className="button-row"><button className="secondary compact" disabled={!allowed || !decoded || activeDemo || snapshot.config.provider !== 'gemini'} onClick={() => props.send('set_live_video', { enabled: !snapshot.liveVideo })}>{snapshot.liveVideo ? 'Stop camera uploads' : 'Send camera to Gemini'}</button><button className="plain" disabled={!allowed || !snapshot.liveVideo || activeDemo} onClick={() => props.send('send_text', { text: 'Describe what you see in the recorded camera feed.', requireLiveVideo: true })}>Tell me what you see</button>{camera && <button className="plain" disabled={activeDemo} onClick={() => chooseCamera()}>Use synthetic fixture</button>}</div>
        <p className="simulator-status" role="status">{cameraStatus}</p>{snapshot.config.provider !== 'gemini' && <p>Continuous camera uploads require Gemini. Still inspection works with the selected provider.</p>}{cameraError && <p className="simulator-error" role="alert">{cameraError}</p>}
      </div>
      <div className="simulator-output">
        <div className="simulator-display" aria-label={activeDemo ? 'Simulated glasses demonstration' : 'Simulated centered glasses display'}>
          {activeDemo ? <><video ref={demoVideo} src={demo?.id === demonstration.assetId ? demo.url : undefined} playsInline preload="auto" aria-label="Demonstration playback" /><span className="simulator-video-label">DEMONSTRATION</span></> : rows.length ? <div className="simulator-card">{rows.map((row, index) => <div className={row.heading ? 'simulator-heading' : 'simulator-row'} key={index}>{row.text}</div>)}</div> : <p className="simulator-empty">Display clear</p>}
        </div>
        <p className="simulator-caption">600 × 600 display model · centered, four-row preview · hardware rendering unverified</p>
        <label>Requested demonstration · MP4<input type="file" accept="video/mp4,.mp4" disabled={!allowed || activeDemo || loadingDemo} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseDemo(file); }} /></label>
        <p>Separate from the camera source. Up to 400 pixels per side and 70,000 pixels total, for example 320 × 180. This prototype limits demos to five minutes.</p>
        {demo && <p className="simulator-filename">{demo.name} · {demo.width} × {demo.height} · {(demo.durationMs / 1000).toFixed(1)}s</p>}
        <div className="button-row"><button className="secondary compact" disabled={!allowed || !demo || activeDemo || loadingDemo} onClick={() => { props.flushAudio(); props.send('start_demo', { assetId: demo!.id }); }}>{loadingDemo ? 'Checking demo…' : 'Play demo'}</button><button className="plain" disabled={!allowed || !demonstration} onClick={() => props.send('stop_demo', { requestId: demonstration?.requestId })}>Stop demo</button></div>
        <p className="simulator-status" role="status">{demoStatus}</p>{demoError && <p className="simulator-error" role="alert">{demoError}</p>}
        <p>After a demo, resume the camera recording and enable uploads again. Watching a clip does not complete a practice step.</p>
      </div>
    </div>
  </section>;
}
