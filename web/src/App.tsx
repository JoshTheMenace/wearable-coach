import { useCallback, useEffect, useRef, useState } from 'react';

type Json = Record<string, any>;
type Provider = { id: string; model: string; available: boolean; reason?: string; inputRate: number; outputRate: number };
type Session = { sessionId: string; token: string; spectatorToken?: string; readOnly?: boolean };
type Snapshot = Json & { id: string; generation: number; speechEpoch: number; hudRevision: number; throughSeq: number; status: string; config: Json; transcripts: Json[]; hud: Json; receipts: Json[]; work: Json[]; usage: Json[] };
const uuid = () => crypto.randomUUID();
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const terminal = (status?: string) => ['ended', 'failed', 'interrupted'].includes(status ?? '');
const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const latestSnapshot = (current: Snapshot | null, next: Snapshot) => !current || current.id !== next.id || next.throughSeq >= current.throughSeq ? next : current;
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(`${status}: ${message}`); }
}

async function request(path: string, token: string, options: RequestInit = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...options.headers } });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { const json = JSON.parse(text); message = json.error?.message ?? json.error ?? json.message ?? text; } catch {}
    throw new HttpError(response.status, typeof message === 'string' ? message : JSON.stringify(message));
  }
  return response;
}

async function recoverSession(session: Session, generation: number) {
  const path = `/sessions/${session.sessionId}`;
  try {
    return await (await request(`${path}/reconnect`, session.token, { method: 'POST', body: JSON.stringify({ generation, requestId: uuid() }) })).json();
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    return await (await request(path, session.token)).json();
  }
}

function InspectionStatus({ work, simulated, canRetry, retry }: { work: Json; simulated: boolean; canRetry: boolean; retry: (question: string) => void }) {
  const result = work.result ?? {};
  const observation = result.observation;
  const unsuccessful = ['failed', 'cancelled', 'aborted', 'discarded'].includes(work.status);
  const pending = ['reserved', 'running'].includes(work.status);
  const question = typeof work.input?.question === 'string' ? work.input.question : '';
  const title = work.status === 'reserved' ? 'Waiting for a fresh capture' : work.status === 'running' ? 'Analyzing the captured frame'
    : unsuccessful ? `Inspection ${work.status}` : simulated && result.status === 'dispatched' ? 'Simulation completed'
    : result.status === 'context_dispatched' ? 'Observation sent to coach' : result.status === 'dispatched' ? 'Frame sent to coach' : 'Inspection completed';
  return <section className={`inspection-status ${unsuccessful ? 'unsuccessful' : ''}`} aria-label="Latest inspection">
    <div className="inspection-heading" role="status"><strong>{title}</strong>{typeof result.elapsedMs === 'number' && Number.isFinite(result.elapsedMs) && <span>{(result.elapsedMs / 1000).toFixed(1)}s elapsed</span>}</div>
    {question && <p className="inspection-question">{question}</p>}
    {unsuccessful && <p>{typeof result.reason === 'string' ? result.reason.slice(0, 240).replaceAll('_', ' ') : 'This inspection did not complete.'}</p>}
    {!pending && !unsuccessful && <p>{simulated && result.status === 'dispatched' ? 'The mock received a frame and did not interpret its contents.' : 'Model interpretation. A spoken response and audible playback remain unconfirmed.'}</p>}
    {(result.frameId ?? work.frameId) && <div className="inspection-frame"><span>Frame <code>{String(result.frameId ?? work.frameId)}</code></span><span>Freshness at inspection: {typeof result.captureFreshness === 'string' ? result.captureFreshness : 'unknown'}</span></div>}
    {observation && <details><summary>Model observation{typeof observation.visibility === 'string' ? ` · ${observation.visibility}` : ''}</summary>{(['claims', 'limitations'] as const).map(field => {
      const values = Array.isArray(observation[field]) ? observation[field].filter((value: unknown) => typeof value === 'string') : typeof observation[field] === 'string' ? [observation[field]] : [];
      return values.length ? <div className="inspection-findings" key={field}><span>{field === 'claims' ? 'Model claims' : 'Limitations'}</span><ul>{values.map((value: string, index: number) => <li key={index}>{value}</li>)}</ul></div> : null;
    })}</details>}
    {unsuccessful && canRetry && <button className="secondary compact" disabled={!question.trim()} onClick={() => retry(question)}>Retry inspection</button>}
  </section>;
}

