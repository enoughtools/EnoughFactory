import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

const migrations = [{
  version: 1,
  apply(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS records(bucket TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bucket,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL,at TEXT NOT NULL);`);
  },
}];
const currentSchemaVersion = migrations.at(-1)!.version;

function schemaVersion(db: DatabaseSync): number {
  const object = db.prepare("SELECT type FROM sqlite_schema WHERE name='schema_version'").get();
  if (!object) return 0; // Before migrations were introduced, the baseline had no version table.
  if (object.type !== 'table') throw new Error('Invalid EnoughFactory schema_version: expected a table.');
  const columns = db.prepare('PRAGMA table_info(schema_version)').all();
  if (columns.length !== 1 || columns[0]?.name !== 'version') {
    throw new Error('Invalid EnoughFactory schema_version: expected one version column.');
  }
  const rows = db.prepare('SELECT CAST(version AS TEXT) AS version,typeof(version) AS kind FROM schema_version LIMIT 2').all();
  if (rows.length !== 1 || rows[0]?.kind !== 'integer' || !/^[1-9]\d*$/.test(String(rows[0]?.version))) {
    throw new Error('Invalid EnoughFactory schema_version: expected exactly one positive integer version.');
  }
  const version = BigInt(String(rows[0].version));
  if (version > BigInt(currentSchemaVersion)) {
    throw new Error(`EnoughFactory database schema version ${version} is newer than this build supports (${currentSchemaVersion}). Use a compatible newer build.`);
  }
  return Number(version);
}

function validateBaseline(db: DatabaseSync): void {
  const tables = {
    records: [['bucket', 'TEXT', 1, 1], ['id', 'TEXT', 1, 2], ['value', 'TEXT', 1, 0]],
    events: [['seq', 'INTEGER', 0, 1], ['topic', 'TEXT', 1, 0], ['entity', 'TEXT', 1, 0], ['value', 'TEXT', 1, 0], ['at', 'TEXT', 1, 0]],
  };
  for (const [name, expected] of Object.entries(tables)) {
    const object = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name);
    const columns = db.prepare(`PRAGMA table_info(${name})`).all();
    const actual = columns.map(column => [column.name, String(column.type).toUpperCase(), column.notnull, column.pk]);
    const table = db.prepare('PRAGMA table_list').all().find(row => row.schema === 'main' && row.name === name);
    // Ignore comments and quoted literals/identifiers when checking the persistent cursor contract.
    const sql = String(object?.sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g, ' ');
    if (object?.type !== 'table' || table?.wr !== 0 || JSON.stringify(actual) !== JSON.stringify(expected) ||
      (name === 'events' && !/\bAUTOINCREMENT\b/i.test(sql))) {
      throw new Error(`Invalid EnoughFactory database: ${name} does not match the supported schema. Restore a consistent backup.`);
    }
  }
}

function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    let version = schemaVersion(db);
    if (version === 0) db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL)');
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      migration.apply(db);
      if (version === 0) db.prepare('INSERT INTO schema_version(version) VALUES(?)').run(migration.version);
      else db.prepare('UPDATE schema_version SET version=?').run(migration.version);
      version = migration.version;
    }
    validateBaseline(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the startup failure. */ }
    throw error;
  }
}

export class Store {
  private db: DatabaseSync;
  private depth = 0;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'factory.sqlite'));
    try {
      chmodSync(path.join(directory, 'factory.sqlite'), 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      migrate(this.db);
      this.db.exec('PRAGMA journal_mode=WAL;');
    } catch (error) {
      try { this.db.close(); } catch { /* Preserve the startup failure. */ }
      throw error;
    }
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
