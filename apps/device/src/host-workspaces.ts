import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ArtifactStore, WorkingDirectoryManager, fingerprintWorkingDirectories, writeAtomic, type WorkingDirectoryCapture, type WorkingDirectorySnapshot, type WorkingDirectorySource, type WorkspaceRecord } from '@enoughfactory/workspaces';

const execute = promisify(execFile);
const operations = new Map<string, Promise<unknown>>();
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const alias = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const commit = /^[a-f0-9]{40,64}$/;

export interface HostWorkspacePrepared {
  sessionId: string;
  root: string;
  cwd: string;
  workspaceId: string;
  /** Independent authored roots. The containerPath is an identity, not a host path. */
  roots: WorkingDirectorySnapshot[];
  /** An advisory read-only copy; its immutable artifact remains authoritative. */
  referenceContext?: WorkingDirectorySnapshot;
}

export interface HostWorkspacePrepareInput {
  sessionId: string;
  workspace: WorkspaceRecord;
  workingDirectorySources?: readonly WorkingDirectorySource[];
  referenceContext?: WorkingDirectorySource;
  assertCurrent?: () => void;
}

interface HostWorkspaceJournal {
  version: 1;
  disposal?: 'disposing' | 'disposed';
  workspace: WorkspaceRecord;
  prepared: HostWorkspacePrepared;
}

interface HostWorkspaceCaptures {
  version: 1;
  sessionId: string;
  workspaceId: string;
  fingerprint: string;
  roots: WorkingDirectoryCapture[];
}

/** Owns files only. The session/process owner must stop writers before capture/dispose.
 * Private copies protect the selected checkouts; they do not sandbox a same-user host process.
 */
export class HostWorkspaceManager {
  private readonly dataRoot: string;
  private readonly directories: WorkingDirectoryManager;

  constructor(private readonly options: { workspaceDataDir: string; artifacts: ArtifactStore; directoryManager?: WorkingDirectoryManager }) {
    this.dataRoot = path.resolve(options.workspaceDataDir);
    this.directories = options.directoryManager ?? new WorkingDirectoryManager({ dataDir: this.dataRoot, artifacts: options.artifacts });
  }

  async prepare(input: HostWorkspacePrepareInput): Promise<HostWorkspacePrepared> {
    validId(input.sessionId);
    return this.serial(input.sessionId, () => this.prepareLocked(input));
  }

  /** Reconnect to the existing copies without reseeding files or consulting live sources. */
  async load(sessionId: string): Promise<HostWorkspacePrepared> {
    return (await this.journal(sessionId)).prepared;
  }

  private async prepareLocked(input: HostWorkspacePrepareInput): Promise<HostWorkspacePrepared> {
    input.assertCurrent?.();
    const sources = input.workingDirectorySources ?? [];
    validateSources(sources, input.referenceContext);
    const root = this.sessionRoot(input.sessionId);
    await this.ensureDirectory(this.dataRoot);
    await this.validateWorkspace(input.workspace);
    try {
      const previous = await this.journal(input.sessionId);
      if (workspaceIdentity(previous.workspace) !== workspaceIdentity(input.workspace)
        || sourceIdentity(previous.prepared.roots) !== sourceIdentity(sources)
        || sourceIdentity(previous.prepared.referenceContext ? [previous.prepared.referenceContext] : []) !== sourceIdentity(input.referenceContext ? [input.referenceContext] : [])) {
        throw new Error('Host session identity already belongs to different captured inputs.');
      }
      input.assertCurrent?.();
      return previous.prepared;
    } catch (error) { if (!missing(error)) throw error; }

    await this.ensureDirectory(path.dirname(root));
    // A partial directory is retained for inspection after a service crash, never reseeded.
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Host session has an incomplete workspace; preserve it before retrying.'); throw error; }
    try {
      await inspectLinks(input.workspace.path);
      await removePrimaryRemotes(input.workspace.path);
      const roots = await this.directories.prepare({ identity: this.baselineId(input.sessionId), transferred: sources });
      const reference = input.referenceContext
        ? (await this.directories.prepare({ identity: this.referenceId(input.sessionId), transferred: [input.referenceContext] }))[0]
        : undefined;
      input.assertCurrent?.();
      const materialized: WorkingDirectorySnapshot[] = [];
      for (const snapshot of roots) {
        const destination = this.rootPath(input.sessionId, snapshot.id, false);
        await this.copySnapshot(snapshot, destination, this.baselineId(input.sessionId), false);
        input.assertCurrent?.();
        materialized.push({ ...snapshot, path: destination });
      }
      let referenceContext: WorkingDirectorySnapshot | undefined;
      if (reference) {
        const destination = this.rootPath(input.sessionId, reference.id, true);
        await this.copySnapshot(reference, destination, this.referenceId(input.sessionId), true);
        input.assertCurrent?.();
        referenceContext = { ...reference, path: destination };
      }
      // Match the durable JSON form on the initial return and after recovery.
      const prepared = JSON.parse(JSON.stringify({ sessionId: input.sessionId, root, cwd: input.workspace.path, workspaceId: input.workspace.id, roots: materialized, ...(referenceContext ? { referenceContext } : {}) })) as HostWorkspacePrepared;
      await writeAtomic(path.join(root, 'workspace.json'), { version: 1, workspace: input.workspace, prepared } satisfies HostWorkspaceJournal);
      return prepared;
    } catch (error) {
      // No process receives these paths before prepare returns. Retire unpublished
      // input copies too, so retry reimports the immutable bundles rather than
      // trusting a mutable cache left by an interrupted preparation.
      for (const identity of [this.baselineId(input.sessionId), this.referenceId(input.sessionId)]) {
        try { await this.removeOwnedTree(path.join(this.dataRoot, 'working-directories', identity)); }
        catch (cleanupError) { if (!missing(cleanupError)) throw cleanupError; }
      }
      await this.removeOwnedTree(root);
      throw error;
    }
  }

