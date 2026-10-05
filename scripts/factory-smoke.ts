import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Attempt, ContainerRuntimeStatus, Decision, FactoryTask, Goal, Project, Session } from '../packages/contracts/src/index.ts';

// One assembled, real-model product journey. It costs inference and requires
// EnoughFactory's bundled owned runtime plus an authenticated host Codex account;
// it is deliberately not CI and never invokes the user's Docker client or engine.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const savedFixture = process.env.ENOUGHFACTORY_SMOKE_FIXTURE;
// Short app paths also leave room for Lima's private Unix socket names on Mac.
const fixture = savedFixture || await mkdtemp(path.join(process.env.ENOUGHFACTORY_SMOKE_TMPDIR || (process.platform==='darwin'?'/tmp':tmpdir()), 'enoughfactory-product-'));
const repository = path.join(fixture, 'repository');
const home = path.join(fixture, 'device');
const port = Number(process.env.ENOUGHFACTORY_SMOKE_PORT || 4327);
const url = `http://127.0.0.1:${port}`;
const checkImage = process.env.ENOUGHFACTORY_SMOKE_CHECK_IMAGE || 'debian:bookworm-slim';
const exerciseRecovery = process.env.ENOUGHFACTORY_SMOKE_RECOVERY === '1';
const deadline = Date.now() + 30 * 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let service: ChildProcess | undefined;
let token = '';
let serviceLog = '';
let goalId: string | undefined;
let ownedRuntime: ContainerRuntimeStatus | undefined;
const steps: Array<{ at: string; event: string; detail?: unknown }> = [];
function record(event: string, detail?: unknown) { steps.push({ at: new Date().toISOString(), event, detail }); console.log(event, detail === undefined ? '' : JSON.stringify(detail)); }
function command(program: string, args: string[], cwd?: string): string {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout.trim();
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result as T;
}
interface Snapshot { goal: Goal; tasks: FactoryTask[]; attempts: Attempt[]; decisions: Decision[]; evaluations: Array<{head: string; evaluation: {complete: boolean; criteria: Array<{criterion: string;satisfied: boolean;evidence: string[]}>}}>; control: unknown; plan: unknown }
async function observe<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let previous = '';
  while (Date.now() < deadline) {
    assert.ok(service && service.exitCode === null && service.signalCode === null, `Device service exited: ${serviceLog.slice(-4000)}`);
    const value = await read();
    const snapshot = value as Partial<Snapshot>;
    if (snapshot.goal) {
      const progress = JSON.stringify({ status: snapshot.goal.status, nextAction: snapshot.goal.nextAction, tasks: snapshot.tasks?.map(t => ({ id: t.id, status: t.status })), attempts: snapshot.attempts?.map(a => ({id:a.id,status:a.status,candidate:a.candidate})) });
      if (progress !== previous) { record(label, JSON.parse(progress)); previous = progress; }
      assert.ok(!['failed','canceled','waiting'].includes(snapshot.goal.status), `Goal needs intervention: ${progress}`);
    }
    if (ready(value)) return value;
    await sleep(1500);
  }
  throw new Error(`${label} timed out; fixture retained at ${fixture}`);
}
async function start() {
  serviceLog = '';
  service = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'apps/device/src/index.ts')], { cwd: root, env: { ...process.env,
    ENOUGHFACTORY_HOME: home, ENOUGHFACTORY_PORT: String(port), ENOUGHFACTORY_REPO: root, ENOUGHFACTORY_CHECK_IMAGE: checkImage,
    // A nonexistent context/socket proves the product does not use inherited
    // Docker settings. These fixture paths never point at a user's daemon.
    DOCKER_HOST: `unix://${path.join(fixture,'unowned-runtime.sock')}`, DOCKER_CONTEXT: 'enoughfactory-unowned', DOCKER_CONFIG: path.join(fixture,'unowned-docker-config')
  }, stdio: ['ignore','pipe','pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream?.on('data', value => { serviceLog += value.toString(); });
  const live = service;
  for (let tries = 0; tries < 100; tries++) {
    assert.equal(live.exitCode, null, serviceLog);
    try {
      const connection = JSON.parse(await readFile(path.join(home, 'connection.json'), 'utf8'));
      if (connection.pid === live.pid) { token = connection.token; await api('/api/health'); record('device-service-ready', {pid:live.pid}); return; }
    } catch { /* Startup publishes its connection record once it listens. */ }
    await sleep(200);
  }
  throw new Error(`Service did not start: ${serviceLog}`);
}
async function prepareOwnedRuntime(): Promise<ContainerRuntimeStatus> {
  const status = await api<ContainerRuntimeStatus>('/api/runtime');
  if (status.state !== 'ready') await api('/api/runtime/start','POST',{});
  let ready = status;
  let previous = '';
  while (Date.now()<deadline) {
    ready = await api<ContainerRuntimeStatus>('/api/runtime');
    const progress = JSON.stringify({state:ready.state,phase:ready.phase,error:ready.error});
    if (previous!==progress) { record('owned-runtime-preparation',JSON.parse(progress)); previous=progress; }
    assert.ok(!['failed','unavailable'].includes(ready.state),ready.error||JSON.stringify(ready.requiredActions));
    if (ready.state==='ready') break;
    await sleep(1000);
  }
  assert.equal(ready.state,'ready',ready.error||ready.phase);
  assert.ok(path.isAbsolute(ready.socketPath));
  assert.notEqual(ready.socketPath,'/var/run/docker.sock');
  assert.notEqual(ready.socketPath,path.join(fixture,'unowned-runtime.sock'));
  await verifyOwnedStorage(ready);
  record('owned-container-runtime-ready',{kind:ready.kind,socketPath:ready.socketPath,dataDirectory:ready.dataDirectory,dockerVersion:ready.dockerVersion});
  ownedRuntime = ready; return ready;
}
async function verifyOwnedStorage(runtime: ContainerRuntimeStatus): Promise<void> {
  const directory = path.resolve(runtime.dataDirectory);
  if (directory.startsWith(path.resolve(home)+path.sep)) return;
  // A long Mac app path uses a persistent short socket directory. Verify the
  // app's private location receipt and its user-owned allocation instead of
  // requiring VM disks to sit beneath the application home in that case.
  assert.equal(process.platform,'darwin','External runtime storage is supported only by the Mac short-path allocation.');
  assert.equal(runtime.kind,'lima');
  const uid = process.getuid?.(); assert.equal(typeof uid,'number');
  const stateHash = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0,24);
  const allocation = path.join('/Users/Shared',`.enoughfactory-runtime-${uid}-${stateHash}`);
  assert.equal(directory,path.join(allocation,'lima'),'Runtime storage must belong to this fixture’s private short-path allocation.');
  const receiptPath = path.join(home,'container/runtime-location.json');
  const receiptStat = await lstat(receiptPath);
  assert.ok(receiptStat.isFile()&&!receiptStat.isSymbolicLink()); assert.equal(receiptStat.uid,uid); assert.equal(receiptStat.mode&0o077,0);
  const receipt = JSON.parse(await readFile(receiptPath,'utf8')) as {kind?:string;directory?:string};
  assert.equal(receipt.kind,'lima'); assert.equal(path.resolve(receipt.directory||''),directory);
  const allocationStat = await lstat(allocation);
  assert.ok(allocationStat.isDirectory()&&!allocationStat.isSymbolicLink()); assert.equal(allocationStat.uid,uid); assert.equal(allocationStat.mode&0o777,0o700);
  record('owned-runtime-short-path-receipt',{directory,allocation,receiptPath});
}
async function stopOwnedRuntimeIfIdle(): Promise<void> {
  if (!ownedRuntime||!service||service.exitCode!==null||service.signalCode!==null) return;
  const state = await api<{sessions:Session[]}>('/api/state');
  if (state.sessions.some(s=>!['stopped','failed'].includes(s.status))) {
    record('owned-runtime-retained-for-diagnosis'); return;
  }
  const current = await api<ContainerRuntimeStatus>('/api/runtime');
  assert.equal(current.socketPath,ownedRuntime.socketPath,'Cleanup must stay on this fixture’s owned runtime.');
  assert.equal(current.dataDirectory,ownedRuntime.dataDirectory);
  await api('/api/runtime/stop','POST',{});
  record('owned-runtime-stop-requested',{socketPath:current.socketPath});
  const stopDeadline = Date.now()+120_000;
  while (Date.now()<stopDeadline) {
    const status = await api<ContainerRuntimeStatus>('/api/runtime');
    assert.equal(status.socketPath,ownedRuntime.socketPath);
    if (status.state==='stopped') { record('owned-runtime-stopped',{socketPath:status.socketPath}); return; }
    assert.notEqual(status.state,'failed',status.error);
    await sleep(1000);
  }
  throw new Error('The fixture’s private container runtime did not confirm stopping; its state was retained.');
}
function verifyReadyEndpoints(): string[] {
  assert.ok(ownedRuntime);
  const store = new DatabaseSync(path.join(home,'factory.sqlite'),{readOnly:true});
  try {
    const hosts = store.prepare('SELECT value FROM records WHERE bucket=?').all('session-private').map(row=>{
      const record = JSON.parse(String(row.value)) as {ready:{dockerHost?:string}};
      return record.ready.dockerHost;
    });
    assert.ok(hosts.length>=3,'The planner, worker and evaluator must each record real envmux readiness.');
    for (const host of hosts) assert.equal(host,`unix://${ownedRuntime.socketPath}`,'An envmux session used an endpoint outside EnoughFactory’s owned runtime.');
    return hosts as string[];
  } finally { store.close(); }
}
async function stop() {
  const current = service;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await api('/api/service/shutdown', 'POST', {});
  await new Promise<void>((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Service shutdown did not finish.')),30_000);
    current.once('exit',() => { clearTimeout(timer); resolve(); });
  });
  record('device-service-stopped', {pid:current.pid});
}

