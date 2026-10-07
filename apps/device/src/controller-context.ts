import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FactoryTask, Project } from '@enoughfactory/contracts';
import type { AttemptDetail, CandidateRef, ControlRecord, FactoryRuntimePort, FactoryStore, TaskDetail } from '@enoughfactory/factory';
import type { WorkingDirectoryManager, WorkingDirectorySnapshot, WorkingDirectorySource, WorkspaceManager } from '@enoughfactory/workspaces';
import { exec } from './util.ts';

type ControllerRole = Parameters<FactoryRuntimePort['complete']>[0]['role'];
export interface SelectedCandidate { task: FactoryTask; candidate: CandidateRef; }

/** Select the same retained work that the controller's decision prompt describes. */
export function controllerCandidates(store: FactoryStore, goalId: string, role: ControllerRole): SelectedCandidate[] {
  const control = store.get<ControlRecord>('factory-control', goalId);
  return store.list<FactoryTask>('tasks').filter(task => task.goalId === goalId && (
    role === 'diagnosis' ? task.id === control?.diagnosisTaskId :
      role === 'evaluator' ? task.status === 'completed' :
        task.status !== 'completed' && (!control?.replanTaskIds || control.replanTaskIds.includes(task.id))
  )).flatMap(task => {
    const detail = store.get<TaskDetail>('factory-task-details', task.id);
    const attempt = task.currentAttemptId ? store.get<AttemptDetail>('factory-attempt-details', task.currentAttemptId) : undefined;
    const candidate = role === 'evaluator' ? attempt?.candidate : detail?.lastCandidate ?? attempt?.candidate;
    return candidate ? [{ task, candidate }] : [];
  });
}

interface ContextManifest {
  version: 1;
  goalId: string;
  role: ControllerRole | 'worker';
  assignment?: { taskId: string; attemptId: string; generation: number; goalRevision: number };
  projectDirectories: Array<{ id: string; name: string; path: string; sourceCommit?: string; snapshotCommit: string }>;
  candidates: Array<{
    id: string; taskId: string; title: string; taskStatus: string; commit: string; baseCommit: string;
    repository?: string; sourceBundle?: string; bundleRef?: string; bundleSha256?: string; unavailable?: string;
    caseCollisions?: string[][];
    workingDirectories?: Array<{ id: string; name: string; path?: string; sourceBundle: string; bundleRef: string; commit: string; baseCommit: string; bundleSha256: string; caseCollisions?: string[][];
      emptyDirectories: Array<{ path: string; mode: number }>; emptyDirectoriesSha256: string }>;
  }>;
}

/**
 * Decision agents inspect isolated source/evidence, never a worker's live tree.
 * The current primary repository is deliberately left to the normal session handoff.
 */
