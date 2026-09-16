import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { SessionEvent, Snapshot, Work } from '../../contracts/index.ts';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const version=this.db.prepare('PRAGMA user_version').get()!.user_version as number;
    if(version>1)throw new Error('Database schema is newer than this application');
    this.db.exec(`PRAGMA user_version=1; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, create_key TEXT UNIQUE NOT NULL, create_hash TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, generation INTEGER NOT NULL, conversation_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,generation));
      CREATE TABLE IF NOT EXISTS commands(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, hash TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS work(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, native_key TEXT, data TEXT NOT NULL, PRIMARY KEY(session_id,id), UNIQUE(session_id,native_key));
      CREATE TABLE IF NOT EXISTS assets(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS events(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, event_id TEXT UNIQUE NOT NULL, source_message_id TEXT, data TEXT NOT NULL, PRIMARY KEY(session_id,seq), UNIQUE(session_id,source_message_id));`);
  }
  atomic<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  get(id: string): Snapshot | undefined { const row = this.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(id); return row ? JSON.parse(row.snapshot as string) : undefined; }
  byCreate(key: string) { return this.db.prepare('SELECT id,create_hash FROM sessions WHERE create_key=?').get(key); }
  list(): Snapshot[] { return this.db.prepare('SELECT snapshot FROM sessions ORDER BY rowid DESC').all().map(r => JSON.parse(r.snapshot as string)); }
  create(snapshot: Snapshot, key: string, hash: string) { this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(snapshot.id,key,hash,JSON.stringify(snapshot)); }
  save(snapshot: Snapshot) { this.db.prepare('UPDATE sessions SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),snapshot.id); }
  connection(id: string, generation: number, conversation: string, data: unknown) { this.db.prepare('INSERT OR REPLACE INTO connections VALUES(?,?,?,?)').run(id,generation,conversation,JSON.stringify(data)); }
  command(id: string, key: string) { const r = this.db.prepare('SELECT hash,outcome FROM commands WHERE session_id=? AND id=?').get(id,key); return r ? { hash: r.hash as string, outcome: JSON.parse(r.outcome as string) } : undefined; }
  updateReceipt(id:string,key:string,outcome:unknown){this.db.prepare('UPDATE commands SET outcome=? WHERE session_id=? AND id=?').run(JSON.stringify(outcome),id,key);}
  receipt(id: string, key: string, hash: string, result: unknown) { this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(id,key,hash,JSON.stringify(result)); }
  work(id: string, work: Work) { this.db.prepare('INSERT INTO work VALUES(?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET data=excluded.data').run(id,work.id,work.nativeKey ?? null,JSON.stringify(work)); }
  native(id: string, key: string): Work | undefined { const r = this.db.prepare('SELECT data FROM work WHERE session_id=? AND native_key=?').get(id,key); return r ? JSON.parse(r.data as string) : undefined; }
  works(id: string): Work[] { return this.db.prepare('SELECT data FROM work WHERE session_id=?').all(id).map(r=>JSON.parse(r.data as string)); }
  asset(id: string, assetId: string) { const r = this.db.prepare('SELECT hash,data FROM assets WHERE session_id=? AND id=?').get(id,assetId); return r ? { hash:r.hash as string, ...JSON.parse(r.data as string) } : undefined; }
  assets(id: string): Record<string, unknown>[] { return this.db.prepare('SELECT id,hash,data FROM assets WHERE session_id=?').all(id).map(r=>({id:r.id,hash:r.hash,...JSON.parse(r.data as string)})); }
  putAsset(id: string, assetId: string, hash: string, data: unknown) { this.db.prepare('INSERT INTO assets VALUES(?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET data=excluded.data').run(id,assetId,hash,JSON.stringify(data)); }
  report(id: string, messageId: string) { return this.db.prepare('SELECT 1 FROM events WHERE session_id=? AND source_message_id=?').get(id,messageId); }
  append(snapshot: Snapshot, type: string, payload: Record<string, unknown>, source='server', messageId?: string): SessionEvent {
    const event: SessionEvent = {schemaVersion:1,sessionId:snapshot.id,generation:snapshot.generation,eventId:randomUUID(),seq:++snapshot.throughSeq,type,source,receivedAt:Date.now(),payload};
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(snapshot.id,event.seq,event.eventId,messageId ?? null,JSON.stringify(event)); return event;
  }
  events(id: string, after=0, limit=10000): SessionEvent[] { return this.db.prepare('SELECT data FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit).map(r=>JSON.parse(r.data as string)); }
  delete(id: string) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  close() { this.db.close(); }
}