  /** Additional roots retain their own bundles; none are merged into the primary checkout. */
  async capture(prepared: HostWorkspacePrepared, context: { goalId?: string; taskId?: string; attemptId?: string } = {}): Promise<WorkingDirectoryCapture[]> {
    validId(prepared.sessionId);
    return this.serial(prepared.sessionId, async () => {
      const journal = await this.match(prepared);
      const expectedContext = { goalId: journal.workspace.goalId, taskId: journal.workspace.taskId, attemptId: journal.workspace.attemptId };
      for (const key of ['goalId', 'taskId', 'attemptId'] as const) if (context[key] !== undefined && context[key] !== expectedContext[key]) throw new Error('Host capture context belongs to different attempt authority.');
      const capturePath = this.capturePath(prepared.sessionId);
      const previous = await this.readCaptures(journal);
      if (previous) return previous.roots;
      const fingerprint = await fingerprintWorkingDirectories(journal.prepared.roots);
      const roots: WorkingDirectoryCapture[] = [];
      for (const snapshot of journal.prepared.roots) {
        await this.existingDirectory(snapshot.path);
        roots.push(await this.directories.captureFromPath(snapshot, snapshot.path, expectedContext));
      }
      // Publish only a complete capture set. A failure leaves every authored root intact.
      await this.ensureDirectory(path.dirname(capturePath));
      if (await fingerprintWorkingDirectories(journal.prepared.roots) !== fingerprint) throw new Error('Host working folders changed during capture; stop writers and preserve the current files before retrying.');
      await writeAtomic(capturePath, { version: 1, sessionId: prepared.sessionId, workspaceId: prepared.workspaceId, fingerprint, roots } satisfies HostWorkspaceCaptures);
      return roots;
    });
  }

  /** A deliberate stopped-session continuation retains its earlier capture and
   * starts a new capture boundary; stale edits cannot silently replace evidence.
   */
  async beginContinuation(prepared:HostWorkspacePrepared):Promise<void> {
    return this.serial(prepared.sessionId,async()=>{
      const journal=await this.match(prepared),captures=await this.readCaptures(journal);
      if(!captures)return;
      const history=path.join(this.dataRoot,'host-session-capture-history',validId(prepared.sessionId));
      await this.ensureDirectory(history);
      await writeAtomic(path.join(history,`${randomUUID()}.json`),captures);
      await rm(this.capturePath(prepared.sessionId));
    });
  }

