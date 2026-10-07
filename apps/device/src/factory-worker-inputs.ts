import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Attempt, Chat, FactoryTask } from '@enoughfactory/contracts';
import type { AttemptDetail, CandidateRef, FactoryStore, WorkspaceRef } from '@enoughfactory/factory';
import { workingDirectoryEmptyDirectories, type ArtifactManifest, type ArtifactStore, type Candidate, type CheckReport, type WorkingDirectoryManager, type WorkingDirectorySource, type WorkspaceManager } from '@enoughfactory/workspaces';
import type { SessionController } from './sessions.ts';
import { exec } from './util.ts';

interface Inputs {
  dataDir: string; store: FactoryStore; directoryManager: WorkingDirectoryManager;
  artifacts: ArtifactStore; workspaces: Pick<WorkspaceManager, 'candidate'>;
}
interface CapturedWorker {
  id: string; status: string; goal: { id: string }; task: { id: string };
  workspace?: WorkspaceRef; sessionId?: string; chatId?: string;
  candidate?: CandidateRef; workingDirectorySources?: WorkingDirectorySource[];
}
const identityPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
function identity(value: string): void { if (!identityPattern.test(value)) throw new Error('Invalid Factory input ownership.'); }
function persisted<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function publicSource(source: WorkingDirectorySource & { path?: string }): WorkingDirectorySource { const { path: _, ...value } = source; return value; }
function candidateArtifacts(candidate: Candidate): ArtifactManifest[] {
  return [candidate.bundleArtifact, candidate.diffArtifact, ...(candidate.workingDirectories ?? []).flatMap(root => [root.bundleArtifact, root.diffArtifact])];
}
async function retainedArtifact(input: Inputs, manifest: ArtifactManifest): Promise<void> {
  if (!isDeepStrictEqual(await input.artifacts.get(manifest.id), persisted(manifest))) throw new Error('Factory input cleanup requires the exact durable artifact manifest.');
  await input.artifacts.path(manifest);
}
async function retainedCandidate(input: Inputs, expected: CandidateRef | Candidate): Promise<Candidate> {
  const candidate = await input.workspaces.candidate(expected.id);
  if (!isDeepStrictEqual(candidate, persisted(expected))) throw new Error('Factory input cleanup requires the exact durable candidate.');
  for (const manifest of candidateArtifacts(candidate)) await retainedArtifact(input, manifest);
  return candidate;
}
function capturedSources(candidate: Candidate, sources: readonly WorkingDirectorySource[]): void {
  const roots = candidate.workingDirectories ?? [];
  if (roots.length !== sources.length || sources.some(source => !roots.some(root =>
    root.id === source.id && root.name === source.name && root.kind === source.kind &&
    root.containerPath === source.containerPath && root.baseCommit === source.baseCommit))) {
    throw new Error('Factory input cleanup requires an exact retained capture of every additional folder.');
  }
}
async function ownedDirectory(anchor: string, directory: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const relative = path.relative(anchor, directory);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Factory input cleanup path is outside its owned root.');
  const uid = process.getuid?.(), root = await lstat(anchor);
  if (uid === undefined || root.uid !== uid || !root.isDirectory() || root.isSymbolicLink()) throw new Error('Factory input cleanup requires an owned anchor directory.');
  let current = anchor;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (entry.uid !== uid || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Factory input cleanup requires owned directories without symlink parents.');
  }
  if (await realpath(directory) !== path.join(await realpath(anchor), relative)) throw new Error('Factory input cleanup directory escaped its owned root.');
  return lstat(directory);
}
async function onlyEntries(directory: string, expected: string[]): Promise<void> {
  if (!isDeepStrictEqual((await readdir(directory)).sort(), expected.sort())) throw new Error('Factory input copy contains unrecognized files; it is retained.');
}
async function cleanBaseline(source: WorkingDirectorySource & { path: string }): Promise<void> {
  const metadata = await lstat(path.join(source.path, '.git'));
  const configuration = await lstat(path.join(source.path, '.git', 'config'));
  if (metadata.uid !== process.getuid?.() || configuration.uid !== process.getuid?.() || !metadata.isDirectory() || metadata.isSymbolicLink() || !configuration.isFile() || configuration.isSymbolicLink()) throw new Error('Factory input copy has unsafe Git metadata.');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = async (...args: string[]) => (await exec('git', ['--no-optional-locks', '-C', source.path, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args], {
    env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim();
  if ((await git('ls-files', '-v', '-z')).split('\0').filter(Boolean).some(entry => !entry.startsWith('H '))) throw new Error('Factory input copy has nonordinary Git index flags; hidden edits may exist and it is retained.');
  if (await git('rev-parse', 'HEAD') !== source.baseCommit || await git('status', '--porcelain=v1', '--untracked-files=all', '--ignored')) throw new Error('Factory input copy has local edits; it is retained.');
  if (!isDeepStrictEqual(await workingDirectoryEmptyDirectories(source.path), source.sourceArtifact.metadata?.emptyDirectories ?? [])) throw new Error('Factory input copy has changed empty directories; it is retained.');
}
async function writeReceipt(filename: string, value: unknown): Promise<void> {
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || !isDeepStrictEqual(JSON.parse(await readFile(filename, 'utf8')), persisted(value))) throw new Error('Factory cleanup receipt already contains unrecognized evidence.');
    return;
  }
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}

/** Remove only complete, clean materializations, after all ownership and evidence checks. */
async function releaseCopies(input: Inputs, operation: string, candidate: Candidate, copies: Array<{ identity: string; sources: WorkingDirectorySource[] }>, assertCurrent: () => void): Promise<void> {
  identity(operation);
  const workspaceData = path.join(input.dataDir, 'workspace-data');
  const retained = [];
  for (const copy of copies) {
    identity(copy.identity);
    const directory = path.join(workspaceData, 'working-directories', copy.identity);
    let entry;
    try { entry = await ownedDirectory(input.dataDir, directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const journalPath = path.join(directory, 'snapshots.json'), journalEntry = await lstat(journalPath);
    if (journalEntry.uid !== process.getuid?.() || !journalEntry.isFile() || journalEntry.isSymbolicLink()) throw new Error('Factory input journal is not an owned file.');
    const snapshots = await input.directoryManager.sourceSnapshots(copy.identity);
    if (!isDeepStrictEqual(snapshots.map(publicSource), copy.sources)) throw new Error('Factory input journal does not match its retained source contract.');
    capturedSources(candidate, copy.sources);
    await onlyEntries(directory, ['snapshots.json', ...(snapshots.length ? ['roots'] : [])]);
    if (snapshots.length) await onlyEntries(path.join(directory, 'roots'), snapshots.map(source => source.id));
    for (const source of snapshots) {
      await ownedDirectory(input.dataDir, source.path);
      await onlyEntries(path.dirname(source.path), ['repository']);
      await retainedArtifact(input, source.sourceArtifact);
      await cleanBaseline(source);
    }
    retained.push({ identity: copy.identity, directory, device: entry.dev, inode: entry.ino, journal: JSON.parse(await readFile(journalPath, 'utf8')) });
  }
  if (!retained.length) return;
  const receipts = path.join(workspaceData, 'worker-input-receipts');
  // Reject substituted receipt parents before writing or creating descendants.
  await ownedDirectory(input.dataDir, workspaceData);
  try { await ownedDirectory(input.dataDir, receipts); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(receipts, { mode: 0o700 }); }
  const receiptDirectory = path.join(receipts, operation);
  try { await ownedDirectory(input.dataDir, receiptDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(receiptDirectory, { mode: 0o700 }); }
  for (const copy of retained) await writeReceipt(path.join(receiptDirectory, `${copy.identity}.json`), { version: 1, operation, candidateId: candidate.id, identity: copy.identity, journal: copy.journal });
  assertCurrent();
  input.store.set('factory-worker-inputs', { id: operation, status: 'releasing', candidateId: candidate.id, identities: retained.map(copy => copy.identity), receiptDirectory, updatedAt: new Date().toISOString() });
  for (const copy of retained) {
    assertCurrent();
    const current = await ownedDirectory(input.dataDir, copy.directory);
    if (current.dev !== copy.device || current.ino !== copy.inode) throw new Error('Factory input identity changed during cleanup; its replacement is retained.');
    await rm(copy.directory, { recursive: true, force: true });
  }
  input.store.set('factory-worker-inputs', { id: operation, status: 'released', candidateId: candidate.id, identities: retained.map(copy => copy.identity), receiptDirectory, updatedAt: new Date().toISOString() });
}

/** Called by the coordinator's accepted-work release, including on remote workers. */
export async function releaseWorkerInputs(input: Inputs & {
  attemptId: string; sessions: Pick<SessionController, 'record' | 'owns' | 'needsTermination' | 'assertCanArchive' | 'withStoppedInputs'>;
  disposeWorkspace: () => Promise<void>;
}): Promise<void> {
  identity(input.attemptId);
  const worker = input.store.get<CapturedWorker>('factory-workers', input.attemptId);
  if (!worker?.sessionId || !worker.workspace || !worker.candidate || worker.status !== 'succeeded' || worker.workspace.id !== input.attemptId) throw new Error('Only a successfully captured Factory worker can release its input copies.');
  const sessionId = worker.sessionId;
  if (worker.workspace.sessionId !== sessionId) throw new Error('Factory workspace belongs to a different environment.');
  await input.sessions.withStoppedInputs(sessionId, async () => {
    const launch = input.store.get<{ id: string; workingDirectorySources?: WorkingDirectorySource[] }>('session-launch', sessionId);
    const sources = worker.workingDirectorySources ?? [];
    const assertCurrent = () => {
      const current = input.store.get<CapturedWorker>('factory-workers', input.attemptId), session = input.sessions.record(sessionId);
      if (!current || current.status !== 'succeeded' || current.sessionId !== sessionId || current.goal.id !== worker.goal.id || current.task.id !== worker.task.id
        || !isDeepStrictEqual(current.workspace, worker.workspace) || !isDeepStrictEqual(current.candidate, worker.candidate) || !isDeepStrictEqual(current.workingDirectorySources ?? [], sources)
        || session.projectId !== `workspace-${input.attemptId}` || session.status !== 'stopped' || !input.sessions.owns(sessionId) || input.sessions.needsTermination(sessionId)
        || !isDeepStrictEqual(input.store.get('session-launch', sessionId), launch)
        || input.store.list<Chat>('chats').some(chat => chat.sessionId === sessionId && ['running', 'waiting'].includes(chat.status))) throw new Error('Factory worker termination or retained input ownership is unconfirmed.');
      input.sessions.assertCanArchive(sessionId);
    };
    assertCurrent();
    if (!isDeepStrictEqual(launch?.workingDirectorySources, sources)) throw new Error('Factory worker restart sources are not durably retained.');
    const candidate = await retainedCandidate(input, worker.candidate!);
    if (candidate.workspaceId !== input.attemptId || candidate.attemptId !== input.attemptId || candidate.baseCommit !== worker.workspace!.baseCommit || candidate.goalId !== worker.goal.id || candidate.taskId !== worker.task.id) throw new Error('Factory candidate belongs to a different worker assignment.');
    capturedSources(candidate, sources);
    if (!isDeepStrictEqual(input.store.get<{ roots: Candidate['workingDirectories'] }>('session-working-directory-captures', sessionId)?.roots ?? [], candidate.workingDirectories ?? [])) throw new Error('Factory worker folder capture is not durably retained.');
    await releaseCopies(input, input.attemptId, candidate, [{ identity: input.attemptId, sources }, { identity: sessionId, sources }], assertCurrent);
    assertCurrent();
    await input.disposeWorkspace();
  });
}

/** The remote worker has acknowledged release; coordinator source copies are redundant. */
export async function releaseCoordinatorWorkerInputs(input: Inputs & { attemptId: string }): Promise<void> {
  identity(input.attemptId);
  const detail = input.store.get<AttemptDetail>('factory-attempt-details', input.attemptId);
  if (!detail?.candidate || detail.phase !== 'done') throw new Error('Coordinator inputs remain until the exact candidate has integrated.');
  const assertCurrent = () => {
    const attempt = input.store.get<Attempt>('attempts', input.attemptId), task = attempt && input.store.get<FactoryTask>('tasks', attempt.taskId);
    if (attempt?.status !== 'succeeded' || task?.status !== 'completed' || !isDeepStrictEqual(input.store.get<AttemptDetail>('factory-attempt-details', input.attemptId)?.candidate, detail.candidate)) throw new Error('Coordinator input ownership is no longer terminal.');
  };
  assertCurrent();
  const candidate = await retainedCandidate(input, detail.candidate);
  if (candidate.attemptId !== input.attemptId || candidate.workspaceId !== input.attemptId) throw new Error('Coordinator candidate belongs to a different attempt.');
  const sources = (await input.directoryManager.sourceSnapshots(input.attemptId)).map(publicSource);
  await releaseCopies(input, input.attemptId, candidate, [{ identity: input.attemptId, sources }], assertCurrent);
}

/** Goal checks have no author session; completed check release is their runtime fence. */
export async function releaseGoalCheckInputs(input: Inputs & { operation: string; candidate: Candidate; report: CheckReport }): Promise<void> {
  identity(input.operation);
  const candidate = await retainedCandidate(input, input.candidate);
  if (candidate.workspaceId !== input.operation || candidate.attemptId !== input.operation || candidate.taskId !== 'goal-check') throw new Error('Goal check inputs belong to a different operation.');
  identity(input.report.id);
  const report = JSON.parse(await readFile(path.join(input.dataDir, 'workspace-data', 'reports', `${input.report.id}.json`), 'utf8')) as CheckReport;
  if (!isDeepStrictEqual(report, persisted(input.report)) || report.candidateId !== candidate.id || report.commit !== candidate.commit || report.cleanupErrors?.length || report.commands.some(command => command.cleanupErrors?.length)) throw new Error('Goal check resource release is unconfirmed; its inputs are retained.');
  await retainedArtifact(input, report.logArtifact);
  const sources = (await input.directoryManager.sourceSnapshots(input.operation)).map(publicSource);
  await releaseCopies(input, input.operation, candidate, [{ identity: input.operation, sources }], () => {});
}