export async function prepareControllerContext(input: {
  operation: string; goalId: string; role: ControllerRole | 'worker'; project: Project; store: FactoryStore;
  workspaces: WorkspaceManager; directoryManager: WorkingDirectoryManager; dataDir: string;
  selected?: SelectedCandidate[]; contextName?: string; bundlesOnly?: boolean; maxBundleBytes?: number;
  assignment?: ContextManifest['assignment']; assertCurrent?: () => void;
}): Promise<{ workingDirectorySources: WorkingDirectorySource[]; instructions: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(input.operation)) throw new Error('Invalid controller context identity.');
  input.assertCurrent?.();
  const selected = input.selected ?? (input.role === 'worker' ? [] : controllerCandidates(input.store, input.goalId, input.role));
  const roots = input.project.workingDirectories?.length
    ? await input.directoryManager.prepare({ identity: `${input.operation}-project-context`, sources: input.project.workingDirectories }) : [];
  if (!selected.length) return {
    workingDirectorySources: publicSources(roots),
    instructions: roots.length ? `Additional project folders are isolated snapshots: ${roots.map(root => `${root.name}: ${root.containerPath}`).join(', ')}. They are context, not integrated changes.` : '',
  };

  // One aggregate evidence source avoids consuming a mount for every retained task.
  input.assertCurrent?.();
  const name = uniqueName(input.contextName ?? 'factory-context', roots.map(root => root.name));
  const containerRoot = `/workspaces/${name}`;
  const staging = path.join(input.dataDir, 'workspace-data', 'controller-context', input.operation);
  const contents = path.join(staging, 'context');
  const aggregateProjectRoots = roots.length === 8;
  const manifest: ContextManifest = { version: 1, goalId: input.goalId, role: input.role, assignment: input.assignment, projectDirectories: [], candidates: [] };
  let bundleBytes = 0;
  await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  try {
    await mkdir(contents, { mode: 0o700 });
    for (const root of roots) {
      const destination = aggregateProjectRoots ? `${containerRoot}/project-directories/${root.id}` : root.containerPath;
      if (aggregateProjectRoots) await copyTree(root.path, path.join(contents, 'project-directories', root.id));
      manifest.projectDirectories.push({ id: root.id, name: root.name, path: destination, sourceCommit: root.sourceCommit, snapshotCommit: root.baseCommit });
    }
    for (const { task, candidate: reference } of selected) {
      input.assertCurrent?.();
      const entry: ContextManifest['candidates'][number] = {
        id: reference.id, taskId: task.id, title: task.title, taskStatus: task.status, commit: reference.commit, baseCommit: reference.baseCommit,
      };
      manifest.candidates.push(entry);
      try {
        const candidate = await input.workspaces.candidate(reference.id);
        if (candidate.id !== reference.id || candidate.goalId !== input.goalId || candidate.taskId !== task.id || candidate.commit !== reference.commit || candidate.baseCommit !== reference.baseCommit
          || candidate.bundleArtifact.metadata?.commit !== candidate.commit || candidate.bundleArtifact.metadata?.baseCommit !== candidate.baseCommit)
          throw new Error('Retained candidate identity does not match the controller task and exact commits.');
        const size = candidate.bundleArtifact.size + (candidate.workingDirectories ?? []).reduce((total, capture) => total + capture.bundleArtifact.size, 0);
        if (input.maxBundleBytes !== undefined && bundleBytes + size > input.maxBundleBytes) {
          entry.unavailable = 'This retained candidate exceeds the bounded reference context byte budget. No source from it was transferred.';
          continue;
        }
        bundleBytes += size;
        const relative = path.join('candidates', candidate.id);
        const candidateRoot = `${containerRoot}/candidates/${candidate.id}`;
        const bundle = await input.workspaces.artifacts.path(candidate.bundleArtifact);
        const bundleRef = String(candidate.bundleArtifact.metadata?.ref ?? '');
        const collisions = await bundleCaseCollisions(bundle, bundleRef, candidate.commit, candidate.baseCommit, path.join(staging, 'objects', candidate.id, 'primary.git'));
        await mkdir(path.join(contents, relative), { recursive: true, mode: 0o700 });
        await copyFile(bundle, path.join(contents, relative, 'source.bundle'));
        entry.sourceBundle = `${candidateRoot}/source.bundle`;
        entry.bundleRef = bundleRef;
        entry.bundleSha256 = candidate.bundleArtifact.sha256;
        if (collisions.length) entry.caseCollisions = collisions;
        else if (!input.bundlesOnly) {
          const imported = path.join(staging, 'imports', candidate.id, 'repository');
          await input.workspaces.importSource({ artifact: candidate.bundleArtifact, targetPath: imported });
          await copyTree(imported, path.join(contents, relative, 'repository'));
          entry.repository = `${candidateRoot}/repository`;
        }
        entry.workingDirectories = [];
        for (const capture of candidate.workingDirectories ?? []) {
          if (capture.bundleArtifact.metadata?.commit !== capture.commit || capture.bundleArtifact.metadata?.baseCommit !== capture.baseCommit)
            throw new Error('Retained working-directory bundle identity does not match its exact commits.');
          const inventory = retainedDirectoryInventory(capture.bundleArtifact.metadata);
          const extraBundle = await input.workspaces.artifacts.path(capture.bundleArtifact), extraRef = String(capture.bundleArtifact.metadata?.ref ?? '');
          const extraCollisions = await bundleCaseCollisions(extraBundle, extraRef, capture.commit, capture.baseCommit, path.join(staging, 'objects', candidate.id, 'working-directories', `${capture.id}.git`));
          await mkdir(path.join(contents, relative, 'bundles'), { recursive: true, mode: 0o700 });
          await copyFile(extraBundle, path.join(contents, relative, 'bundles', `${capture.id}.bundle`));
          const extra: NonNullable<typeof entry.workingDirectories>[number] = { id: capture.id, name: capture.name,
            sourceBundle: `${candidateRoot}/bundles/${capture.id}.bundle`, bundleRef: extraRef,
            commit: capture.commit, baseCommit: capture.baseCommit, bundleSha256: capture.bundleArtifact.sha256, ...inventory };
          if (extraCollisions.length) extra.caseCollisions = extraCollisions;
          else if (!input.bundlesOnly) {
            const retained = path.join(staging, 'imports', candidate.id, 'working-directories', capture.id);
            await input.directoryManager.importCapture(capture, retained);
            await copyTree(retained, path.join(contents, relative, 'working-directories', capture.id));
            extra.path = `${candidateRoot}/working-directories/${capture.id}`;
          }
          entry.workingDirectories.push(extra);
          input.assertCurrent?.();
        }
      } catch (error) {
        // A missing cached artifact is observable missing evidence, never proof of completion.
        // Integrity/ownership errors remain hard errors rather than exposing another task's bytes.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entry.unavailable = 'Some retained candidate source is not available in the coordinator artifact cache. Only source locations actually listed here were reconstructed. Do not infer unavailable contents or completion from metadata.';
      }
      input.assertCurrent?.();
    }
    await writeFile(path.join(contents, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const evidence = await input.directoryManager.prepare({ identity: `${input.operation}-evidence-context`,
      sources: [{ id: `controller-context-${input.operation}`, name, path: contents }] });
    input.assertCurrent?.();
    const unavailable = manifest.candidates.filter(candidate => candidate.unavailable).map(candidate => `${candidate.id} (${candidate.title})`);
    const colliding = manifest.candidates.filter(candidate => candidate.caseCollisions?.length || candidate.workingDirectories?.some(root => root.caseCollisions?.length)).map(candidate => candidate.id);
    return {
      workingDirectorySources: [...(aggregateProjectRoots ? [] : publicSources(roots)), ...publicSources(evidence)],
      instructions: `${unavailable.length ? `Unavailable retained source: ${unavailable.join(', ')}. Missing evidence was not inspected and cannot prove completion; use the manifest to distinguish available trees from missing inputs. ` : ''}${colliding.length ? `Native tree reconstruction was skipped for case/Unicode-colliding Git paths in candidates: ${colliding.join(', ')}. The manifest lists the exact conflicting paths. Their verified raw bundles are available: reconstruct them in this Linux container for faithful inspection, rather than inspecting a case-folded Mac tree. ` : ''}Inspect ${containerRoot}/manifest.json for the exact retained candidate IDs, commits, source locations and project folder locations. Each sourceBundle retains the exact Git objects: in a fresh container directory use git init, git fetch <sourceBundle> <bundleRef>, then git checkout --detach <commit>. For captured extra folders, also restore each emptyDirectories entry under that checkout and apply its recorded mode; their validated inventory/hash preserves directories Git omits. Candidate trees are isolated copies of retained output, not the current integrated repository or live worker environments. Their original Git metadata is omitted; the manifest records the verified bundle identity. The main working directory remains the current project snapshot. Use candidate evidence to preserve useful work and diagnose failures, never to claim it was integrated. Changes to these ${input.role === 'worker' ? 'reference' : 'controller'} folders are not integrated or used to change a retained candidate.`,
    };
  } finally {
    // Snapshots/artifacts now own their inputs; disposable imports must not become mutable shared state.
    await rm(staging, { recursive: true, force: true });
  }
}

function publicSources(roots: WorkingDirectorySnapshot[]): WorkingDirectorySource[] {
  return roots.map(({ path: _privatePath, ...source }) => source);
}
function uniqueName(base: string, used: string[]): string {
  const names = new Set(used.map(name => name.toLowerCase()));
  let result = base, suffix = 2;
  while (names.has(result.toLowerCase())) result = `${base}-${suffix++}`;
  return result;
}
async function copyTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: filename => path.basename(filename).toLowerCase() !== '.git' });
}