  /** Remove only owned scratch after all additional roots have durable captures.
   * The primary attempt repository belongs to WorkspaceManager and is retained here.
   */
  async dispose(prepared: HostWorkspacePrepared): Promise<void> {
    validId(prepared.sessionId);
    return this.serial(prepared.sessionId, async () => {
      const journal = await this.match(prepared, true);
      if (journal.disposal === 'disposed') return;
      const captures = await this.readCaptures(journal, journal.disposal !== 'disposing');
      if (prepared.roots.length && !captures) throw new Error('Capture every authored host working folder before disposing its workspace.');
      // Record intent before deleting scratch, so a crash can resume cleanup without
      // presenting partially removed roots to a replacement host process.
      await writeAtomic(path.join(prepared.root, 'workspace.json'), { ...journal, disposal: 'disposing' });
      for (const directory of ['roots', 'reference-context']) {
        try { await this.removeOwnedTree(path.join(prepared.root, directory)); } catch (error) { if (!missing(error)) throw error; }
      }
      for (const identity of [this.baselineId(prepared.sessionId), this.referenceId(prepared.sessionId)]) {
        const directory = path.join(this.dataRoot, 'working-directories', identity);
        try { await this.removeOwnedTree(directory); } catch (error) { if (!missing(error)) throw error; }
      }
      await writeAtomic(path.join(prepared.root, 'workspace.json'), { ...journal, disposal: 'disposed' });
    });
  }

  private async copySnapshot(snapshot: WorkingDirectorySnapshot, destination: string, identity: string, readOnly: boolean): Promise<void> {
    if (snapshot.path !== path.join(this.dataRoot, 'working-directories', identity, 'roots', snapshot.id, 'repository')) throw new Error('Host input snapshot does not belong to its private baseline.');
    await this.existingDirectory(snapshot.path);
    await this.options.artifacts.path(snapshot.sourceArtifact);
    await this.ensureDirectory(path.dirname(destination));
    await copyTree(snapshot.path, destination, readOnly);
  }

  private async journal(sessionId: string, allowDisposal = false): Promise<HostWorkspaceJournal> {
    validId(sessionId);
    const root = this.sessionRoot(sessionId);
    await this.existingDirectory(root);
    const journal = await readJson<HostWorkspaceJournal>(path.join(root, 'workspace.json'));
    if (journal.version !== 1 || !journal.prepared || !journal.workspace) throw new Error('Invalid private host workspace journal.');
    const prepared = journal.prepared;
    if (prepared.sessionId !== sessionId || prepared.root !== root || prepared.cwd !== journal.workspace.path || prepared.workspaceId !== journal.workspace.id) throw new Error('Host workspace journal has a different private identity.');
    await this.validateWorkspace(journal.workspace);
    validateSources(prepared.roots, prepared.referenceContext);
    if (journal.disposal !== undefined && !['disposing', 'disposed'].includes(journal.disposal)) throw new Error('Invalid host workspace disposal state.');
    if (journal.disposal && !allowDisposal) throw new Error('Host workspace scratch is being retired or has already been disposed.');
    for (const snapshot of [...prepared.roots, ...(prepared.referenceContext ? [prepared.referenceContext] : [])]) {
      if (snapshot.path !== this.rootPath(sessionId, snapshot.id, snapshot === prepared.referenceContext)) throw new Error('Host workspace journal contains an unowned root path.');
      if (!journal.disposal) await this.existingDirectory(snapshot.path);
      await this.options.artifacts.path(snapshot.sourceArtifact);
    }
    return journal;
  }

  private async match(prepared: HostWorkspacePrepared, allowDisposal = false): Promise<HostWorkspaceJournal> {
    const journal = await this.journal(prepared.sessionId, allowDisposal);
    if (JSON.stringify(journal.prepared) !== JSON.stringify(prepared)) throw new Error('Host workspace binding changed; reload its private journal before continuing.');
    return journal;
  }

  private async readCaptures(journal: HostWorkspaceJournal, verifyCurrent = true): Promise<HostWorkspaceCaptures | undefined> {
    const capturePath = this.capturePath(journal.prepared.sessionId);
    let captures: HostWorkspaceCaptures;
    try {
      await this.existingDirectory(path.dirname(capturePath));
      captures = await readJson<HostWorkspaceCaptures>(capturePath);
    } catch (error) { if (missing(error)) return undefined; throw error; }
    if (captures.version !== 1 || captures.sessionId !== journal.prepared.sessionId || captures.workspaceId !== journal.workspace.id || !Array.isArray(captures.roots) || captures.roots.length !== journal.prepared.roots.length) throw new Error('Host workspace capture journal is incomplete or belongs to different work.');
    if (verifyCurrent && captures.fingerprint !== await fingerprintWorkingDirectories(journal.prepared.roots)) throw new Error('Host working folders changed after their retained capture; preserve the new files before disposing or reusing the capture.');
    for (let index = 0; index < captures.roots.length; index++) {
      const capture = captures.roots[index]!, snapshot = journal.prepared.roots[index]!;
      if (capture.id !== snapshot.id || capture.name !== snapshot.name || capture.kind !== snapshot.kind || capture.containerPath !== snapshot.containerPath || capture.baseCommit !== snapshot.baseCommit || !commit.test(capture.commit)) throw new Error('Host workspace capture no longer matches its independent input.');
      await this.options.artifacts.path(capture.bundleArtifact);
      await this.options.artifacts.path(capture.diffArtifact);
    }
    return captures;
  }

