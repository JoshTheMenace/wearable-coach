import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../contracts/index.ts';
import { captureRecordedFrame, FrameSampler, hudRows, inspectDemoFile, SIMULATED_DISPLAY, type CapturedFrame, type DemoAsset } from './device-simulator.ts';
import type { CachedLessonClip } from './lesson-media.ts';
import { LessonPageView } from './CprLesson.tsx';
import './simulator.css';

type Props = {
  snapshot: Snapshot; ready: boolean; lessonClips?: CachedLessonClip[]; loadingLessonMedia?: boolean; retryLessonMedia?: () => void;
  send: (type: string, payload?: Record<string, unknown>) => void;
  report: (type: string, payload: Record<string, unknown>) => void;
  uploadFrame: (blob: Blob, meta: Record<string, unknown>) => Promise<{ status?: string; reason?: string }>;
  onCaptureReady: (capture: (() => Promise<CapturedFrame>) | null) => void;
  flushAudio: () => void;
};
type LocalVideo = { id: string; url: string; name: string };
const noLessonClips: CachedLessonClip[] = [];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function GlassesSimulator(props: Props) {
  const { snapshot, ready, lessonClips = noLessonClips } = props, demonstration = snapshot.demonstration;
  const lessonMode = !!snapshot.lesson;
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
  const cameraResume = useRef<{ cameraId: string; playing: boolean; uploading: boolean } | null>(null);
  const cameraLiveBeforeDemo = useRef(false);
  const preparedDemo = lessonClips.find(clip => clip.id === demonstration?.assetId);
  const playbackId = preparedDemo?.id ?? demo?.id, playbackUrl = preparedDemo?.localUrl ?? demo?.url;
  latest.current = props;
  const allowed = ready && snapshot.status === 'active';
  const activeDemo = !!demonstration;
  const movieActive = !!demonstration && demonstration.status !== 'cueing';

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
    const assets = [...lessonClips, ...(demo ? [demo] : [])].map(asset => ({ id: asset.id, width: asset.width, height: asset.height, durationMs: asset.durationMs, mime: asset.mime, ...('lessonKey' in asset ? { lessonKey: asset.lessonKey } : {}) }));
    latest.current.report('device.status', { displayCapabilities: SIMULATED_DISPLAY, demoAssets: assets, cameraSource: camera ? 'recorded_video' : 'mock', simulation: true });
  }, [ready, snapshot.id, snapshot.generation, camera, demo, lessonClips]);

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
    if (ready && snapshot.liveVideo && !activeDemo && sampler.current.restartRequired) latest.current.send('set_live_video', { enabled: false });
  }, [ready, snapshot.generation, snapshot.liveVideo, activeDemo]);

  useEffect(() => { if (!activeDemo) cameraLiveBeforeDemo.current = snapshot.liveVideo; }, [activeDemo, snapshot.liveVideo]);

  useEffect(() => {
    if (!demonstration) {
      if (previousDemonstration.current) setDemoStatus(lessonMode ? 'Demonstration closed. Returning to your practice.' : 'Demonstration closed. Resume the camera recording and enable uploads when ready.');
      previousDemonstration.current = null;
      return;
    }
    if (previousDemonstration.current !== demonstration.requestId && lessonMode && camera) cameraResume.current = { cameraId: camera.id, playing: !!cameraVideo.current && !cameraVideo.current.paused && !cameraVideo.current.ended, uploading: demonstration.resumeLiveVideo ?? cameraLiveBeforeDemo.current };
    previousDemonstration.current = demonstration.requestId;
    if (!ready) { setDemoStatus('Demonstration paused while the simulator reconnects.'); return; }
    if (!movieActive) { cameraVideo.current?.pause(); setDemoStatus('The coach is introducing the clip. Video begins after the cue.'); return; }
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
    if (!playbackUrl || playbackId !== request.assetId || !video) finish('failed', 'This demonstration file is unavailable in this browser. Choose it again.');
    else {
      video.currentTime = 0;
      if (lessonMode) video.scrollIntoView({ behavior: 'smooth', block: 'center' });
      video.onplaying = () => { if (current() && !terminal && !playing) { playing = true; clearTimeout(timeout); setDemoStatus('Demonstration playing · coach and camera uploads suspended'); latest.current.report('demo.playback', { requestId: request.requestId, status: 'playing' }); } };
      video.onended = () => finish('ended');
      video.onerror = () => finish('failed', 'The browser could not play this demonstration.');
      void video.play().catch(error => finish('failed', `Playback could not start: ${message(error)}`));
    }
    return () => { cancelled = true; clearTimeout(timeout); if (video) { video.pause(); video.onplaying = null; video.onended = null; video.onerror = null; } };
  }, [demonstration?.requestId, movieActive, snapshot.generation, ready, playbackId, playbackUrl]);

  useEffect(() => {
    const video = cameraVideo.current;
    if (snapshot.lesson?.status === 'paused' && camera && video && !activeDemo) {
      cameraResume.current ??= { cameraId: camera.id, playing: !video.paused && !video.ended, uploading: snapshot.liveVideo };
      video.pause();
    }
  }, [snapshot.lesson?.status, camera?.id, activeDemo]);

  useEffect(() => {
    const resume = cameraResume.current;
    if (!resume || activeDemo || !allowed || snapshot.lesson?.status === 'paused') return;
    cameraResume.current = null;
    if (snapshot.lesson?.status !== 'active' || camera?.id !== resume.cameraId || !resume.playing) return;
    const video = cameraVideo.current;
    if (!video || video.ended) return;
    let cancelled = false;
    void video.play().then(() => {
      if (cancelled || latest.current.snapshot.demonstration || latest.current.snapshot.lesson?.status !== 'active') return;
      setCameraStatus('Practice recording resumed.');
      if (resume.uploading && !latest.current.snapshot.liveVideo) latest.current.send('set_live_video', { enabled: true });
    }).catch(error => { if (!cancelled) setCameraError(`Press play to resume your practice recording: ${message(error)}`); });
    return () => { cancelled = true; };
  }, [activeDemo, allowed, camera?.id, snapshot.generation, snapshot.lesson?.status]);

  const chooseCamera = (file?: File) => {
    sourceEpoch.current++; sampler.current.invalidate(); cameraResume.current = null; setDecoded(false); setCameraError('');
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
  const seekCamera = () => {
    sourceEpoch.current++; decodedFrames.current = 0; cameraResume.current = null;
    if (!latest.current.snapshot.liveVideo) { sampler.current.invalidate(); return; }
    sampler.current.suspend(); cameraVideo.current?.pause();
    if (latest.current.ready) latest.current.send('set_live_video', { enabled: false });
    setCameraStatus('Recording position changed. Restart camera uploads when ready.');
  };
  const toggleCamera = async () => {
    if (snapshot.liveVideo) { sampler.current.suspend(); props.send('set_live_video', { enabled: false }); return; }
    try {
      if (lessonMode) await cameraVideo.current?.play();
      sampler.current.resume(); props.send('set_live_video', { enabled: true }); setCameraError('');
    } catch (error) { setCameraError(`Camera recording could not start: ${message(error)}`); }
  };
  const rows = hudRows(snapshot.hud, now);
  return <section className="panel simulator-panel" aria-label="Glasses simulator">
    <div className="panel-head"><div><h2>{lessonMode ? 'Your camera and glasses display' : 'Glasses simulator'}</h2><p>{lessonMode ? 'Use a recorded practice as the camera feed. The coach sees that recording.' : 'Local files stand in for the camera and requested demos. This is a browser simulation.'}</p></div><span className="badge">SIMULATED</span></div>
    {lessonMode && <p className="lesson-cache-status" role="status">{props.loadingLessonMedia ? 'Preparing lesson videos…' : lessonClips.length ? `${lessonClips.map(clip => clip.lessonKey === 'overview' ? 'Overview' : 'Hand-placement replay').join(' · ')} ready` : 'Lesson clips are not ready yet.'}{!props.loadingLessonMedia && !lessonClips.length && <button className="plain" onClick={props.retryLessonMedia}>Reload lesson media</button>}</p>}
    <div className="simulator-grid">
      <div className="simulator-source">
        <h3>Recorded camera source</h3><p>The coach receives sampled frames from this recording, not a live scene. Camera files can use any video format your browser supports.</p>
        <label>Camera recording<input type="file" accept="video/*" disabled={!allowed || activeDemo} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) chooseCamera(file); }} /></label>
        {camera && <><video ref={cameraVideo} className="simulator-camera" src={camera.url} controls={!activeDemo} muted playsInline preload="auto" aria-label="Recorded camera preview" onLoadedData={() => { setDecoded(true); setCameraStatus('Recording ready. Play it to send changing frames.'); }} onPlay={() => { if (latest.current.snapshot.demonstration) cameraVideo.current?.pause(); else setCameraStatus('Camera recording playing.'); }} onPause={() => setCameraStatus(sampler.current.restartRequired ? 'Camera uploads stopped. Restart them when ready.' : 'Camera recording paused · no continuous frames sent.')} onEnded={() => setCameraStatus('Camera recording ended · no continuous frames sent.')} onSeeking={seekCamera} onError={() => { setDecoded(false); setCameraError('This browser cannot decode the camera recording. Choose another file.'); if (snapshot.liveVideo) props.send('set_live_video', { enabled: false }); }} /><p className="simulator-filename">{camera.name}</p></>}
        <div className="button-row"><button className="secondary compact" disabled={!allowed || !decoded || activeDemo || snapshot.lesson?.status === 'paused' || snapshot.config.provider !== 'gemini'} onClick={() => void toggleCamera()}>{snapshot.liveVideo ? 'Stop camera uploads' : lessonMode ? 'Start simulated practice feed' : 'Send camera to Gemini'}</button><button className="plain" disabled={!allowed || !snapshot.liveVideo || activeDemo} onClick={() => props.send('send_text', { text: 'Describe what you see in the recorded camera feed.', requireLiveVideo: true })}>Tell me what you see</button>{camera && <button className="plain" disabled={activeDemo} onClick={() => chooseCamera()}>Use synthetic fixture</button>}</div>
        <p className="simulator-status" role="status">{cameraStatus}</p>{snapshot.config.provider !== 'gemini' && <p>Continuous camera uploads require Gemini. Still inspection works with the selected provider.</p>}{cameraError && <p className="simulator-error" role="alert">{cameraError}</p>}
      </div>
      <div className="simulator-output">
        <div className="simulator-display" aria-label={movieActive ? 'Simulated glasses demonstration' : 'Simulated glasses display'}>
          {movieActive ? <><video ref={demoVideo} src={playbackId === demonstration.assetId ? playbackUrl : undefined} playsInline preload="auto" aria-label="Demonstration playback" /><span className="simulator-video-label">DEMONSTRATION</span></> : snapshot.hud.brand === 'marines' ? <div className="marine-welcome"><img src="/marines-emblem.png" alt="United States Marine Corps seal" /><h3>{snapshot.hud.card?.title}</h3><p>{snapshot.hud.card?.body}</p></div> : snapshot.hud.lessonPage ? <LessonPageView page={snapshot.hud.lessonPage} display /> : rows.length ? <div className="simulator-card">{rows.map((row, index) => <div className={row.heading ? 'simulator-heading' : 'simulator-row'} key={index}>{row.text}</div>)}</div> : <p className="simulator-empty">Display clear</p>}
        </div>
        <p className="simulator-caption">{lessonMode ? '600 × 600 lesson canvas · upper-middle layout · simulated' : '600 × 600 display model · centered, four-row preview · hardware rendering unverified'}</p>
        <details className="simulator-extra" open={lessonMode ? undefined : true}><summary hidden={!lessonMode}>Use a different demonstration clip</summary>
        <label>Requested demonstration · MP4<input type="file" accept="video/mp4,.mp4" disabled={!allowed || activeDemo || loadingDemo} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseDemo(file); }} /></label>
        <p>Separate from the camera source. Up to 400 pixels per side and 70,000 pixels total, for example 320 × 180. This prototype limits demos to ten minutes.</p>
        {demo && <p className="simulator-filename">{demo.name} · {demo.width} × {demo.height} · {(demo.durationMs / 1000).toFixed(1)}s</p>}
        <div className="button-row"><button className="secondary compact" disabled={!allowed || !demo || activeDemo || loadingDemo} onClick={() => { props.flushAudio(); props.send('start_demo', { assetId: demo!.id }); }}>{loadingDemo ? 'Checking demo…' : 'Play demo'}</button><button className="plain" disabled={!allowed || !demonstration} onClick={() => props.send('stop_demo', { requestId: demonstration?.requestId })}>Stop demo</button></div>
        </details>
        {lessonMode && demonstration && <button className="secondary compact" disabled={!allowed} onClick={() => props.send('lesson_action', { action: 'pause', expectedRevision: snapshot.lesson?.revision })}>Pause video</button>}
        <p className="simulator-status" role="status">{lessonMode && lessonClips.length && demoStatus === 'No demonstration clip added.' ? 'Ask your coach to play the overview or replay hand placement.' : demoStatus}</p>{demoError && <p className="simulator-error" role="alert">{demoError}</p>}
        <p>{lessonMode ? 'A playing practice recording resumes after the clip. A paused recording stays paused. Camera observations remain labeled as simulation.' : 'After a demo, resume the camera recording and enable uploads again. Watching a clip does not complete a practice step.'}</p>
      </div>
    </div>
  </section>;
}
