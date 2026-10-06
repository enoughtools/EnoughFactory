import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';

const bucket = 'migration-fixture';
const recordId = 'legacy-record';
const record = { id: recordId, label: 'Retained legacy data', nested: { revision: 7, values: ['source', 'evidence'] } };
const event = { seq: 41, topic: bucket, entity: recordId, value: JSON.stringify({ state: 'retained', revision: 7 }), at: '2026-10-05T00:00:00.000Z' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(accept => setTimeout(accept, ms));

function sqlite(node, source, args) {
  return JSON.parse(execFileSync(node, ['--input-type=module', '-e', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }));
}

export async function seedDataFixture(node, home, kind = 'legacy') {
  assert(['legacy', 'version1', 'future', 'malformed'].includes(kind), 'Unknown data fixture kind.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const filename = join(home, 'factory.sqlite');
  const result = sqlite(node, `
    import { DatabaseSync } from 'node:sqlite';
    import { existsSync } from 'node:fs';
    const [filename, kind, input] = process.argv.slice(1);
    if (existsSync(filename)) throw new Error('Refusing to overwrite a data fixture database.');
    const { bucket, recordId, record, event } = JSON.parse(input);
    const db = new DatabaseSync(filename);
    try {
      db.exec('CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bucket,id))');
      db.prepare('INSERT INTO records VALUES(?,?,?)').run(bucket, recordId, JSON.stringify(record));
      if (kind === 'malformed') {
        db.exec('CREATE TABLE events(original TEXT NOT NULL)');
        db.prepare('INSERT INTO events VALUES(?)').run('retained malformed baseline');
      } else {
        db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL,at TEXT NOT NULL)');
        db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.seq, event.topic, event.entity, event.value, event.at);
      }
      if (kind === 'version1' || kind === 'future') {
        db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL)');
        db.prepare('INSERT INTO schema_version VALUES(?)').run(kind === 'future' ? 2 : 1);
      }
    } finally { db.close(); }
    console.log(JSON.stringify({ kind, filename }));
  `, [filename, kind, JSON.stringify({ bucket, recordId, record, event })]);
  return { ...result, sha256: sha256(await readFile(filename)) };
}

export function readDataFixture(node, home) {
  return sqlite(node, `
    import { DatabaseSync } from 'node:sqlite';
    const [filename, bucket, recordId] = process.argv.slice(1);
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const metadata = db.prepare("SELECT type FROM sqlite_schema WHERE name='schema_version'").get();
      const version = metadata ? db.prepare('SELECT version FROM schema_version').get()?.version : 0;
      const retained = db.prepare('SELECT value FROM records WHERE bucket=? AND id=?').get(bucket, recordId);
      const eventColumns = db.prepare('PRAGMA table_info(events)').all().map(column => column.name);
      const events = eventColumns.includes('seq') ? db.prepare('SELECT seq,topic,entity,value,at FROM events WHERE topic=? AND entity=? ORDER BY seq').all(bucket, recordId) : [];
      const sequence = db.prepare("SELECT type FROM sqlite_schema WHERE name='sqlite_sequence'").get() ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq : undefined;
      console.log(JSON.stringify({ version, record: retained?.value, events, eventColumns, sequence }));
    } finally { db.close(); }
  `, [join(home, 'factory.sqlite'), bucket, recordId]);
}

export function inspectMigratedData(node, home) {
  const snapshot = readDataFixture(node, home);
  assert.equal(snapshot.version, 1, 'Installed service did not adopt/reopen schema version 1.');
  assert.equal(snapshot.record, JSON.stringify(record), 'Installed service changed a retained legacy record.');
  assert.deepEqual(snapshot.events, [event], 'Installed service changed retained events or their cursors.');
  assert(Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= event.seq, 'Installed service reset or invalidated the persistent event cursor.');
  return { status: 'passed', schemaVersion: snapshot.version, retainedRecordCount: 1, retainedEventCount: 1, eventCursor: event.seq, persistentCursorHighWaterMark: snapshot.sequence, retainedDataSha256: sha256(JSON.stringify({ record: snapshot.record, events: snapshot.events })) };
}

async function portOpen(port) {
  return await new Promise(accept => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); accept(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(300, () => finish(true));
  });
}
async function fileExists(filename) {
  try { await access(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function checkRejectedStartup(resources, home, kind) {
  assert(['future', 'malformed'].includes(kind), 'Unknown rejected-startup fixture.');
  const node = join(resources, 'runtime/node');
  const seeded = await seedDataFixture(node, home, kind);
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; listener.close(); await once(listener, 'close');
  const env = {
    ...process.env, ENOUGHFACTORY_HOME: home, ENOUGHFACTORY_PORT: String(port), ENOUGHFACTORY_RESOURCES: resources,
    ENOUGHFACTORY_CONTAINER_ASSETS: join(resources, 'runtime/container'), ENOUGHFACTORY_WEB_PATH: join(resources, 'web'),
    ENOUGHFACTORY_ENVMUX_PATH: join(resources, 'envmux/envmux'), ENOUGHFACTORY_REPO: undefined,
  };
  const child = spawn(node, [join(resources, 'device/service.cjs')], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', finished = false, launchError;
  const exited = new Promise(accept => {
    child.once('error', error => { launchError = error; finished = true; accept({ code: null, signal: null }); });
    child.once('close', (code, signal) => { finished = true; accept({ code, signal }); });
  });
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => { output = (output + bytes).slice(-12_000); });
  let listenerObserved = false, connectionRecordCreated = false;
  try {
    const deadline = Date.now() + 15_000;
    while (!finished && Date.now() < deadline) {
      listenerObserved ||= await portOpen(port);
      connectionRecordCreated ||= await fileExists(join(home, 'connection.json'));
      if (!finished) await pause(50);
    }
    if (!finished) throw new Error(`Rejected ${kind} database startup did not exit before its deadline.\n${output}`);
    const result = await exited;
    if (launchError) throw launchError;
    listenerObserved ||= await portOpen(port);
    connectionRecordCreated ||= await fileExists(join(home, 'connection.json'));
    assert(Number.isInteger(result.code) && result.code !== 0 && !result.signal, `The ${kind} startup did not reject its database cleanly.\n${output}`);
    assert(!listenerObserved && !connectionRecordCreated, `The ${kind} startup became reachable before rejecting its database.`);
    assert.match(output, kind === 'future' ? /database schema version 2 is newer than this build supports/ : /events does not match the supported schema/, `The ${kind} startup failed for an unrelated reason.`);
    const after = sha256(await readFile(join(home, 'factory.sqlite')));
    assert.equal(after, seeded.sha256, `Rejected ${kind} startup changed its database.`);
    return { status: 'passed', fixture: kind === 'future' ? 'newer-schema-version-2' : 'malformed-events-baseline', exitCode: result.code, listenerObserved, connectionRecordCreated, databaseSha256Before: seeded.sha256, databaseSha256After: after, databaseBytesPreserved: true };
  } finally {
    if (!finished) {
      // Only terminate the child this check created, never a recorded service PID.
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await exited; clearTimeout(timer);
    }
  }
}