  private async validateWorkspace(workspace: WorkspaceRecord): Promise<void> {
    for (const id of [workspace.id, workspace.attemptId, workspace.goalId, workspace.taskId]) validId(id);
    if (workspace.provider !== 'git') throw new Error('Native host authoring requires an EnoughFactory-owned Git attempt workspace.');
    const expected = path.join(this.dataRoot, 'workspaces', workspace.id, 'repository');
    if (workspace.path !== expected || workspace.id !== workspace.attemptId || !commit.test(workspace.baseCommit)) throw new Error('Host primary working directory must be the exact private attempt repository.');
    await this.existingDirectory(expected);
    const record = await readJson<WorkspaceRecord>(path.join(path.dirname(expected), 'workspace.json'));
    if (workspaceIdentity(record) !== workspaceIdentity(workspace)) throw new Error('Host primary workspace does not match its retained workspace identity.');
    let original = path.resolve(workspace.projectPath);
    try { original = await realpath(original); } catch (error) { if (!missing(error)) throw error; }
    const canonical = await realpath(expected);
    if (contains(original, canonical) || contains(canonical, original)) throw new Error('Host authoring must not expose the primary project checkout as its working directory.');
  }

  private sessionRoot(sessionId: string): string { return path.join(this.dataRoot, 'host-sessions', validId(sessionId)); }
  private rootPath(sessionId: string, id: string, reference: boolean): string { return path.join(this.sessionRoot(sessionId), reference ? 'reference-context' : 'roots', validId(id), 'repository'); }
  private baselineId(sessionId: string): string { return `${validId(sessionId)}-host-roots`; }
  private referenceId(sessionId: string): string { return `${validId(sessionId)}-host-reference`; }
  private capturePath(sessionId: string): string { return path.join(this.dataRoot, 'host-session-captures', `${validId(sessionId)}.json`); }

  private async serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.sessionRoot(sessionId), previous = operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    operations.set(key, current);
    try { return await current; } finally { if (operations.get(key) === current) operations.delete(key); }
  }

  private async ensureDirectory(selected: string): Promise<void> { await this.walkOwned(selected, true); }
  private async existingDirectory(selected: string): Promise<void> { await this.walkOwned(selected, false); }

  private async walkOwned(selected: string, create: boolean): Promise<void> {
    if (!contains(this.dataRoot, selected) || path.resolve(selected) !== selected) throw new Error('Host workspace paths must remain inside EnoughFactory-owned storage.');
    // Resolve aliases above the configured storage root (e.g. /var on macOS), but
    // reject a symlink at or below that root rather than following it.
    if (create) await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const rootEntry = await lstat(this.dataRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('Host workspace storage root is not an owned directory.');
    const canonicalRoot = await realpath(this.dataRoot);
    let current = this.dataRoot;
    for (const part of path.relative(this.dataRoot, selected).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create) try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Host workspace storage contains an unsafe directory or symlink.');
      const canonical = await realpath(current);
      if (canonical !== path.join(canonicalRoot, path.relative(this.dataRoot, current))) throw new Error('Host workspace path does not have its exact canonical ownership.');
    }
  }

  private async removeOwnedTree(selected: string): Promise<void> {
    if (selected === this.dataRoot) throw new Error('Cannot dispose the host workspace storage root.');
    await this.existingDirectory(selected);
    await makeWritable(selected);
    await rm(selected, { recursive: true, force: true });
  }
}

