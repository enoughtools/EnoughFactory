import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { candidateCheckInputs, type CheckContext, type CheckExecutor, type CommandResult } from '@enoughfactory/workspaces';

const execute = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const basePath = [...new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin', path.dirname(process.execPath)])].join(':');
const privateEnvironment = { PATH: basePath, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
const graceMs = 250;
const inventoryProbeTimeoutMs = 3_000;
const inventoryProbeMaxBuffer = 8 * 1024 * 1024;
const inventoryProbeAttempts = 2;

type InventoryProbe = (options: { timeoutMs: number; maxBuffer: number }) => Promise<string>;
interface InventoryProbeFailure {
  probe: 'descendant-inventory'; at: string; attempt: number; timeoutMs: number; maxBuffer: number;
  code: string | number | null; signal: string | null; killed: boolean | null;
  stdoutBytes: number | null; stderrBytes: number | null;
}

interface Outcome { exitCode: number; timedOut: boolean; canceled: boolean; error?: string; }
interface ActiveRun { child: ChildProcess; stop: () => void; completed: Promise<CommandResult>; }
interface OwnedChild { pid: number; identity: string; }

// A stable group leader remains alive while descendants are terminated. Its own
// deadline also bounds execution if the device service disconnects or exits.
const supervisor = `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
process.umask(0o077);
const [directory, key, timeout, command] = process.argv.slice(2);
const write = (name, value) => { const stage = path.join(directory, name + '.tmp'); fs.writeFileSync(stage, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(stage, path.join(directory, name)); };
write('owner.json', { version: 1, key, pid: process.pid, supervisor: process.argv[1], startedAt: new Date().toISOString() });
let stopping = false, reason, result;
const stop = why => {
  if (stopping) return;
  stopping = true; reason = why;
  if (why !== 'completed') write('outcome.json', { exitCode: why === 'timeout' ? 124 : 130, timedOut: why === 'timeout', canceled: why === 'canceled' });
  try { process.kill(-process.pid, 'SIGTERM'); } catch (error) { write('outcome.json', { exitCode: 1, timedOut: why === 'timeout', canceled: why === 'canceled', error: 'Could not terminate the owned host check group: ' + error.message }); }
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); }
    catch (error) { write('outcome.json', { exitCode: 1, timedOut: why === 'timeout', canceled: why === 'canceled', error: 'Could not kill the owned host check group: ' + error.message }); process.exit(1); }
  }, ${graceMs});
};
process.on('SIGTERM', () => stop('canceled'));
process.on('SIGINT', () => stop('canceled'));
const timer = setTimeout(() => stop('timeout'), Number(timeout));
const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', error => { if (!stopping) { write('outcome.json', { exitCode: 127, timedOut: false, canceled: false, error: error.message }); clearTimeout(timer); stop('completed'); } });
child.once('close', (code, signal) => {
  if (!stopping) { write('outcome.json', { exitCode: typeof code === 'number' ? code : 1, timedOut: false, canceled: false, ...(signal ? { error: 'Command ended with signal ' + signal } : {}) }); clearTimeout(timer); stop('completed'); }
});
`;

/** Full host permissions are intentional and are not a sandbox. Private copies
 * and a clean environment avoid exposing the user's checkout or credentials by
 * inheritance. Only frozen host-macos candidates can enter this execution route.
 */
export function hostCheckExecutor(options: { checksRoot: string; integrationRoot?: string; platform?: NodeJS.Platform; processInventoryProbe?: InventoryProbe }): CheckExecutor {
  const roots = [options.checksRoot, ...(options.integrationRoot ? [options.integrationRoot] : [])].map(root => path.resolve(root));
  if (new Set(roots).size !== roots.length || roots.some(root => path.dirname(root) === root)) throw new Error('Host checks require distinct private snapshot roots.');
  const active = new Map<string, Set<ActiveRun>>();
  const failures = new Map<string, string[]>();
  const leases = new Map<string, { controller: AbortController; completed: Promise<void> }>();

  const validatePath = async (selected: string): Promise<void> => {
    if (path.resolve(selected) !== selected || !uuid.test(path.basename(selected)) || !roots.includes(path.dirname(selected))) throw new Error('Host checks require an exact private check snapshot path.');
    await ownedDirectory(path.dirname(selected), selected);
  };
  const statePath = (selected: string) => `${selected}-host-checks`;

  const release = async (selected: string): Promise<void> => {
    const lease = leases.get(selected);
    lease?.controller.abort();
    for (const run of active.get(selected) ?? []) run.stop();
    await lease?.completed;
    await Promise.all([...active.get(selected) ?? []].map(run => run.completed));
    await validatePath(selected);
    if (failures.get(selected)?.length) throw new Error(failures.get(selected)!.join('; '));
    const state = statePath(selected);
    try { await ownedDirectory(path.dirname(selected), state); }
    catch (error) { if (missing(error)) return; throw error; }
    for (const name of await readdir(state)) {
      if (!uuid.test(name)) throw new Error('Host check storage contains an unknown run; preserve it before cleanup.');
      const directory = path.join(state, name);
      await ownedDirectory(state, directory);
      const completed = await readPrivateJson<{ terminationConfirmed?: boolean }>(path.join(directory, 'completed.json')).catch(error => { if (missing(error)) return undefined; throw error; });
      if (!completed?.terminationConfirmed) throw new Error('Host check execution outcome is uncertain; its private snapshots and process journal were retained.');
    }
    await rm(state, { recursive: true, force: true });
  };

  const executeContext: CheckExecutor = async context => {
    if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Native host checks require a Mac execution target.');
    if (context.executionTargetKind !== 'host-macos' || context.candidate.executionTargetKind !== 'host-macos' || [context.candidate.bundleArtifact, context.candidate.diffArtifact].some(artifact => artifact.metadata?.executionTargetKind !== 'host-macos')) throw new Error('Host checks require the frozen host-macos candidate execution target.');
    if (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs < 1 || context.timeoutMs > 24 * 60 * 60 * 1000) throw new Error('Host check timeout must be bounded to at most 24 hours.');
    if (typeof context.command !== 'string' || !context.command.trim() || context.command.length > 128 * 1024 || context.command.includes('\0')) throw new Error('Invalid host check command.');
    await validatePath(context.path);
    if (active.get(context.path)?.size) throw new Error('A host check is already running against these exact snapshots.');
    if (failures.get(context.path)?.length) throw new Error('An earlier host check has an uncertain outcome; preserve and reconcile it first.');
    const inputs = candidateCheckInputs(context.candidate);
    await verifyRepository(context.path, context.commit);
    const captures = context.candidate.workingDirectories ?? [];
    const directories = context.workingDirectories ?? [];
    if (directories.length !== captures.length) throw new Error('Host checks require every exact captured working-directory snapshot.');
    const mounts = new Map<string, string>();
    for (const root of directories) {
      const matches = captures.filter(capture => capture.containerPath === root.containerPath && capture.commit === root.commit);
      if (matches.length !== 1 || mounts.has(root.containerPath.toLowerCase()) || root.path !== path.join(`${context.path}-working-directories`, matches[0]!.id)) throw new Error('Host check working directories must match their exact private captured roots.');
      await ownedDirectory(path.dirname(context.path), root.path);
      await verifyRepository(root.path, root.commit);
      mounts.set(root.containerPath.toLowerCase(), root.path);
    }
    const environment: NodeJS.ProcessEnv = { ...privateEnvironment };
    for (const [key, value] of Object.entries(inputs?.environment ?? {})) {
      if (!value.startsWith('/workspaces/')) { environment[key] = value; continue; }
      const mount = value.split('/').slice(0, 3).join('/');
      const root = mounts.get(mount.toLowerCase());
      if (!root) throw new Error('Frozen host check inputs refer to a missing captured root.');
      environment[key] = path.join(root, ...value.split('/').slice(3));
      await validateInputPath(root, environment[key]!);
    }
    const startedAt = new Date().toISOString();
    if (context.signal?.aborted) return { command: context.command, exitCode: 130, stdout: '', stderr: 'Host check canceled before execution.', startedAt, endedAt: startedAt, executionTargetKind: 'host-macos', hostPermissions: 'full-host' };
    const state = statePath(context.path);
    await mkdir(state, { recursive: true, mode: 0o700 });
    await ownedDirectory(path.dirname(context.path), state);
    // An unconfirmed journal from an earlier service process fences replacement checks.
    for (const name of await readdir(state)) {
      if (!uuid.test(name)) throw new Error('Unknown host check process journal.');
      const completed = await readPrivateJson<{ terminationConfirmed?: boolean }>(path.join(state, name, 'completed.json')).catch(error => { if (missing(error)) return undefined; throw error; });
      if (!completed?.terminationConfirmed) throw new Error('An earlier host check outcome is uncertain; retain its snapshot before retrying.');
    }
    const key = randomUUID(), directory = path.join(state, key), supervisorPath = path.join(directory, 'supervisor.cjs');
    await mkdir(directory, { mode: 0o700 });
    for (const name of ['home', 'tmp', 'cache', 'config']) await mkdir(path.join(directory, name), { mode: 0o700 });
    Object.assign(environment, { HOME: path.join(directory, 'home'), TMPDIR: path.join(directory, 'tmp'), TMP: path.join(directory, 'tmp'), TEMP: path.join(directory, 'tmp'), XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_CONFIG_HOME: path.join(directory, 'config') });
    await writeFile(supervisorPath, supervisor, { flag: 'wx', mode: 0o600 });
    const child = spawn(process.execPath, [supervisorPath, directory, key, String(context.timeoutMs), context.command], { cwd: context.path, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = false, closed = false, timedOut = false, canceled = false;
    child.once('close', () => { closed = true; });
    const cleanupErrors: string[] = [];
    const probeFailures: InventoryProbeFailure[] = [];
    let omittedProbeFailures = 0;
    const inventory = () => processInventory(options.processInventoryProbe, async failure => {
      if (probeFailures.length < 256) probeFailures.push(failure); else omittedProbeFailures++;
      // Preserve useful diagnostics without storing a process table or arbitrary
      // command/error text, which can contain personal prompts and credentials.
      await writeFile(path.join(directory, 'process-probe-errors.json'), JSON.stringify({ failures: probeFailures, omitted: omittedProbeFailures }), { mode: 0o600 });
    });
    const descendants = new Map<number, OwnedChild>();
    let observing: Promise<void> | undefined;
    const observe = () => {
      if (observing || exited || !child.pid) return;
      observing = inventory().then(async inventory => {
        const parents = new Set([child.pid!, ...[...descendants.values()].filter(known => inventory.some(entry => entry.pid === known.pid && entry.identity === known.identity)).map(known => known.pid)]);
        for (let round = 0; round < inventory.length; round++) {
          let changed = false;
          for (const entry of inventory) if (parents.has(entry.parent) && !parents.has(entry.pid)) { parents.add(entry.pid); descendants.set(entry.pid, { pid: entry.pid, identity: entry.identity }); changed = true; }
          if (!changed) break;
        }
        if (descendants.size > 2048) throw new Error('Host check descendant inventory exceeded its safe bound.');
        await writeFile(path.join(directory, 'descendants.json'), JSON.stringify([...descendants.values()]), { mode: 0o600 });
      }).catch(error => { cleanupErrors.push(`Host check descendant ownership could not be observed: ${message(error)}`); }).finally(() => { observing = undefined; });
    };
    observe();
    const observationTimer = setInterval(observe, 50); observationTimer.unref();
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (exited || !child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (!missingProcess(error)) cleanupErrors.push(`Could not terminate host check: ${message(error)}`); }
      escalation ??= setTimeout(() => {
        if (!exited && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (!missingProcess(error)) cleanupErrors.push(`Could not kill host check: ${message(error)}`); }
      }, graceMs * 2);
    };
    const abort = () => { canceled = true; stop(); };
    let stdout = '', stderr = '';
    const limit = 1024 * 1024;
    child.stdout!.on('data', (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString().slice(0, limit - stdout.length); });
    child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < limit) stderr += chunk.toString().slice(0, limit - stderr.length); });
    // The supervisor owns the command deadline. Allow its bounded teardown to
    // finish so a command completed just before that deadline stays successful.
    const deadline = setTimeout(() => { timedOut = true; stop(); }, context.timeoutMs + graceMs * 2 + 500);
    context.signal?.addEventListener('abort', abort, { once: true });
    const runs = active.get(context.path) ?? new Set<ActiveRun>();
    active.set(context.path, runs);
    const completed = new Promise<CommandResult>(resolve => {
      let settled = false;
      const finish = async (spawnError?: Error) => {
        if (settled) return; settled = true; exited = true;
        clearInterval(observationTimer); await observing;
        clearTimeout(deadline); if (escalation) clearTimeout(escalation);
        context.signal?.removeEventListener('abort', abort);
        // A detached descendant may keep pipes open after the owned group has ended.
        if (!closed) await Promise.race([new Promise<void>(done => child.once('close', () => done())), delay(500)]);
        if (!closed) cleanupErrors.push('Host check output pipes remain open after its process group ended; descendant execution is uncertain and private snapshots were retained.');
        child.stdout?.destroy(); child.stderr?.destroy();
        try { await stopKnownDescendants([...descendants.values()], inventory); }
        catch (error) { cleanupErrors.push(message(error)); }
        if (child.pid) {
          try { await confirmGroupStopped(child.pid); }
          catch (error) { cleanupErrors.push(message(error)); }
        }
        try {
          const remaining = await snapshotUsers([context.path, ...(context.workingDirectories ?? []).map(root => root.path)]);
          if (remaining.length) cleanupErrors.push('Detached processes still use the private host check snapshots; their execution outcome is uncertain and the snapshots and journals were retained.');
        } catch (error) { cleanupErrors.push(`Host check snapshot users could not be reconciled: ${message(error)}`); }
        let outcome: Outcome | undefined;
        try { outcome = await readPrivateJson<Outcome>(path.join(directory, 'outcome.json')); }
        catch (error) {
          if (!spawnError && !canceled && !timedOut) cleanupErrors.push(`Host check outcome was not recorded: ${message(error)}`);
          else if (!spawnError) stderr += `${stderr ? '\n' : ''}Host check was interrupted before its command outcome was recorded.`;
        }
        if (outcome?.error) stderr += `${stderr ? '\n' : ''}${outcome.error}`;
        if (spawnError) stderr += `${stderr ? '\n' : ''}${spawnError.message}`;
        const result: CommandResult & { processProbeFailures?: InventoryProbeFailure[]; omittedProcessProbeFailures?: number } = { command: context.command, exitCode: timedOut || outcome?.timedOut ? 124 : canceled || outcome?.canceled ? 130 : outcome?.exitCode ?? 127, stdout, stderr, timedOut: timedOut || outcome?.timedOut || false, startedAt, endedAt: new Date().toISOString(), executionTargetKind: 'host-macos', hostPermissions: 'full-host', ...(cleanupErrors.length ? { cleanupErrors } : {}), ...(probeFailures.length ? { processProbeFailures: probeFailures } : {}), ...(omittedProbeFailures ? { omittedProcessProbeFailures: omittedProbeFailures } : {}) };
        try { await writeFile(path.join(directory, 'completed.json'), JSON.stringify({ terminationConfirmed: cleanupErrors.length === 0, result }), { flag: 'wx', mode: 0o600 }); }
        catch (error) { cleanupErrors.push(`Could not retain host check termination evidence: ${message(error)}`); result.cleanupErrors = cleanupErrors; }
        if (cleanupErrors.length) failures.set(context.path, [...failures.get(context.path) ?? [], ...cleanupErrors]);
        runs.delete(run); if (!runs.size) active.delete(context.path);
        resolve(result);
      };
      child.once('error', error => { void finish(error); });
      child.once('exit', () => { void finish(); });
    });
    const run: ActiveRun = { child, stop, completed };
    runs.add(run);
    if (context.signal?.aborted) abort();
    return completed;
  };
  const runner: CheckExecutor = async context => {
    // Reserve before filesystem awaits; setup itself belongs to this execution.
    if (leases.has(context.path)) throw new Error('A host check is already running against these exact snapshots.');
    const controller = new AbortController();
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    leases.set(context.path, { controller, completed });
    try { return await executeContext({ ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal }); }
    finally { leases.delete(context.path); complete(); }
  };
  runner.release = release;
  return runner;
}

