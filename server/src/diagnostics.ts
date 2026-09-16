import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const diagnosticMessages = {
  'app.lifecycle': 'The device application changed lifecycle state.',
  'session.start_requested': 'The device requested a new session.',
  'session.created': 'The server created the session.',
  'session.active': 'The device session became active.',
  'session.ended': 'The device session ended.',
  'session.failed': 'The device could not start or continue the session.',
  'network.unavailable': 'The device could not reach the network.',
  'transport.closed': 'A device connection closed.',
  'transport.failure': 'A device connection failed.',
  'reconnect.attempt': 'The device is attempting to reconnect.',
  'reconnect.recovered': 'The device connection recovered.',
  'reconnect.exhausted': 'Automatic reconnection stopped after repeated failures.',
  'request.failed': 'A device request failed.',
  'command.failed': 'A device command failed.',
  'permissions.denied': 'A required device permission was denied.',
  'capture.failed': 'The device could not capture the requested frame.',
  'audio.discontinuity': 'The device audio stream was interrupted.',
  'audio.status': 'The device reported its audio status.',
  'storage.failed': 'The device could not save local state.',
  'app.error': 'The device reported an application error.',
} as const;
const number = (max: number) => z.number().int().min(0).max(max);
const identifier = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
export const diagnosticDetailsSchema = z.object({
  provider: z.enum(['mock', 'gemini', 'openai']).optional(), model: identifier(100).optional(),
  device: z.enum(['mock', 'phone', 'meta_display']).optional(), appVersion: identifier(50).optional(),
  deviceModel: z.string().min(1).max(80).regex(/^[A-Za-z0-9 ._()+/-]+$/).optional(),
  androidApi: z.number().int().min(1).max(100).optional(), attempt: number(100000).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(), closeCode: number(4999).optional(),
  durationMs: number(86400000).optional(), pendingCount: number(10000).optional(),
  errorClass: z.string().min(1).max(100).regex(/^[A-Za-z_$][A-Za-z0-9_.$]*$/).optional(),
  cameraError: z.enum(['CaptureFailed', 'CaptureInProgress', 'DeviceDisconnected', 'NotStreaming', 'VideoFrameTimeout', 'UnsupportedVideoLayout', 'VideoStreamFailed', 'MetaRegistrationRequired', 'MetaPermissionRequired', 'DeviceStartTimeout', 'VideoStartTimeout']).optional(),
  inputRate: z.number().int().min(8000).max(192000).optional(), outputRate: z.number().int().min(8000).max(192000).optional(),
  queuedBytes: number(1024 * 1024 * 1024).optional(), droppedSamples: number(1e9).optional(), underruns: number(1e6).optional(),
  capturedBytes: number(1e12).optional(), receivedBytes: number(1e12).optional(), writtenSamples: number(1e12).optional(), playedSamples: number(1e12).optional(),
  pendingMs: number(86400000).optional(), queueHighWaterMs: number(86400000).optional(), queueBudgetMs: number(86400000).optional(), shortWrites: number(1e12).optional(),
  routeType: z.union([number(100), identifier(40)]).optional(),
}).strict();
export const diagnosticReportSchema = z.object({
  eventId: z.string().uuid(), deviceInstallId: z.string().uuid(), runId: z.string().uuid(),
  occurredAt: z.number().int().min(0).max(8640000000000000),
  sessionId: z.string().uuid().nullable().default(null), generation: z.number().int().positive().max(0xffffffff).nullable().default(null),
  code: z.enum(Object.keys(diagnosticMessages) as [keyof typeof diagnosticMessages, ...(keyof typeof diagnosticMessages)[]]),
  severity: z.enum(['info', 'warning', 'error']),
  stage: z.enum(['bootstrap', 'permissions', 'session', 'control', 'audio', 'camera', 'hud', 'provider', 'network', 'storage', 'app']),
  recovery: z.enum(['none', 'retrying', 'recovered', 'user_action', 'failed']),
  message: z.string().max(300).optional(), details: diagnosticDetailsSchema.default({}),
}).strict();
export const diagnosticBatchSchema = z.array(diagnosticReportSchema).max(50);
export type DiagnosticRecord = Omit<z.infer<typeof diagnosticReportSchema>, 'message' | 'details'> & {
  receivedAt: number; message: string; details: Record<string, string | number>;
};
type Options = { now?: () => number; retentionMs?: number; maxRows?: number };
type Filter = { sessionId?: string | null };
const SEVEN_DAYS = 7 * 86400000;
// Free-form messages are replaced, not logged. Scrub credential-shaped values in allowed identifier fields too.
const credential = /(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+|(?:bearer|authorization|api[_-]?key|password|secret|token)[\s:=]+\S+)/i;

