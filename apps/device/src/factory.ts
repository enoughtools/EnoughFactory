import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, readlink, open } from 'node:fs/promises';
import path from 'node:path';
import type { Attempt, FactoryTask, Goal, Project, Decision, ControllerRun, ContainerRuntimeStatus, DevelopmentToolchain, DevelopmentToolchainId } from '@enoughfactory/contracts';
import {
  FactoryCoordinator, FactoryOperationError, type FactoryWorkspacePort, type FactoryRuntimePort, type WorkspaceRef,
  type CandidateRef, type ExecutionResult, type CheckResult, type CreateGoalInput,
  type RepositoryEvidence, type EvaluationRecord, type ControlRecord, type TaskDetail, type AttemptDetail,
} from '@enoughfactory/factory';
import { WorkspaceManager, ArtifactFsWorkspaceProvider, dockerCheckExecutor, appleCheckExecutor, isAppleCheckCommand, appleCheckArtifacts, fingerprintWorkingDirectories, type WorkingDirectorySource, type WorkingDirectoryCapture, type ArtifactManifest, type Candidate, type CheckReport, type WorkspaceRecord } from '@enoughfactory/workspaces';
import type { PeerManager } from '@enoughfactory/peers';
import type { TurnResult } from '@enoughfactory/agents';
import { dockerInvocation, SWIFT_TOOLCHAIN, validatePreparedToolchain } from '@enoughfactory/runtime';
import type { DeviceApp, ApiCall } from './app.ts';
import type { ChatController } from './chats.ts';
import type { SessionController } from './sessions.ts';
import { exec, HttpError, now } from './util.ts';
import { inspectAttempt, inspectGoal, inspectTask, taskControlReason, taskDispatchBlocker } from './task-inspection.ts';
import { factoryChatBinding } from './factory-chat.ts';
import { controllerError } from './factory-controller-error.ts';
import { prepareControllerContext } from './controller-context.ts';
import { developmentToolchainChoice, parseDevelopmentToolchain, prepareDevelopmentToolchain, type FrozenDevelopmentToolchain } from './development-toolchain.ts';
import { retainManualContinuation, type ManualContinuationInput } from './manual-continuation-retention.ts';

interface WorkerRecord {
  id: string; coordinatorId: string; goal: Goal; task: FactoryTask; attempt: Attempt; project: Project;
  status: 'preparing' | 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'canceled';
  workspace?: WorkspaceRef; sessionId?: string; chatId?: string; result?: ExecutionResult;
  candidate?: CandidateRef; error?: string; updatedAt: string;
  cancellationAcknowledged?: boolean;
  workingDirectorySources?: WorkingDirectorySource[];
  developmentToolchain?: FrozenDevelopmentToolchain;
}
interface ReceivedArtifact { id: string; peerId: string; manifest: ArtifactManifest; path: string; }
interface GoalOptions { id: string; workspaceProvider: 'git' | 'artifactfs'; }
const journal = 'factory-workers';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function candidateArtifacts(candidate:Candidate):ArtifactManifest[]{return [candidate.bundleArtifact,candidate.diffArtifact,...(candidate.workingDirectories||[]).flatMap(root=>[root.bundleArtifact,root.diffArtifact])];}
function publicWorkerProject(project:Project):Project{return {...project,path:'',workingDirectories:project.workingDirectories?.map(root=>({...root,path:''}))};}
function assertCapturedRoots(roots:WorkingDirectoryCapture[],expected:Array<{id:string;name:string;baseCommit:string}>):void{if(roots.length!==expected.length||expected.some(source=>!roots.some(root=>root.id===source.id&&root.name===source.name&&root.baseCommit===source.baseCommit)))throw new Error('Every prepared working folder must have an exact retained capture before this attempt can be accepted.');}
export function factoryExecutionIsUncertain(error: { agentStarted?: boolean; executionEnded?: boolean; code?: string }): boolean {
  // Adapter boundary facts outrank transport codes. Only older failures lacking both
  // facts need the legacy fallback; an unacknowledged task request may have real effects.
  if (typeof error.agentStarted === 'boolean' || typeof error.executionEnded === 'boolean') return error.agentStarted !== false && error.executionEnded !== true;
  return ['RUNTIME_DISCONNECTED', 'PROTOCOL_TIMEOUT', 'PROTOCOL_ERROR', 'RUNTIME_TIMEOUT', 'CONTAINER_UNAVAILABLE'].includes(error.code ?? '');
}
export async function factoryAttemptWorkingDirectorySources(dataDir: string, sessions: Pick<SessionController, 'directoryManager' | 'workingDirectorySources'>, attemptId: string, project: Project, prior?: readonly WorkingDirectoryCapture[]): Promise<WorkingDirectorySource[]> {
  if (!prior?.length) return sessions.workingDirectorySources(attemptId, project);
  // Retain authored repair inputs by identity, including previously selected roots.
  // Current configuration contributes only new identities; it cannot silently replace
  // retained contents/names or remove a root that the previous candidate still needs.
  const sources = [];
  const retainedIds = new Set(prior.map(root => root.id));
  for (const root of prior) {
    const target = path.join(dataDir, 'workspace-data', 'working-directory-repair', attemptId, root.id);
    await sessions.directoryManager.importCapture(root, target);
    sources.push({ id: root.id, name: root.name, path: target });
  }
  sources.push(...(project.workingDirectories ?? []).filter(root => !retainedIds.has(root.id)));
  // The existing snapshot manager validates the entire union (names/IDs, paths and
  // the eight-root limit) before export, rather than truncating or renaming inputs.
  return sessions.workingDirectorySources(attemptId, { ...project, workingDirectories: sources });
}