async function verifyRepository(selected: string, expected: string): Promise<void> {
  if (!commit.test(expected)) throw new Error('Host checks require an exact captured Git commit.');
  await inspectLinks(selected);
  const metadata = await lstat(path.join(selected, '.git'));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Host checks require private Git metadata.');
  for (const filename of ['alternates', 'http-alternates']) {
    const alternate = await readFile(path.join(selected, '.git', 'objects', 'info', filename), 'utf8').catch(error => { if (missing(error)) return ''; throw error; });
    if (alternate.trim()) throw new Error('Host check Git objects must not reference another checkout.');
  }
  const result = await execute('/usr/bin/git', ['--no-optional-locks', '-C', selected, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', 'rev-parse', '--verify', 'HEAD^{commit}'], { env: privateEnvironment, timeout: 30_000, maxBuffer: 64 * 1024 });
  if (result.stdout.trim() !== expected) throw new Error('Host check snapshot does not match its exact captured commit.');
}

async function ownedDirectory(root: string, selected: string): Promise<void> {
  if (!contains(root, selected)) throw new Error('Host check path is outside its owned snapshot root.');
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Host check storage must be an owned directory, not a symlink.');
  const canonical = await realpath(root);
  let current = root;
  for (const name of path.relative(root, selected).split(path.sep).filter(Boolean)) {
    current = path.join(current, name);
    const part = await lstat(current);
    if (!part.isDirectory() || part.isSymbolicLink() || await realpath(current) !== path.join(canonical, path.relative(root, current))) throw new Error('Host check snapshot contains an unsafe directory or symlink.');
  }
}

async function inspectLinks(root: string, current = root): Promise<void> {
  for (const name of await readdir(current)) {
    const selected = path.join(current, name), entry = await lstat(selected);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(selected), await readlink(selected));
      if (!contains(root, target)) throw new Error('Host check snapshot contains a symlink outside its private root.');
      try { if (!contains(await realpath(root), await realpath(selected))) throw new Error('Host check symlink resolves outside its private root.'); }
      catch (error) { if (!missing(error)) throw error; }
    } else if (entry.isDirectory()) await inspectLinks(root, selected);
    else if (!entry.isFile()) throw new Error('Host check snapshot contains an unsupported special file.');
  }
}

