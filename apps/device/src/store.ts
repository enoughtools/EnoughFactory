import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export class Store {
  private db: DatabaseSync;
  private depth = 0;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'factory.sqlite'));
    chmodSync(path.join(directory, 'factory.sqlite'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS records(bucket TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bucket,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL,at TEXT NOT NULL);`);
  }
  list<T>(bucket: string): T[] {
    return this.db.prepare('SELECT value FROM records WHERE bucket=? ORDER BY rowid').all(bucket).map(row => JSON.parse(String(row.value)) as T);
  }
  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE bucket=? AND id=?').get(bucket, id);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  set<T extends {id: string}>(bucket: string, value: T): void {
    this.db.prepare('INSERT INTO records(bucket,id,value) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value').run(bucket, value.id, JSON.stringify(value));
  }
  delete(bucket: string, id: string): void { this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, id); }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  append<T>(topic: string, entity: string, value: T): number {
    return Number(this.db.prepare('INSERT INTO events(topic,entity,value,at) VALUES(?,?,?,?)').run(topic, entity, JSON.stringify(value), new Date().toISOString()).lastInsertRowid);
  }
  events<T>(topic: string, entity: string, cursor = 0): {seq: number; value: T}[] {
    return this.db.prepare('SELECT seq,value FROM events WHERE topic=? AND entity=? AND seq>? ORDER BY seq LIMIT 10000').all(topic, entity, cursor).map(row => ({ seq: Number(row.seq), value: JSON.parse(String(row.value)) as T }));
  }
  close(): void { this.db.close(); }
}
