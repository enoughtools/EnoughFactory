#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

export const smokeChecks = [
  'current bundled Node and service match the installed manifest',
  'authenticated local health reports the current release',
  'inspection endpoints reject unauthenticated requests',
  'paused goal projects typed tasks and recovered controllers',
  'task inspection preserves kind, criteria and expected outputs',
  'attempt inspection exposes retained candidate and check receipts',
  'legacy task inspection preserves absent optional fields',
  'inspection hides private paths and leaves records unchanged',
  'artifact content matches its immutable manifest',
  'owned private runtime remains stopped',
  'authenticated shutdown exits and closes the service',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(accept => setTimeout(accept, ms));
const at = '2026-10-05T00:00:00.000Z';
const buckets = ['goals', 'tasks', 'attempts', 'factory-plans', 'factory-control', 'factory-task-details', 'factory-attempt-details', 'artifacts', 'factory-controller-runs'];

function sqlite(node, source, args) {
  return JSON.parse(execFileSync(node, ['--input-type=module', '-e', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }));
}

export async function seedSmokeFixture(node, home) {
  const project = { id: 'smoke-project', name: 'Inspection fixture', path: join(home, 'fixture-repository'), deviceId: 'fixture-worker', runtime: 'codex', approvalMode: 'manual', rules: [], createdAt: at };
  const goal = { id: 'smoke-goal', projectId: project.id, coordinatorId: 'fixture-coordinator', title: 'Inspect retained work', objective: 'Read fixture receipts without executing work', criteria: ['Inspection returns retained evidence'], status: 'paused', autonomy: 'manual', approvalMode: 'manual', runtime: 'codex', concurrency: 1, revision: 3, createdAt: at, updatedAt: at };
  const task = { id: 'smoke-typed-task', goalId: goal.id, title: 'Deliver an inspectable feature', description: 'Retain the typed delivery contract', kind: 'feature', acceptanceCriteria: ['The retained response is inspectable'], expectedOutputs: ['Immutable inspection evidence'], dependsOn: [], status: 'completed', currentAttemptId: 'smoke-attempt', createdAt: at, updatedAt: at };
  const legacy = { id: 'smoke-legacy-task', goalId: goal.id, title: 'Retained generic task', description: 'Legacy optional contract fields remain absent', dependsOn: [task.id], status: 'queued', createdAt: at, updatedAt: at };
  const attempt = { id: 'smoke-attempt', taskId: task.id, generation: 2, deviceId: 'fixture-worker', sessionId: 'retained-session', chatId: 'retained-chat', status: 'succeeded', startedAt: at, endedAt: at };
  const failedAttempt = { id: 'smoke-old-attempt', taskId: task.id, generation: 1, deviceId: 'fixture-worker', status: 'failed', startedAt: at, endedAt: at, error: 'Retained previous failure' };
  const check = { command: 'fixture/check', passed: true, output: 'Fixture check passed.\n', exitCode: 0, candidateCommit: '2'.repeat(40), checkedCommit: '2'.repeat(40) };
  const combined = { ...check, output: 'Fixture combined check passed.\n', checkedCommit: '4'.repeat(40) };
  const contract = { title: task.title, description: task.description, kind: task.kind, acceptanceCriteria: task.acceptanceCriteria, expectedOutputs: task.expectedOutputs, dependsOn: task.dependsOn, checks: [check.command], planRevision: goal.revision };
  const detail = { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, phase: 'done', cancellation: 'none', contract,
    workspace: { id: 'fixture-workspace', path: join(home, 'private-workspace'), provider: 'git', baseCommit: '1'.repeat(40), sessionId: attempt.sessionId, deviceId: attempt.deviceId },
    candidate: { id: 'fixture-candidate', commit: '2'.repeat(40), baseCommit: '1'.repeat(40), tree: '3'.repeat(40), branch: 'fixture/retained', deviceId: attempt.deviceId, bundle: join(home, 'private-candidate.bundle') },
    result: { status: 'succeeded', text: 'Retained fixture implementation evidence' }, checks: [check],
    integration: { commit: '4'.repeat(40), previousHead: '1'.repeat(40), candidateCommit: '2'.repeat(40), checks: [combined] } };
  const artifactBytes = Buffer.from('EnoughFactory packaged service smoke evidence.\n');
  const artifact = { id: 'smoke-artifact', name: 'Inspection evidence', mime: 'text/plain', sha256: digest(artifactBytes), size: artifactBytes.length, deviceId: attempt.deviceId, createdAt: at, goalId: goal.id, taskId: task.id, attemptId: attempt.id };
  const controller = { id: 'smoke-controller', goalId: goal.id, role: 'planner', sessionId: 'retained-controller-session', chatId: 'retained-controller-chat', status: 'running', updatedAt: at };
  const rows = [
    ['projects', project], ['goals', goal], ['tasks', task], ['tasks', legacy], ['attempts', attempt], ['attempts', failedAttempt],
    ['factory-plans', { id: goal.id, goalId: goal.id, revision: goal.revision, summary: 'Retained fixture plan', checks: [check.command], taskKeys: { typed: task.id, legacy: legacy.id }, createdAt: at }],
    ['factory-control', { id: goal.id, stage: 'dispatch', spent: 0, startedAt: at, steering: [] }],
    ['factory-task-details', { id: task.id, key: 'typed', checks: [check.command], planRevision: goal.revision, selected: false, failureSignatures: [], repairInstructions: 'Inspect retained evidence only.' }],
    ['factory-attempt-details', detail],
    ['factory-attempt-details', { id: failedAttempt.id, goalId: goal.id, goalRevision: 2, phase: 'checking', cancellation: 'none', checks: [{ ...check, passed: false, output: 'Retained failure evidence.\n', exitCode: 17 }], result: { status: 'failed', text: '', error: failedAttempt.error } }],
    ['artifacts', { ...artifact, path: join(home, 'private-artifact.log') }], ['factory-controller-runs', controller],
    ['private', { id: 'runtime-control', suspended: true }],
    ['settings', { id: 'main', deviceName: 'Packaged inspection fixture', defaultRuntime: 'codex', defaultApprovalMode: 'manual' }],
  ];
  await mkdir(project.path, { recursive: true, mode: 0o700 });
  sqlite(node, `
    import {DatabaseSync} from 'node:sqlite'; import {existsSync} from 'node:fs';
    const [filename, input]=process.argv.slice(1); if(existsSync(filename))throw new Error('Refusing to overwrite a smoke fixture database.');
    const db=new DatabaseSync(filename); try {
      db.exec('CREATE TABLE records(bucket TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bucket,id)); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL,at TEXT NOT NULL); CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1);');
      const statement=db.prepare('INSERT INTO records VALUES(?,?,?)'); for(const [bucket,value] of JSON.parse(input))statement.run(bucket,value.id,JSON.stringify(value));
    } finally {db.close();} console.log(JSON.stringify({seeded:true}));
  `, [join(home, 'factory.sqlite'), JSON.stringify(rows)]);
  const root = join(home, 'workspace-data/artifacts');
  await mkdir(join(root, 'objects', artifact.sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'manifests'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'objects', artifact.sha256.slice(0, 2), artifact.sha256), artifactBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'manifests', `${artifact.id}.json`), JSON.stringify(artifact), { flag: 'wx', mode: 0o600 });
  return { goal, task, legacy, attempt, failedAttempt, detail, check, combined, artifact, artifactBytes, controller };
}

