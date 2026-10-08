import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { InspectionAuthority } from '@enoughfactory/contracts';
import { APPLE_CHECK_PREFIX, parseAppleCheckCommand, type ArtifactStore, type InspectionSnapshot } from '@enoughfactory/workspaces';
import type { NativeFixtureProfile, NativeInspectionBuild } from './inspection-native.ts';

const execute = promisify(execFile);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface NativeBuildRequest {
  version: 1; key: string; jobId: string; dataDir: string; artifactsRoot: string; deviceId: string;
  snapshot: InspectionSnapshot; profile: NativeFixtureProfile; authority: InspectionAuthority;
  /** Exact canonical verifier-owned roots registered by the service, never author tool arguments. */
  verifierOwnedSnapshot?: { root: string; path: string; manifestSha256: string };
}
export interface NativeBuildOwner {
  version: 1; key: string; jobId: string; requestSha256: string; workerPath: string; workerArgs: string[];
  status: 'registered' | 'running' | 'cancel-requested' | 'completed' | 'unknown';
  createdAt: string; updatedAt: string; pid?: number; identity?: string; startAuthorized?: true;
}
export interface NativeBuildCompletion {
  version: 1; key: string; jobId: string; requestSha256: string; pid: number; identity: string;
  started: boolean; teardownConfirmed: boolean; canceled: boolean; completedAt: string;
  build?: NativeInspectionBuild; error?: string;
}
export type NativeBuildRecovery =
  | { status: 'completed'; build?: NativeInspectionBuild; error?: string; canceled: boolean; record: NativeBuildOwner }
  | { status: 'unknown'; reason: string; record?: NativeBuildOwner };
interface ActiveBuild { child: ChildProcessWithoutNullStreams; completion: Promise<NativeInspectionBuild>; }
export interface NativeBuildRunnerOptions {
  dataDir: string; artifacts: ArtifactStore;
  /** Trusted service registration for verifier copies outside inspection-snapshots. */
  verifySnapshot?: (snapshot: InspectionSnapshot, signal?: AbortSignal) => Promise<void>;
  /** Fixed service-owned directory containing registered independent-verifier copies. */
  verifierCopiesRoot?: string;
  /** Focused real-process verification only. Product code always uses its fixed installed worker. */
  workerCommand?: { file: string; args: string[] };
  startupTimeoutMs?: number; cancelTimeoutMs?: number;
}

/** A compiler may outlive a service transport. Only its original worker receipt can release its job. */
export class NativeBuildRunner {
  readonly root: string;
  private readonly active = new Map<string, ActiveBuild>();
  constructor(private readonly options: NativeBuildRunnerOptions) { this.root = resolve(options.dataDir, 'native-build-runs'); }