async function validateInputPath(root: string, selected: string): Promise<void> {
  if (!contains(root, selected)) throw new Error('Frozen host check input is outside its captured root.');
  // Missing evidence remains a real check failure. Existing paths must not escape
  // through a symlink, including one in an ancestor of a missing file.
  let current = selected;
  while (contains(root, current)) {
    try { if (!contains(await realpath(root), await realpath(current))) throw new Error('Frozen host check input resolves outside its captured root.'); return; }
    catch (error) { if (!missing(error)) throw error; }
    if (current === root) return;
    current = path.dirname(current);
  }
}

async function readPrivateJson<T>(filename: string): Promise<T> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const entry = await file.stat(); if (!entry.isFile() || entry.size > 3 * 1024 * 1024) throw new Error('Invalid host check process journal.'); return JSON.parse(await file.readFile('utf8')) as T; }
  finally { await file.close(); }
}

async function confirmGroupStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await execute('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { env: privateEnvironment, timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
    if (!result.stdout.split('\n').some(line => { const fields = line.trim().split(/\s+/); return Number(fields[1]) === pid && fields[2] && !fields[2].startsWith('Z'); })) return;
    await delay(50);
  }
  throw new Error('Host check process group termination is unconfirmed; execution outcome is uncertain and private snapshots were retained.');
}