export function readSmokeRecords(node, home) {
  return sqlite(node, `
    import {DatabaseSync} from 'node:sqlite'; const [filename,input]=process.argv.slice(1); const db=new DatabaseSync(filename,{readOnly:true});
    try {const result={};for(const bucket of JSON.parse(input))result[bucket]=db.prepare('SELECT id,value FROM records WHERE bucket=? ORDER BY id').all(bucket);console.log(JSON.stringify(result));}finally{db.close();}
  `, [join(home, 'factory.sqlite'), JSON.stringify(buckets)]);
}

export async function verifySmokeFixture(node, home, fixture) {
  const rows = readSmokeRecords(node, home);
  const values = bucket => rows[bucket].map(row => JSON.parse(row.value));
  assert.equal(values('goals')[0].status, 'paused');
  assert.equal(values('goals')[0].autonomy, 'manual');
  assert(values('attempts').every(attempt => !['created', 'running', 'unknown'].includes(attempt.status)), 'Fixture attempts could authorize execution.');
  assert.deepEqual(values('tasks').find(task => task.id === fixture.task.id), fixture.task);
  const legacy = values('tasks').find(task => task.id === fixture.legacy.id);
  for (const field of ['kind', 'acceptanceCriteria', 'expectedOutputs']) assert(!Object.hasOwn(legacy, field));
  assert.deepEqual(values('factory-attempt-details').find(detail => detail.id === fixture.attempt.id).contract, fixture.detail.contract);
  const bytes = await readFile(join(home, 'workspace-data/artifacts/objects', fixture.artifact.sha256.slice(0, 2), fixture.artifact.sha256));
  assert.equal(digest(bytes), fixture.artifact.sha256); assert.equal(bytes.length, fixture.artifact.size);
  return rows;
}