  async build(snapshot: InspectionSnapshot, profile: NativeFixtureProfile, input: { authority: InspectionAuthority; jobId: string; signal?: AbortSignal }): Promise<NativeInspectionBuild> {
    input.signal?.throwIfAborted();
    if (!identifier.test(input.jobId)) throw new Error('Invalid native build job identity.');
    if (this.active.has(input.jobId)) throw new Error('This native build job already has an owned worker.');
    await privateDirectory(resolve(this.options.dataDir));
    await privateDirectory(this.root);
    await this.options.verifySnapshot?.(snapshot, input.signal);
    // A custom verifier must still register canonical, private directories before a child starts.
    let verifierOwnedSnapshot: NativeBuildRequest['verifierOwnedSnapshot'];
    if (snapshot.path !== join(resolve(this.options.dataDir), 'inspection-snapshots', snapshot.id)) {
      if (!this.options.verifySnapshot || !this.options.verifierCopiesRoot) throw new Error('Independent verifier copies require an exact trusted service registration.');
      verifierOwnedSnapshot = { root: resolve(this.options.verifierCopiesRoot), path: snapshot.path, manifestSha256: digest(JSON.stringify(snapshot.manifest)) };
    }
    await validateRegisteredSnapshot(snapshot, this.options.dataDir, verifierOwnedSnapshot);
    const directory = join(this.root, input.jobId);
    await mkdir(directory, { mode: 0o700 }); // Exclusive: an uncertain earlier worker must be reconciled, never replaced.
    const command = this.options.workerCommand ?? await installedWorker();
    const key = randomUUID(), at = new Date().toISOString();
    const request: NativeBuildRequest = { version: 1, key, jobId: input.jobId, dataDir: resolve(this.options.dataDir), artifactsRoot: resolve(this.options.artifacts.root), deviceId: this.options.artifacts.deviceId,
      snapshot: structuredClone(snapshot), profile: structuredClone(profile), authority: structuredClone(input.authority), ...(verifierOwnedSnapshot ? { verifierOwnedSnapshot } : {}) };
    const requestBytes = JSON.stringify(request);
    await writeNativeBuildRecord(join(directory, 'request.json'), request);
    const owner: NativeBuildOwner = { version: 1, key, jobId: input.jobId, requestSha256: digest(requestBytes), workerPath: resolve(command.args.find(arg => /inspection-build-worker\.(?:cjs|ts)$/.test(arg)) ?? command.file), workerArgs: command.args,
      status: 'registered', createdAt: at, updatedAt: at };
    await writeNativeBuildRecord(join(directory, 'owner.json'), owner);
    const child = spawn(command.file, [...command.args, directory, key], { cwd: resolve(this.options.dataDir), detached: true, stdio: 'pipe',
      env: workerEnvironment(directory) }) as ChildProcessWithoutNullStreams;
    let ended = false, closed = false, stderr = '';
    let resolveCancellation: (() => void) | undefined;
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, Math.max(0, 8192 - stderr.length)); });
    const exited = new Promise<void>(resolveExit => { child.once('close', () => { closed = true; resolveExit(); }); child.once('error', () => { ended = true; resolveExit(); }); });
    const abort = () => {
      resolveCancellation?.();
      if (ended || closed) return;
      child.stdin.write(JSON.stringify({ type: 'CANCEL', key }) + '\n');
      child.stdin.end();
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    const completion = (async () => {
      try {
        await waitReady(child, key, this.options.startupTimeoutMs ?? 15_000);
        const ready = await readPrivateJson<{ version: number; key: string; jobId: string; pid: number; identity: string }>(join(directory, 'ready.json'));
        const identity = child.pid ? await nativeBuildProcessIdentity(child.pid) : undefined;
        if (ready.version !== 1 || ready.key !== key || ready.jobId !== input.jobId || ready.pid !== child.pid || ready.identity !== identity || !identity?.includes(key)) throw new Error('Native build worker ownership could not be verified.');
        Object.assign(owner, { pid: ready.pid, identity, status: input.signal?.aborted ? 'cancel-requested' : 'running', startAuthorized: true, updatedAt: new Date().toISOString() });
        await writeNativeBuildRecord(join(directory, 'owner.json'), owner);
        if (input.signal?.aborted) abort();
        else child.stdin.write(JSON.stringify({ type: 'START', key, requestSha256: owner.requestSha256 }) + '\n');
        const canceled = new Promise<void>(resolveCancel => { resolveCancellation = resolveCancel; });
        if (input.signal?.aborted) await bounded(exited, this.options.cancelTimeoutMs ?? 30_000);
        else {
          const end = await Promise.race([exited.then(() => 'exited'), canceled.then(() => 'canceled')]);
          if (end === 'canceled') await bounded(exited, this.options.cancelTimeoutMs ?? 30_000);
        }
        ended = true;
        const recovered = await this.recover(input.jobId);
        if (recovered.status !== 'completed') throw new NativeBuildUnknownError(recovered.reason);
        if (!recovered.build) throw new NativeBuildFailedError(recovered.error ?? 'Native build was canceled before compilation.');
        return recovered.build;
      } catch (error) {
        child.stdin.end(); // A live worker treats lost parent transport as cancellation and owns teardown.
        const prior = await readPrivateJson<NativeBuildOwner>(join(directory, 'owner.json')).catch(() => owner);
        if (prior.status !== 'completed') await writeNativeBuildRecord(join(directory, 'owner.json'), { ...prior, status: 'unknown', updatedAt: new Date().toISOString() });
        if (error instanceof NativeBuildUnknownError || error instanceof NativeBuildFailedError) throw error;
        throw new NativeBuildUnknownError(`${message(error)}${stderr ? ` ${stderr.trim()}` : ''}`);
      } finally { input.signal?.removeEventListener('abort', abort); this.active.delete(input.jobId); }
    })();
    this.active.set(input.jobId, { child, completion });
    return completion;
  }

  async recover(jobId: string): Promise<NativeBuildRecovery> {
    if (!identifier.test(jobId)) return { status: 'unknown', reason: 'Invalid native build job identity.' };
    let owner: NativeBuildOwner | undefined;
    try {
      const directory = join(this.root, jobId);
      await assertPrivateDirectory(directory);
      owner = await readPrivateJson<NativeBuildOwner>(join(directory, 'owner.json'));
      const requestBytes = await readPrivateBytes(join(directory, 'request.json'));
      const request = JSON.parse(requestBytes.toString()) as NativeBuildRequest;
      if (owner.version !== 1 || owner.jobId !== jobId || request.version !== 1 || request.jobId !== jobId || request.key !== owner.key || digest(requestBytes) !== owner.requestSha256
        || request.dataDir !== resolve(this.options.dataDir) || request.artifactsRoot !== resolve(this.options.artifacts.root) || request.deviceId !== this.options.artifacts.deviceId) throw new Error('Native build request ownership changed.');
      const receipt = await readPrivateJson<NativeBuildCompletion>(join(directory, 'completion.json'));
      if (receipt.version !== 1 || receipt.key !== owner.key || receipt.jobId !== jobId || receipt.requestSha256 !== owner.requestSha256 || !receipt.teardownConfirmed
        || !owner.pid || receipt.pid !== owner.pid || !owner.identity || receipt.identity !== owner.identity || !Number.isFinite(Date.parse(receipt.completedAt))) throw new Error('Native build has no matching confirmed teardown receipt.');
      if (receipt.started && owner.startAuthorized !== true) throw new Error('Native build receipt predates its recorded execution authority.');
      if (receipt.build) await this.verifyOriginalBuild(receipt.build, request);
      else if (!receipt.error) throw new Error('Native build has no original preparation outcome.');
      owner = { ...owner, status: 'completed', updatedAt: receipt.completedAt };
      await writeNativeBuildRecord(join(directory, 'owner.json'), owner);
      return { status: 'completed', build: receipt.build, error: receipt.error, canceled: receipt.canceled, record: owner };
    } catch (error) { return { status: 'unknown', reason: message(error), record: owner }; }
  }

  async cancel(jobId: string): Promise<NativeBuildRecovery> {
    if (!identifier.test(jobId)) return { status: 'unknown', reason: 'Invalid native build job identity.' };
    const selected = this.active.get(jobId);
    if (selected) {
      const owner = await readPrivateJson<NativeBuildOwner>(join(this.root, jobId, 'owner.json'));
      selected.child.stdin.write(JSON.stringify({ type: 'CANCEL', key: owner.key }) + '\n'); selected.child.stdin.end();
      await bounded(selected.completion.catch(() => undefined), this.options.cancelTimeoutMs ?? 30_000).catch(() => undefined);
    } else {
      const current = await this.recover(jobId);
      if (current.status === 'completed') return current;
      const owner = current.record;
      // A recycled PID or absent worker never confirms what happened to compiler children.
      if (owner?.pid && owner.identity && await nativeBuildProcessIdentity(owner.pid) === owner.identity && owner.identity.includes(owner.key)) {
        await writeNativeBuildRecord(join(this.root, jobId, 'owner.json'), { ...owner, status: 'cancel-requested', updatedAt: new Date().toISOString() });
        try { process.kill(owner.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        const deadline = Date.now() + (this.options.cancelTimeoutMs ?? 30_000);
        while (Date.now() < deadline) { const recovered = await this.recover(jobId); if (recovered.status === 'completed') return recovered; await new Promise(resolveWait => setTimeout(resolveWait, 50)); }
      }
    }
    return this.recover(jobId);
  }

  async close(): Promise<NativeBuildRecovery[]> { return Promise.all([...this.active.keys()].map(jobId => this.cancel(jobId))); }

  private async verifyOriginalBuild(build: NativeInspectionBuild, request: NativeBuildRequest): Promise<void> {
    if (build.candidate.goalId !== request.authority.goalId || build.candidate.taskId !== request.authority.taskId || build.candidate.attemptId !== request.authority.attemptId
      || build.candidate.commit !== request.snapshot.roots[0]!.commit || build.report.commit !== build.candidate.commit || build.report.candidateId !== build.candidate.id
      || build.fixtureProfileId !== request.profile.id || request.snapshot.manifestArtifact && build.snapshotArtifact.sha256 !== request.snapshot.manifestArtifact.sha256 || build.report.cleanupErrors?.length || build.report.commands.some(command => command.cleanupErrors?.length)) throw new Error('Native build outcome does not match its original owner or confirmed teardown.');
    const bytes = await this.options.artifacts.read(build.preparationArtifact);
    const saved = JSON.parse(bytes.toString()) as Record<string, unknown>;
    const { preparationArtifact: _preparation, ...original } = build;
    for (const [key, value] of Object.entries(original)) if (JSON.stringify(saved[key]) !== JSON.stringify(value)) throw new Error('Native build outcome differs from its original preparation artifact.');
    if (saved.kind !== 'native-inspection-build' || saved.previewOnly !== true || (saved.sourceIdentity as { sha256?: string })?.sha256 !== request.snapshot.sourceDigest) throw new Error('Native build preparation source changed.');
    const profile = { ...request.profile, build: parseAppleCheckCommand(`${APPLE_CHECK_PREFIX} ${JSON.stringify(request.profile.build)}`) };
    if (JSON.stringify(saved.fixtureProfile) !== JSON.stringify(profile)) throw new Error('Native build fixed fixture profile differs from its registered request.');
    if (JSON.stringify(JSON.parse((await this.options.artifacts.read(build.snapshotArtifact)).toString())) !== JSON.stringify(request.snapshot.manifest)) throw new Error('Native build original snapshot manifest changed.');
    for (const artifact of [build.reportArtifact, build.snapshotArtifact, build.fixtureReceiptArtifact, ...build.evidenceArtifacts, ...build.productArtifacts,
      build.candidate.bundleArtifact, build.candidate.diffArtifact, ...(build.candidate.workingDirectories ?? []).flatMap(root => [root.bundleArtifact, root.diffArtifact])]) await this.options.artifacts.path(artifact);
  }
}

export class NativeBuildUnknownError extends Error { readonly outcomeUnknown = true; constructor(reason: string) { super(`Native build outcome is unknown; retain its source and reservation. ${reason}`); } }
export class NativeBuildFailedError extends Error { readonly teardownConfirmed = true; }

export async function nativeBuildProcessIdentity(pid: number): Promise<string | undefined> {
  try { return (await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 3_000, env: { PATH: '/usr/bin:/bin' } })).stdout.trim() || undefined; }
  catch (error) { if ((error as { code?: number }).code === 1) return undefined; throw error; }
}
export async function readPrivateJson<T>(path: string): Promise<T> { return JSON.parse((await readPrivateBytes(path)).toString()) as T; }
export async function readPrivateBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 32 * 1024 * 1024) throw new Error('Native build record ownership changed.'); return await handle.readFile(); }
  finally { await handle.close(); }
}
export async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(path) !== resolve(path)) throw new Error('Native build storage must remain a private canonical directory.');
}
async function privateDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await assertPrivateDirectory(path); }
async function writePrivateExclusive(path: string, bytes: string): Promise<void> { const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
export async function writeNativeBuildRecord(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writePrivateExclusive(temporary, JSON.stringify(value)); await rename(temporary, path);
    const parent = await open(dirname(path), constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}
export async function validateRegisteredSnapshot(snapshot: InspectionSnapshot, dataDir: string, registration?: NativeBuildRequest['verifierOwnedSnapshot']): Promise<void> {
  if (!identifier.test(snapshot.id) || !snapshot.roots.length || snapshot.roots.length > 9 || snapshot.path !== resolve(snapshot.path)) throw new Error('Invalid registered native build snapshot.');
  if (!registration && snapshot.path !== join(resolve(dataDir), 'inspection-snapshots', snapshot.id)) throw new Error('Native build requires its exact service-owned snapshot path.');
  // Verifier registration cannot grant arbitrary filesystem roots or symlink traversals.
  if (registration) {
    if (registration.root !== resolve(registration.root) || dirname(registration.root) === registration.root || registration.path !== snapshot.path
      || !snapshot.path.startsWith(registration.root + '/') || registration.manifestSha256 !== digest(JSON.stringify(snapshot.manifest))) throw new Error('Native verifier snapshot does not match its exact trusted registration.');
    await assertPrivateDirectory(registration.root);
  }
  await assertPrivateDirectory(snapshot.path);
  for (const root of snapshot.roots) {
    if (!root.path.startsWith(snapshot.path + '/') || root.path !== resolve(root.path) || await realpath(root.path) !== root.path || !(await lstat(root.path)).isDirectory()) throw new Error('Native build source root changed after registration.');
  }
}
async function installedWorker(): Promise<{ file: string; args: string[] }> {
  const self = fileURLToPath(import.meta.url), directory = dirname(self);
  if (self.endsWith('.cjs') || self.endsWith('.js')) {
    const worker = join(directory, 'inspection-build-worker.cjs');
    const info = await lstat(worker); if (!info.isFile() || info.isSymbolicLink() || await realpath(worker) !== worker) throw new Error('Installed native build worker is unavailable.');
    return { file: process.execPath, args: [worker] };
  }
  return { file: process.execPath, args: ['--import', createRequire(import.meta.url).resolve('tsx'), join(directory, 'inspection-build-worker.ts')] };
}
function workerEnvironment(directory: string): NodeJS.ProcessEnv {
  const inherited = process.env;
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', HOME: directory,
    ...Object.fromEntries(['ENOUGHFACTORY_RESOURCES', 'ENOUGHFACTORY_NATIVE_ASSETS', 'ENOUGHFACTORY_NATIVE_MAC_HELPER', 'ENOUGHFACTORY_NATIVE_IOS_XCTESTRUN', 'ENOUGHFACTORY_NATIVE_IOS_RUNTIME', 'ENOUGHFACTORY_NATIVE_IOS_DEVICE_TYPE'].flatMap(key => inherited[key] ? [[key, inherited[key]]] : [])) };
}
function waitReady(child: ChildProcessWithoutNullStreams, key: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let bytes = '';
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', data); child.off('error', error); child.off('close', close); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const close = () => error(new Error('Native build worker ended before its ownership handshake.'));
    const data = (chunk: Buffer) => {
      bytes += chunk.toString(); if (bytes.length > 64 * 1024) { error(new Error('Native build worker readiness exceeded its limit.')); return; }
      const newline = bytes.indexOf('\n'); if (newline < 0) return;
      try { const value = JSON.parse(bytes.slice(0, newline)); if (value.ready !== key || value.pid !== child.pid) throw new Error('Native build worker readiness does not match its owner.'); cleanup(); resolveReady(); }
      catch (cause) { error(cause instanceof Error ? cause : new Error(String(cause))); }
    };
    const timer = setTimeout(() => error(new Error('Native build worker ownership handshake timed out.')), timeoutMs);
    child.stdout.on('data', data); child.once('error', error); child.once('close', close);
  });
}
function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { return new Promise((resolveBounded, reject) => { const timer = setTimeout(() => reject(new NativeBuildUnknownError('The worker has not yet confirmed bounded teardown.')), timeoutMs); promise.then(value => { clearTimeout(timer); resolveBounded(value); }, error => { clearTimeout(timer); reject(error); }); }); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
