import { SIMULATOR_DISPLAY_LIMITS, type DemoAsset, type DisplayCapabilities, type Hud } from '../../contracts/index.ts';
export type { DemoAsset } from '../../contracts/index.ts';

export type CapturedFrame = { blob: Blob; meta: Record<string, unknown> };
const { maxWidth, maxHeight, maxPixels, maxDurationMs } = SIMULATOR_DISPLAY_LIMITS;
export const SIMULATED_DISPLAY: DisplayCapabilities = { video: true, source: 'device-local', maxWidth, maxHeight, maxPixels };

export function validateDemo(width: number, height: number, duration: number, mime: string) {
  if (mime !== 'video/mp4') throw new Error('Choose an MP4 demonstration clip. Camera recordings can use other browser-supported formats.');
  if (![width, height, duration].every(value => Number.isFinite(value) && value > 0)) throw new Error('The clip has no usable video dimensions or duration.');
  if (width > maxWidth || height > maxHeight || width * height > maxPixels) throw new Error('Demo clips must be at most 400 pixels per side and 70,000 pixels total. Try 320 × 180.');
  if (duration < 0.1 || duration * 1000 > maxDurationMs) throw new Error('This prototype accepts demonstration clips from 0.1 seconds to five minutes.');
}

// One outstanding operation survives resets: replacing a source cannot create an upload backlog.
export class FrameSampler {
  private epoch = 0;
  private busy = false;
  private suspended = false;
  private lastAt = -Infinity;
  private lastPosition = -1;
  invalidate() { this.epoch++; this.lastPosition = -1; }
  suspend() { this.suspended = true; this.invalidate(); }
  resume() { this.suspended = false; }
  get restartRequired() { return this.suspended; }
  begin(position: number, now: number, playing: boolean) {
    if (this.suspended || !playing || this.busy || !Number.isFinite(position) || position === this.lastPosition || now - this.lastAt < 1100) return null;
    this.busy = true; this.lastAt = now; this.lastPosition = position;
    const epoch = this.epoch;
    return { current: () => epoch === this.epoch, release: () => { this.busy = false; } };
  }
}

export function hudRows(hud: Hud, now: number): { text: string; heading: boolean }[] {
  const lines = [
    ...(hud.card?.title ? [{ text: hud.card.title, heading: true }] : []),
    ...(hud.card ? [{ text: hud.card.body, heading: false }] : []),
    ...(hud.checklist ?? []).map(item => ({ text: `${item.checked ? '✓' : '○'} ${item.text}`, heading: false })),
    ...(hud.timer ? [{ text: `${Math.max(0, Math.ceil(((hud.timer.startedAt ?? now) + hud.timer.durationMs - now) / 1000))}s remaining`, heading: false }] : []),
  ];
  const rows = lines.flatMap(line => line.text.split('\n').flatMap(paragraph => {
    const points = Array.from(paragraph), width = line.heading ? 18 : 26, result = [];
    while (points.length) {
      let count = Math.min(width, points.length);
      if (count < points.length) for (let index = count - 1; index > 0; index--) if (/\s/.test(points[index])) { count = index; break; }
      result.push({ ...line, text: points.splice(0, count).join('') });
      while (points.length && /\s/.test(points[0])) points.shift();
    }
    return result;
  }));
  return rows.length > 4 ? [...rows.slice(0, 3), { text: '… More on phone', heading: false }] : rows;
}

export async function captureRecordedFrame(video: HTMLVideoElement, current: () => boolean): Promise<CapturedFrame> {
  if (!current() || video.readyState < 2 || video.seeking || !video.videoWidth) throw new Error('Wait for a decoded camera frame. Play or seek the camera recording first.');
  const canvas = document.createElement('canvas'), scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot capture video frames.');
  const drawnAt = performance.now(), sourcePositionMs = Math.round(video.currentTime * 1000);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.6, 0.4, 0.2]) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!current()) throw new Error('Camera source or session changed during capture. Try again.');
    if (blob && blob.size <= 256 * 1024) return { blob, meta: { cameraSource: 'recorded_video', captureTimeBasis: 'recorded_media', sourcePositionMs, frameAgeMs: Math.max(0, performance.now() - drawnAt), width: canvas.width, height: canvas.height } };
  }
  throw new Error('The camera frame could not be encoded within the 256 KiB upload limit.');
}

export async function inspectDemoFile(file: File): Promise<Omit<DemoAsset, 'id'>> {
  const mime = file.type || (/\.mp4$/i.test(file.name) ? 'video/mp4' : '');
  if (mime !== 'video/mp4') validateDemo(1, 1, 1, mime);
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timeout); video.onloadedmetadata = null; video.onerror = null; error ? reject(error) : resolve(); };
      const timeout = setTimeout(() => finish(new Error('Demo metadata timed out. Try a browser-playable MP4.')), 10000);
      video.onloadedmetadata = () => finish(); video.onerror = () => finish(new Error('This browser could not read the demonstration clip.'));
      video.preload = 'metadata'; video.src = url;
    });
    validateDemo(video.videoWidth, video.videoHeight, video.duration, mime);
    return { width: video.videoWidth, height: video.videoHeight, durationMs: Math.ceil(video.duration * 1000), mime: 'video/mp4' };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