export class Diagnostics {
  private retentionMs: number;
  private maxRows: number;
  constructor(private db: DatabaseSync, private options: Options = {}) {
    this.retentionMs = z.number().int().min(1).max(SEVEN_DAYS).parse(options.retentionMs ?? SEVEN_DAYS);
    this.maxRows = z.number().int().min(1).max(10000).parse(options.maxRows ?? 10000);
    db.exec(`CREATE TABLE IF NOT EXISTS device_diagnostics(event_id TEXT PRIMARY KEY,session_id TEXT,received_at INTEGER NOT NULL,code TEXT NOT NULL,severity TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS device_diagnostics_session ON device_diagnostics(session_id,received_at DESC);
      CREATE INDEX IF NOT EXISTS device_diagnostics_received ON device_diagnostics(received_at DESC)`);
    this.prune();
  }
  private prune() {
    const expired = this.db.prepare('DELETE FROM device_diagnostics WHERE received_at<?').run((this.options.now ?? Date.now)() - this.retentionMs);
    const overflow = this.db.prepare('DELETE FROM device_diagnostics WHERE rowid IN (SELECT rowid FROM device_diagnostics ORDER BY received_at DESC,rowid DESC LIMIT -1 OFFSET ?)').run(this.maxRows);
    return Number(expired.changes) + Number(overflow.changes);
  }
  ingest(reports: unknown): { accepted: number; duplicates: number; dropped: number } {
    const parsed = diagnosticBatchSchema.parse(reports);
    let accepted = 0, dropped = 0;
    const receivedAt = (this.options.now ?? Date.now)();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const report of parsed) {
        const stored: DiagnosticRecord = { ...report, receivedAt, message: diagnosticMessages[report.code],
          details: Object.fromEntries(Object.entries(report.details).map(([key, value]) => [key, typeof value === 'string' && credential.test(value) ? '[redacted]' : value])) as DiagnosticRecord['details'],
        };
        const result = this.db.prepare('INSERT OR IGNORE INTO device_diagnostics VALUES(?,?,?,?,?,?)')
          .run(report.eventId, report.sessionId, stored.receivedAt, report.code, report.severity, JSON.stringify(stored));
        accepted += Number(result.changes);
      }
      dropped = this.prune();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // dropped counts rows removed by retention/cap during this ingestion, including older stored rows.
    return { accepted, duplicates: parsed.length - accepted, dropped };
  }
  private filter({ sessionId }: Filter) {
    if (sessionId === undefined) return { where: '', params: [] as (string | null)[] };
    return { where: 'WHERE session_id IS ?', params: [z.string().uuid().nullable().parse(sessionId)] };
  }
  list(options: Filter & { limit?: number } = {}): DiagnosticRecord[] {
    const limit = z.number().int().min(1).max(1000).parse(options.limit ?? 100);
    const { where, params } = this.filter(options);
    this.prune();
    return this.db.prepare(`SELECT data FROM device_diagnostics ${where} ORDER BY received_at DESC,rowid DESC LIMIT ?`).all(...params, limit).map(row => JSON.parse(String(row.data)));
  }
  counts(options: Filter = {}) {
    const { where, params } = this.filter(options);
    this.prune();
    const result = { total: 0, bySeverity: { info: 0, warning: 0, error: 0 }, byCode: {} as Record<string, number> };
    for (const row of this.db.prepare(`SELECT severity,code,COUNT(*) AS count FROM device_diagnostics ${where} GROUP BY severity,code`).all(...params)) {
      const count = Number(row.count);
      result.total += count;
      result.bySeverity[row.severity as keyof typeof result.bySeverity] += count;
      result.byCode[String(row.code)] = (result.byCode[String(row.code)] ?? 0) + count;
    }
    return result;
  }
  deleteSession(sessionId: string) {
    return Number(this.db.prepare('DELETE FROM device_diagnostics WHERE session_id=?').run(z.string().uuid().parse(sessionId)).changes);
  }
}