/** Read exact object paths without checkout on the host's potentially case-folding filesystem. */
async function bundleCaseCollisions(bundle: string, advertisedRef: string, commit: string, baseCommit: string, repository: string): Promise<string[][]> {
  if (!/^refs\/[a-zA-Z0-9._/-]+$/.test(advertisedRef) || advertisedRef.includes('..') || advertisedRef.includes('//')) throw new Error('Retained bundle omitted a safe advertised ref.');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'init.templateDir=', ...args], { env, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })).stdout;
  await mkdir(path.dirname(repository), { recursive: true, mode: 0o700 });
  await git('init', '--bare', '--quiet', repository);
  await git('-C', repository, 'fetch', '--no-tags', bundle, `${advertisedRef}:refs/enoughfactory/source`);
  if ((await git('-C', repository, 'rev-parse', '--verify', 'refs/enoughfactory/source^{commit}')).trim() !== commit)
    throw new Error('Retained bundle advertised ref does not match its exact candidate commit.');
  await git('-C', repository, 'merge-base', '--is-ancestor', baseCommit, commit);
  const paths = (await git('-C', repository, 'ls-tree', '-r', '-t', '--name-only', '-z', commit)).split('\0').filter(Boolean);
  const groups = new Map<string, string[]>();
  for (const filename of paths) {
    const folded = filename.normalize('NFD').toLowerCase();
    const group = groups.get(folded) ?? []; group.push(filename); groups.set(folded, group);
  }
  return [...groups.values()].filter(group => group.length > 1);
}

/** The capture's empty-directory inventory is outside Git objects, but part of its immutable identity. */
function retainedDirectoryInventory(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.emptyDirectories, expected = metadata?.emptyDirectoriesSha256;
  const digest = (inventory: unknown) => createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
  if (value === undefined && expected === undefined) return { emptyDirectories: [], emptyDirectoriesSha256: digest([]) };
  if (!Array.isArray(value) || typeof expected !== 'string') throw new Error('Retained working directory omitted its immutable empty-directory inventory.');
  let previous = '';
  const emptyDirectories = value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid retained empty-directory inventory.');
    const { path: filename, mode } = entry as { path: string; mode: number };
    if (typeof filename !== 'string' || !filename || filename.includes('\0') || filename.includes('\\') || path.isAbsolute(filename) || /^[a-zA-Z]:/.test(filename)
      || filename.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
      || filename <= previous || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid retained empty-directory path or mode.');
    previous = filename;
    return { path: filename, mode };
  });
  if (digest(emptyDirectories) !== expected) throw new Error('Retained empty-directory inventory failed integrity verification.');
  return { emptyDirectories, emptyDirectoriesSha256: expected };
}
