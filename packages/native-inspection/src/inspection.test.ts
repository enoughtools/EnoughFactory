import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appInventorySha256, NativeInspectionBackend, verifyNativeProduct, type NativeProduct } from './index.js';
import { IOSCommandBroker } from './transport.js';

const h = 'a'.repeat(64);
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'enough-native-inspection-')));
  const app = join(root, 'Original.app'); await mkdir(app); await writeFile(join(app, 'original'), 'exact original bytes');
  const product: NativeProduct = { platform: 'macos', appPath: app, bundleIdentifier: 'tools.enough.fixture', inventorySha256: await appInventorySha256(app), originalArtifactSha256: h, source: { kind: 'integrated', commit: 'a'.repeat(40) }, launchArguments: ['--fixture', 'isolated'], fixture: { kind: 'verified-isolated', runId: 'isolated', evidenceSha256: h } };
  return { root, app, product };
}
test('modified original app bytes and escaping symlinks cannot be launched as the verified product', async () => {
  const { root, app, product } = await fixture();
  try {
    await verifyNativeProduct(product);
    await writeFile(join(app, 'original'), 'changed bytes');
    await assert.rejects(verifyNativeProduct(product), { code: 'product-changed' });
    await symlink(root, join(app, 'escape'));
    await assert.rejects(appInventorySha256(app), { code: 'invalid-product' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('source and fixture provenance are required separately from an app path', async () => {
  const { root, product } = await fixture();
  try {
    await assert.rejects(verifyNativeProduct({ ...product, fixture: undefined! }), { code: 'fixture-required' });
    await assert.rejects(verifyNativeProduct({ ...product, source: { kind: 'development-snapshot' } }), { code: 'invalid-product' });
    await verifyNativeProduct({ ...product, source: { kind: 'development-snapshot', snapshotSha256: h } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('iOS broker authenticates and binds replies to its session without replaying polled input', async () => {
  const broker = new IOSCommandBroker('owned-session', 1000); await broker.listen();
  const headers = { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(broker.url + '/v1/command')).status, 401);
    const result = broker.call({ kind: 'click', observationId: 'observation', elementId: 'element' });
    const command = await (await fetch(broker.url + '/v1/command', { headers })).json() as any;
    assert.equal(command.sessionId, 'owned-session');
    assert.equal((await fetch(broker.url + '/v1/command', { headers })).status, 204);
    assert.equal((await fetch(broker.url + '/v1/result', { method: 'POST', headers, body: JSON.stringify({ id: command.id, sessionId: 'another-session', ok: true, value: { performed: true } }) })).status, 400);
    assert.equal((await fetch(broker.url + '/v1/result', { method: 'POST', headers, body: JSON.stringify({ id: command.id, sessionId: 'owned-session', ok: true, value: { performed: true } }) })).status, 204);
    assert.deepEqual(await result, { performed: true });
  } finally { broker.close(); }
});
test('timed-out queued input is removed and retains an unknown outcome', async () => {
  const broker = new IOSCommandBroker('owned-session', 20); await broker.listen();
  try {
    await assert.rejects(broker.call({ kind: 'click' }), { code: 'action-unknown' });
    assert.equal((await fetch(broker.url + '/v1/command', { headers: { authorization: `Bearer ${broker.token}` } })).status, 204);
  } finally { broker.close(); }
});
test('session wrapper fences stale references, serializes launch and reports interrupted sessions honestly', { skip: process.platform !== 'darwin' }, async () => {
  const { root, product } = await fixture();
  const helper = join(root, 'helper');
  await writeFile(helper, `#!/usr/bin/env node
const{createInterface}=require('node:readline');const{writeFileSync}=require('node:fs');const{join}=require('node:path');let output,seq=0;
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);let value;if(r.kind==='readiness')value={status:'ready',reasons:[]};else if(r.kind==='start'){output=r.outputDirectory;value={pid:12345,processStartedAt:1000}}else if(r.kind==='observe'){const id='observation-'+(++seq),path=join(output,id+'.png');writeFileSync(path,Buffer.from('89504e470d0a1a0a','hex'));value={observationId:id,observedAt:new Date().toISOString(),appState:'foreground',elements:[],screenshot:{path,width:1,height:1}}}else if(r.kind==='restart')value={performed:true,requiresObservation:true,previousProcessExited:true,previousPid:12345,pid:12346,processStartedAt:1001};else value={performed:true,requiresObservation:true};process.stdout.write(JSON.stringify({id:r.id,ok:true,value})+'\\n')});
`, { mode: 0o700 });
  const backend = new NativeInspectionBackend({ directory: join(root, 'sessions'), macHelperExecutable: helper });
  try {
    const first = backend.start(product, 'attempt-1');
    await assert.rejects(backend.start(product, 'attempt-2'), { code: 'native-busy' });
    const session = await first; const observation = await backend.observe(session.id);
    await backend.act(session.id, { kind: 'click', observationId: observation.observationId, elementId: 'element' });
    await assert.rejects(backend.act(session.id, { kind: 'click', observationId: observation.observationId, elementId: 'element' }), { code: 'stale-observation' });
    await assert.rejects(backend.restart(session.id, observation.observationId), { code: 'stale-observation' });
    const beforeRestart = await backend.observe(session.id);
    const exit = await backend.restart(session.id, beforeRestart.observationId);
    assert.equal(exit.previousProcessExited, true);
    assert.equal(exit.previousPid, 12345);
    assert.equal(exit.pid, 12346);
    await assert.rejects(backend.act(session.id, { kind: 'key', observationId: beforeRestart.observationId, key: 'enter' }), { code: 'stale-observation' });
    const persisted = JSON.parse(await readFile(join(session.directory, 'session.json'), 'utf8'));
    assert.equal(persisted.pid, 12346);
    assert.deepEqual(persisted.product, session.product);
    assert.equal(persisted.id, session.id);
    const restarted = new NativeInspectionBackend({ directory: join(root, 'sessions') });
    assert.equal((await restarted.discover())[0]?.status, 'unknown');
    await assert.rejects(restarted.act(session.id, { kind: 'key', observationId: 'observation', key: 'enter' }), { code: 'session-not-found' });
    await backend.stop(session.id);
    assert.deepEqual(await restarted.discover(), []);
    assert.equal(JSON.parse(await readFile(join(session.directory, 'session.json'), 'utf8')).status, 'stopped');
  } finally { backend.closeTransport(); await rm(root, { recursive: true, force: true }); }
});

test('restart recovery stops only a complete retained launch without UI readiness or changing old unknown actions', { skip: process.platform !== 'darwin' }, async () => {
  const { root, product } = await fixture();
  const log = join(root, 'calls'); const helper = join(root, 'recovery-helper');
  await writeFile(helper, `#!/usr/bin/env node
const{createInterface}=require('node:readline');const{appendFileSync}=require('node:fs');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');let value;if(r.kind==='readiness')value={status:'ready',reasons:[]};else if(r.kind==='start')value={pid:23456,processStartedAt:2000};else if(r.kind==='recoverStop')value={originalProcessExited:true,alreadyExited:false};else value={performed:true,requiresObservation:true};setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,ok:true,value})+'\\n'),r.kind==='recoverStop'?60:0)});
`, { mode: 0o700 });
  const options = { directory: join(root, 'sessions'), macHelperExecutable: helper };
  const original = new NativeInspectionBackend(options); const restored = new NativeInspectionBackend(options);
  try {
    await assert.rejects(original.start(product, 'attempt-recovery', '../foreign'), { code: 'invalid-session' });
    const session = await original.start(product, 'attempt-recovery', '11111111-2222-4333-8444-555555555555');
    assert.equal(session.id, '11111111-2222-4333-8444-555555555555');
    await assert.rejects(original.recoverStop(session.id), { code: 'session-busy' });
    const oldAction = '{"outcome":"unknown","reason":"service transport lost after input"}\n';
    const actionPath = join(session.directory, 'action-interrupted.json'); await writeFile(actionPath, oldAction);
    const recordPath = join(session.directory, 'session.json'); const initial = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, '{');
    assert.equal((await original.discover())[0]?.id, session.id); // Live ownership remains visible even if a retained manifest becomes unreadable.
    await writeFile(recordPath, JSON.stringify(initial));
    original.closeTransport(); await writeFile(log, '');
    await assert.rejects(restored.start(product, 'replacement-attempt'), { code: 'native-busy' });
    const cleanup = restored.recoverStop(session.id);
    await assert.rejects(restored.recoverStop(session.id), { code: 'session-busy' });
    await assert.rejects(restored.start(product, 'replacement-attempt'), { code: 'native-busy' });
    assert.deepEqual(await cleanup, { sessionId: session.id, status: 'stopped', originalProcessExited: true, historicalActionsRemainUnknown: true });
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(x => x.kind), ['recoverStop']);
    assert.equal(calls[0].pid, 23456); assert.equal(calls[0].processStartedAt, 2000);
    assert.equal(await readFile(actionPath, 'utf8'), oldAction);
    assert.equal((await restored.recoverStop(session.id)).status, 'stopped');
    assert.deepEqual(await restored.discover(), []);
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
    await assert.rejects(restored.start(product, 'attempt-reuse', session.id), { code: 'session-exists' });

    // Mutable session metadata cannot redirect cleanup away from the immutable owner/launch receipts.
    for (const changed of [
      { ...initial, pid: 34567 },
      { ...initial, processStartedAt: undefined },
      { ...initial, product: { ...initial.product, bundleIdentifier: 'tools.some.other.app' } },
      { ...initial, product: { ...initial.product, launchArguments: ['--different-state'] } },
      { ...initial, status: 'unknown', restartPending: true },
    ]) {
      await writeFile(recordPath, JSON.stringify(changed)); await writeFile(log, '');
      assert.equal((await restored.recoverStop(session.id)).status, 'unknown');
      assert.equal(await readFile(log, 'utf8'), '');
    }
    await writeFile(recordPath, JSON.stringify(initial)); await writeFile(join(product.appPath, 'original'), 'changed product bytes');
    assert.equal((await restored.recoverStop(session.id)).status, 'unknown'); assert.equal(await readFile(log, 'utf8'), '');
    await writeFile(join(product.appPath, 'original'), 'exact original bytes');

    const foreignRoot = join(root, 'foreign-sessions'); await mkdir(foreignRoot); await symlink(session.directory, join(foreignRoot, session.id));
    const foreign = new NativeInspectionBackend({ ...options, directory: foreignRoot });
    assert.equal((await foreign.recoverStop(session.id)).status, 'unknown');
    await assert.rejects(foreign.discover(), { code: 'ownership-unknown' });
    assert.equal(await readFile(log, 'utf8'), ''); foreign.closeTransport();

    await writeFile(recordPath, '{');
    assert.equal((await restored.recoverStop(session.id)).status, 'unknown');
    await assert.rejects(restored.discover(), { code: 'ownership-unknown' });
    await assert.rejects(restored.start(product, 'replacement-attempt'), { code: 'ownership-unknown' });
    assert.equal(await readFile(log, 'utf8'), '');
  } finally { original.closeTransport(); restored.closeTransport(); await rm(root, { recursive: true, force: true }); }
});

test('a lost Mac restart reply keeps replacement-process uncertainty sticky across ordinary unknown saves', { skip: process.platform !== 'darwin' }, async () => {
  const { root, product } = await fixture(); const helper = join(root, 'uncertain-helper'); const log = join(root, 'calls');
  await writeFile(helper, `#!/usr/bin/env node
const{createInterface}=require('node:readline');const{appendFileSync,writeFileSync}=require('node:fs');const{join}=require('node:path');let output;
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(log)},r.kind+'\\n');let value;if(r.kind==='readiness')value={status:'ready',reasons:[]};else if(r.kind==='start'){output=r.outputDirectory;value={pid:34567,processStartedAt:3000}}else if(r.kind==='observe'){const path=join(output,'fresh.png');writeFileSync(path,Buffer.from('89504e470d0a1a0a','hex'));value={observationId:'fresh',observedAt:new Date().toISOString(),appState:'foreground',elements:[],screenshot:{path,width:1,height:1}}}if(r.kind==='restart')process.stdout.write(JSON.stringify({id:r.id,ok:false,error:{code:'action-unknown',message:'Reply lost after native restart input.'}})+'\\n');else process.stdout.write(JSON.stringify({id:r.id,ok:true,value})+'\\n')});
`, { mode: 0o700 });
  const options = { directory: join(root, 'sessions'), macHelperExecutable: helper }; const backend = new NativeInspectionBackend(options); const restored = new NativeInspectionBackend(options);
  try {
    const session = await backend.start(product, 'attempt-lost-restart'); await backend.observe(session.id);
    await assert.rejects(backend.restart(session.id, 'fresh'), { code: 'action-unknown' });
    const record = JSON.parse(await readFile(join(session.directory, 'session.json'), 'utf8'));
    assert.equal(record.status, 'unknown'); assert.equal(record.restartPending, true);
    backend.closeTransport(); await writeFile(log, '');
    assert.equal((await restored.recoverStop(session.id)).status, 'unknown');
    assert.equal(await readFile(log, 'utf8'), '');
  } finally { backend.closeTransport(); restored.closeTransport(); await rm(root, { recursive: true, force: true }); }
});