function validId(value: string): string { if (typeof value !== 'string' || !identifier.test(value)) throw new Error('Invalid host workspace identifier.'); return value; }
function contains(root: string, selected: string): boolean { const relative = path.relative(root, selected); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function validateSources(sources: readonly WorkingDirectorySource[], reference?: WorkingDirectorySource): void {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('Select at most eight authored host working folders.');
  const ids = new Set<string>(), names = new Set<string>();
  for (const source of [...sources, ...(reference ? [reference] : [])]) {
    validId(source.id);
    if (!alias.test(source.name) || names.has(source.name.toLowerCase()) || ids.has(source.id.toLowerCase())) throw new Error('Host working folder identifiers and names must be unique, including reference evidence.');
    if (!['git', 'folder'].includes(source.kind) || source.containerPath !== `/workspaces/${source.name}` || !commit.test(source.baseCommit) || !source.sourceArtifact) throw new Error('Host working folder omitted an exact captured source identity.');
    names.add(source.name.toLowerCase()); ids.add(source.id.toLowerCase());
  }
}

function sourceIdentity(sources: readonly WorkingDirectorySource[]): string { return JSON.stringify(sources.map(({ id, name, kind, containerPath, baseCommit, sourceCommit, sourceArtifact }) => ({ id, name, kind, containerPath, baseCommit, sourceCommit, sourceArtifact }))); }
function workspaceIdentity(workspace: WorkspaceRecord): string { return JSON.stringify({ id: workspace.id, attemptId: workspace.attemptId, goalId: workspace.goalId, taskId: workspace.taskId, deviceId: workspace.deviceId, projectPath: workspace.projectPath, path: workspace.path, provider: workspace.provider, baseCommit: workspace.baseCommit, branch: workspace.branch }); }

async function readJson<T>(selected: string): Promise<T> {
  const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) throw new Error('Host workspace journal is not a regular private file.'); return JSON.parse(await handle.readFile('utf8')) as T; }
  finally { await handle.close(); }
}

/** Never dereference source symlinks into a checkout, credentials, or other host files. */
async function inspectLinks(root: string, current = root, relocating = false): Promise<void> {
  for (const name of await readdir(current)) {
    const selected = path.join(current, name), entry = await lstat(selected);
    if (entry.isSymbolicLink()) {
      const link = await readlink(selected), target = path.resolve(path.dirname(selected), link);
      if (relocating && path.isAbsolute(link)) throw new Error('Captured host inputs require relative internal symlinks so relocation cannot expose another copy.');
      if (!contains(root, target)) throw new Error('Host workspace contains a symlink outside its captured root; capture that dependency explicitly.');
      try { if (!contains(await realpath(root), await realpath(selected))) throw new Error('Host workspace symlink resolves outside its captured root.'); }
      catch (error) { if (!missing(error)) throw error; }
    } else if (entry.isDirectory()) await inspectLinks(root, selected, relocating);
    else if (!entry.isFile()) throw new Error('Host workspace contains an unsupported special file.');
  }
}

async function copyTree(source: string, destination: string, readOnly: boolean): Promise<void> {
  await inspectLinks(source, source, true);
  const copy = async (from: string, to: string): Promise<void> => {
    const entry = await lstat(from);
    if (entry.isSymbolicLink()) { await symlink(await readlink(from), to); return; }
    // Copy-on-write shares storage until either private copy is edited, with a
    // normal independent file copy on filesystems that cannot clone blocks.
    if (entry.isFile()) { await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); await chmod(to, (entry.mode & 0o777) & (readOnly ? ~0o222 : 0o777)); return; }
    if (!entry.isDirectory()) throw new Error('Host workspace input contains an unsupported special file.');
    await mkdir(to, { mode: 0o700 });
    const names = await readdir(from);
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('Host input contains names that collide on a case-insensitive Mac filesystem.');
    for (const name of names) await copy(path.join(from, name), path.join(to, name));
    await chmod(to, readOnly ? (entry.mode & 0o555) | 0o500 : entry.mode & 0o777);
  };
  await copy(source, destination);
}

async function makeWritable(root: string): Promise<void> {
  await chmod(root, (await lstat(root)).mode & 0o777 | 0o700);
  for (const name of await readdir(root)) {
    const selected = path.join(root, name), entry = await lstat(selected);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeWritable(selected);
  }
}

async function removePrimaryRemotes(cwd: string): Promise<void> {
  const metadata = await lstat(path.join(cwd, '.git')), config = await lstat(path.join(cwd, '.git', 'config'));
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !config.isFile() || config.isSymbolicLink()) throw new Error('Host primary workspace must have private Git metadata.');
  const run = async (args: string[]) => execute('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, 'config', '--local', '--no-includes', ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000, maxBuffer: 1024 * 1024 });
  let output: string;
  try { output = (await run(['--name-only', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'])).stdout; }
  catch (error) { if ((error as { code?: number }).code === 1) return; throw error; }
  for (const section of new Set(output.trim().split('\n').filter(Boolean).map(key => key.slice(0, key.lastIndexOf('.'))))) await run(['--remove-section', section]);
}
