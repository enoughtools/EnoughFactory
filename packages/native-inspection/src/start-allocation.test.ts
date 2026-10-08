import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appInventorySha256, NativeInspectionBackend, NativeInspectionError, NativeSessionNotAllocatedError, type NativeProduct } from './index.js';

const sessionId = '11111111-2222-4333-8444-555555555555';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'enough-native-allocation-')));
  const app = join(root, 'Original.app'); await mkdir(app); await writeFile(join(app, 'original'), 'original product');
  const product: NativeProduct = {
    platform: 'macos', appPath: app, bundleIdentifier: 'tools.enough.fixture', inventorySha256: await appInventorySha256(app), originalArtifactSha256: 'a'.repeat(64),
    source: { kind: 'integrated', commit: 'a'.repeat(40) }, launchArguments: ['--fixture', 'isolated'], fixture: { kind: 'verified-isolated', runId: 'isolated', evidenceSha256: 'a'.repeat(64) },
  };
  return { root, app, product, directory: join(root, 'sessions') };
}
async function helper(root: string, mode: 'flip' | 'normal' | 'late-blocked') {
  const executable = join(root, 'helper'); const log = join(root, 'calls');
  await writeFile(executable, `#!/usr/bin/env node
const {createInterface}=require('node:readline');const {appendFileSync}=require('node:fs');let readinessCount=0;
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(log)},r.kind+'\\n');let value;
if(r.kind==='readiness'){readinessCount++;value=${JSON.stringify(mode)}==='flip'&&readinessCount>1?{status:'setup-required',reasons:['Desktop became unavailable.']}:{status:'ready',reasons:[]};}
else if(r.kind==='start'){if(${JSON.stringify(mode)}==='late-blocked'){process.stdout.write(JSON.stringify({id:r.id,ok:false,error:{code:'setup-required',message:'Desktop became unavailable after allocation.'}})+'\\n');return;}value={pid:12345,processStartedAt:1000};}
else value={stopped:true};process.stdout.write(JSON.stringify({id:r.id,ok:true,value})+'\\n');});
`, { mode: 0o700 });
  return { executable, log };
}

test('a readiness flip before allocation explicitly proves no new session journal or helper launch', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const fake = await helper(f.root, 'flip');
  const backend = new NativeInspectionBackend({ directory: f.directory, macHelperExecutable: fake.executable });
  try {
    assert.equal((await backend.readiness('macos')).status, 'ready');
    await assert.rejects(backend.start(f.product, 'attempt-flip', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeSessionNotAllocatedError);
      assert.ok(error instanceof NativeInspectionError);
      assert.equal(error.code, 'session-not-allocated');
      assert.equal(error.allocationOutcome, 'not-allocated');
      assert.equal(error.reasonCode, 'setup-required');
      assert.equal(error.sessionId, sessionId);
      return true;
    });
    assert.deepEqual((await readFile(fake.log, 'utf8')).trim().split('\n'), ['readiness', 'readiness']);
    await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
    assert.deepEqual(await backend.discover(), []);
  } finally { backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});

test('product validation before allocation carries the same explicit proof', async () => {
  const f = await fixture(); const backend = new NativeInspectionBackend({ directory: f.directory });
  let readinessCalls = 0; backend.readiness = async () => { readinessCalls++; return { status: 'ready', reasons: [] }; };
  try {
    await writeFile(join(f.app, 'original'), 'changed product');
    await assert.rejects(backend.start(f.product, 'attempt-invalid-product', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeSessionNotAllocatedError);
      assert.equal(error.reasonCode, 'product-changed');
      assert.equal(error.sessionId, sessionId);
      return true;
    });
    assert.equal(readinessCalls, 0);
    await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
  } finally { backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});

test('an existing stopped UUID cannot be classified unallocated by a later readiness or product failure', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const fake = await helper(f.root, 'normal');
  const options = { directory: f.directory, macHelperExecutable: fake.executable };
  const backend = new NativeInspectionBackend(options); const restored = new NativeInspectionBackend(options);
  let readinessCalls = 0; restored.readiness = async () => { readinessCalls++; return { status: 'setup-required', reasons: ['Desktop unavailable.'] }; };
  try {
    const session = await backend.start(f.product, 'attempt-original', sessionId); await backend.stop(session.id);
    await writeFile(fake.log, ''); await writeFile(join(f.app, 'original'), 'changed product');
    await assert.rejects(restored.start(f.product, 'attempt-reuse', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeInspectionError);
      assert.equal(error.code, 'session-exists');
      assert.equal(error instanceof NativeSessionNotAllocatedError, false);
      return true;
    });
    assert.equal(readinessCalls, 0); assert.equal(await readFile(fake.log, 'utf8'), '');
    assert.equal(JSON.parse(await readFile(join(session.directory, 'session.json'), 'utf8')).status, 'stopped');
  } finally { backend.closeTransport(); restored.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});

test('a UUID allocated concurrently during preflight remains EEXIST without a no-allocation proof', async () => {
  const f = await fixture(); const backend = new NativeInspectionBackend({ directory: f.directory });
  backend.readiness = async () => { await mkdir(join(f.directory, sessionId), { recursive: true }); return { status: 'ready', reasons: [] }; };
  try {
    await assert.rejects(backend.start(f.product, 'attempt-racing-owner', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeInspectionError); assert.equal(error.code, 'session-exists');
      assert.equal(error instanceof NativeSessionNotAllocatedError, false); return true;
    });
    assert.deepEqual(await readdir(join(f.directory, sessionId)), []);
    await assert.rejects(backend.discover(), { code: 'ownership-unknown' });
  } finally { backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});

test('a UUID acquired during a failing readiness preflight cannot carry a no-allocation proof', async () => {
  const f = await fixture(); const backend = new NativeInspectionBackend({ directory: f.directory });
  backend.readiness = async () => { await mkdir(join(f.directory, sessionId), { recursive: true }); return { status: 'setup-required', reasons: ['Desktop became unavailable.'] }; };
  try {
    await assert.rejects(backend.start(f.product, 'attempt-racing-blocked-owner', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeInspectionError); assert.equal(error.code, 'session-exists');
      assert.equal(error instanceof NativeSessionNotAllocatedError, false); return true;
    });
    assert.deepEqual(await readdir(join(f.directory, sessionId)), []);
    await assert.rejects(backend.discover(), { code: 'ownership-unknown' });
  } finally { backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});

test('readiness failure after a launch journal exists keeps its outcome unknown', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const fake = await helper(f.root, 'late-blocked');
  const backend = new NativeInspectionBackend({ directory: f.directory, macHelperExecutable: fake.executable });
  try {
    await assert.rejects(backend.start(f.product, 'attempt-late-flip', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeInspectionError); assert.equal(error.code, 'setup-required');
      assert.equal(error instanceof NativeSessionNotAllocatedError, false); return true;
    });
    assert.deepEqual((await readFile(fake.log, 'utf8')).trim().split('\n'), ['readiness', 'start']);
    assert.equal(JSON.parse(await readFile(join(f.directory, sessionId, 'session.json'), 'utf8')).status, 'unknown');
    assert.equal((await backend.discover())[0]?.status, 'unknown');
  } finally { backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});