async function portOpen(port) {
  return await new Promise(accept => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); accept(value); };
    socket.once('connect', () => finish(true)); socket.once('error', error => finish(error.code !== 'ECONNREFUSED')); socket.setTimeout(300, () => finish(true));
  });
}
async function absent(filename) {
  try { await access(filename); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function ownedRuntime(home) {
  if (process.platform === 'linux') return { kind: 'rootless', storage: join(home, 'docker/data'), socket: join(home, 'docker/run/docker.sock'), marker: join(home, 'docker/daemon.json') };
  const normal = join(home, 'container/lima'), owner = digest(resolve(home)).slice(0, 24);
  const storage = Buffer.byteLength(join(normal, 'factory/sock/docker.sock')) <= 100 ? normal : join('/Users/Shared', `.enoughfactory-runtime-${process.getuid()}-${owner}`, 'lima');
  return { kind: 'lima', storage, socket: join(storage, 'factory/sock/docker.sock'), marker: join(storage, 'factory/lima.yaml') };
}

async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--resources') options.resources = process.argv[++index];
    else if (flag === '--receipt') options.receipt = process.argv[++index];
    else if (flag === '--source-commit') options.sourceCommit = process.argv[++index];
    else if (flag === '--keep-state') options.keepState = true;
    else if (flag === '--fixture-only') options.fixtureOnly = true;
    else if (flag === '--help') { console.log('Usage: node scripts/check-packaged-service-smoke.mjs --resources <native installed resources> --receipt <json> [--source-commit <40hex>] [--keep-state]\n--fixture-only seeds and validates inert SQL/artifact fixtures without launching a service or writing a verification receipt.'); return; }
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.resources || (!options.receipt && !options.fixtureOnly)) throw new Error('Pass --resources and --receipt (or --fixture-only).');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Run this smoke check on native Mac or Linux.');
  const resources = resolve(options.resources), node = join(resources, 'runtime/node');
  const manifestBytes = await readFile(join(resources, 'bundle-provenance.json')), manifest = JSON.parse(manifestBytes);
  assert(manifest.formatVersion === 1 && manifest.product === 'EnoughFactory' && manifest.platform === process.platform && manifest.arch === process.arch && /^[a-f0-9]{40}$/.test(manifest.sourceCommit || '') && (!options.sourceCommit || options.sourceCommit === manifest.sourceCommit), 'Installed manifest does not match this native source revision.');
  const nodeSha256 = digest(await readFile(node)), serviceSha256 = digest(await readFile(join(resources, 'device/service.cjs')));
  assert.equal(nodeSha256, manifest.files?.['runtime/node']); assert.equal(serviceSha256, manifest.files?.['device/service.cjs']);
  const native = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'], { encoding: 'utf8', timeout: 10_000 }));
  assert(native.platform === process.platform && native.arch === process.arch && native.version === 'v22.22.0', 'Bundled Node does not match this native release.');
  const home = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ef-smoke-'));
  const fixture = await seedSmokeFixture(node, home);
  await verifySmokeFixture(node, home, fixture);
  if (options.fixtureOnly) { console.log('Packaged-service inert SQL/artifact fixture verified; no service, runtime, agent or model launched.'); if (!options.keepState) await rm(home, { recursive: true, force: true }); return; }
  const startedAt = new Date().toISOString();
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; listener.close(); await once(listener, 'close');
  const child = spawn(node, [join(resources, 'device/service.cjs')], { cwd: home, env: { ...process.env, ENOUGHFACTORY_HOME: home, ENOUGHFACTORY_PORT: String(port), ENOUGHFACTORY_RESOURCES: resources, ENOUGHFACTORY_CONTAINER_ASSETS: join(resources, 'runtime/container'), ENOUGHFACTORY_WEB_PATH: join(resources, 'web'), ENOUGHFACTORY_ENVMUX_PATH: join(resources, 'envmux/envmux'), ENOUGHFACTORY_REPO: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', finished = false, launchError, connection, success = false;
  const exited = new Promise(accept => { child.once('error', error => { launchError = error; finished = true; accept({code:null,signal:null}); }); child.once('close', (code, signal) => { finished = true; accept({code,signal}); }); });
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  const request = async (route, method = 'GET') => {
    const response = await fetch(`${connection.url}${route}`, { method, headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000) });
    const value = await response.json(); assert.equal(response.status, 200, `${route} returned ${response.status}: ${JSON.stringify(value)}`); return value;
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError; if (finished) throw new Error(`Packaged service exited before readiness.\n${log}`);
      try {
        const candidate = JSON.parse(await readFile(join(home, 'connection.json'), 'utf8'));
        assert.equal(candidate.url, `http://127.0.0.1:${port}`); assert.equal(candidate.pid, child.pid); assert.equal(typeof candidate.token, 'string');
        if (log.includes(`EnoughFactory device service ready at http://127.0.0.1:${port}`)) { connection = candidate; const health = await request('/api/health'); assert(health.ok && health.product === 'EnoughFactory' && health.version === manifest.version); break; }
      } catch { connection = undefined; }
      await pause(200);
    }
    assert(connection, `Packaged service did not become ready.\n${log}`);
    const routes = [`/api/goals/${fixture.goal.id}/inspection`, `/api/tasks/${fixture.task.id}`, `/api/attempts/${fixture.attempt.id}`, `/api/artifacts/${fixture.artifact.id}/content`];
    for (const route of routes) { const denied = await fetch(`${connection.url}${route}`, { signal: AbortSignal.timeout(5_000) }); assert.equal(denied.status, 401); await denied.arrayBuffer(); }
    const before = readSmokeRecords(node, home);
    const goal = await request(routes[0]), task = await request(routes[1]), attempt = await request(routes[2]);
    assert.equal(goal.goal.id, fixture.goal.id); assert.equal(task.task.id, fixture.task.id); assert.equal(attempt.attempt.id, fixture.attempt.id);
    assert.equal(goal.goal.status, 'paused'); assert.equal(goal.goal.autonomy, 'manual');
    assert.equal(goal.tasks.find(item => item.task.id === fixture.task.id).state, 'accepted');
    assert.equal(goal.tasks.find(item => item.task.id === fixture.legacy.id).state, 'waiting');
    const controller = goal.controllers.find(item => item.id === fixture.controller.id);
    assert.equal(controller.status, 'interrupted'); assert.equal(controller.chatId, fixture.controller.chatId); assert.equal(controller.sessionId, fixture.controller.sessionId); assert.match(controller.error, /service restarted/);
    assert.equal(task.task.kind, 'feature'); assert.deepEqual(task.task.acceptanceCriteria, fixture.task.acceptanceCriteria); assert.deepEqual(task.task.expectedOutputs, fixture.task.expectedOutputs);
    assert.deepEqual(task.attempts.map(item => item.attempt.id), [fixture.attempt.id, fixture.failedAttempt.id]);
    assert.deepEqual(attempt.contract, fixture.detail.contract); assert.equal(attempt.phase, 'done'); assert.equal(attempt.candidate.commit, fixture.detail.candidate.commit); assert.equal(attempt.candidate.baseCommit, fixture.detail.candidate.baseCommit);
    assert.deepEqual(attempt.checks, [fixture.check]); assert.deepEqual(attempt.integration.checks, [fixture.combined]); assert.equal(attempt.integration.commit, fixture.detail.integration.commit);
    const legacy = await request(`/api/tasks/${fixture.legacy.id}`);
    for (const field of ['kind', 'acceptanceCriteria', 'expectedOutputs']) assert(!Object.hasOwn(legacy.task, field));
    assert.equal(legacy.detailsAvailable, false); assert.equal(legacy.state, 'waiting'); assert.deepEqual(legacy.attempts, []);
    assert(!Object.hasOwn(attempt.workspace, 'path')); assert(!Object.hasOwn(attempt.candidate, 'bundle'));
    assert.equal(task.artifacts[0].sha256, fixture.artifact.sha256); assert(!Object.hasOwn(task.artifacts[0], 'path'));
    const artifact = await request(`/api/artifacts/${fixture.artifact.id}`), content = await request(routes[3]);
    assert.equal(artifact.sha256, fixture.artifact.sha256); assert.equal(artifact.size, fixture.artifact.size); assert.equal(content.encoding, 'base64');
    assert(!Object.hasOwn(artifact, 'path'));
    const privatePaths = [fixture.detail.workspace.path, fixture.detail.candidate.bundle, join(home, 'private-artifact.log')];
    for (const view of [goal, task, attempt, legacy, artifact, content]) {
      const serialized = JSON.stringify(view);
      for (const privatePath of privatePaths) assert(!serialized.includes(privatePath), `Inspection exposed private path ${privatePath}.`);
    }
    assert.deepEqual(Buffer.from(content.content, 'base64'), fixture.artifactBytes); assert.equal(digest(Buffer.from(content.content, 'base64')), content.manifest.sha256);
    assert.deepEqual(readSmokeRecords(node, home), before, 'Read-only inspection changed retained coordination records.');
    const expected = ownedRuntime(home), runtime = await request('/api/runtime');
    assert.equal(runtime.kind, expected.kind); assert.equal(runtime.state, 'stopped'); assert.equal(runtime.stateDirectory, home); assert.equal(runtime.dataDirectory, expected.storage); assert.equal(runtime.socketPath, expected.socket);
    assert(await absent(expected.marker), 'The smoke check created a private engine/VM.');
    const state = await request('/api/state'); assert.equal(state.product, 'EnoughFactory'); assert.equal(state.version, manifest.version); assert.equal(state.device.platform, process.platform); assert.equal(state.device.arch, process.arch); assert.deepEqual(state.sessions, []); assert.deepEqual(state.chats, []);
    await request('/api/service/shutdown', 'POST');
    const shutdownDeadline = Date.now() + 10_000; while (!finished && Date.now() < shutdownDeadline) await pause(100);
    assert(finished, 'Authenticated service shutdown did not finish before its deadline.'); const outcome = await exited; assert.equal(outcome.code, 0); assert.equal(outcome.signal, null); assert(!await portOpen(port));
    assert.deepEqual(readSmokeRecords(node, home), before, 'Service shutdown changed retained inspection records.');
    const receipt = { formatVersion: 1, product: 'EnoughFactory', suite: 'packaged-service-smoke', status: 'passed', version: manifest.version, platform: process.platform, arch: process.arch, sourceCommit: manifest.sourceCommit, startedAt, completedAt: new Date().toISOString(),
      bundle: { manifestSha256: digest(manifestBytes), sourceCommit: manifest.sourceCommit, version: manifest.version, platform: process.platform, arch: process.arch }, serviceSha256, nodeSha256, checks: smokeChecks,
      scope: { transport: 'authenticated-local-http', pairedTransportTested: false, containerEngineStarted: false, agentOrModelStarted: false },
      inspection: { typedTaskKind: 'feature', criteriaAndOutputsPreserved: true, retainedAttemptReceipts: true, controllerRecovery: 'interrupted', legacyOptionalFieldsPreserved: true, privatePathsRedacted: true, readOnlyRecordsPreserved: true },
      authentication: { unauthenticatedStatus: 401 }, runtime: { kind: runtime.kind, state: 'stopped', ownedStateDirectory: true, ownedSocket: true }, shutdown: { authenticated: true, exitedCleanly: true, connectionClosed: true },
      artifact: { sha256: fixture.artifact.sha256, size: fixture.artifact.size, contentVerified: true } };
    await mkdir(dirname(resolve(options.receipt)), { recursive: true }); await writeFile(resolve(options.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
    success = true; console.log(`Packaged local service inspection smoke passed on ${process.platform}/${process.arch}. Receipt: ${resolve(options.receipt)}`);
  } finally {
    if (!finished) {
      if (connection) await request('/api/service/shutdown', 'POST').catch(() => {});
      const deadline = Date.now() + 5_000; while (!finished && Date.now() < deadline) await pause(100);
      if (!finished) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2_000); await exited; clearTimeout(timer); }
    }
    if (success && !options.keepState) await rm(home, { recursive: true, force: true });
    else console.log(`Smoke fixture state ${success ? 'preserved' : 'retained for diagnostics'} at ${home}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