async function processInventory(probe: InventoryProbe = async options => (await execute('/bin/ps', ['-U', String(process.getuid!()), '-o', 'pid=,ppid=,stat=,lstart=,command='], { env: privateEnvironment, timeout: options.timeoutMs, maxBuffer: options.maxBuffer })).stdout, recordFailure: (failure: InventoryProbeFailure) => Promise<void>): Promise<Array<OwnedChild & { parent: number }>> {
  let stdout: string | undefined;
  for (let attempt = 1; attempt <= inventoryProbeAttempts; attempt++) {
    try { stdout = await probe({ timeoutMs: inventoryProbeTimeoutMs, maxBuffer: inventoryProbeMaxBuffer }); break; }
    catch (error) {
      const failure = inventoryProbeFailure(error, attempt);
      await recordFailure(failure);
      if (attempt === inventoryProbeAttempts) throw new Error(`Host check process inventory is unavailable after ${inventoryProbeAttempts} probes: ${JSON.stringify(failure)}`);
      // Compilers can temporarily saturate the host. A fresh successful probe
      // recovers the observation; exhausted retries still fence all cleanup.
      await delay(100);
    }
  }
  return stdout!.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match && !match[3]!.startsWith('Z') ? [{ pid: Number(match[1]), parent: Number(match[2]), identity: match[4]!.trim() }] : [];
  });
}