if (!savedFixture) {
  await mkdir(repository);
  await writeFile(path.join(repository, 'README.md'), '# Slug CLI\n\nA small dependency-free command-line utility.\n');
  await writeFile(path.join(repository, '.envmux.json'), JSON.stringify({ name: 'factory-proof', portal: { open: false }, tools: {}, tasks: { ready: { command: 'printf "factory-environment-ready\\n"', kind: 'once' } } }, null, 2));
  command('git', ['init'], repository); command('git', ['config','user.name','EnoughFactory'], repository); command('git', ['config','user.email','factory@enoughtools.com'], repository);
  command('git', ['add','.'], repository); command('git', ['commit','-m','Disposable factory journey fixture'], repository);
}
const initialHead = command('git', ['rev-list','--max-parents=0','HEAD'], repository);
record('fixture-ready', {fixture, repository, initialHead});
try {
  await start();
  await prepareOwnedRuntime();
  const diagnostics = await api<{docker:{available:boolean};envmux:{available:boolean;error?:string}}>('/api/diagnostics');
  assert.equal(diagnostics.docker.available, true); assert.equal(diagnostics.envmux.available,true,diagnostics.envmux.error);
  if (exerciseRecovery) { const unauthorized = await fetch(`${url}/api/state`); assert.equal(unauthorized.status,401); }
  const project = await api<Project>('/api/projects','POST',{path:repository,name:'Factory product journey',runtime:'codex',approvalMode:'approve-all'});
  assert.equal((await api<{valid:boolean}>(`/api/projects/${project.id}/validate`)).valid,true);
  const criteria = [
    'bin/slug.sh accepts one text argument and prints lowercase ASCII letters/digits separated by single hyphens, removing leading/trailing hyphens; Hello__World!! produces hello-world.',
    'Whitespace-only or punctuation-only input exits 2 and prints a clear error to stderr; tests/slug.test.sh passes for normal, mixed-case, repeated separator, empty-result and digit inputs.',
    'README.md documents invoking the CLI, the normalization contract, the empty-result exit status and running the tests; all source is integrated into this repository.'
  ];
  const goal = savedFixture
    ? (await api<Goal[]>('/api/goals')).find(g=>g.projectId===project.id&&g.status==='completed')!
    : await api<Goal>('/api/goals','POST',{projectId:project.id,title:'Ship the slug CLI',objective:'Build and document a useful dependency-free POSIX shell slug CLI in bin/slug.sh. Implement its focused shell tests in tests/slug.test.sh. Use one compact implementation task covering code, tests and docs; this is a small utility. Run checks with bash tests/slug.test.sh, using standard shell tools only (no Node/Python/packages). Preserve .envmux.json unchanged. Make the actual source executable and finish the full goal. Do not stop at a proposal.',criteria,runtime:'codex',approvalMode:'approve-all',autonomy:'autonomous',concurrency:1,maxDurationMs:25*60_000});
  assert.ok(goal, 'Saved-fixture verification requires an already completed goal; it never reruns inference.');
  goalId = goal.id; record(savedFixture?'completed-autonomous-goal-opened':'autonomous-goal-created',{goalId,approvalMode:goal.approvalMode,autonomy:goal.autonomy});
  const read = () => api<Snapshot>(`/api/goals/${goal.id}`);
  let completed: Snapshot;
  let firstAttempt: Attempt;
  if (savedFixture) {
    completed = await read(); firstAttempt = completed.attempts[0]!;
    assert.equal(completed.goal.status,'completed');
    record('completed-fixture-reverification',{goalId});
  } else {
  const dispatched = await observe('factory-progress',read,s => s.attempts.some(a=>a.status==='running'));
  assert.equal(dispatched.tasks.length,1,'This bounded product fixture should remain one compact task.');
  firstAttempt = dispatched.attempts[0]!;
  if (exerciseRecovery) {
  await api(`/api/goals/${goal.id}/pause`,'POST',{}); record('coordination-paused-while-owner-runs',{attemptId:firstAttempt.id,generation:firstAttempt.generation});
  const retained = await observe('retaining-candidate',read,s => s.goal.status==='paused' && s.attempts.some(a=>a.id===firstAttempt.id&&Boolean(a.candidate)));
  assert.equal(retained.tasks[0]!.status,'review'); assert.equal(command('git',['rev-parse','HEAD'],repository),initialHead,'Paused coordination must not integrate work.');
  const beforeRestart = {goalId:retained.goal.id,revision:retained.goal.revision,taskIds:retained.tasks.map(t=>t.id),attempts:retained.attempts.map(a=>({id:a.id,generation:a.generation,candidate:a.candidate}))};
  await stop(); await start();
  await prepareOwnedRuntime();
  const recovered = await read();
  assert.equal(recovered.goal.status,'paused'); assert.equal(recovered.goal.revision,beforeRestart.revision);
  assert.deepEqual(recovered.tasks.map(t=>t.id),beforeRestart.taskIds);
  assert.deepEqual(recovered.attempts.map(a=>({id:a.id,generation:a.generation,candidate:a.candidate})),beforeRestart.attempts);
  record('durable-coordinator-recovered',beforeRestart);
  await api(`/api/goals/${goal.id}/resume`,'POST',{});
  }
  completed = await observe('factory-resumed',read,s=>s.goal.status==='completed');
  }
  assert.equal(completed.attempts.length,1,'Recovery must not launch a duplicate worker.');
  assert.equal(completed.attempts[0]!.id,firstAttempt.id); assert.equal(completed.attempts[0]!.generation,firstAttempt.generation);
  assert.ok(completed.tasks.every(t=>t.status==='completed'));
  assert.equal(completed.decisions.filter(d=>d.kind==='integrated').length,1,'The candidate should integrate exactly once.');
  if (exerciseRecovery) assert.ok(completed.decisions.some(d=>d.kind==='attempt-recovered'));
  const head = command('git',['rev-parse','HEAD'],repository); assert.notEqual(head,initialHead);
  assert.equal(command('git',['status','--porcelain'],repository),'');
  const tests = command('bash',['tests/slug.test.sh'],repository);
  assert.equal(command('bash',['bin/slug.sh','Hello__World!!'],repository),'hello-world');
  const empty = spawnSync('bash',['bin/slug.sh','!!!'],{cwd:repository,encoding:'utf8'}); assert.equal(empty.status,2); assert.ok(empty.stderr.trim());
  assert.ok((await readFile(path.join(repository,'README.md'),'utf8')).includes('slug'));
  const finalEvaluation = completed.evaluations.at(-1)!; assert.equal(finalEvaluation.head,head); assert.equal(finalEvaluation.evaluation.complete,true);
  for(const criterion of completed.goal.criteria) assert.ok(finalEvaluation.evaluation.criteria.some(c=>c.criterion===criterion&&c.satisfied&&c.evidence.length));
  const state = await api<{sessions:Session[];chats:Array<{id:string;title:string;status:string;threadId?:string}>}>('/api/state');
  for (const role of ['planner','evaluator']) {
    const summary = state.chats.find(c=>c.title.endsWith(`· ${role}`)); assert.ok(summary);
    const detail = await api<{threadId?:string;status:string}>(`/api/chats/${summary.id}`);
    assert.ok(detail.threadId); assert.equal(detail.status,'idle');
  }
  assert.ok(state.sessions.every(s=>s.status==='stopped'));
  const readyHosts = verifyReadyEndpoints();
  record('real-goal-completed',{goalId:goal.id,head,attemptId:firstAttempt.id,tests,criteria:completed.goal.criteria});
  const evidence = {verifiedAt:new Date().toISOString(),fixture,repository,initialHead,head,ownedRuntime,readyHosts,exerciseRecovery,goal:completed.goal,tasks:completed.tasks,attempts:completed.attempts,decisions:completed.decisions,evaluations:completed.evaluations,steps,scope:`Real Codex planner, worker and evaluator in envmux Docker sessions on EnoughFactory’s explicitly owned container runtime via authenticated device HTTP API. All readiness descriptors use its private socket despite poisoned inherited Docker settings. Candidate checked and integrated once.${exerciseRecovery?' Paused candidate retained across a clean device-service restart; same attempt recovered.':''} No browser/Electron packaging, multi-device transport or selective approval coverage claimed by this script.`};
  const evidenceDir = path.join(root,'docs/verification'); await mkdir(evidenceDir,{recursive:true});
  await writeFile(path.join(evidenceDir,'factory-managed-runtime-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(`Factory journey passed. Source: ${repository}. Evidence: docs/verification/factory-managed-runtime-evidence.json`);
} catch(error) {
  await writeFile(path.join(fixture,'service.log'),serviceLog);
  console.error(`Journey failed; preserved ${fixture}${goalId?`; goal ${goalId}`:''}`);
  throw error;
} finally { try { await stopOwnedRuntimeIfIdle(); } finally { await stop(); } }
