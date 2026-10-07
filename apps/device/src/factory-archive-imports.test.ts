import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import type { Chat, Session } from '@enoughfactory/contracts';
import type { EnvmuxReady } from '@enoughfactory/envmux';
import { hashFile } from '@enoughfactory/workspaces';
import { factoryArchiveImportBucket, importFactoryEnvironmentArchives, type FactoryArchiveImportManifest, type FactoryArchiveImportRecord } from './factory-archive-imports.ts';
import type { EphemeralContainerReceipt } from './factory-container-retirement.ts';
import { Store } from './store.ts';
import { exec } from './util.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'enough-archive-import-'));
  const store = new Store(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const sessionId = 'session_import', containerId = 'a'.repeat(64), name = 'repository-f-import';
  const endpoint = { host: 'unix:///private/enoughfactory-import-test.sock', configDirectory: path.join(dataDir, 'docker'), cliPath: path.join(dataDir, 'fake-docker') };
  const ready: EnvmuxReady = { type: 'ready', version: 1, endpoint: 'http://127.0.0.1:43199', token: 'fixture-private-token',
    project: 'repository', session: 'f-import', instance: name, workdir: '/work', user: 'root', branch: 'envmux/f-import', dockerHost: endpoint.host };
  const session: Session = { id: sessionId, projectId: 'project', deviceId: 'local', name: ready.session, containerId: name, status: 'unknown', services: [],
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
  const chat: Chat = { id: 'chat', sessionId, deviceId: 'local', runtime: 'codex', title: 'Preserved chat', status: 'interrupted', approvalMode: 'approve-all',
    createdAt: session.createdAt, updatedAt: session.updatedAt };
  const projectPath = path.join(dataDir, 'source');
  const launch = { id: sessionId, generation: 1, dockerHost: endpoint.host, projectPath };
  store.set('sessions', session); store.set('chats', chat); store.set('session-launch', launch);
  store.set('session-private', { id: sessionId, ready, projectPath });
  store.set('attempts', { id: 'attempt', sessionId, status: 'unknown' });
  const directory = path.join(dataDir, 'provider-history', sessionId, containerId), source = path.join(dataDir, 'fixture', 'work');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(source, { recursive: true, mode: 0o700 });
  await writeFile(path.join(source, 'important.txt'), 'Authored files and useful history remain preserved.\n', { mode: 0o600 });
  const archive = path.join(directory, '00-work.tar.gz');
  await exec('/usr/bin/tar', ['-czf', archive, '--format=pax', '-C', path.dirname(source), 'work'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }); await chmod(archive, 0o600);
  const archiveBytes = await readFile(archive), raw = gunzipSync(archiveBytes);
  const metadata = { ...await hashFile(archive), rawSha256: createHash('sha256').update(raw).digest('hex'), rawSize: raw.length,
    entries: (await exec('/usr/bin/tar', ['-tzf', archive])).stdout.trim().split('\n').length };
  const receipt: EphemeralContainerReceipt & { status: 'removed' } = { version: 2, status: 'removed', runtime: 'ephemeral', containerId,
    identity: { sessionId, container: name, name, project: ready.project, sessionName: ready.session, projectPath, branch: ready.branch, workdir: ready.workdir },
    fingerprint: {}, archive, ...metadata, archives: [{ source: '/work', root: 'work', archive, exclusions: [], ...metadata }], ownedVolumes: [],
    runtimeKinds: ['codex'], exclusions: ['/root/.npm', '/root/.cache', '/root/.codex/plugins/cache', '/opt/enoughfactory/node', '/opt/enoughfactory/antigravity'] };
  const canonicalPath = path.join(directory, 'preservation.json');
  await writeFile(canonicalPath, JSON.stringify(receipt), { mode: 0o600 });
  const inbox = path.join(dataDir, 'provider-history-imports'); await mkdir(inbox, { mode: 0o700 });
  const manifest: FactoryArchiveImportManifest = { version: 1, id: 'maintenance-fixture', status: 'completed', sessions: [{ sessionId, launchGeneration: 1, receipt }] };
  const manifestPath = path.join(inbox, 'maintenance.json'); await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const statePath = path.join(dataDir, 'fake-docker-state.json');
  await writeFile(statePath, JSON.stringify({ mode: 'absent', calls: [] as string[][] }), { mode: 0o600 });
  await writeFile(endpoint.cliPath, `#!${process.execPath}
const fs=require('node:fs'),statePath=${JSON.stringify(statePath)},args=process.argv.slice(2);
if(args[0]!=='--host'||args[1]!==${JSON.stringify(endpoint.host)}||args[2]!=='--config')process.exit(90);
const command=args.slice(4),state=JSON.parse(fs.readFileSync(statePath,'utf8'));
if(command[0]!=='inspect'||command[1]!=='--type'||command[2]!=='container')process.exit(91);
state.calls.push(command);fs.writeFileSync(statePath,JSON.stringify(state));
if(state.mode==='replacement'&&command[3]===${JSON.stringify(name)}){process.stdout.write('[{}]');process.exit(0);}
if(state.mode==='offline'){process.stderr.write('private provider diagnostic must never enter metadata');process.exit(2);}
process.stderr.write('Error: No such object: '+command[3]);process.exit(1);
`, { mode: 0o700 });
  const state = () => JSON.parse(readFileSync(statePath, 'utf8')) as { mode: string; calls: string[][] };
  const setMode = async (mode: string) => writeFile(statePath, JSON.stringify({ mode, calls: [] }), { mode: 0o600 });
  let canRetire = true;
  const input = { dataDir, store, endpoint, sessions: {
    owns: () => true,
    record: (id: string) => { const value = store.get<Session>('sessions', id); assert.ok(value); return value; },
    canRetireEnvironment: () => canRetire,
  } };
  const record = () => store.get<FactoryArchiveImportRecord>(factoryArchiveImportBucket, `${manifest.id}:${sessionId}`);
  return { ...input, input, sessionId, containerId, name, session, chat, launch, receipt, archive, archiveBytes, canonicalPath, manifestPath,
    state, setMode, record, setCanRetire: (value: boolean) => { canRetire = value; } };
}

test('verified maintenance archives become durable environment history once without changing execution outcomes', async t => {
  const f = await fixture(t);
  assert.deepEqual(await importFactoryEnvironmentArchives(f.input), { imported: 1, deferred: 0, skipped: 0 }, f.record()?.reason);
  const retired = f.store.get<{ status: string; receipt: unknown }>('session-container-retirement', f.sessionId)!;
  assert.equal(retired.status, 'removed'); assert.deepEqual(retired.receipt, f.receipt);
  assert.equal(f.record()?.status, 'imported');
  assert.deepEqual(f.state().calls.map(command => command[3]), [f.containerId, f.name]);
  assert.deepEqual(await importFactoryEnvironmentArchives(f.input), { imported: 0, deferred: 0, skipped: 1 });
  const history = f.store.events<{ sourceImportId: string }>('session-environment-history', f.sessionId);
  assert.equal(history.length, 1); assert.equal(history[0]!.value.sourceImportId, 'maintenance-fixture:session_import');
  assert.deepEqual(f.store.get('sessions', f.sessionId), f.session); assert.deepEqual(f.store.get('chats', 'chat'), f.chat);
  assert.equal(f.store.get<{ status: string }>('attempts', 'attempt')?.status, 'unknown');
  assert.deepEqual(await readFile(f.archive), f.archiveBytes);
});

test('a null public container ID is absent when the saved private generation and ownership are exact', async t => {
  const f = await fixture(t), retained = { ...f.session, containerId: null };
  f.store.set('sessions', retained);
  assert.deepEqual(await importFactoryEnvironmentArchives(f.input), { imported: 1, deferred: 0, skipped: 0 }, f.record()?.reason);
  assert.deepEqual(f.store.get('sessions', f.sessionId), retained, 'archive adoption does not rewrite uncertain public state');
  assert.deepEqual(f.store.get('chats', 'chat'), f.chat);
  assert.equal(f.store.get<{ status: string }>('attempts', 'attempt')?.status, 'unknown');
});

test('generation, chat, native-owner and same-name replacement fences prevent adoption, including a change after inspection', async t => {
  const f = await fixture(t);
  f.store.set('session-launch', { ...f.launch, generation: 2 });
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  f.store.set('session-launch', f.launch); f.store.set('chats', { ...f.chat, status: 'running' });
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  f.store.set('chats', f.chat); f.setCanRetire(false);
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  f.setCanRetire(true); await f.setMode('replacement');
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  await f.setMode('absent');
  assert.equal((await importFactoryEnvironmentArchives({ ...f.input, assertCurrent: () => {
    if (f.state().calls.length >= 2) f.store.set('session-launch', { ...f.launch, generation: 2 });
  } })).deferred, 1);
  assert.equal(f.state().calls.length, 2, 'the final generation fence runs after both absent-container inspections');
  assert.equal(f.record()?.status, 'deferred'); assert.equal(f.store.get('session-container-retirement', f.sessionId), undefined);
  assert.equal(f.store.events('session-environment-history', f.sessionId).length, 0);
  assert.deepEqual(f.store.get('sessions', f.sessionId), f.session); assert.deepEqual(f.store.get('chats', 'chat'), f.chat);
});

test('corrupt archives, mismatched canonical receipts and unavailable runtimes stay deferred without leaking provider diagnostics', async t => {
  const f = await fixture(t);
  await writeFile(f.archive, 'not a verified archive', { mode: 0o600 });
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  await writeFile(f.archive, f.archiveBytes, { mode: 0o600 });
  await writeFile(f.canonicalPath, JSON.stringify({ ...f.receipt, status: 'archived' }), { mode: 0o600 });
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  await writeFile(f.canonicalPath, JSON.stringify(f.receipt), { mode: 0o600 }); await f.setMode('offline');
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  assert.doesNotMatch(f.record()!.reason!, /private provider diagnostic/);
  await chmod(f.manifestPath, 0o644);
  assert.equal((await importFactoryEnvironmentArchives(f.input)).deferred, 1);
  assert.equal(f.store.get('session-container-retirement', f.sessionId), undefined);
  assert.equal(f.store.events('session-environment-history', f.sessionId).length, 0);
});