function inventoryProbeFailure(error: unknown, attempt: number): InventoryProbeFailure {
  const fields = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const byteLength = (value: unknown) => typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : null;
  return { probe: 'descendant-inventory', at: new Date().toISOString(), attempt, timeoutMs: inventoryProbeTimeoutMs, maxBuffer: inventoryProbeMaxBuffer,
    code: typeof fields.code === 'number' && Number.isFinite(fields.code) ? fields.code : typeof fields.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(fields.code) ? fields.code : null,
    signal: typeof fields.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(fields.signal) ? fields.signal : null,
    killed: typeof fields.killed === 'boolean' ? fields.killed : null, stdoutBytes: byteLength(fields.stdout), stderrBytes: byteLength(fields.stderr) };
}

/** A detached tool keeps its captured birth/command identity after reparenting.
 * Never signal a replacement PID or an unobserved snapshot user.
 */
async function stopKnownDescendants(children: OwnedChild[], inventoryProbe: () => Promise<Array<OwnedChild & { parent: number }>>): Promise<void> {
  if (!children.length) return;
  const inventory = await inventoryProbe();
  for (const child of children) {
    const current = inventory.find(entry => entry.pid === child.pid);
    if (!current || current.identity !== child.identity) continue;
    const identity = (await execute('/bin/ps', ['-p', String(child.pid), '-o', 'lstart=', '-o', 'command='], { env: privateEnvironment, timeout: 1000, maxBuffer: 128 * 1024 }).catch(error => { if ((error as { code?: number }).code === 1) return { stdout: '' }; throw error; })).stdout.trim();
    if (identity !== child.identity) continue;
    try { process.kill(child.pid, 'SIGKILL'); } catch (error) { if (!missingProcess(error)) throw error; }
  }
  for (let round = 0; round < 20; round++) {
    const live = await inventoryProbe();
    // Exec changes the command identity, and PID reuse changes the birth
    // identity. Neither proves the previously owned writer has stopped. Do not
    // signal the new identity; retain the uncertainty while that PID is live.
    if (!children.some(child => live.some(entry => entry.pid === child.pid))) return;
    await delay(50);
  }
  throw new Error('Previously owned host check tools remain live or changed process identity; termination is uncertain and private snapshots were retained.');
}