function LiveVideoStatus({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const stats = snapshot.liveVideoStats;
  const age = typeof stats?.lastFrameReceivedAt === 'number' ? Math.max(0, Math.floor((now - stats.lastFrameReceivedAt) / 1000)) : null;
  return <section className="inspection-status" aria-label="Live camera status">
    <div className="inspection-heading"><strong>Live camera · {snapshot.liveVideo ? 'Enabled' : 'Disabled'}</strong><span>{stats?.submitted ?? 0} submitted · {stats?.dropped ?? 0} dropped</span></div>
    <p>{age === null ? 'No live frame received yet.' : `Last reported frame received ${age}s ago; sensor capture age unknown.`}</p>
    <p>Gemini reads sampled video directly (≤1 fps), without a separate observer check. Live video is not recorded or shown in this preview. Start or stop it on Android.</p>
  </section>;
}

function DiagnosticsPanel({ path, token, scope }: { path: string; token: string; scope: string }) {
  const [data, setData] = useState<{ reports: Json[]; counts: { total: number; bySeverity: Record<string, number>; byCode: Record<string, number> } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setLoading(true);
    try {
      const next = await (await request(path, token, { signal: current.signal })).json();
      if (!current.signal.aborted) { setData(next); setFailure(''); setUpdatedAt(Date.now()); }
    } catch (error) { if (!current.signal.aborted) setFailure(errorMessage(error)); }
    finally { if (!current.signal.aborted) setLoading(false); }
  }, [path, token]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => { clearInterval(timer); controller.current?.abort(); };
  }, [refresh]);
  const exportDiagnostics = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: Date.now(), scope, ...data }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `fieldwork-diagnostics-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="panel testing-diagnostics" aria-label={`${scope} diagnostics`}>
    <div className="panel-head"><div><h2>Testing diagnostics</h2><p>{scope} · setup, connection, and device failures</p></div><div className="diagnostic-actions"><button className="plain" onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh diagnostics'}</button><button className="plain" onClick={exportDiagnostics} disabled={!data}>Export diagnostics ↓</button></div></div>
    {failure && <div className="diagnostic-error" role="status">Diagnostics unavailable: {failure}{data && ' · Showing the last successful response.'}</div>}
    {data && <div className="diagnostic-counts"><span>{data.counts.total} total</span><span className="diagnostic-error-count">Errors: {data.counts.bySeverity.error ?? 0}</span><span>Warnings: {data.counts.bySeverity.warning ?? 0}</span><span>Info: {data.counts.bySeverity.info ?? 0}</span><span>Updated {time(updatedAt)}</span><details><summary>Counts by code</summary><pre>{JSON.stringify(data.counts.byCode, null, 2)}</pre></details></div>}
    <div className="diagnostic-reports">{data?.reports.length ? data.reports.map(report => <details className="diagnostic-report" key={report.eventId}>
      <summary><span className={`severity ${report.severity}`}>{report.severity}</span><span className="diagnostic-title"><strong>{report.code}</strong><span>{report.message}</span></span><time>{time(report.receivedAt)}</time></summary>
      <div className="diagnostic-context"><span>Stage <strong>{report.stage ?? 'unknown'}</strong></span><span>Recovery <strong>{report.recovery === 'user_action' ? 'User action required' : String(report.recovery ?? 'not reported').replaceAll('_', ' ')}</strong></span><span>{report.sessionId ? `Session ${report.sessionId.slice(0, 8)} · G${report.generation ?? '?'}` : 'Before session creation'}</span></div>
      <pre>{JSON.stringify({ occurredAt: report.occurredAt, receivedAt: report.receivedAt, deviceInstallId: report.deviceInstallId, runId: report.runId, ...report.details }, null, 2)}</pre>
    </details>) : <p className="diagnostic-empty">{loading && !data ? 'Loading diagnostic reports…' : data ? 'No reports received. This does not confirm that every device is healthy.' : 'Use Refresh diagnostics to try again.'}</p>}</div>
  </section>;
}

export function App() {
  const [operatorToken, setOperatorToken] = useState(() => sessionStorage.getItem('coach.operator') ?? '');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState('mock');
  const [device, setDevice] = useState('mock');
  const [recordFrames, setRecordFrames] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<Json[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState('offline');
  const [controlReady, setControlReady] = useState(false);
  const [bindingAttempt, setBindingAttempt] = useState(0);
  const [text, setText] = useState('What do you see?');
  const [question, setQuestion] = useState('Read the zone label in this current view.');
  const [hudTitle, setHudTitle] = useState('Next step');
  const [hudBody, setHudBody] = useState('Pause, observe, then describe what you see.');
  const [joinId, setJoinId] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [zone, setZone] = useState('A');
  const [imageUrl, setImageUrl] = useState('');
  const [now, setNow] = useState(Date.now());
  const [sound, setSound] = useState(false);
  const [muted, setMuted] = useState(true);
  const [sessionList, setSessionList] = useState<Json[]>([]);
  const [copied, setCopied] = useState(false);
  const control = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const zoneRef = useRef(zone);
  const audio = useRef<AudioContext | null>(null);
  const sources = useRef(new Set<AudioBufferSourceNode>());
  const audioUntil = useRef(0);
  const suppressed = useRef(false);
  const ending = useRef(false);
  const audioEpoch = useRef(0);
  const audioSeq = useRef(-1);
  const soundRef = useRef(false);
  const renderer = useRef(uuid());
  const captionEnd = useRef<HTMLDivElement>(null);
  const lastCaption = useRef(0);
  const cursor = useRef(0);
  const serverOffset = useRef(0);
  const commandPending = useRef(new Map<string, { envelope: Json; sentAt: number }>());
  const active = !!snapshot && !terminal(snapshot.status);
  const mockDevice = snapshot?.config.device === 'mock';
  const canControl = !!session && !session.readOnly && (controlReady || !mockDevice) && active;
  const selected = providers.find(item => item.id === provider);
  zoneRef.current = zone;
  snapshotRef.current = snapshot;
  soundRef.current = sound;

  const flushAudio = useCallback(() => {
    for (const source of sources.current) { try { source.stop(); } catch {} }
    sources.current.clear();
    audioUntil.current = 0;
  }, []);
  const leave = () => {
    flushAudio();
    setSession(null); setSnapshot(null); setEvents([]); setImageUrl(''); setConnection('offline');
  };
  const loadProviders = async () => {
    setBusy(true); setError('');
    try {
      sessionStorage.setItem('coach.operator', operatorToken);
      const data = await (await request('/providers', operatorToken)).json();
      setProviders(data.providers);
      const dataSessions = await (await request('/sessions', operatorToken)).json();
      setSessionList(Array.isArray(dataSessions) ? dataSessions : dataSessions.sessions ?? []);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setError('');
    try {
      const data = await (await request('/sessions', operatorToken, { method: 'POST', body: JSON.stringify({ createKey: uuid(), config: { provider, model: selected?.model ?? 'mock-coach', device, recordFrames } }) })).json();
      setEvents([]); cursor.current = 0; renderer.current = uuid(); ending.current = false;
      setSnapshot(data.snapshot); setSession({ sessionId: data.sessionId, token: data.token, spectatorToken: data.spectatorToken });
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const join = async (id = joinId, token = joinToken) => {
    setBusy(true); setError('');
    try {
      const data = await (await request(`/sessions/${encodeURIComponent(id)}`, token)).json();
      setEvents([]); cursor.current = 0;
      setSnapshot(data.snapshot ?? data); setSession({ sessionId: id, token, readOnly: true });
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const send = (type: string, payload: Json = {}) => {
    if (!canControl || !session || !snapshot || (mockDevice && control.current?.readyState !== WebSocket.OPEN)) { setError('Control connection is unavailable. Reconnect before sending.'); return; }
    if (type === 'stop_speech' || type === 'end_session') { suppressed.current = true; flushAudio(); }
    if (type === 'end_session') ending.current = true;
    const envelope = { schemaVersion: 1, sessionId: session.sessionId, generation: snapshot.generation, messageId: uuid(), commandId: uuid(), type, payload };
    if (mockDevice) {
      commandPending.current.set(envelope.commandId, { envelope, sentAt: Date.now() });
      control.current!.send(JSON.stringify(envelope));
    } else {
      void request(`/sessions/${session.sessionId}/commands`, session.token, { method: 'POST', body: JSON.stringify(envelope) }).catch(error => setError(errorMessage(error)));
    }
  };
  const reconnect = async () => {
    if (!session || !snapshot) return;
    setBusy(true); setError(''); suppressed.current = true; flushAudio();
    try {
      const data = await recoverSession(session, snapshot.generation);
      setSnapshot(previous => latestSnapshot(previous, data.snapshot));
      if (data.snapshot.generation === snapshotRef.current?.generation && control.current?.readyState !== WebSocket.OPEN) setBindingAttempt(value => value + 1);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const exportEvidence = async () => {
    if (!session) return;
    try {
      const response = await request(`/sessions/${session.sessionId}/export`, session.token);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `fieldwork-${session.sessionId}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(errorMessage(error)); }
  };

  useEffect(() => {
    const saved = sessionStorage.getItem('coach.session');
    if (!saved) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const restored: Session = JSON.parse(saved);
        let data = await (await request(`/sessions/${encodeURIComponent(restored.sessionId)}`, restored.token)).json();
        if (!restored.readOnly && data.snapshot.config.device === 'mock' && !terminal(data.snapshot.status)) {
          data = await recoverSession(restored, data.snapshot.generation);
        }
        if (!cancelled) { setSnapshot(data.snapshot); setSession(restored); }
      } catch (error) { if (!cancelled) setError(`Could not restore the last session: ${errorMessage(error)}`); }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (session) sessionStorage.setItem('coach.session', JSON.stringify(session));
    else sessionStorage.removeItem('coach.session');
  }, [session]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const data = await (await request(`/sessions/${session.sessionId}`, session.token)).json();
        if (!cancelled) setSnapshot(previous => latestSnapshot(previous, data.snapshot ?? data));
      } catch (error) { if (!cancelled) setError(errorMessage(error)); }
      finally { refreshing = false; }
    };
    const liveRefresh = setInterval(() => { if (snapshotRef.current?.liveVideo && document.visibilityState === 'visible') void refresh(); }, 2000);
    const connect = () => {
      setConnection('connecting');
      socket = new WebSocket(wsUrl(`/api/sessions/${session.sessionId}/events`));
      socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: session.token, afterSeq: cursor.current }));
      socket.onmessage = message => {
        try {
          const data = JSON.parse(message.data);
          setConnection('live');
          if (data.type === 'snapshot') {
            if (typeof data.serverTime === 'number') serverOffset.current = data.serverTime - Date.now();
            cursor.current = Math.max(cursor.current, data.snapshot.throughSeq); setSnapshot(previous => latestSnapshot(previous, data.snapshot));
          }
          if (data.type === 'event') {
            const event = data.event;
            if (event.seq <= cursor.current) return;
            if (cursor.current && event.seq !== cursor.current + 1) void refresh();
            cursor.current = event.seq;
            setEvents(previous => [...previous.slice(-199), event]);
            if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 70);
          }
          if (data.type === 'error') setError(data.message ?? data.error ?? 'Event stream error');
        } catch { setError('An invalid event was received.'); }
      };
      socket.onerror = () => setConnection('disconnected');
      socket.onclose = () => { if (!cancelled) { setConnection('reconnecting'); retry = setTimeout(connect, 1500); } };
    };
    connect();
    return () => { cancelled = true; clearTimeout(retry); clearTimeout(refreshTimer); clearInterval(liveRefresh); socket?.close(); };
  }, [session]);

  useEffect(() => {
    if (!session || session.readOnly || !snapshotRef.current || terminal(snapshotRef.current.status) || snapshotRef.current.config.device !== 'mock') return;
    let cancelled = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const generation = snapshotRef.current.generation;
    renderer.current = uuid();
    const isMock = snapshotRef.current.config.device === 'mock';
    audioEpoch.current = snapshotRef.current.speechEpoch;
    audioSeq.current = -1;
    suppressed.current = false;
    commandPending.current.clear();
    const socket = new WebSocket(wsUrl(`/api/sessions/${session.sessionId}/control`));
    control.current = socket;
    let audioSocket: WebSocket | undefined;
    let bound = false;
    let renderedRevision = -1;
    const report = (type: string, payload: Json) => {
      if (!ending.current && !terminal(snapshotRef.current?.status) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ schemaVersion: 1, sessionId: session.sessionId, generation, messageId: uuid(), type, payload }));
    };
    const receipt = (revision: number) => {
      if (revision <= renderedRevision) return;
      renderedRevision = revision;
      report('hud.receipt', { hudRevision: revision, rendererInstanceId: renderer.current, target: 'mock', status: 'sdk_submitted' });
    };
    const capture = async (data: Json) => {
      if (!isMock) return;
      try {
        const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 640;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#d1d1bb'; ctx.fillRect(0, 0, 960, 640);
        ctx.fillStyle = '#adad95'; ctx.fillRect(0, 440, 960, 200);
        ctx.strokeStyle = '#bdbda7'; ctx.lineWidth = 2;
        for (let x = 0; x < 960; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 440); ctx.stroke(); }
        ctx.fillStyle = '#143b30'; ctx.fillRect(180, 110, 600, 300);
        ctx.fillStyle = '#f4f1dd'; ctx.font = 'bold 108px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`ZONE ${zoneRef.current === 'occluded' ? 'A' : zoneRef.current}`, 480, 302);
        if (zoneRef.current === 'occluded') { ctx.fillStyle = '#595b50'; ctx.fillRect(100, 90, 780, 350); ctx.fillStyle = '#fff'; ctx.font = '32px sans-serif'; ctx.fillText('VIEW OBSTRUCTED', 480, 280); }
        ctx.fillStyle = '#182b23'; ctx.font = '23px monospace'; ctx.fillText('ARTIFICIAL TEST FIXTURE · NOT A CAMERA', 480, 538);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image encoding failed')), 'image/jpeg', .85));
        if (cancelled) return;
        await request(`/sessions/${session.sessionId}/frames/${uuid()}`, session.token, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-frame-meta': JSON.stringify({ generation, workId: data.workId, cameraSource: 'mock', capturedAt: Date.now(), clockUncertaintyMs: 0, captureTimeBasis: 'synthetic', width: 960, height: 640 }) }, body: blob });
      } catch (error) { if (!cancelled) setError(errorMessage(error)); }
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: session.token, generation }));
    socket.onmessage = message => {
      try {
        const data = JSON.parse(message.data);
        if (data.type === 'event' && ['session.ending', 'session.ended', 'session.failed', 'session.interrupted'].includes(data.event?.type)) ending.current = true;
        if (data.type === 'rebind' && data.snapshot) {
          suppressed.current = true; flushAudio(); setSnapshot(previous => latestSnapshot(previous, data.snapshot));
          return;
        }
        if (!bound && ['ready', 'snapshot', 'hello', 'bound'].includes(data.type)) {
          bound = true;
          setControlReady(true);
          if (isMock) { report('device.status', { cameraSource: 'mock', microphoneSource: 'unavailable', outputSource: 'browser', hudTarget: 'mock', connected: true, observedAt: Date.now(), input: 'typed text; no microphone captured' }); receipt(snapshotRef.current?.hudRevision ?? 0); }
        }
        if (data.type === 'capture') void capture(data);
        if (data.type === 'flush') { flushAudio(); audioEpoch.current = data.speechEpoch; audioSeq.current = -1; suppressed.current = false; }
        if (data.type === 'hud' && isMock) receipt(data.hudRevision);
        if (data.type === 'error') setError(data.message ?? data.error ?? 'Control request failed');
        if (data.commandId) {
          commandPending.current.delete(data.commandId);
          if (data.status === 'rejected' || data.outcome?.status === 'rejected') setError(data.reason ?? data.outcome?.reason ?? 'Command rejected');
        }
      } catch (error) { setError(errorMessage(error)); }
    };
    socket.onclose = () => {
      if (cancelled) return;
      setControlReady(false); suppressed.current = true; flushAudio();
      recoveryTimer = setTimeout(() => {
        if (cancelled || ending.current || terminal(snapshotRef.current?.status)) return;
        void recoverSession(session, generation).then(data => {
          if (cancelled) return;
          setSnapshot(previous => latestSnapshot(previous, data.snapshot));
          if (data.snapshot.generation === snapshotRef.current?.generation) setBindingAttempt(value => value + 1);
        }).catch(error => { if (!cancelled) setError(`Connection recovery failed: ${errorMessage(error)}`); });
      }, 300);
    };
    socket.onerror = () => { if (!cancelled) setError('Control connection failed. Use Reconnect to acquire a fresh connection.'); };
    if (isMock) {
      audioSocket = new WebSocket(wsUrl(`/api/sessions/${session.sessionId}/audio`)); audioSocket.binaryType = 'arraybuffer';
      audioSocket.onopen = () => audioSocket!.send(JSON.stringify({ type: 'hello', token: session.token, generation }));
      audioSocket.onmessage = message => {
        if (!(message.data instanceof ArrayBuffer) || message.data.byteLength < 24 || !soundRef.current || suppressed.current || !audio.current) return;
        const view = new DataView(message.data);
        const seq = view.getUint32(12, true);
        if (view.getUint32(0, true) !== 0x434f4143 || view.getUint32(4, true) !== generation || view.getUint32(8, true) !== audioEpoch.current || seq <= audioSeq.current) return;
        audioSeq.current = seq;
        const count = (view.byteLength - 24) / 2;
        if (!Number.isInteger(count) || count === 0) return;
        const context = audio.current;
        const rate = snapshotRef.current?.outputRate ?? 24000;
        if (Math.max(audioUntil.current, context.currentTime) - context.currentTime + count / rate > .5) { flushAudio(); return; }
        const buffer = context.createBuffer(1, count, rate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < count; i++) channel[i] = view.getInt16(24 + i * 2, true) / 32768;
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
        const starts = Math.max(context.currentTime, audioUntil.current); audioUntil.current = starts + buffer.duration;
        sources.current.add(source); source.onended = () => sources.current.delete(source); source.start(starts);
      };
      audioSocket.onclose = () => { if (!cancelled) { suppressed.current = true; flushAudio(); } };
    }
    const pendingTimer = setInterval(() => {
      for (const [id, pending] of commandPending.current) if (Date.now() - pending.sentAt > 8000) {
        commandPending.current.delete(id); setError(`No receipt for ${pending.envelope.type}. Outcome is unknown; check the event log before retrying.`);
      }
    }, 1000);
    return () => { cancelled = true; clearTimeout(recoveryTimer); clearInterval(pendingTimer); setControlReady(false); socket.close(); audioSocket?.close(); flushAudio(); };
  }, [session, snapshot?.generation, terminal(snapshot?.status), bindingAttempt, flushAudio]);

  useEffect(() => {
    if (!session || !snapshot?.latestFrame) { setImageUrl(''); return; }
    let cancelled = false;
    let objectUrl = '';
    const frameId = snapshot.latestFrame.frameId ?? snapshot.latestFrame.assetId;
    request(`/sessions/${session.sessionId}/assets/${frameId}`, session.token).then(response => response.blob()).then(blob => {
      if (!cancelled) { objectUrl = URL.createObjectURL(blob); setImageUrl(objectUrl); }
    }).catch(() => { if (!cancelled) setImageUrl(''); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [session, snapshot?.latestFrame?.frameId, snapshot?.latestFrame?.assetId]);
  useEffect(() => {
    if (snapshot?.transcripts?.length !== lastCaption.current) {
      const scroller = captionEnd.current?.parentElement;
      scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      lastCaption.current = snapshot?.transcripts?.length ?? 0;
    }
    if (terminal(snapshot?.status)) { suppressed.current = true; flushAudio(); }
  }, [snapshot?.transcripts?.length, snapshot?.status, flushAudio]);
  useEffect(() => { if (snapshot?.muted !== undefined) setMuted(snapshot.muted); }, [snapshot?.muted]);

  const latestFrame = snapshot?.latestFrame;
  const latestInspection = (snapshot?.work ?? []).filter((work: Json) => work.kind === 'inspect').reduce<Json | undefined>((latest, work) => !latest || work.createdAt >= latest.createdAt ? work : latest, undefined);
  const serverNow = Math.max(now, Date.now()) + serverOffset.current;
  const frameAge = latestFrame ? Math.max(0, Math.round((serverNow - (latestFrame.capturedAt ?? latestFrame.receivedAt)) / 1000)) : null;
  const freshness = !latestFrame || latestFrame.capturedAt === undefined || latestFrame.clockUncertaintyMs === undefined ? 'unknown'
    : serverNow - latestFrame.capturedAt + latestFrame.clockUncertaintyMs > (snapshot?.config.maxFrameAgeMs ?? 15000) || serverNow < latestFrame.capturedAt ? 'stale' : latestFrame.freshness;
  const receipts = snapshot?.receipts ?? [];
  const currentReceipts = receipts.filter((receipt: Json) => (receipt.hudRevision ?? receipt.revision) === snapshot?.hudRevision && (receipt.generation === undefined || receipt.generation === snapshot?.generation));
  const hud = snapshot?.hud ?? {};
  const toggleSound = async () => {
    if (sound) { flushAudio(); setSound(false); return; }
    try { audio.current ??= new AudioContext(); await audio.current.resume(); setSound(true); } catch (error) { setError(errorMessage(error)); }
  };

  return <main>
    <header className="masthead"><a className="brand" href="/" aria-label="Fieldwork home"><span className="brand-mark">f<span>↗</span></span><span>fieldwork<small>WEARABLE COACH LAB</small></span></a><div className="header-right"><span className={`dot ${connection === 'live' ? 'on' : ''}`} />{session ? connection : 'Local development'}<span className="version">PROTOTYPE / 01</span></div></header>
    <section className="heading"><div><div className="eyebrow">LIVE SESSION WORKSPACE</div><h1>A second set<br className="mobile-break" /> of eyes.</h1><p>One coach. A shared view. Every action accounted for.</p></div><div className="session-tag"><span>{session ? session.readOnly ? 'SPECTATOR' : 'OPERATOR' : 'AWAITING SESSION'}</span><strong>{snapshot?.status ?? 'Ready when you are'}</strong>{session && <code>{session.sessionId.slice(0, 8)} / G{snapshot?.generation}</code>}</div></section>
    {error && <div className="alert" role="alert"><span>{error}</span><button className="plain" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {!session ? <section className="setup-grid">
      <div className="panel setup-panel"><div className="panel-title"><span className="step">01</span><h2>Connect your workspace</h2></div><p className="hint">Use the development operator token from your server configuration. Credentials stay in this browser tab.</p><label>Operator token<input type="password" autoComplete="off" value={operatorToken} onChange={event => setOperatorToken(event.target.value)} placeholder="Enter operator token" /></label><button className="secondary" onClick={loadProviders} disabled={busy || !operatorToken}>Check connection <span>↗</span></button>{providers.length > 0 && <div className="connected-note"><span className="dot on" /> Server connected · {providers.filter(item => item.available).length} providers available</div>}
        <div className="divider" /><div className="panel-title"><span className="step">02</span><h2>Choose a coach</h2></div><div className="provider-list">{(providers.length ? providers : [{ id: 'mock', model: 'Deterministic development coach', available: true, inputRate: 16000, outputRate: 24000 }]).map(item => <button key={item.id} className={`provider ${provider === item.id ? 'selected' : ''}`} onClick={() => setProvider(item.id)} disabled={!item.available}><span className="radio" /><span><strong>{item.id === 'mock' ? 'Mock coach' : item.id === 'gemini' ? 'Gemini Live' : 'GPT Live'}</strong><small>{item.available ? item.model : item.reason ?? 'Not configured'}</small></span><span className="provider-status">{item.available ? 'AVAILABLE' : 'UNAVAILABLE'}</span></button>)}</div>
        <div className="form-row"><label>Device<select value={device} onChange={event => setDevice(event.target.value)}><option value="mock">Browser mock device</option><option value="phone">Android phone</option><option value="meta_display">Meta display glasses</option></select></label></div><label className="checkbox"><input type="checkbox" checked={recordFrames} onChange={event => setRecordFrames(event.target.checked)} />Retain selected inspection images with session evidence</label><button className="primary start" onClick={start} disabled={busy || !providers.length || !selected?.available}>Start session <span>↗</span></button>
      </div>
      <div className="setup-aside"><div className="intro-visual"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="visual-card"><div className="tiny">COACH → LEARNER</div><div className="visual-line" /><strong>Notice.<br />Understand.<br /><span>Act.</span></strong><div className="visual-caption"><span className="dot on" />A clear view of what happens next</div></div><span className="axis axis-top">VISION / VOICE / CONTEXT</span><span className="axis axis-bottom">DESIGNED FOR THE MOMENT</span></div><div className="panel spectator-join"><h2>Watch a session</h2><p className="hint">Join with a read-only spectator capability. Camera previews may be visible.</p><form onSubmit={event => { event.preventDefault(); void join(); }}><label>Session ID<input value={joinId} onChange={event => setJoinId(event.target.value)} required placeholder="Session UUID" /></label><label>Spectator token<input type="password" value={joinToken} onChange={event => setJoinToken(event.target.value)} required placeholder="Session-scoped token" autoComplete="off" /></label><button className="secondary" disabled={busy}>Open spectator view <span>↗</span></button></form></div></div>
      {providers.length > 0 && <DiagnosticsPanel key="workspace-diagnostics" path="/diagnostics" token={operatorToken} scope="Workspace" />}
      {sessionList.length > 0 && <div className="panel session-history"><h2>Recent sessions</h2><div className="history-list">{sessionList.slice(0, 8).map(item => <div key={item.id ?? item.sessionId}><code>{(item.id ?? item.sessionId ?? '').slice(0, 8)}</code><span>{item.config?.provider ?? item.provider ?? 'Session'}</span><span className="badge">{item.status}</span><button className="plain" onClick={() => void join(item.id ?? item.sessionId, operatorToken)}>View evidence ↗</button></div>)}</div></div>}
    </section> : <>
      <div className="toolbar"><div className="session-info"><span className="badge">{snapshot?.config.provider ?? 'coach'}</span><span>{snapshot?.config.model}</span><span className="subtle">{snapshot?.config.device === 'mock' ? 'Artificial fixture · browser renderer' : snapshot?.config.device}</span></div><div className="toolbar-actions">{!session.readOnly && <><button onClick={toggleSound} className="plain">{sound ? 'Sound on' : 'Enable sound'}</button><button onClick={reconnect} disabled={busy || !active} className="secondary compact">Reconnect</button><button onClick={() => send('end_session')} disabled={!canControl} className="danger compact">End session</button></>}<button onClick={leave} className="plain">Leave view ↗</button></div></div>
      <div className="workspace-grid">
        <div className="panel frame-panel"><div className="panel-head"><h2>Shared view</h2><span className={`badge ${latestFrame ? 'accent' : ''}`}>{latestFrame?.cameraSource ?? 'NO CAMERA'}</span></div><div className="camera-view">{imageUrl ? <img src={imageUrl} alt={`${latestFrame?.cameraSource === 'mock' ? 'Artificial test fixture' : 'Latest selected camera frame'}`} /> : <div className="camera-empty"><span className="focus-corners">⌗</span><strong>{latestFrame ? 'Frame bytes unavailable' : 'Waiting for a fresh frame'}</strong><span>{latestFrame ? 'The frame metadata is preserved in the evidence log.' : 'Inspect the view to request an image from the device.'}</span></div>}<div className="camera-meta"><span><span className="dot" /> SAMPLED PREVIEW</span><span>{frameAge === null ? 'No capture yet' : `${frameAge}s ${latestFrame?.capturedAt ? 'since capture' : 'since received · capture age unknown'}`}</span></div></div><div className="frame-foot"><span>Freshness <strong>{freshness}</strong></span><span>{snapshot?.config.device === 'mock' ? 'SYNTHETIC / NOT REAL-WORLD EVIDENCE' : 'Capture timing includes device uncertainty'}</span></div>
          {snapshot?.config.provider === 'gemini' && <LiveVideoStatus snapshot={snapshot} now={serverNow} />}
          {!session.readOnly && <div className="inspect-controls">{snapshot?.config.device === 'mock' && <label className="fixture-label">Artificial fixture<select value={zone} onChange={event => setZone(event.target.value)}><option value="A">Zone A</option><option value="B">Zone B</option><option value="occluded">Occluded view</option></select></label>}<label>Inspection question<input value={question} onChange={event => setQuestion(event.target.value)} maxLength={1000} /></label><button className="primary" disabled={!canControl || !question.trim()} onClick={() => send('inspect_frame', { question })}>Inspect current view <span>⌗</span></button></div>}
          {latestInspection && <InspectionStatus work={latestInspection} simulated={snapshot?.config.provider === 'mock'} canRetry={canControl} retry={question => send('inspect_frame', { question })} />}
        </div>
        <div className="panel hud-panel"><div className="panel-head"><h2>Desired display</h2><span className="badge">REV {snapshot?.hudRevision ?? 0}</span></div><div className="hud-stage"><div className="hud-document">{hud.card && <><span className="tiny">{hud.card.title ?? 'COACH'}</span><p>{hud.card.body}</p></>}{hud.checklist?.map((item: Json) => <div className="hud-check" key={item.id}><span>{item.checked ? '☑' : '☐'}</span>{item.text}</div>)}{hud.timer && <div className="hud-timer">{Math.max(0, Math.ceil((hud.timer.startedAt + hud.timer.durationMs - serverNow) / 1000))}s</div>}{!Object.keys(hud).length && <div className="hud-empty"><span>□</span>Display clear<small>Accepted guidance appears here.</small></div>}{hud.imageAssetId && <small>Image asset: {hud.imageAssetId}</small>}</div></div><div className="render-evidence"><span className="tiny">RENDER EVIDENCE</span>{currentReceipts.length ? currentReceipts.slice(-3).map((receipt: Json, index: number) => <div key={index}><span className="dot on" /><strong>{receipt.target}</strong><span>{receipt.status}</span></div>) : <p>No receipt for this revision.</p>}<small>Accepted content is a request. Submission does not prove the learner saw it.</small></div>{!session.readOnly && <details className="manual-hud"><summary>Manual display controls</summary><label>Title<input value={hudTitle} onChange={event => setHudTitle(event.target.value)} maxLength={60} /></label><label>Message<textarea value={hudBody} onChange={event => setHudBody(event.target.value)} maxLength={240} rows={2} /></label><div className="button-row"><button className="secondary" disabled={!canControl || !hudBody} onClick={() => send('set_hud', { hud: { card: { title: hudTitle, body: hudBody } } })}>Set display</button><button className="plain" disabled={!canControl} onClick={() => send('clear_hud')}>Clear display</button></div></details>}</div>
        <div className="panel conversation-panel"><div className="panel-head"><h2>Conversation</h2><span className="tiny">EXACT TRANSCRIPT FRAGMENTS</span></div><div className="transcript" role="log" aria-live="polite">{snapshot?.transcripts?.length ? snapshot.transcripts.map((fragment: Json, index: number) => <div key={index} className={`fragment ${fragment.speaker}`}><span className="speaker">{fragment.speaker === 'assistant' || fragment.speaker === 'coach' ? 'COACH' : fragment.speaker?.toUpperCase() ?? 'UNKNOWN'}</span><p>{fragment.text}</p>{fragment.startMs !== undefined && <small>{fragment.startMs}–{fragment.endMs ?? '?'} ms</small>}</div>) : <div className="transcript-empty"><span>Start with a question.</span><p>Captions appear as the provider sends them.<br />They do not confirm audible playback.</p></div>}<div ref={captionEnd} /></div>{!session.readOnly && <div className="conversation-input"><form onSubmit={event => { event.preventDefault(); send('send_text', { text }); setText(''); }}><label className="sr-only" htmlFor="learner-input">Message to coach</label><input id="learner-input" value={text} onChange={event => setText(event.target.value)} placeholder="Type a message to the coach…" maxLength={4000} /><button className="primary compact" disabled={!canControl || !text.trim()} type="submit">Send ↗</button></form><div className="input-actions"><span>{snapshot?.config.device === 'mock' ? 'Typed input · no browser microphone' : 'Microphone captured on Android'}</span><div><button className="plain" disabled={!canControl} onClick={() => { send('set_mic', { muted: !muted }); setMuted(!muted); }}>{muted ? 'Unmute device mic' : 'Mute device mic'}</button><button className="stop" disabled={!canControl} onClick={() => send('stop_speech')}>■ Stop speech</button></div></div></div>}</div>
        <div className="panel activity-panel"><div className="panel-head"><h2>Activity & evidence</h2><span className="badge">SEQ {snapshot?.throughSeq ?? 0}</span></div><div className="event-list">{events.length ? [...events].reverse().map(event => <details className="event" key={event.eventId ?? event.seq}><summary><span className={`event-dot ${event.type.includes('error') || event.type.includes('failed') ? 'failed' : ''}`} /><span>{event.type}</span><time>{time(event.receivedAt)}</time></summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>) : <div className="no-events">Waiting for session activity.<br /><small>Replay changes this view only; it never executes actions.</small></div>}</div><div className="activity-foot"><span>{snapshot?.work?.filter((work: Json) => ['reserved', 'running'].includes(work.status)).length ?? 0} active requests</span>{!session.readOnly && <button className="plain" onClick={exportEvidence}>Export evidence ↓</button>}</div></div>
      </div>
      <section className="diagnostics panel"><div><span className="tiny">CONNECTION</span><strong>{connection} / {session.readOnly ? 'read only' : !mockDevice ? 'HTTP controls' : controlReady ? 'control ready' : 'control offline'}</strong></div><div><span className="tiny">AUDIO FORMAT</span><strong>{snapshot?.inputRate ? `${snapshot.inputRate / 1000} → ${(snapshot.outputRate ?? 0) / 1000} kHz` : 'Not negotiated'}<small>PCM16 · mono</small></strong></div><div><span className="tiny">PLAYBACK</span><strong>{sound ? 'Browser sound enabled' : 'Browser sound off'}<small>Epoch {snapshot?.speechEpoch ?? 0} · queue ≤ 500 ms</small></strong></div><div><span className="tiny">USAGE EVIDENCE</span><strong>{snapshot?.usage?.length ? `${snapshot.usage.length} reports` : 'Not reported'}<small>Unknown usage is not zero cost</small></strong></div></section>
      {!session.readOnly && <DiagnosticsPanel key={session.sessionId} path={`/sessions/${session.sessionId}/diagnostics`} token={session.token} scope="This session" />}
      <details className="panel technical-details"><summary>Device status, active work & usage details</summary><pre>{JSON.stringify({ device: snapshot?.device ?? 'No device report', work: snapshot?.work, usage: snapshot?.usage }, null, 2)}</pre></details>
      {!session.readOnly && session.spectatorToken && <div className="share-row"><span>Share read-only access with a trusted spectator.</span><button className="plain" onClick={async () => { try { await navigator.clipboard.writeText(`Session ID: ${session.sessionId}\nSpectator token: ${session.spectatorToken}`); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Clipboard unavailable. Open spectator credentials below to copy them.'); } }}>{copied ? 'Copied' : 'Copy spectator credentials ↗'}</button><details><summary>Show credentials</summary><code>{session.sessionId}<br />{session.spectatorToken}</code></details></div>}
    </>}
    <footer><span>FIELDWORK / HUMAN + MACHINE</span><span>Prototype evidence is explicit. Hardware capability must be verified on device.</span></footer>
  </main>;
}
