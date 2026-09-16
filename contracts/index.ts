import { z } from 'zod';

export const VERSION = 1;
export const idSchema = z.string().uuid();
export const configSchema = z.object({
  provider: z.enum(['mock', 'gemini', 'openai']), model: z.string().min(1).max(100),
  device: z.enum(['mock', 'phone', 'meta_display']).default('mock'), voice: z.string().max(40).optional(),
  manualActivity: z.boolean().default(false), recordFrames: z.boolean().default(false),
  observerModel: z.string().max(100).optional(), maxFrameAgeMs: z.number().int().min(1000).max(60000).default(15000),
  maxSessionMinutes: z.number().int().min(1).max(120).default(30),
}).strict().superRefine((c, ctx) => {
  const models = { mock: ['mock-coach'], gemini: ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking'], openai: ['gpt-live-1'] };
  if (!models[c.provider].includes(c.model)) ctx.addIssue({ code: 'custom', message: 'Model does not match selected provider' });
});
export type SessionConfig = z.infer<typeof configSchema>;
export const hudSchema = z.object({
  card: z.object({ title: z.string().max(60).optional(), body: z.string().min(1).max(240) }).strict().optional(),
  checklist: z.array(z.object({ id: z.string().max(60), text: z.string().max(60), checked: z.boolean() }).strict()).max(5).optional(),
  timer: z.object({ id: z.string().max(100).optional(), startedAt: z.number().optional(), durationMs: z.number().int().min(1000).max(3600000) }).strict().optional(),
  imageAssetId: idSchema.optional(), expiresAt: z.number().int().positive().optional(),
}).strict();
export type Hud = z.infer<typeof hudSchema>;
export const commandSchema = z.object({
  schemaVersion: z.literal(1), sessionId: idSchema, generation: z.number().int().positive(),
  messageId: idSchema, commandId: idSchema,
  type: z.enum(['send_text','set_mic','stop_speech','clear_hud','set_hud','inspect_frame','end_session','activity','cancel_work','set_live_video','start_demo','stop_demo']),
  payload: z.record(z.string(), z.unknown()),
});
export type Command = z.infer<typeof commandSchema>;
export type Transcript = { speaker: string; text: string; startMs?: number; endMs?: number; seq?: number };
export type Work = { id: string; generation: number; kind: string; status: string; createdAt: number; deadlineAt: number; expectedHudRevision: number; input: Record<string, unknown>; result?: unknown; nativeKey?: string; frameId?: string };
export type Frame = { frameId: string; receivedAt: number; capturedAt?: number; clockUncertaintyMs?: number; cameraSource: string; freshness: 'fresh'|'stale'|'unknown'; captureTimeBasis: string; workId?: string; width?: number; height?: number; sourcePositionMs?: number };
export const SIMULATOR_DISPLAY_LIMITS = { maxWidth: 400, maxHeight: 400, maxPixels: 70000, maxDurationMs: 300000 } as const;
export const displayCapabilitiesSchema=z.object({video:z.boolean(),source:z.literal('device-local'),maxWidth:z.number().int().positive(),maxHeight:z.number().int().positive(),maxPixels:z.number().int().positive()}).strict();
export const demoAssetsSchema=z.array(z.object({id:idSchema,width:z.number().int().positive(),height:z.number().int().positive(),durationMs:z.number().int().min(100).max(SIMULATOR_DISPLAY_LIMITS.maxDurationMs),mime:z.literal('video/mp4')}).strict()).max(20).refine(assets=>new Set(assets.map(asset=>asset.id)).size===assets.length,'Duplicate demonstration asset');
export type DemoAsset = z.infer<typeof demoAssetsSchema>[number];
export type DisplayCapabilities = z.infer<typeof displayCapabilitiesSchema>;
export type Demonstration = { requestId: string; assetId: string; status: 'starting'|'playing'; startedAt: number; deadlineAt: number };
export type Snapshot = {
  id: string; config: SessionConfig; status: string; generation: number; speechEpoch: number; throughSeq: number;
  hudRevision: number; hud: Hud; inputRate: number; outputRate: number; createdAt: number; endedAt?: number;
  transcripts: Transcript[]; work: Work[]; receipts: Record<string, unknown>[]; usage: Record<string, unknown>[];
  device?: Record<string, unknown>; latestFrame?: Frame; muted: boolean; finalization: string;
  demonstration?: Demonstration;
  liveVideo: boolean; liveVideoEpoch: number; liveVideoStats?: {submitted:number; dropped:number; lastFrameReceivedAt?:number; cameraSource?:string; sourcePositionMs?:number};
};
export type SessionEvent = { schemaVersion: 1; sessionId: string; generation: number; eventId: string; seq: number; type: string; source: string; receivedAt: number; payload: Record<string, unknown> };
export const AUDIO_MAGIC = 0x434f4143;
export const AUDIO_HEADER = 24;
export function encodeAudio(pcm: Uint8Array, generation: number, speechEpoch: number, seq: number, timestamp = Date.now()): Uint8Array {
  const output = new Uint8Array(AUDIO_HEADER + pcm.byteLength);
  const v = new DataView(output.buffer);
  v.setUint32(0, AUDIO_MAGIC, true); v.setUint32(4, generation, true); v.setUint32(8, speechEpoch, true);
  v.setUint32(12, seq, true); v.setFloat64(16, timestamp, true); output.set(pcm, AUDIO_HEADER); return output;
}
export function decodeAudio(bytes: Uint8Array) {
  if (bytes.byteLength < AUDIO_HEADER || (bytes.byteLength - AUDIO_HEADER) % 2) throw new Error('Invalid PCM packet');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== AUDIO_MAGIC) throw new Error('Invalid audio protocol');
  return { generation: v.getUint32(4, true), speechEpoch: v.getUint32(8, true), seq: v.getUint32(12, true), timestamp: v.getFloat64(16, true), pcm: bytes.subarray(AUDIO_HEADER) };
}