/** Sampling ancestry cannot prove a rapid detach-and-exit did not occur. Cwd
 * handles provide positive evidence of remaining snapshot users even when a
 * daemon ignored stdio and reparented before the first process inventory. Those
 * unknown identities are retained for reconciliation, never killed by guesswork.
 */
async function snapshotUsers(sources: string[]): Promise<number[]> {
  const canonical = await Promise.all(sources.map(source => realpath(source)));
  const users = new Set<number>();
  if (process.platform === 'darwin') {
    const result = await execute('/usr/sbin/lsof', ['-a', '-u', String(process.getuid!()), '-d', 'cwd', '-F', 'pn', '-n', '-P'], { env: privateEnvironment, timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    let pid = 0;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      if (line.startsWith('n') && canonical.some(root => contains(root, line.slice(1))) && Number.isSafeInteger(pid) && pid > 1) users.add(pid);
    }
  } else if (process.platform === 'linux') {
    for (const name of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      try {
        if ((await lstat(`/proc/${name}`)).uid !== process.getuid!()) continue;
        const cwd = await readlink(`/proc/${name}/cwd`);
        if (canonical.some(root => contains(root, cwd))) users.add(Number(name));
      } catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  } else throw new Error('This platform cannot reconcile native host check snapshot users.');
  return [...users];
}

function contains(root: string, selected: string): boolean { const relative = path.relative(root, selected); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function missingProcess(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