/** The service owns execution and the supervisor; no open window is required. */
export async function initializeFactory(app: DeviceApp, chats: ChatController, network?: { peers: PeerManager }) {
  for (const run of app.store.list<ControllerRun>('factory-controller-runs')) {
    if (run.status === 'starting' || run.status === 'running') app.store.set('factory-controller-runs', { ...run, status: 'interrupted', error: 'The device service restarted before this decision completed. Its conversation and environment remain inspectable.', updatedAt: now() });
  }
  const checkExecutor=dockerCheckExecutor({ image:process.env.ENOUGHFACTORY_CHECK_IMAGE,dockerRuntime:app.runtime.endpoint });
  const workspaces: WorkspaceManager = new WorkspaceManager({
    dataDir: path.join(app.dataDir, 'workspace-data'), deviceId: app.device.id,
    checkExecutor: Object.assign((context: Parameters<typeof checkExecutor>[0]) => app.withRuntimeOperation(async signal => {
      const check = { ...context, signal: context.signal ? AbortSignal.any([signal, context.signal]) : signal };
      if (isAppleCheckCommand(context.command)) {
        const result = await appleCheckExecutor({ checksRoot: path.join(app.dataDir, 'workspace-data', 'checks'), artifacts: workspaces.artifacts })(check);
        rememberArtifacts(...appleCheckArtifacts(result));
        return result;
      }
      await app.ensureRuntimeReady();
      await app.runtime.prepareWorkspace(context.path);
      for (const root of context.workingDirectories || []) await app.runtime.prepareWorkspace(root.path);
      return checkExecutor(check);
    }), { release: checkExecutor.release }),
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
      const uncertain = factoryExecutionIsUncertain(error);
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
  function validationInstructions(): string {
    const common = 'Authoring agents and ordinary shell checks run in Linux containers, including on a Mac device. Do not claim Xcode, simulator or native build evidence from a Linux shell. Choose checks that actually match each task and its available inputs; never require later implementation files to accept earlier architecture work. Keep repository paths portable across operating systems: do not create files or directories that differ only by letter case.';
    if (process.platform !== 'darwin') return common;
    return `${common} The coordinator can run fixed Apple validation profiles on exact saved candidates. Use a check string such as enoughfactory:apple-build {"tool":"swift","package":".","action":"build"} or enoughfactory:apple-build {"tool":"xcodebuild","project":"EnoughMail.xcodeproj","scheme":"EnoughMail","platform":"macos","configuration":"Debug"}; ios-simulator is also supported. These are structured check profiles, not container shell commands. Native validation has private build output, no network, personal files, keychain, signing or simulator launch. Vendor required dependencies inside the primary repository and use portable relative paths. A passing Xcode build retains unsigned app products as artifacts. Only the recorded check result is build evidence; a profile in a plan is not proof that it passed. Credential-dependent or signed distribution checks must remain explicitly unresolved until their real inputs exist.`;
  }
  function toolchainInstructions(toolchain?:DevelopmentToolchain):string{return toolchain?`This environment has the fixed Swift ${toolchain.swiftVersion} and Node ${toolchain.nodeVersion} toolchain. Both are available through bash -lc. Use that toolchain directly; the factory checks the saved candidate with the same pinned recipe. Native Apple validation remains a separate recorded check.`:'';}
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
  async function resolveToolchain(project:Project,signal?:AbortSignal,frozen?:FrozenDevelopmentToolchain):Promise<FrozenDevelopmentToolchain>{
    const resolved=await prepareDevelopmentToolchain(app.runtime.endpoint,project,{signal,frozen,onProgress:phase=>app.emit('toolchain-progress',{projectId:project.sourceProjectId||project.id,phase})});
    app.store.set('project-toolchains',{id:project.sourceProjectId||project.id,profile:resolved==='default'?'default':resolved.id,developmentToolchain:resolved==='default'?undefined:resolved});
    return resolved;
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
  async function sourceRootsForAttempt(attemptId:string,project:Project,previous?:CandidateRef):Promise<WorkingDirectorySource[]>{
    return factoryAttemptWorkingDirectorySources(app.dataDir,app.sessions,attemptId,project,previous?.workingDirectories as WorkingDirectoryCapture[]|undefined);
  }
  async function prepareLocal(record: WorkerRecord, project = record.project, previousCandidate?: CandidateRef): Promise<void> {
    return app.withRuntimeOperation(async signal=>{
    await app.ensureRuntimeReady();
    const developmentToolchain=await resolveToolchain(project,signal,record.developmentToolchain);
    patchWorker(record.id,{developmentToolchain});
    const name = sessionName(record.id);
    const config = await projectConfig(project);
    let workspace = await workspaces.create({ projectPath: project.path, goalId: record.goal.id,
      taskId: record.task.id, attemptId: record.id, provider: sourceProvider(record.goal), fallbackToGit: true, sessionName: name,
      workspaceBranch: `${config ? envmuxBranchPrefix(config) : 'envmux/'}${name}`,developmentToolchain:developmentToolchain==='default'?undefined:developmentToolchain });
    if (previousCandidate) {
      const promoted = await workspaces.promotePreviousCandidate({ candidateId: previousCandidate.id, workspaceId: workspace.id });
      if (promoted.conflicts.length) app.store.set('factory-repair-input', { id: record.id, conflicts: promoted.conflicts, message: promoted.message });
      workspace = await workspaces.workspace(workspace.id);
    }
    if (worker(record.id).status === 'canceled') return;
    await configureHandoff(workspace);
    const workingDirectorySources=record.workingDirectorySources||await sourceRootsForAttempt(record.id,project,previousCandidate);
    patchWorker(record.id,{workingDirectorySources});
    const owned = internalProject(project, workspace, record.task.title);
    const state = workspace.providerState;
    const session = await app.sessions.create(owned, name,{workingDirectorySources,developmentToolchain,...(state && typeof state.bindSource === 'string' && typeof state.stateVolume === 'string'
      ? { workspace: { bindSource: state.bindSource, stateVolume: state.stateVolume } } : {})});
    patchWorker(record.id, { workspace: ref(workspace, session.id), sessionId: session.id });
    await app.sessions.waitReady(session.id);
    patchWorker(record.id,{workspace:{...ref(workspace,session.id),workingDirectories:app.sessions.record(session.id).workingDirectories}});
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
      systemInstructions: `You are implementing an assigned EnoughFactory task toward this goal:\n${record.goal.objective}\n\nYou have full permissions inside this container. Enough owns the configured ${record.goal.approvalMode} policy. Make routine implementation decisions and execute the task completely. Do not stop at a plan or ask for permission already granted. Keep verification proportionate. Preserve changes and describe concrete evidence and any remaining work. The factory will independently capture, check, integrate and evaluate your result.\n\n${validationInstructions()}\n\n${toolchainInstructions(app.sessions.record(record.sessionId).developmentToolchain)}` });
    if (worker(record.id).status === 'canceled') return;
    patchWorker(record.id, { status: 'succeeded', result: { status: 'succeeded', text: result.text, sessionId: record.sessionId, chatId: chat.id, spend: spend(result) } });
  }
  async function reconcileLocal(id: string): Promise<WorkerRecord> {
    const record = worker(id);
    if (jobs.has(id)) return record;
    if ((record.status === 'running' || record.status === 'unknown') && record.chatId) {
      if (chats.isRunning(record.chatId)) {
        if (record.status === 'unknown') patchWorker(id, { status: 'running', error: undefined, result: undefined });
        return worker(id);
      }
      const completed = app.store.get<{ id: string; result: TurnResult; attemptId?: string; completedAt?: string }>('chat-results', record.chatId);
      if (completed?.attemptId === record.id) {
        patchWorker(id, { status: 'succeeded', error: undefined, result: { status: 'succeeded', text: completed.result.text,
          chatId: record.chatId, sessionId: record.sessionId, spend: spend(completed.result) } });
      } else {
        const chat = chats.get(record.chatId), binding = factoryChatBinding(app.store, chat, app.device.id);
        // Older manual continuations lost their task binding. Reuse the assignment with its
        // full prompt; an unbound response is not evidence that the assigned work finished.
        const legacyContinuation = completed && completed.attemptId === undefined && binding?.attemptId === record.id &&
          chat.status === 'idle' && completed.result.threadId && completed.result.threadId === chat.threadId &&
          completed.completedAt && Date.parse(completed.completedAt) >= Date.parse(record.attempt.startedAt) && record.workspace;
        if (legacyContinuation) {
          app.store.set('chats', { ...chat, attemptId: record.id });
          patchWorker(id, { status: 'prepared', error: undefined, result: undefined });
        } else {
          const failure = app.store.get<{ id: string; attemptId?: string; error: string; agentStarted?: boolean }>('chat-turn-failures', record.chatId);
          if (failure?.attemptId === record.id && failure.agentStarted === false) {
            patchWorker(id, { status: 'failed', error: failure.error, result: { status: 'failed', text: '', error: failure.error, chatId: record.chatId, sessionId: record.sessionId } });
          } else patchWorker(id, { status: 'unknown', error: 'The runtime disconnected before its outcome was journaled. Inspect preserved work before retiring this attempt.' });
        }
      }
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
      const workingDirectories=await app.sessions.captureWorkingDirectories(session.id);
      assertCapturedRoots(workingDirectories,(record.workspace!.workingDirectories as import('@enoughfactory/contracts').WorkingDirectoryMount[]|undefined)||app.sessions.record(session.id).workingDirectories||[]);
      const candidate = await workspaces.capture({ workspaceId: record.workspace!.id,
        workingDirectories,
        ...(record.workspace!.provider === 'git' ? { reference: commit || session.branch || `envmux/${session.name}` } : {}) });
      rememberArtifacts(candidate.bundleArtifact, candidate.diffArtifact,...workingDirectories.flatMap(root=>[root.bundleArtifact,root.diffArtifact]));
      const value = candidateRef(candidate); patchWorker(id, { candidate: value }); return value;
    }).finally(() => captureJobs.delete(id));
    captureJobs.set(id, operation); return operation;
  }
  async function acceptRemoteCandidate(peerId: string, candidate: CandidateRef): Promise<void> {
    const value = candidate as unknown as Candidate;
    for (const manifest of candidateArtifacts(value)) {
      const received = app.store.get<ReceivedArtifact>('peer-artifacts', manifest.id);
      if (!received || received.peerId !== peerId) throw new Error('Candidate bytes have not arrived from the owning worker.');
      await workspaces.artifacts.importFile(received.path, manifest);
    }
    await workspaces.acceptCandidate(value, await workspaces.artifacts.path(value.bundleArtifact), await workspaces.artifacts.path(value.diffArtifact));
    rememberArtifacts(...candidateArtifacts(value));
  }
  const workspacePort: FactoryWorkspacePort = {
    async prepare({ goal, task, attempt, project, previousCandidate }) {
      const toolchainProfile=await developmentToolchainChoice(project);
      project={...project,developmentToolchain:toolchainProfile};
      if (local(attempt.deviceId)) {
        const record = beginWorker({ id: attempt.id, coordinatorId: app.device.id, goal, task, attempt, project });
        if (record.status === 'preparing') track(record.id, () => prepareLocal(record, project, previousCandidate));
      } else {
        if(toolchainProfile!=='default'){
          const health=await rpc<{deviceId:string;capabilities?:{developmentToolchains?:Array<{id:string;recipeSha256:string}>}}>(attempt.deviceId,'GET','/api/health');
          if(health.deviceId!==attempt.deviceId||!health.capabilities?.developmentToolchains?.some(profile=>profile.id===toolchainProfile&&profile.recipeSha256===SWIFT_TOOLCHAIN.recipeSha256))throw new Error('Update the selected worker device to the same fixed Swift toolchain recipe before dispatching this task.');
        }
        if(project.workingDirectories?.length||(previousCandidate?.workingDirectories as unknown[]|undefined)?.length){const health=await rpc<{deviceId:string;capabilities?:{workingDirectories?:boolean}}>(attempt.deviceId,'GET','/api/health');if(health.deviceId!==attempt.deviceId||health.capabilities?.workingDirectories!==true)throw new Error('Update the selected worker device before using additional working folders.');}
        const source = await workspaces.exportSource({ projectPath: project.path }); rememberArtifacts(source);
        await sendArtifact(attempt.deviceId, source);
        const workingDirectorySources=await sourceRootsForAttempt(attempt.id,project,previousCandidate);
        for(const root of workingDirectorySources){rememberArtifacts(root.sourceArtifact);await sendArtifact(attempt.deviceId,root.sourceArtifact);}
        if (previousCandidate) {
          const prior = await workspaces.candidate(previousCandidate.id);
          for(const artifact of candidateArtifacts(prior))await sendArtifact(attempt.deviceId,artifact);
        }
        await rpc(attempt.deviceId, 'POST', '/api/factory/worker/prepare', { goal, task, attempt,
          project: publicWorkerProject(project), source, workingDirectorySources, config: await projectConfig(project), previousCandidate,
          workspaceProvider: sourceProvider(goal),toolchainRecipe:toolchainProfile==='default'?undefined:{id:SWIFT_TOOLCHAIN.id,recipeSha256:SWIFT_TOOLCHAIN.recipeSha256} });
      }
      const record = await waitWorker(attempt.deviceId, attempt.id, 'prepared');
      if (!record.workspace || !['prepared', 'running', 'succeeded'].includes(record.status)) throw new Error(record.error || 'Worker preparation did not complete.');
      if(toolchainProfile!=='default')validatePreparedToolchain(record.workspace.developmentToolchain);
      else if(record.workspace.developmentToolchain)throw new Error('The worker did not honor the selected default development environment.');
      const sources=local(attempt.deviceId)?worker(attempt.id).workingDirectorySources||[]:await app.sessions.directoryManager.sourceSnapshots(attempt.id);
      const mounts=record.workspace.workingDirectories as import('@enoughfactory/contracts').WorkingDirectoryMount[]|undefined;
      if(sources.length&&(!mounts||mounts.length!==sources.length||sources.some(source=>!mounts.some(root=>root.id===source.id&&root.name===source.name&&root.path===source.containerPath&&root.baseCommit===source.baseCommit&&root.kind===source.kind))))throw new Error('The worker did not confirm the exact additional working folder snapshots. No task execution was authorized.');
      return record.workspace;
    },
    async capture(workspace, { attempt }) {
      if (local(workspace.deviceId)) return captureLocal(attempt.id);
      await rpc(workspace.deviceId!, 'POST', `/api/factory/worker/${attempt.id}/capture`);
      for (;;) {
        const record = await rpc<WorkerRecord>(workspace.deviceId!, 'GET', `/api/factory/worker/${attempt.id}`);
        if (record.candidate) {
          const value = record.candidate as unknown as Candidate;
          if(JSON.stringify(value.developmentToolchain)!==JSON.stringify(workspace.developmentToolchain))throw new Error('The captured candidate does not match its prepared development toolchain.');
          assertCapturedRoots(value.workingDirectories||[],(workspace.workingDirectories as import('@enoughfactory/contracts').WorkingDirectoryMount[]|undefined)||[]);
          if (candidateArtifacts(value).every(manifest => app.store.get<ReceivedArtifact>('peer-artifacts', manifest.id)?.peerId === workspace.deviceId)) {
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
      hash.update(await fingerprintWorkingDirectories(project.workingDirectories||[]));
      const profile=await developmentToolchainChoice(project);
      const saved=app.store.get<{id:string;profile:DevelopmentToolchainId;developmentToolchain?:DevelopmentToolchain}>('project-toolchains',project.sourceProjectId||project.id);
      const developmentToolchain=profile!=='default'&&saved?.profile===profile&&saved.developmentToolchain?validatePreparedToolchain(saved.developmentToolchain):undefined;
      hash.update(JSON.stringify({profile,...(profile==='default'?{}:{recipeSha256:SWIFT_TOOLCHAIN.recipeSha256}),developmentToolchain}));
      return { head, branch, status, summary, diff, fingerprint: hash.digest('hex'),developmentToolchain };
    },
    async checkGoal(project,commands,goal){
      const developmentToolchain=await app.withRuntimeOperation(async signal=>{await app.ensureRuntimeReady();return resolveToolchain(project,signal);});
      const repository=await workspacePort.inspect(project),operation=randomUUID();
      if(repository.status.trim())throw new Error('Goal checks require a clean primary working tree so they can verify the integrated commit. Commit or preserve the remaining primary edits before evaluating.');
      const workspace=await workspaces.create({projectPath:project.path,goalId:goal.id,taskId:'goal-check',attemptId:operation,baseCommit:repository.head,developmentToolchain:developmentToolchain==='default'?undefined:developmentToolchain});
      try{
        const roots=await app.sessions.directoryManager.prepare({identity:operation,sources:project.workingDirectories||[]});
        const workingDirectories:WorkingDirectoryCapture[]=[];for(const root of roots)workingDirectories.push(await app.sessions.directoryManager.captureFromPath(root,root.path));
        const candidate=await workspaces.capture({workspaceId:workspace.id,reference:workspace.branch,workingDirectories});
        rememberArtifacts(...candidateArtifacts(candidate));
        const report=await workspaces.verify({candidateId:candidate.id,commands});rememberArtifacts(report.logArtifact);
        return {repository,checks:checkResults(report,candidate.commit)};
      }finally{await workspaces.dispose(workspace.id);}
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
      let providerInvoked = false;
      return app.withRuntimeOperation(async runtimeSignal=>{
      signal=signal?AbortSignal.any([signal,runtimeSignal]):runtimeSignal;
      if (signal?.aborted) throw new Error('The controller decision was revoked.');
      await app.ensureRuntimeReady();
      const developmentToolchain=await resolveToolchain(project,signal);
      const operation = randomUUID();
      const workspace = await workspaces.create({ projectPath: project.path, goalId: goal.id, taskId: `control-${role}`, attemptId: operation,developmentToolchain:developmentToolchain==='default'?undefined:developmentToolchain });
      await configureHandoff(workspace);
      const context = await prepareControllerContext({ operation, goalId: goal.id, role, project, store: app.store,
        workspaces, directoryManager: app.sessions.directoryManager, dataDir: app.dataDir });
      const owned = internalProject(project, workspace, `${goal.title} · ${role}`);
      const session = await app.sessions.create(owned, sessionName(operation), { workingDirectorySources: context.workingDirectorySources,developmentToolchain });
      const record: ControllerRun = { id: operation, goalId: goal.id, role, sessionId: session.id, status: 'starting', updatedAt: now() };
      app.store.set('factory-controller-runs', record);
      let chatId: string | undefined;
      let controllerFailure: unknown;
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
        providerInvoked = true;
        const result = await chats.run(chat.id, prompt, { autonomous: goal.autonomy === 'autonomous',
          systemInstructions: [`You are the EnoughFactory ${role}. This container contains an isolated snapshot of the current project repository. Inspect the actual source and relevant runtime evidence to make your decision. You have full container permissions under ${goal.approvalMode} policy. Your role is to decide the next factory action; implementation belongs to assigned worker tasks. Do not modify product source as part of this decision. Return the structured JSON requested in the prompt. Goal: ${goal.objective}`, validationInstructions(), toolchainInstructions(app.sessions.record(session.id).developmentToolchain), context.instructions].filter(Boolean).join('\n\n') });
        app.store.set('factory-controller-runs', { ...record, chatId: chat.id, status: 'completed', updatedAt: now(), result: result.text });
        return { text: result.text, chatId: chat.id, spend: spend(result) };
      } catch (error) {
        controllerFailure = error;
        app.store.set('factory-controller-runs', { ...record, chatId, status: signal?.aborted ? 'interrupted' : 'failed', error: (error as Error).message, updatedAt: now() });
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        try {
          const current = app.sessions.record(session.id);
          if (app.sessions.needsTermination(session.id)) {
            if (current.status !== 'stopping') await app.sessions.stop(session.id);
            await app.sessions.waitStopped(session.id);
          }
        } catch (error) {
          // Cleanup cannot turn a known preparation failure into an unknown provider outcome.
          app.store.set('factory-controller-cleanup', { id: operation, sessionId: session.id, error: (error as Error).message, updatedAt: now() });
          if (controllerFailure === undefined) throw error;
        }
      }
      }).catch(error => { throw controllerError(error, { providerInvoked, runtimeReady: app.diagnostics.containerRuntime?.state === 'ready' }); });
    },
    async execute({ attempt, goal, project, prompt, assignmentGoalRevision }) {
      const currentProject = app.store.get<Project>('projects', project.id) || project;
      if (local(attempt.deviceId)) {
        const record = worker(attempt.id);
        if (record.status === 'prepared') { patchWorker(record.id, { goal, project: currentProject }); track(record.id, () => executeLocal(worker(record.id), prompt)); }
      } else await rpc(attempt.deviceId, 'POST', `/api/factory/worker/${attempt.id}/execute`, {
        // A branch repair advances coordinator authority without replacing this worker's assignment.
        prompt, goal: { ...goal, revision: assignmentGoalRevision ?? goal.revision }, project: publicWorkerProject(currentProject),
      });
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
    const record = worker(id); patchWorker(id, { status: 'canceled', cancellationAcknowledged: false });
    if (record.chatId) {await chats.interrupt(record.chatId);await chats.waitForIdle(record.chatId);}
    if (record.sessionId && !['stopped', 'stopping', 'failed'].includes(app.sessions.record(record.sessionId).status)) await app.sessions.stop(record.sessionId);
    const running = jobs.get(id);
    if (running) await running;
    const latest = worker(id);
    if (latest.sessionId && app.sessions.record(latest.sessionId).status !== 'stopped') {
      await app.sessions.stop(latest.sessionId); await app.sessions.waitStopped(latest.sessionId);
    }
    patchWorker(id, { cancellationAcknowledged: true, result: { status: 'failed', text: '', error: 'Cancellation acknowledged by the owning service.', sessionId: record.sessionId, chatId: record.chatId } });
  }
  const coordinator = new FactoryCoordinator({ store: app.store, runtime, workspaces: workspacePort,
    deviceId: app.device.id, devices: () => app.devices, project: id => app.store.get<Project>('projects', id), onChange: () => app.changed() });
  const runtimeReady = (topic: string, data: unknown) => {
    if (topic !== 'runtime' || (data as ContainerRuntimeStatus).state !== 'ready') return;
    try { app.assertRuntimeCanRun(); } catch { return; }
    coordinator.notifyCondition('runtime-available');
  };
  app.listeners.add(runtimeReady);
  app.closers.push(() => { app.listeners.delete(runtimeReady); });
  if (app.diagnostics.containerRuntime?.state === 'ready') runtimeReady('runtime', app.diagnostics.containerRuntime);

  app.extensions.push(async (call: ApiCall) => {
    const { method, url, body } = call, route = url.pathname;
    if (method === 'POST' && route === '/api/goals') {
      if (body.workspaceProvider !== undefined && !['git', 'artifactfs'].includes(String(body.workspaceProvider))) throw new HttpError(400, 'Unknown workspace provider.');
      const workspaceProvider = body.workspaceProvider === undefined
        ? process.env.ENOUGHFACTORY_WORKSPACE_PROVIDER === 'artifactfs' ? 'artifactfs' : 'git'
        : body.workspaceProvider as 'git' | 'artifactfs';
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
      if (method === 'GET' && action === 'inspection') return inspectGoal(app.store, app.devices, goal);
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
    const taskInspectionRoute = route.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskInspectionRoute) {
      const task = app.store.get<FactoryTask>('tasks', taskInspectionRoute[1]); if (!task) throw new HttpError(404, 'Task not found.');
      return inspectTask(app.store, app.devices, task);
    }
    const attemptInspectionRoute = route.match(/^\/api\/attempts\/([^/]+)$/);
    if (method === 'GET' && attemptInspectionRoute) {
      const attempt = app.store.get<Attempt>('attempts', attemptInspectionRoute[1]); if (!attempt) throw new HttpError(404, 'Attempt not found.');
      return inspectAttempt(app.store, attempt);
    }
    const continuationRoute = route.match(/^\/api\/tasks\/([^/]+)\/retain-continuation$/);
    if (method === 'POST' && continuationRoute) {
      const task = app.store.get<FactoryTask>('tasks', continuationRoute[1]);
      if (!task) throw new HttpError(404, 'Task not found.');
      const turn = body.turn;
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new HttpError(400, 'Identify the exact completed manual turn.');
      const input: ManualContinuationInput = {
        goalId: task.goalId, taskId: task.id, goalRevision: body.expectedGoalRevision as number,
        attemptId: body.expectedAttemptId as string, oldCandidateId: body.expectedCandidateId as string,
        chatId: body.chatId as string, turn: turn as ManualContinuationInput['turn'],
      };
      return app.withRuntimeOperation(() => retainManualContinuation(input, {
        store: app.store, deviceId: app.device.id,
        readChatEvents(chatId) {
          const events: ReturnType<ChatController['events']> = [];
          let cursor = 0;
          for (;;) {
            const batch = chats.events(chatId, cursor);
            if (!batch.length) return events;
            events.push(...batch);
            const latest = batch[batch.length - 1]!.seq;
            if (latest <= cursor) throw new Error('Conversation event cursor did not advance.');
            cursor = latest;
          }
        },
        chatIsRunning: chatId => chats.isRunning(chatId),
        workerJobsBusy: attemptId => jobs.has(attemptId) || captureJobs.has(attemptId),
        async captureGitCommit(context) {
          const session = app.sessions.record(context.sessionId);
          if (session.status !== 'ready') throw new HttpError(409, 'Reconnect the retained environment before preserving its completed manual repair.');
          const engine = app.sessions.get(session.id);
          const containerGit = async (...args: string[]) => {
            const invocation = dockerInvocation(app.runtime.endpoint, ['exec', engine.ready.instance, 'git', '-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null', '-C', engine.ready.workdir, ...args]);
            return (await exec(invocation.command, invocation.args, { env: invocation.env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
          };
          await containerGit('add', '--all');
          if (await containerGit('diff', '--cached', '--name-only')) await containerGit('-c', 'user.name=EnoughFactory', '-c', 'user.email=factory@enoughtools.com', 'commit', '-m', `Preserve completed manual repair for EnoughFactory attempt ${context.attempt.id}`);
          return containerGit('rev-parse', 'HEAD');
        },
        captureExtras: context => app.sessions.captureWorkingDirectories(context.sessionId),
        async validateGitCommit(context, commit) {
          // An artifact-write retry must not stop an environment containing newer terminal edits.
          if (app.sessions.record(context.sessionId).status === 'stopped') return;
          const engine = app.sessions.get(context.sessionId);
          const containerGit = async (...args: string[]) => {
            const invocation = dockerInvocation(app.runtime.endpoint, ['exec', engine.ready.instance, 'git', '-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null', '-C', engine.ready.workdir, ...args]);
            return (await exec(invocation.command, invocation.args, { env: invocation.env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
          };
          if (await containerGit('rev-parse', 'HEAD') !== commit || await containerGit('status', '--porcelain')) throw new HttpError(409, 'The retained environment has newer source changes than this repair capture. It has been left running; preserve and inspect those edits before retrying this retention.', 'MANUAL_CONTINUATION_SOURCE_CHANGED');
        },
        async stopSession(context) {
          if (app.sessions.record(context.sessionId).status !== 'stopped') await app.sessions.stop(context.sessionId);
          await app.sessions.waitStopped(context.sessionId);
        },
        async capture(context, captureInput) {
          const candidate = await workspaces.capture({ workspaceId: context.workspace.id, ...captureInput });
          rememberArtifacts(...candidateArtifacts(candidate));
          return candidateRef(candidate);
        },
        onChange: () => app.changed(),
      }));
    }
    const taskRoute = route.match(/^\/api\/tasks\/([^/]+)\/(run|retry)$/);
    if (method === 'POST' && taskRoute) {
      if (body.expectedGoalRevision !== undefined && (!Number.isInteger(body.expectedGoalRevision) || Number(body.expectedGoalRevision) < 1)) throw new HttpError(400, 'Expected goal revision must be a positive integer.');
      if (body.expectedAttemptId !== undefined && body.expectedAttemptId !== null && typeof body.expectedAttemptId !== 'string') throw new HttpError(400, 'Expected attempt identity must be text or null.');
      if (body.repairInstructions !== undefined && (typeof body.repairInstructions !== 'string' || body.repairInstructions.length > 8000)) throw new HttpError(400, 'Repair instructions must be text of at most 8,000 characters.');
      const currentState = (expectedRevision: unknown) => {
        const task = app.store.get<FactoryTask>('tasks', taskRoute[1]); if (!task) throw new HttpError(404, 'Task not found.');
        const goal = app.store.get<Goal>('goals', task.goalId); if (!goal) throw new HttpError(404, 'Goal not found.');
        const control = app.store.get<ControlRecord>('factory-control', goal.id);
        const reason = taskControlReason(task, control);
        const goalAvailable = ['draft', 'running', 'waiting'].includes(goal.status) || (goal.status === 'planning' && control?.stage === 'plan' && !!control.replanTaskIds?.length);
        if (goal.coordinatorId !== app.device.id || (expectedRevision !== undefined && goal.revision !== expectedRevision) || !goalAvailable || !control || !['dispatch', 'diagnose', 'plan'].includes(control.stage) || reason) throw new HttpError(409, reason || 'The goal changed or is coordinating another action. Refresh its task before running or retrying.');
        return { task, goal, control };
      };
      const { task, goal, control } = currentState(body.expectedGoalRevision);
      let dispatchControl = control;
      const eligible = (candidate: FactoryTask, currentGoal: Goal) => {
        const blocker = taskDispatchBlocker(app.store, app.devices, candidate, currentGoal);
        if (blocker) throw new HttpError(409, blocker.reason);
      };
      if (taskRoute[2] === 'run') {
        if (!['queued', 'ready'].includes(task.status)) throw new HttpError(409, 'This task is no longer eligible to run. Refresh its current state.');
        eligible(task, goal);
      } else {
        const attempt = task.currentAttemptId ? app.store.get<Attempt>('attempts', task.currentAttemptId) : undefined;
        if (task.status !== 'failed' || (task.currentAttemptId && attempt?.status !== 'failed') || (body.expectedAttemptId !== undefined && body.expectedAttemptId !== (task.currentAttemptId ?? null))) throw new HttpError(409, 'This failed attempt has changed. Refresh its current state before retrying.');
        eligible({ ...task, status: 'queued', currentAttemptId: undefined }, goal);
        if (task.currentAttemptId) {
          const previousAttempts = app.store.list<Attempt>('attempts').filter(item => item.taskId === task.id);
          const nextGeneration = Math.max(0, ...previousAttempts.map(item => item.generation)) + 1;
          try { await coordinator.retireAttempt(task.currentAttemptId, { preserveController: true, expectedGoalRevision: goal.revision, ...(typeof body.repairInstructions === 'string' ? { repairInstructions: body.repairInstructions } : {}) }); }
          catch (error) { if (error instanceof FactoryOperationError && error.kind === 'stale') throw new HttpError(409, error.message); throw error; }
          const after = currentState(goal.revision);
          if (after.task.status !== 'queued' || after.task.currentAttemptId) {
            const successor = after.task.currentAttemptId ? app.store.get<Attempt>('attempts', after.task.currentAttemptId) : undefined;
            const successorDetail = successor ? app.store.get<AttemptDetail>('factory-attempt-details', successor.id) : undefined;
            const retired = app.store.get<Attempt>('attempts', task.currentAttemptId);
            const retirement = app.store.get<AttemptDetail>('factory-attempt-details', task.currentAttemptId);
            // Acknowledgment can wake the scheduler before retireAttempt returns. The
            // authorized retry already succeeded when its exact new generation owns
            // the task; do not select it again or overwrite its repair/controller state.
            if (successor && successor.taskId === task.id && successor.generation === nextGeneration &&
              ['running', 'review'].includes(after.task.status) && ['created', 'running', 'unknown', 'succeeded'].includes(successor.status) &&
              successorDetail?.goalId === goal.id && successorDetail.goalRevision === goal.revision && successorDetail.cancellation === 'none' &&
              retired?.status === 'retired' && retirement?.cancellation === 'acknowledged') return { ok: true };
            throw new HttpError(409, 'Coordination advanced while cancellation was acknowledged. Refresh the current attempt.');
          }
          eligible(after.task, after.goal);
          dispatchControl = after.control;
        } else {
          app.store.set('tasks', { ...task, status: 'queued', updatedAt: now() });
        }
        const detail = app.store.get<TaskDetail>('factory-task-details', task.id);
        const repairInstructions = !task.currentAttemptId && typeof body.repairInstructions === 'string' ? body.repairInstructions.trim() : detail?.repairInstructions;
        app.store.transaction(() => {
          app.store.set<TaskDetail>('factory-task-details', { ...(detail ?? { id: task.id, key: task.id, checks: [], planRevision: goal.revision, selected: true, failureSignatures: [] }), waitingFor: undefined, waitReason: undefined, repairInstructions: repairInstructions || undefined });
          if (!task.currentAttemptId && body.repairInstructions !== undefined) app.store.set<Decision>('decisions', {
            id: randomUUID(), goalId: goal.id, at: now(), kind: 'task-retry-instructions',
            text: repairInstructions ? 'The user supplied repair instructions for the next isolated task attempt.' : 'The user cleared repair instructions for the next isolated task attempt.',
            data: { taskId: task.id, previousAttemptId: task.currentAttemptId, repairInstructions },
          });
        });
      }
      coordinator.selectTasks(task.goalId, [task.id], { additive: true, preserveController: dispatchControl.stage === 'diagnose' || dispatchControl.stage === 'plan' }); return { ok: true };
    }
    const attemptRoute = route.match(/^\/api\/attempts\/([^/]+)\/retire$/);
    if (method === 'POST' && attemptRoute) {
      try { await coordinator.retireAttempt(attemptRoute[1]); }
      catch (error) { if (error instanceof FactoryOperationError && error.kind === 'stale') throw new HttpError(409, error.message); throw error; }
      return { ok: true };
    }
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
      const toolchainProfile=parseDevelopmentToolchain(project.developmentToolchain);
      if(toolchainProfile==='swift-6.0.3'){
        const recipe=body.toolchainRecipe as {id?:unknown;recipeSha256?:unknown}|undefined;
        if(recipe?.id!==SWIFT_TOOLCHAIN.id||recipe.recipeSha256!==SWIFT_TOOLCHAIN.recipeSha256)throw new HttpError(409,'The coordinator and worker must agree on the exact fixed Swift toolchain recipe.');
      }else if(body.toolchainRecipe!==undefined)throw new HttpError(400,'A toolchain recipe must match the selected development toolchain.');
      for (const value of [attempt.id, task.id, goal.id]) if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new HttpError(400, 'Invalid factory identity.');
      const source = body.source as ArtifactManifest; await importReceived(peerId, source);
      const workingDirectorySources=body.workingDirectorySources as WorkingDirectorySource[]|undefined;
      if(project.workingDirectories?.length&&!workingDirectorySources?.length)throw new HttpError(409,'The coordinator did not transfer the configured additional working folders.');
      for(const root of workingDirectorySources||[])await importReceived(peerId,root.sourceArtifact);
      const previousCandidate = body.previousCandidate as CandidateRef | undefined;
      if (previousCandidate) await acceptRemoteCandidate(peerId, previousCandidate);
      app.assertRuntimeCanRun();
      const record = beginWorker({ id: attempt.id, coordinatorId: peerId, goal, task, attempt, project, workingDirectorySources });
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
          for(const artifact of candidateArtifacts(candidate))await sendArtifact(peerId,artifact);
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
  app.serviceActivityHooks.push(()=>{
    const active=coordinator.serviceActivity(),busy:string[]=[];
    if(active.controllers||app.store.list<ControllerRun>('factory-controller-runs').some(run=>['starting','running'].includes(run.status)))busy.push('A factory controller is active.');
    if(active.attempts||active.reconciliation||active.pending||jobs.size)busy.push('Factory execution or reconciliation is active.');
    if(captureJobs.size)busy.push('Factory candidate capture is active.');
    if(app.store.list<WorkerRecord>(journal).some(worker=>worker.status==='preparing'))busy.push('A factory worker is preparing.');
    return busy;
  });
  app.serviceHandoffHooks.push(()=>coordinator.stop());
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
  const results:CheckResult[] = report.commands.map(command => ({ command: command.command, passed: command.exitCode === 0 && !command.timedOut,
    output: `${command.stdout}${command.stderr}`, exitCode: command.exitCode, candidateCommit, checkedCommit: report.commit,developmentToolchain:command.developmentToolchain }));
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
