import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'enoughfactory-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename: path.join(directory, 'factory.sqlite') };
}

function seed(filename: string, versionSql = '') {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bucket,id));
      CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL,at TEXT NOT NULL);`);
    db.prepare('INSERT INTO records VALUES(?,?,?)').run('goals', 'goal', JSON.stringify({ id: 'goal', status: 'running' }));
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(41, 'goal', 'goal', JSON.stringify({ state: 'running' }), '2026-10-05T00:00:00.000Z');
    if (versionSql) db.exec(versionSql);
  } finally { db.close(); }
}

for (const versioned of [false, true]) {
  test(`${versioned ? 'version 1 startup' : 'unversioned adoption'} retains records and event cursors across reopen`, async t => {
    const { directory, filename } = await fixture(t);
    seed(filename, versioned ? 'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1)' : '');
    const store = new Store(directory);
    try {
      assert.deepEqual(store.get('goals', 'goal'), { id: 'goal', status: 'running' });
      assert.deepEqual(store.events('goal', 'goal', 40), [{ seq: 41, value: { state: 'running' } }]);
      assert.equal(store.append('goal', 'goal', { state: 'checking' }), 42);
    } finally { store.close(); }
    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.get('goals', 'goal'), { id: 'goal', status: 'running' });
      assert.deepEqual(reopened.events('goal', 'goal', 41), [{ seq: 42, value: { state: 'checking' } }]);
    } finally { reopened.close(); }
    const db = new DatabaseSync(filename, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().map(row => row.version), [1]); }
    finally { db.close(); }
  });
}

test('a fresh database initializes the baseline once and remains writable after reopen', async t => {
  const { directory } = await fixture(t);
  const store = new Store(directory);
  try {
    store.set('goals', { id: 'new', status: 'planned' });
    assert.equal(store.append('goal', 'new', { state: 'planned' }), 1);
  } finally { store.close(); }
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.get('goals', 'new'), { id: 'new', status: 'planned' });
    assert.equal(reopened.append('goal', 'new', { state: 'running' }), 2);
  } finally { reopened.close(); }
});

const invalidVersions = [
  { name: 'newer', sql: 'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(2)', error: /newer than this build supports/ },
  { name: 'empty', sql: 'CREATE TABLE schema_version(version INTEGER NOT NULL)', error: /exactly one positive integer/ },
  { name: 'duplicate', sql: 'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1),(1)', error: /exactly one positive integer/ },
  { name: 'zero', sql: 'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(0)', error: /exactly one positive integer/ },
  { name: 'fractional', sql: 'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1.5)', error: /exactly one positive integer/ },
  { name: 'text', sql: "CREATE TABLE schema_version(version TEXT NOT NULL); INSERT INTO schema_version VALUES('1')", error: /exactly one positive integer/ },
  { name: 'view', sql: 'CREATE VIEW schema_version AS SELECT 1 AS version', error: /expected a table/ },
];
for (const scenario of invalidVersions) {
  test(`startup rejects ${scenario.name} version metadata without changing the database and closes its handle`, async t => {
    const { directory, filename } = await fixture(t);
    seed(filename, scenario.sql);
    const before = await readFile(filename);
    const close = t.mock.method(DatabaseSync.prototype, 'close');
    assert.throws(() => new Store(directory), scenario.error);
    assert.equal(close.mock.callCount(), 1, 'startup rejection must close its database handle');
    close.mock.restore();
    assert.deepEqual(await readFile(filename), before, 'rejected startup must leave all schema, records and events unchanged');
  });
}

test('failed baseline adoption rolls back earlier DDL and retains the original database', async t => {
  const { directory, filename } = await fixture(t);
  const db = new DatabaseSync(filename);
  try {
    db.exec('CREATE TABLE events(original TEXT NOT NULL); INSERT INTO events VALUES(\'retained\')');
  } finally { db.close(); }
  const before = await readFile(filename);
  assert.throws(() => new Store(directory), /events does not match the supported schema/);
  assert.deepEqual(await readFile(filename), before, 'failed adoption must undo the new records and version tables');
  const reopened = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(reopened.prepare('SELECT original FROM events').all().map(row => row.original), ['retained']);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('records','schema_version')").get()?.count, 0);
  } finally { reopened.close(); }
});

for (const scenario of [
  { name: 'records without rowids', table: 'records', sql: `CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bucket,id)) WITHOUT ROWID;
    INSERT INTO records VALUES('goals','retained','{"id":"retained"}')` },
  { name: 'events with reusable cursors', table: 'events', sql: `CREATE TABLE events(seq INTEGER PRIMARY KEY,topic TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL,at TEXT NOT NULL);
    INSERT INTO events VALUES(41,'goal','retained','{}','2026-10-05T00:00:00.000Z')` },
]) {
  test(`baseline adoption rejects ${scenario.name} without changing existing data`, async t => {
    const { directory, filename } = await fixture(t);
    const db = new DatabaseSync(filename);
    try { db.exec(scenario.sql); } finally { db.close(); }
    const before = await readFile(filename);
    assert.throws(() => new Store(directory), new RegExp(`${scenario.table} does not match the supported schema`));
    assert.deepEqual(await readFile(filename), before);
  });
}
