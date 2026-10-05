import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, readlink, open } from 'node:fs/promises';
import path from 'node:path';
import type { Attempt, FactoryTask, Goal, Project, Decision } from '@enoughfactory/contracts';
import {
  FactoryCoordinator, FactoryOperationError, type FactoryWorkspacePort, type FactoryRuntimePort, type WorkspaceRef,
  type CandidateRef, type ExecutionResult, type CheckResult, type CreateGoalInput,
  type RepositoryEvidence, type EvaluationRecord,
} from '@enoughfactory/factory';
import { WorkspaceManager, ArtifactFsWorkspaceProvider, dockerCheckExecutor, type ArtifactManifest, type Candidate, type CheckReport, type WorkspaceRecord } from '@enoughfactory/workspaces';
import type { PeerManager } from '@enoughfactory/peers';
import type { TurnResult } from '@enoughfactory/agents';
import { dockerInvocation } from '@enoughfactory/runtime';
import type { DeviceApp, ApiCall } from './app.ts';
import type { ChatController } from './chats.ts';
import { exec, HttpError, now } from './util.ts';

interface WorkerRecord {
  id: string; coordinatorId: string; goal: Goal; task: FactoryTask; attempt: Attempt; project: Project;
  status: 'preparing' | 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'canceled';
  workspace?: WorkspaceRef; sessionId?: string; chatId?: string; result?: ExecutionResult;
  candidate?: CandidateRef; error?: string; updatedAt: string;
}
interface ReceivedArtifact { id: string; peerId: string; manifest: ArtifactManifest; path: string; }
interface GoalOptions { id: string; workspaceProvider: 'git' | 'artifactfs'; }
const journal = 'factory-workers';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The service owns execution and the supervisor; no open window is required. */
export async function initializeFactory(app: DeviceApp, chats: ChatController, network?: { peers: PeerManager }) {
  const checkExecutor=dockerCheckExecutor({ image:process.env.ENOUGHFACTORY_CHECK_IMAGE,dockerRuntime:app.runtime.endpoint });
  const workspaces = new WorkspaceManager({
    dataDir: path.join(app.dataDir, 'workspace-data'), deviceId: app.device.id,
    checkExecutor:context=>app.withRuntimeOperation(async signal=>{await app.ensureRuntimeReady();await app.runtime.prepareWorkspace(context.path);return checkExecutor({...context,signal:context.signal?AbortSignal.any([signal,context.signal]):signal});}),
    artifactFs: new ArtifactFsWorkspaceProvider({
      rootDirectory: path.join(app.dataDir, 'workspace-data'),
      dockerRuntime:app.runtime.endpoint,
      runtimeDirectory: process.env.ENOUGHFACTORY_RESOURCES
        ? path.join(process.env.ENOUGHFACTORY_RESOURCES, 'workspaces')
        : path.join(app.repositoryRoot, 'runtime/workspaces'),
    }),
  });
  const jobs = new Map<string, Promise<void>>();
  const captureJobs = new Map<string, Promise<CandidateRef>>();
  const verifiedArtifacts = new Map<string, { path: string; size: number; mtime: number; ctime: number }>();
  const local = (deviceId?: string) => !deviceId || deviceId === app.device.id;
  const worker = (id: string): WorkerRecord => {
    const record = app.store.get<WorkerRecord>(journal, id);
    if (!record) throw new HttpError(404, 'This device has no execution record for the attempt.');
    return record;
  };
  const patchWorker = (id: string, fields: Partial<WorkerRecord>) => {
    app.store.set(journal, { ...worker(id), ...fields, updatedAt: now() }); app.changed();
  };
  const track = (id: string, operation: () => Promise<void>) => {
    if (jobs.has(id)) return;
    const running = operation().catch(error => {
      const record = worker(id);
      if (record.status === 'canceled') return;
      const uncertain = ['RUNTIME_DISCONNECTED', 'PROTOCOL_TIMEOUT', 'PROTOCOL_ERROR', 'RUNTIME_TIMEOUT', 'CONTAINER_UNAVAILABLE'].includes(error.code);
      const result: ExecutionResult = { status: uncertain ? 'unknown' : 'failed', text: '', error: error.message, sessionId: record.sessionId, chatId: record.chatId };
      patchWorker(id, { status: uncertain ? 'unknown' : 'failed', error: error.message, result });
    }).finally(() => jobs.delete(id));
    jobs.set(id, running);
  };
  async function rpc<T>(peerId: string, method: string, route: string, body?: unknown): Promise<T> {
    if (!network) throw new Error('Device networking is not configured.');
    const response = await network.peers.request(peerId, { method, path: route, body }, 60_000);
    if (response.status >= 400) throw new Error((response.body as { error?: string })?.error || `Worker request failed (${response.status}).`);
    return response.body as T;
  }
  async function sendArtifact(peerId: string, manifest: ArtifactManifest): Promise<void> {
    if (!network) throw new Error('Device networking is not configured.');
    await network.peers.uploadArtifact(peerId, await workspaces.artifacts.path(manifest), { ...manifest });
  }
  async function importReceived(peerId: string, manifest: ArtifactManifest): Promise<void> {
    // An artifact can only be claimed by the paired sender which supplied its bytes.
    const received = app.store.get<ReceivedArtifact>('peer-artifacts', manifest.id);
    if (!received || received.peerId !== peerId || received.manifest.sha256 !== manifest.sha256 || received.manifest.size !== manifest.size)
      throw new HttpError(409, 'The source artifact has not arrived from its coordinator.');
    await workspaces.artifacts.importFile(received.path, manifest);
    rememberArtifacts(manifest);
  }
  function rememberArtifacts(...manifests: ArtifactManifest[]) {
    for (const manifest of manifests) app.store.set('artifacts', manifest); app.changed();
  }
  async function artifactPath(manifest: ArtifactManifest): Promise<string> {
    const prior = verifiedArtifacts.get(manifest.sha256);
    if (prior) {
      const current = await lstat(prior.path);
      if (current.size === prior.size && current.mtimeMs === prior.mtime && current.ctimeMs === prior.ctime) return prior.path;
      verifiedArtifacts.delete(manifest.sha256);
    }
    const filename = await workspaces.artifacts.path(manifest), current = await lstat(filename);
    if (verifiedArtifacts.size >= 256) verifiedArtifacts.delete(verifiedArtifacts.keys().next().value!);
    verifiedArtifacts.set(manifest.sha256, { path: filename, size: current.size, mtime: current.mtimeMs, ctime: current.ctimeMs });
    return filename;
  }
  async function projectConfig(project: Project): Promise<string | undefined> {
    try { return await readFile(path.join(project.path, '.envmux.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async function configureHandoff(workspace: WorkspaceRecord): Promise<void> {
    const filename = path.join(workspace.path, '.envmux.json');
    try {
      const config = envmuxConfig(await readFile(filename, 'utf8'));
      const key = Object.keys(config).find(key => key.toLowerCase() === 'git') || 'git';
      const git = config[key] && typeof config[key] === 'object' ? { ...config[key] as Record<string, unknown> } : {};
      for (const name of Object.keys(git)) if (name.toLowerCase() === 'base') delete git[name];
      git.base = 'HEAD'; config[key] = git;
      // This is the private runtime handoff config. The original project's config and Git commit remain unchanged.
      await writeFile(filename, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  function internalProject(project: Project, workspace: WorkspaceRecord, title: string): Project {
    const record = { ...project, id: `workspace-${workspace.id}`, path: workspace.path, name: title,
      deviceId: app.device.id, internal: true, sourceProjectId: project.id };
    app.store.set('projects', record); return record;
  }
  function sessionName(attemptId: string): string { return `f-${attemptId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`; }
  function sourceProvider(goal: Goal): 'git' | 'artifactfs' {
    return (goal as Goal & { workspaceProvider?: 'git' | 'artifactfs' }).workspaceProvider
      || app.store.get<GoalOptions>('factory-options', goal.id)?.workspaceProvider
      || (process.env.ENOUGHFACTORY_WORKSPACE_PROVIDER === 'artifactfs' ? 'artifactfs' : 'git');
  }
  function ref(record: WorkspaceRecord, sessionId?: string): WorkspaceRef {
    return { ...record, ...(sessionId ? { sessionId } : {}) };
  }
  function candidateRef(candidate: Candidate): CandidateRef { return { ...candidate }; }
  async function prepareLocal(record: WorkerRecord, project = record.project, previousCandidate?: CandidateRef): Promise<void> {
    return app.withRuntimeOperation(async()=>{
    await app.ensureRuntimeReady();
    const name = sessionName(record.id);
    const config = await projectConfig(project);
    let workspace = await workspaces.create({ projectPath: project.path, goalId: record.goal.id,
      taskId: record.task.id, attemptId: record.id, provider: sourceProvider(record.goal), fallbackToGit: true, sessionName: name,
      workspaceBranch: `${config ? envmuxBranchPrefix(config) : 'envmux/'}${name}` });
    if (previousCandidate) {
      const promoted = await workspaces.promotePreviousCandidate({ candidateId: previousCandidate.id, workspaceId: workspace.id });
      if (promoted.conflicts.length) app.store.set('factory-repair-input', { id: record.id, conflicts: promoted.conflicts, message: promoted.message });
      workspace = await workspaces.workspace(workspace.id);
    }
    if (worker(record.id).status === 'canceled') return;
    await configureHandoff(workspace);
    const owned = internalProject(project, workspace, record.task.title);
    const state = workspace.providerState;
    const session = await app.sessions.create(owned, name, state && typeof state.bindSource === 'string' && typeof state.stateVolume === 'string'
      ? { workspace: { bindSource: state.bindSource, stateVolume: state.stateVolume } } : undefined);
    patchWorker(record.id, { workspace: ref(workspace, session.id), sessionId: session.id });
    await app.sessions.waitReady(session.id);
    if (worker(record.id).status === 'canceled') { await app.sessions.stop(session.id); return; }
    patchWorker(record.id, { status: 'prepared' });
    });
  }
  function beginWorker(input: Omit<WorkerRecord, 'status' | 'updatedAt'>): WorkerRecord {
    const previous = app.store.get<WorkerRecord>(journal, input.id);
    if (previous) {
      if (previous.coordinatorId !== input.coordinatorId || previous.attempt.generation !== input.attempt.generation
        || previous.goal.id !== input.goal.id || previous.goal.revision !== input.goal.revision || previous.task.id !== input.task.id)
        throw new HttpError(409, 'Attempt identity is already bound to a different assignment.');
      return previous;
    }
    const record: WorkerRecord = { ...input, status: 'preparing', updatedAt: now() };
    app.store.set(journal, record); app.changed(); return record;
  }
  async function executeLocal(record: WorkerRecord, prompt: string): Promise<void> {
    if (!record.sessionId) throw new Error('The prepared attempt has no container session.');
    if (worker(record.id).status === 'canceled') return;
    await app.sessions.waitReady(record.sessionId);
    if (worker(record.id).status === 'canceled') return;
    const ownedProject = app.store.get<Project>('projects', app.sessions.record(record.sessionId).projectId);
    if (ownedProject) app.store.set('projects', { ...ownedProject, rules: record.project.rules, runtime: record.goal.runtime, approvalMode: record.goal.approvalMode });
    const chat = record.chatId ? chats.get(record.chatId) : chats.create({ sessionId: record.sessionId,
      runtime: record.goal.runtime, approvalMode: record.goal.approvalMode, title: record.task.title, attemptId: record.id });
    patchWorker(record.id, { status: 'running', chatId: chat.id });
    const attempt = app.store.get<Attempt>('attempts', record.id);
    if (attempt) app.store.set('attempts', { ...attempt, sessionId: record.sessionId, chatId: chat.id });
    const repair = app.store.get<{ id: string; conflicts: string[]; message?: string }>('factory-repair-input', record.id);
    const result = await chats.run(chat.id, repair ? `${prompt}\n\nRetained work was merged as repair input. Resolve conflict markers in these files before completing: ${repair.conflicts.join(', ')}. ${repair.message || ''}` : prompt, { attemptId: record.id, autonomous: record.goal.autonomy === 'autonomous',
      systemInstructions: `You are implementing an assigned EnoughFactory task toward this goal:\n${record.goal.objective}\n\nYou have full permissions inside this container. Enough owns the configured ${record.goal.approvalMode} policy. Make routine implementation decisions and execute the task completely. Do not stop at a plan or ask for permission already granted. Keep verification proportionate. Preserve changes and describe concrete evidence and any remaining work. The factory will independently capture, check, integrate and evaluate your result.` });
    if (worker(record.id).status === 'canceled') return;
    patchWorker(record.id, { status: 'succeeded', result: { status: 'succeeded', text: result.text, sessionId: record.sessionId, chatId: chat.id, spend: spend(result) } });
  }
  async function reconcileLocal(id: string): Promise<WorkerRecord> {
    const record = worker(id);
    if (jobs.has(id)) return record;
    if (record.status === 'running' && record.chatId) {
      if (chats.isRunning(record.chatId)) return record;
      const completed = app.store.get<{ id: string; result: TurnResult; attemptId?: string }>('chat-results', record.chatId);
      if (completed?.attemptId === record.id) {
        patchWorker(id, { status: 'succeeded', result: { status: 'succeeded', text: completed.result.text,
          chatId: record.chatId, sessionId: record.sessionId, spend: spend(completed.result) } });
      } else patchWorker(id, { status: 'unknown', error: 'The runtime disconnected before its outcome was journaled. Inspect preserved work before retiring this attempt.' });
    } else if (record.status === 'preparing') {
      if (record.sessionId && record.workspace) {
        const session = app.sessions.record(record.sessionId);
        if (session.status === 'ready') patchWorker(id, { status: 'prepared' });
        else if (session.status === 'failed') patchWorker(id, { status: 'failed', error: session.error, result: { status: 'failed', text: '', error: session.error } });
        else patchWorker(id, { status: 'unknown', error: 'Service restarted during preparation. Environment status must be reconciled.' });
      } else patchWorker(id, { status: 'unknown', error: 'Preparation was interrupted before a connected environment was recorded.' });
    }
    return worker(id);
  }
  async function waitWorker(peerId: string | undefined, attemptId: string, until: 'prepared' | 'finished'): Promise<WorkerRecord> {
    for (;;) {
      const record = local(peerId) ? await reconcileLocal(attemptId) : await rpc<WorkerRecord>(peerId!, 'GET', `/api/factory/worker/${attemptId}`);
      if (record.status === 'failed' || record.status === 'canceled' || record.status === 'unknown') return record;
      if (until === 'prepared' && ['prepared', 'running', 'succeeded'].includes(record.status)) return record;
      if (until === 'finished' && record.status === 'succeeded') return record;
      await sleep(1500);
    }
  }
  async function captureLocal(id: string): Promise<CandidateRef> {
    const record = await reconcileLocal(id);
    if (record.candidate) return record.candidate;
    if (!['succeeded', 'failed'].includes(record.status) || !record.workspace || !record.sessionId) throw new Error('Capture requires a confirmed ended execution and workspace.');
    const existing = captureJobs.get(id); if (existing) return existing;
    const operation = app.withRuntimeOperation(async () => {
      const session = app.sessions.record(record.sessionId!);
      let commit = app.store.get<{ id: string; commit: string }>('factory-capture-input', id)?.commit;
      if (session.status !== 'stopped') {
        if (record.workspace!.provider === 'git') {
          // The application owns preservation; a provider final answer need not have committed its work.
          const engine = app.sessions.get(session.id);
          const containerGit = async (...args: string[]) => {
            const invocation=dockerInvocation(app.runtime.endpoint,['exec',engine.ready.instance,'git','-c','safe.directory=*','-c','core.hooksPath=/dev/null','-C',engine.ready.workdir,...args]);
            return (await exec(invocation.command,invocation.args,{env:invocation.env,maxBuffer:16*1024*1024})).stdout.trim();
          };
          await containerGit('add', '--all');
          const staged = await containerGit('diff', '--cached', '--name-only');
          if (staged) await containerGit('-c', 'user.name=EnoughFactory', '-c', 'user.email=factory@enoughtools.com', 'commit', '-m', `Preserve EnoughFactory attempt ${id}`);
          commit = await containerGit('rev-parse', 'HEAD');
          app.store.set('factory-capture-input', { id, commit });
        }
        await app.sessions.stop(session.id);
      }
      await app.sessions.waitStopped(session.id);
      const candidate = await workspaces.capture({ workspaceId: record.workspace!.id,
        ...(record.workspace!.provider === 'git' ? { reference: commit || session.branch || `envmux/${session.name}` } : {}) });
      rememberArtifacts(candidate.bundleArtifact, candidate.diffArtifact);
      const value = candidateRef(candidate); patchWorker(id, { candidate: value }); return value;
    }).finally(() => captureJobs.delete(id));
    captureJobs.set(id, operation); return operation;
  }
  async function acceptRemoteCandidate(peerId: string, candidate: CandidateRef): Promise<void> {
    const value = candidate as unknown as Candidate;
    for (const manifest of [value.bundleArtifact, value.diffArtifact]) {
      const received = app.store.get<ReceivedArtifact>('peer-artifacts', manifest.id);
      if (!received || received.peerId !== peerId) throw new Error('Candidate bytes have not arrived from the owning worker.');
      await workspaces.artifacts.importFile(received.path, manifest);
    }
    await workspaces.acceptCandidate(value, await workspaces.artifacts.path(value.bundleArtifact), await workspaces.artifacts.path(value.diffArtifact));
    rememberArtifacts(value.bundleArtifact, value.diffArtifact);
  }
  const workspacePort: FactoryWorkspacePort = {
    async prepare({ goal, task, attempt, project, previousCandidate }) {
      if (local(attempt.deviceId)) {
        const record = beginWorker({ id: attempt.id, coordinatorId: app.device.id, goal, task, attempt, project });
        if (record.status === 'preparing') track(record.id, () => prepareLocal(record, project, previousCandidate));
      } else {
        const source = await workspaces.exportSource({ projectPath: project.path }); rememberArtifacts(source);
        await sendArtifact(attempt.deviceId, source);
        if (previousCandidate) {
          const prior = await workspaces.candidate(previousCandidate.id);
          await sendArtifact(attempt.deviceId, prior.bundleArtifact); await sendArtifact(attempt.deviceId, prior.diffArtifact);
        }
        await rpc(attempt.deviceId, 'POST', '/api/factory/worker/prepare', { goal, task, attempt,
          project: { ...project, path: '' }, source, config: await projectConfig(project), previousCandidate,
          workspaceProvider: sourceProvider(goal) });
      }
      const record = await waitWorker(attempt.deviceId, attempt.id, 'prepared');
      if (!record.workspace || !['prepared', 'running', 'succeeded'].includes(record.status)) throw new Error(record.error || 'Worker preparation did not complete.');
      return record.workspace;
    },
    async capture(workspace, { attempt }) {
      if (local(workspace.deviceId)) return captureLocal(attempt.id);
      await rpc(workspace.deviceId!, 'POST', `/api/factory/worker/${attempt.id}/capture`);
      for (;;) {
        const record = await rpc<WorkerRecord>(workspace.deviceId!, 'GET', `/api/factory/worker/${attempt.id}`);
        if (record.candidate) {
          const value = record.candidate as unknown as Candidate;
          if ([value.bundleArtifact, value.diffArtifact].every(manifest => app.store.get<ReceivedArtifact>('peer-artifacts', manifest.id)?.peerId === workspace.deviceId)) {
            await acceptRemoteCandidate(workspace.deviceId!, record.candidate); return record.candidate;
          }
        }
        if (record.error) throw new Error(record.error);
        await sleep(1500);
      }
    },
    async check(_project, candidate, commands) {
      const report = await workspaces.verify({ candidateId: candidate.id, commands }); rememberArtifacts(report.logArtifact);
      return checkResults(report, candidate.commit);
    },
    async integrate(project, candidate, input) {
      const result = await workspaces.integrate({ candidateId: candidate.id, projectPath: project.path, commands: input.checks, isCurrent: input.isCurrent });
      if (result.report) rememberArtifacts(result.report.logArtifact);
      if (result.status !== 'integrated' || !result.commit) {
        const kind = result.status === 'conflict' ? 'conflict' : result.status === 'checks-failed' ? 'checks-failed' : 'stale';
        throw new FactoryOperationError(kind, result.message || `Integration ${result.status}${result.conflicts?.length ? `: ${result.conflicts.join(', ')}` : ''}.`);
      }
      return { commit: result.commit, previousHead: result.previousCommit, candidateCommit: candidate.commit,
        checks: result.report ? checkResults(result.report, candidate.commit) : [] };
    },
    async inspect(project): Promise<RepositoryEvidence> {
      const [head, branch, status, summary, diff] = await Promise.all([
        git(project.path, 'rev-parse', 'HEAD'), git(project.path, 'branch', '--show-current'),
        git(project.path, 'status', '--porcelain'), git(project.path, 'log', '-8', '--format=%h %s'), git(project.path, 'diff', '--stat'),
      ]);
      const hash = createHash('sha256'); hash.update(head); hash.update(status);
      hash.update(await git(project.path, 'diff', 'HEAD', '--binary'));
      const untracked = await exec('git', ['-C', project.path, 'ls-files', '--others', '--exclude-standard', '-z'], { maxBuffer: 16 * 1024 * 1024 });
      for (const file of untracked.stdout.split('\0').filter(Boolean).sort()) {
        hash.update(`\0${file}\0`); const filename = path.join(project.path, file); const stat = await lstat(filename);
        if (stat.isSymbolicLink()) hash.update(await readlink(filename));
        else for await (const chunk of createReadStream(filename)) hash.update(chunk);
      }
      return { head, branch, status, summary, diff, fingerprint: hash.digest('hex') };
    },
    async reconcileIntegration(project, candidate) {
      const result = await workspaces.reconcileIntegration({ candidateId: candidate.id, projectPath: project.path });
      if (!result || result.status !== 'integrated' || !result.commit) return undefined;
      return { commit: result.commit, previousHead: result.previousCommit, candidateCommit: candidate.commit,
        checks: result.report ? checkResults(result.report, candidate.commit) : [] };
    },
    async release(workspace) {
      if (local(workspace.deviceId)) await workspaces.dispose(workspace.id);
      else await rpc(workspace.deviceId!, 'POST', `/api/factory/worker/${workspace.id}/release`);
    },
  };
  const runtime: FactoryRuntimePort = {
    async complete({ goal, role, prompt, project, signal }) {
      return app.withRuntimeOperation(async runtimeSignal=>{
      signal=signal?AbortSignal.any([signal,runtimeSignal]):runtimeSignal;
      if (signal?.aborted) throw new Error('The controller decision was revoked.');
      await app.ensureRuntimeReady();
      const operation = randomUUID();
      const workspace = await workspaces.create({ projectPath: project.path, goalId: goal.id, taskId: `control-${role}`, attemptId: operation });
      await configureHandoff(workspace);
      const owned = internalProject(project, workspace, `${goal.title} · ${role}`);
      const session = await app.sessions.create(owned, sessionName(operation));
      const record = { id: operation, goalId: goal.id, role, sessionId: session.id, status: 'starting', updatedAt: now() };
      app.store.set('factory-controller-runs', record);
      let chatId: string | undefined;
      const cancel = () => {
        if (chatId) void chats.interrupt(chatId).catch(() => {});
        else void app.sessions.stop(session.id).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (signal?.aborted) throw new Error('The controller decision was revoked.');
        await app.sessions.waitReady(session.id);
        if (signal?.aborted) throw new Error('The controller decision was revoked.');
        const chat = chats.create({ sessionId: session.id, runtime: goal.runtime, approvalMode: goal.approvalMode, title: `${goal.title} · ${role}` });
        chatId = chat.id;
        app.store.set('factory-controller-runs', { ...record, chatId: chat.id, status: 'running', updatedAt: now() });
        const result = await chats.run(chat.id, prompt, { autonomous: goal.autonomy === 'autonomous',
          systemInstructions: `You are the EnoughFactory ${role}. This container contains an isolated snapshot of the current project repository. Inspect the actual source and relevant runtime evidence to make your decision. You have full container permissions under ${goal.approvalMode} policy. Your role is to decide the next factory action; implementation belongs to assigned worker tasks. Do not modify product source as part of this decision. Return the structured JSON requested in the prompt. Goal: ${goal.objective}` });
        app.store.set('factory-controller-runs', { ...record, chatId: chat.id, status: 'completed', updatedAt: now(), result: result.text });
        return { text: result.text, chatId: chat.id, spend: spend(result) };
      } finally {
        signal?.removeEventListener('abort', cancel);
        const current = app.sessions.record(session.id);
        if (app.sessions.needsTermination(session.id)) {
          if (current.status !== 'stopping') await app.sessions.stop(session.id);
          await app.sessions.waitStopped(session.id);
        }
      }
      });
    },
    async execute({ attempt, goal, project, prompt }) {
      const currentProject = app.store.get<Project>('projects', project.id) || project;
      if (local(attempt.deviceId)) {
        const record = worker(attempt.id);
        if (record.status === 'prepared') { patchWorker(record.id, { goal, project: currentProject }); track(record.id, () => executeLocal(worker(record.id), prompt)); }
      } else await rpc(attempt.deviceId, 'POST', `/api/factory/worker/${attempt.id}/execute`, { prompt, goal, project: { ...currentProject, path: '' } });
      const record = await waitWorker(attempt.deviceId, attempt.id, 'finished');
      return record.result || { status: record.status === 'failed' ? 'failed' : 'unknown', text: '', error: record.error, sessionId: record.sessionId, chatId: record.chatId };
    },
    async reconcile(attempt) {
      const record = local(attempt.deviceId) ? await reconcileLocal(attempt.id) : await rpc<WorkerRecord>(attempt.deviceId, 'GET', `/api/factory/worker/${attempt.id}`);
      if (record.status === 'succeeded') return { status: 'succeeded', result: record.result };
      if (record.status === 'failed' || record.status === 'canceled') return { status: 'failed', result: record.result || { status: 'failed', text: '', error: record.error || 'Execution was canceled.' } };
      if (record.status === 'prepared' && record.workspace && !jobs.has(record.id)) return { status: 'prepared', workspace: record.workspace };
      return { status: record.status === 'running' && (local(attempt.deviceId) ? jobs.has(record.id) || Boolean(record.chatId && chats.isRunning(record.chatId)) : true) ? 'running' : 'unknown' };
    },
    async cancel(attempt) {
      if (local(attempt.deviceId)) await cancelLocal(attempt.id);
      else await rpc(attempt.deviceId, 'POST', `/api/factory/worker/${attempt.id}/cancel`);
    },
  };
  async function cancelLocal(id: string): Promise<void> {
    const record = worker(id); patchWorker(id, { status: 'canceled' });
    if (record.chatId) {await chats.interrupt(record.chatId);await chats.waitForIdle(record.chatId);}
    if (record.sessionId && !['stopped', 'stopping', 'failed'].includes(app.sessions.record(record.sessionId).status)) await app.sessions.stop(record.sessionId);
    const running = jobs.get(id);
    if (running) await running;
    const latest = worker(id);
    if (latest.sessionId && app.sessions.record(latest.sessionId).status !== 'stopped') {
      await app.sessions.stop(latest.sessionId); await app.sessions.waitStopped(latest.sessionId);
    }
    patchWorker(id, { result: { status: 'failed', text: '', error: 'Cancellation acknowledged by the owning service.', sessionId: record.sessionId, chatId: record.chatId } });
  }
  const coordinator = new FactoryCoordinator({ store: app.store, runtime, workspaces: workspacePort,
    deviceId: app.device.id, devices: () => app.devices, project: id => app.store.get<Project>('projects', id), onChange: () => app.changed() });

  app.extensions.push(async (call: ApiCall) => {
    const { method, url, body } = call, route = url.pathname;
    if (method === 'POST' && route === '/api/goals') {
      if (body.workspaceProvider !== undefined && !['git', 'artifactfs'].includes(String(body.workspaceProvider))) throw new HttpError(400, 'Unknown workspace provider.');
      const workspaceProvider = body.workspaceProvider === undefined
        ? process.env.ENOUGHFACTORY_WORKSPACE_PROVIDER === 'artifactfs' ? 'artifactfs' : 'git'
        : body.workspaceProvider as 'git' | 'artifactfs';
      if(workspaceProvider==='artifactfs'&&!(await app.refreshRuntime()).artifactFsSupported)throw new HttpError(400,'ArtifactFS mounting is unavailable on this owned runtime. Choose Git workspaces.');
      const input = createGoalInput(body); const goal = { ...coordinator.create(input), workspaceProvider };
      app.store.set('goals', goal);
      app.store.set<GoalOptions>('factory-options', { id: goal.id, workspaceProvider });
      return goal;
    }
    if (method === 'GET' && route === '/api/goals') return app.store.list<Goal>('goals');
    const goalRoute = route.match(/^\/api\/goals\/([^/]+)(?:\/(.+))?$/);
    if (goalRoute) {
      const goal = app.store.get<Goal>('goals', goalRoute[1]); if (!goal) throw new HttpError(404, 'Goal not found.');
      const action = goalRoute[2];
      if (method === 'GET' && !action) return { goal, tasks: app.store.list<FactoryTask>('tasks').filter(t => t.goalId === goal.id),
        attempts: app.store.list<Attempt>('attempts').filter(a => app.store.list<FactoryTask>('tasks').some(t => t.id === a.taskId && t.goalId === goal.id)),
        decisions: app.store.list<Decision>('decisions').filter(d => d.goalId === goal.id),
        evaluations: app.store.list<EvaluationRecord>('factory-evaluations').filter(e => e.goalId === goal.id),
        plan: app.store.get('factory-plans', goal.id), control: app.store.get('factory-control', goal.id) };
      if (method === 'GET' && ['decisions', 'artifacts', 'evaluations'].includes(action || '')) {
        return app.store.list<{ id: string; goalId?: string }>(action === 'evaluations' ? 'factory-evaluations' : action!).filter(item => item.goalId === goal.id);
      }
      if (method === 'POST' && action === 'pause') { coordinator.pause(goal.id); return { ok: true }; }
      if (method === 'POST' && action === 'resume') { coordinator.resume(goal.id); return { ok: true }; }
      if (method === 'POST' && action === 'cancel') { await coordinator.cancel(goal.id); return { ok: true }; }
      if (method === 'POST' && (action === 'steer' || action === 'context')) {
        await coordinator.steer(goal.id, steeringInput(body)); return { ok: true };
      }
      if (method === 'PATCH' && !action) {
        if (body.runtime !== undefined && !['codex', 'antigravity', 'claude'].includes(String(body.runtime))) throw new HttpError(400, 'Unknown runtime.');
        if (body.workspaceProvider !== undefined) {
          if (!['git', 'artifactfs'].includes(String(body.workspaceProvider))) throw new HttpError(400, 'Unknown workspace provider.');
          const workspaceProvider = body.workspaceProvider as 'git' | 'artifactfs';
          app.store.set('goals', { ...goal, workspaceProvider }); app.store.set<GoalOptions>('factory-options', { id: goal.id, workspaceProvider });
        }
        if (body.objective !== undefined || body.context !== undefined || body.criteria !== undefined) await coordinator.steer(goal.id, steeringInput(body));
        coordinator.configure(goal.id, { ...steeringInput(body), runtime: body.runtime as Goal['runtime'] | undefined, concurrency: numberOption(body.concurrency),
          maxSpend: body.maxSpend === null ? null : numberOption(body.maxSpend), maxAttempts: body.maxAttempts === null ? null : numberOption(body.maxAttempts),
          maxDurationMs: body.maxDurationMs === null ? null : numberOption(body.maxDurationMs) });
        return app.store.get('goals', goal.id);
      }
      if (method === 'POST' && action === 'plan') { coordinator.requestPlan(goal.id); return { ok: true }; }
      if (method === 'POST' && action === 'evaluate') { coordinator.requestEvaluation(goal.id); return { ok: true }; }
      if (method === 'POST' && action === 'tasks') { coordinator.selectTasks(goal.id, stringArray(body.taskIds)); return { ok: true }; }
      if (method === 'POST' && action === 'wake') { coordinator.notifyCondition(String(body.condition || 'external-condition'), goal.id); return { ok: true }; }
    }
    const taskRoute = route.match(/^\/api\/tasks\/([^/]+)\/(run|retry)$/);
    if (method === 'POST' && taskRoute) {
      const task = app.store.get<FactoryTask>('tasks', taskRoute[1]); if (!task) throw new HttpError(404, 'Task not found.');
      if (taskRoute[2] === 'retry' && task.currentAttemptId) await coordinator.retireAttempt(task.currentAttemptId);
      coordinator.selectTasks(task.goalId, [task.id]); return { ok: true };
    }
    const attemptRoute = route.match(/^\/api\/attempts\/([^/]+)\/retire$/);
    if (method === 'POST' && attemptRoute) { await coordinator.retireAttempt(attemptRoute[1]); return { ok: true }; }
    const artifactRoute = route.match(/^\/api\/artifacts\/([^/]+)(?:\/(content|chunk))?$/);
    if (method === 'GET' && artifactRoute) {
      const manifest = await workspaces.artifacts.get(artifactRoute[1]);
      if (artifactRoute[2] === 'chunk') {
        const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('size') || 49152);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > manifest.size || !Number.isSafeInteger(size) || size < 1 || size > 49152) throw new HttpError(400, 'Invalid artifact chunk.');
        const file = await open(await artifactPath(manifest), 'r');
        try {
          const buffer = Buffer.alloc(Math.min(size, manifest.size - offset)); const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          return { offset, data: buffer.subarray(0, bytesRead).toString('base64'), total: manifest.size };
        } finally { await file.close(); }
      }
      if (route.endsWith('/content')) {
        if (manifest.size > 2 * 1024 * 1024) throw new HttpError(413, 'Download this artifact through the device transfer instead.');
        return { manifest, content: (await workspaces.artifacts.read(manifest)).toString('base64'), encoding: 'base64' };
      }
      return manifest;
    }
    if (!route.startsWith('/api/factory/worker/')) return undefined;
    const peerId = (call as ApiCall & { peerId?: string }).peerId;
    if (!peerId) throw new HttpError(403, 'Factory worker commands require a paired coordinator connection.');
    if (method === 'POST' && route === '/api/factory/worker/prepare') {
      app.assertRuntimeCanRun();
      const goal = body.goal as Goal, task = body.task as FactoryTask, attempt = body.attempt as Attempt, project = body.project as Project;
      if (!goal || !task || !attempt || !project || attempt.deviceId !== app.device.id || task.goalId !== goal.id || attempt.taskId !== task.id || goal.coordinatorId !== peerId)
        throw new HttpError(400, 'The worker assignment does not match its coordinator, task and device.');
      for (const value of [attempt.id, task.id, goal.id]) if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new HttpError(400, 'Invalid factory identity.');
      const source = body.source as ArtifactManifest; await importReceived(peerId, source);
      const previousCandidate = body.previousCandidate as CandidateRef | undefined;
      if (previousCandidate) await acceptRemoteCandidate(peerId, previousCandidate);
      app.assertRuntimeCanRun();
      const record = beginWorker({ id: attempt.id, coordinatorId: peerId, goal, task, attempt, project });
      app.store.set<GoalOptions>('factory-options', { id: goal.id, workspaceProvider: body.workspaceProvider === 'artifactfs' ? 'artifactfs' : 'git' });
      if (record.status === 'preparing') track(record.id, async () => {
        const sourcePath = path.join(app.dataDir, 'worker-source', record.id);
        await mkdir(path.dirname(sourcePath), { recursive: true });
        try { await git(sourcePath, 'rev-parse', 'HEAD'); }
        catch { await workspaces.importSource({ artifact: source, targetPath: sourcePath }); }
        if (typeof body.config === 'string') await writeFile(path.join(sourcePath, '.envmux.json'), body.config, { mode: 0o600 });
        await prepareLocal(record, { ...project, path: sourcePath, deviceId: app.device.id }, previousCandidate);
      });
      return worker(record.id);
    }
    const workerRoute = route.match(/^\/api\/factory\/worker\/([^/]+)(?:\/(.+))?$/);
    if (!workerRoute) return undefined;
    const record = worker(workerRoute[1]);
    if (record.coordinatorId !== peerId) throw new HttpError(403, 'Only the assigned coordinator can control this attempt.');
    const action = workerRoute[2];
    if (method === 'GET' && !action) return reconcileLocal(record.id);
    if (method === 'POST' && action === 'execute') {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HttpError(400, 'Execution needs its task instructions.');
      if (record.status === 'prepared') {
        const goal = body.goal as Goal;
        if (!goal || goal.id !== record.goal.id || goal.revision !== record.goal.revision || goal.coordinatorId !== peerId) throw new HttpError(409, 'Execution policy belongs to a different goal assignment.');
        const project = body.project as Project;
        if (!project || project.id !== record.project.id || !Array.isArray(project.rules)) throw new HttpError(409, 'Execution rules belong to a different project.');
        patchWorker(record.id, { goal, project }); track(record.id, () => executeLocal(worker(record.id), body.prompt as string));
      }
      else if (!['running', 'succeeded', 'failed', 'unknown', 'canceled'].includes(record.status)) throw new HttpError(409, 'The worker is not prepared.');
      return worker(record.id);
    }
    if (method === 'POST' && action === 'cancel') { await cancelLocal(record.id); return { ok: true }; }
    if (method === 'POST' && action === 'capture') {
      patchWorker(record.id, { error: undefined });
      track(`capture-${record.id}`, async () => {
        try {
          const candidate = await captureLocal(record.id) as unknown as Candidate;
          await sendArtifact(peerId, candidate.bundleArtifact); await sendArtifact(peerId, candidate.diffArtifact);
          patchWorker(record.id, { error: undefined });
        } catch (error) { patchWorker(record.id, { error: (error as Error).message }); }
      });
      return { ok: true };
    }
    if (method === 'POST' && action === 'release') {
      if (record.workspace) await workspaces.dispose(record.workspace.id); return { ok: true };
    }
    return undefined;
  });
  app.runtimeStopHooks.unshift(async()=>{
    for(const goal of app.store.list<Goal>('goals').filter(goal=>goal.coordinatorId===app.device.id&&!['completed','canceled','failed'].includes(goal.status)))coordinator.pause(goal.id);
    for(const record of app.store.list<WorkerRecord>(journal).filter(record=>record.attempt.deviceId===app.device.id&&['preparing','prepared','running','unknown'].includes(record.status))){
      const attempt=app.store.get<Attempt>('attempts',record.id);
      if(attempt&&attempt.status!=='retired')await coordinator.retireAttempt(record.id);else await cancelLocal(record.id);
    }
  });
  app.closers.unshift(() => coordinator.stop());
  await coordinator.start();
  return { coordinator, workspaces, runtime, workspacePort };
}

/** Envmux accepts JSON comments and trailing commas; preserve quoted URLs and escaped strings. */
function envmuxBranchPrefix(text: string): string {
  const value = envmuxConfig(text);
  const gitConfig = Object.entries(value).find(([key]) => key.toLowerCase() === 'git')?.[1];
  const prefix = gitConfig && typeof gitConfig === 'object' ? Object.entries(gitConfig).find(([key]) => key.toLowerCase() === 'branchprefix')?.[1] : undefined;
  return typeof prefix === 'string' && prefix.trim() ? prefix.trim() : 'envmux/';
}
function envmuxConfig(text: string): Record<string, unknown> {
  let cleaned = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      cleaned += c;
      if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; cleaned += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; cleaned += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; cleaned += ' '; }
    else cleaned += c;
  }
  let normalized = ''; quoted = false; escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (!quoted && c === ',') { let next = i + 1; while (/\s/.test(cleaned[next] || '') && next < cleaned.length) next++; if (cleaned[next] === '}' || cleaned[next] === ']') continue; }
    normalized += c;
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
  }
  const value = JSON.parse(normalized) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The envmux configuration must be an object.');
  return value;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await exec('git', ['-C', repository, ...args], { maxBuffer: 16 * 1024 * 1024 }); return result.stdout.trim();
}
function spend(result: TurnResult): number | undefined {
  const cost = result.usage?.costUsd ?? result.usage?.cost_usd ?? result.usage?.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}
function checkResults(report: CheckReport, candidateCommit: string): CheckResult[] {
  const results = report.commands.map(command => ({ command: command.command, passed: command.exitCode === 0 && !command.timedOut,
    output: `${command.stdout}${command.stderr}`, exitCode: command.exitCode, candidateCommit, checkedCommit: report.commit }));
  if (['failed', 'canceled'].includes(report.status) && results.every(result => result.passed)) {
    results.push({ command: 'Repository integrity after checks', passed: false, output: 'Checks changed the tracked candidate or were canceled.', exitCode: 1, candidateCommit, checkedCommit: report.commit });
  }
  return results;
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new HttpError(400, 'Expected a list of text values.'); return value;
}
function createGoalInput(body: Record<string, unknown>): CreateGoalInput {
  if (typeof body.projectId !== 'string' || typeof body.objective !== 'string') throw new HttpError(400, 'Choose a project and write its goal.');
  if (body.runtime !== undefined && !['codex', 'antigravity', 'claude'].includes(String(body.runtime))) throw new HttpError(400, 'Unknown runtime.');
  const controls = steeringInput(body);
  return { projectId: body.projectId, objective: body.objective, title: typeof body.title === 'string' ? body.title : undefined,
    criteria: controls.criteria, autonomy: controls.autonomy, approvalMode: controls.approvalMode,
    runtime: body.runtime as Goal['runtime'] | undefined,
    concurrency: numberOption(body.concurrency), maxSpend: numberOption(body.maxSpend), maxAttempts: numberOption(body.maxAttempts), maxDurationMs: numberOption(body.maxDurationMs) };
}
function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, 'Budgets and concurrency must be numbers.'); return value;
}
function steeringInput(body: Record<string, unknown>) {
  if (body.autonomy !== undefined && !['manual', 'assisted', 'autonomous'].includes(String(body.autonomy))) throw new HttpError(400, 'Unknown autonomy mode.');
  if (body.approvalMode !== undefined && !['approve-all', 'rules', 'manual'].includes(String(body.approvalMode))) throw new HttpError(400, 'Unknown approval policy.');
  return { objective: typeof body.objective === 'string' ? body.objective : undefined,
    context: typeof body.context === 'string' ? body.context : undefined,
    criteria: body.criteria === undefined ? undefined : stringArray(body.criteria),
    autonomy: body.autonomy as Goal['autonomy'] | undefined, approvalMode: body.approvalMode as Goal['approvalMode'] | undefined };
}
