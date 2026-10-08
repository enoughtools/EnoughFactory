import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, readlink, open } from 'node:fs/promises';
import path from 'node:path';
import type { Attempt, FactoryTask, Goal, Project, Decision, ControllerRun, ContainerRuntimeStatus, DevelopmentToolchain, DevelopmentToolchainId, TaskQualityRequirements } from '@enoughfactory/contracts';
import {
  FactoryCoordinator, FactoryOperationError, FactoryCapacityError, FactoryControllerError, FactoryVerificationWaitError, selectExecutionTarget, validateTaskExecution, UI_QUALITY_CHECK_COMMAND, type FactoryVerificationContext, type FactoryWorkspacePort, type FactoryRuntimePort, type WorkspaceRef,
  type CandidateRef, type ExecutionResult, type CheckResult, type CreateGoalInput,
  type RepositoryEvidence, type EvaluationRecord, type ControlRecord, type TaskDetail, type AttemptDetail, type FactoryStore, type FrozenTaskCheckInputs,
} from '@enoughfactory/factory';
import { WorkspaceManager, ArtifactFsWorkspaceProvider, dockerCheckExecutor, appleCheckExecutor, isAppleCheckCommand, appleCheckArtifacts, fingerprintWorkingDirectories, stageCapturedSource, validateCheckInputs, type WorkingDirectorySource, type WorkingDirectoryCapture, type ArtifactManifest, type Candidate, type CheckReport, type WorkspaceRecord, type AppleCheckResult } from '@enoughfactory/workspaces';
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
import { releaseControllerInputs } from './factory-controller-inputs.ts';
import { releaseCoordinatorWorkerInputs, releaseGoalCheckInputs, releaseWorkerInputs } from './factory-worker-inputs.ts';
import { releaseFactoryCodexPayload } from './factory-codex-cleanup.ts';
import { controllerCandidates, prepareControllerContext } from './controller-context.ts';
import { assertCurrentWorkerAssignment, assertWorkerContext, disposeWorkerContext, prepareWorkerContext, workerCandidates, type WorkerEvidenceContext } from './worker-context.ts';
import { developmentToolchainChoice, parseDevelopmentToolchain, prepareDevelopmentToolchain, type FrozenDevelopmentToolchain } from './development-toolchain.ts';
import { retainManualContinuation, type ManualContinuationInput } from './manual-continuation-retention.ts';
import { HostDiskAdmission, HostDiskHeadroomError, PREPARATION_HEADROOM_BYTES, preparationArtifactBytes } from './host-disk-admission.ts';
import { TerminalSessionCleanup } from './terminal-session-cleanup.ts';
import { importFactoryEnvironmentArchives } from './factory-archive-imports.ts';
import { hostCheckExecutor } from './host-checks.ts';
import { factoryQualityInstructions } from './factory-quality.ts';
import { configureTaskCheckInputs, freezeTaskCheckInputs } from './factory-check-inputs.ts';

interface WorkerRecord {
  id: string; coordinatorId: string; goal: Goal; task: FactoryTask; attempt: Attempt; project: Project;
  status: 'preparing' | 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'canceled';
  workspace?: WorkspaceRef; sessionId?: string; chatId?: string; result?: ExecutionResult;
  candidate?: CandidateRef; error?: string; updatedAt: string;
  cancellationAcknowledged?: boolean;
  workingDirectorySources?: WorkingDirectorySource[];
  referenceContext?: WorkerEvidenceContext;
  developmentToolchain?: FrozenDevelopmentToolchain;
  capacityWait?: string;
  preparationIdentity?: string;
  checkInputs?: FrozenTaskCheckInputs;
}
interface ReceivedArtifact { id: string; peerId: string; manifest: ArtifactManifest; path: string; }
interface GoalOptions { id: string; workspaceProvider: 'git' | 'artifactfs'; }
const journal = 'factory-workers';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function candidateArtifacts(candidate:Candidate):ArtifactManifest[]{return [candidate.bundleArtifact,candidate.diffArtifact,...(candidate.workingDirectories||[]).flatMap(root=>[root.bundleArtifact,root.diffArtifact])];}
function preparationArtifacts(candidates: CandidateRef[]): ArtifactManifest[] {
  return candidates.flatMap(value => {
    const candidate = value as unknown as Partial<Candidate>;
    return [candidate.bundleArtifact, ...(candidate.workingDirectories || []).map(root => root.bundleArtifact)]
      .filter((artifact): artifact is ArtifactManifest => !!artifact);
  });
}
function publicWorkerProject(project:Project):Project{return {...project,path:'',workingDirectories:project.workingDirectories?.map(root=>({...root,path:''}))};}
function assertCapturedRoots(roots:WorkingDirectoryCapture[],expected:Array<{id:string;name:string;baseCommit:string}>):void{if(roots.length!==expected.length||expected.some(source=>!roots.some(root=>root.id===source.id&&root.name===source.name&&root.baseCommit===source.baseCommit)))throw new Error('Every prepared working folder must have an exact retained capture before this attempt can be accepted.');}
export function factoryExecutionIsUncertain(error: { agentStarted?: boolean; executionEnded?: boolean; code?: string }): boolean {
  // Adapter boundary facts outrank transport codes. Only older failures lacking both
  // facts need the legacy fallback; an unacknowledged task request may have real effects.
  if (typeof error.agentStarted === 'boolean' || typeof error.executionEnded === 'boolean') return error.agentStarted !== false && error.executionEnded !== true;
  return ['RUNTIME_DISCONNECTED', 'PROTOCOL_TIMEOUT', 'PROTOCOL_ERROR', 'RUNTIME_TIMEOUT', 'CONTAINER_UNAVAILABLE'].includes(error.code ?? '');
}
/** A retry observes the original transfer, including its exact bundle ref and config. */
export async function factoryAttemptTransferSource(store: FactoryStore, attemptId: string,
  exportSource: () => Promise<ArtifactManifest>, config: () => Promise<string | undefined>): Promise<{ source: ArtifactManifest; config?: string }> {
  const frozen = store.get<{ id: string; source: ArtifactManifest; config?: string }>('factory-worker-source', attemptId);
  if (frozen) return frozen;
  const record = { id: attemptId, source: await exportSource(), config: await config() };
  store.set('factory-worker-source', record);
  return record;
}
export async function factoryAttemptWorkingDirectorySources(dataDir: string, sessions: Pick<SessionController, 'directoryManager' | 'workingDirectorySources'>, attemptId: string, project: Project, prior?: readonly WorkingDirectoryCapture[], refreshIds: readonly string[] = []): Promise<WorkingDirectorySource[]> {
  if (refreshIds.some(id => !project.workingDirectories?.some(root => root.id === id))) throw new Error('A selected check-input folder is no longer configured for this project.');
  if (!prior?.length) return sessions.workingDirectorySources(attemptId, project);
  // Retain authored repair inputs by identity, including previously selected roots.
  // Current configuration contributes only new identities; it cannot silently replace
  // retained contents/names or remove a root that the previous candidate still needs.
  const sources = [];
  const retainedIds = new Set(prior.filter(root => !refreshIds.includes(root.id)).map(root => root.id));
  for (const root of prior) {
    if (refreshIds.includes(root.id)) continue;
    const target = path.join(dataDir, 'workspace-data', 'working-directory-repair', attemptId, root.id);
    await sessions.directoryManager.importCapture(root, target);
    sources.push({ id: root.id, name: root.name, path: target });
  }
  sources.push(...(project.workingDirectories ?? []).filter(root => !retainedIds.has(root.id)));
  // The existing snapshot manager validates the entire union (names/IDs, paths and
  // the eight-root limit) before export, rather than truncating or renaming inputs.
  return sessions.workingDirectorySources(attemptId, { ...project, workingDirectories: sources });
}

interface ControllerReviewContinuation {id:string;goalId:string;goalRevision:number;runtime:Goal['runtime'];execution:string;sessionId:string;chatId:string;repository:RepositoryEvidence;resultText:string;systemInstructions:string;status:'waiting';reason?:string;updatedAt:string}

/** The service owns execution and the supervisor; no open window is required. */
export interface FactoryInspectionPorts {
  reviewController?: (input:{goal:Goal;run:ControllerRun;resultText:string;signal?:AbortSignal})=>Promise<{ready:boolean;reason?:string;evidenceIds:string[]}>;
  qualityCheck?: (input:FactoryVerificationContext & {candidate:Candidate;quality:TaskQualityRequirements;path:string;workingDirectories?:Array<{path:string;containerPath:string;commit:string}>;checkedCommit:string;signal?:AbortSignal})=>Promise<CheckResult>;
}
export async function initializeFactory(app: DeviceApp, chats: ChatController, network?: { peers: PeerManager }, inspection:FactoryInspectionPorts={}) {
  const hostDisk = new HostDiskAdmission(() => [app.dataDir, ...(app.diagnostics.containerRuntime?.dataDirectory ? [app.diagnostics.containerRuntime.dataDirectory] : [])], () => app.device.name);
  function reserveDisk(identity: string, bytes = 0): () => void {
    try { return hostDisk.reserve(identity, bytes); }
    catch (error) { if (error instanceof HostDiskHeadroomError) throw new FactoryCapacityError(error.message, { cause: error }); throw error; }
  }
  async function withCheckCapacity<T>(operation: () => Promise<T>, candidate?: CandidateRef): Promise<T> {
    const release = reserveDisk(`check:${randomUUID()}`, preparationArtifactBytes(preparationArtifacts(candidate ? [candidate] : [])));
    try { return await operation(); } finally { release(); }
  }
  function workerPreparationBytes(goal: Goal, task: FactoryTask, attempt: Pick<Attempt, 'id'>, previousCandidate?: CandidateRef): number {
    const references = workerCandidates(app.store, goal, task, attempt).selected.map(item => item.candidate);
    return preparationArtifactBytes(preparationArtifacts([...references, ...(previousCandidate ? [previousCandidate] : [])]));
  }
  function admission(goal: Goal) {
    const stage = app.store.get<ControlRecord>('factory-control', goal.id)?.stage;
    const role = stage === 'plan' ? 'planner' : stage === 'evaluate' ? 'evaluator' : stage === 'diagnose' ? 'diagnosis' : undefined;
    // Before an attempt exists, use current task contracts rather than an older
    // attempt's frozen assignment. Larger ready tasks conservatively set the floor.
    const bytes = role ? preparationArtifactBytes(preparationArtifacts(controllerCandidates(app.store, goal.id, role).map(item => item.candidate)))
      : Math.max(0, ...app.store.list<FactoryTask>('tasks').filter(task => task.goalId === goal.id && ['queued', 'ready'].includes(task.status))
        .map(task => workerPreparationBytes(goal, task, { id: '' }, app.store.get<TaskDetail>('factory-task-details', task.id)?.lastCandidate)));
    return hostDisk.blocker(PREPARATION_HEADROOM_BYTES + bytes * 2);
  }
  app.sessions.afterCaptureBeforeStop.push(sessionId => releaseFactoryCodexPayload({ store: app.store, sessions: app.sessions, chats, manager: chats.manager }, sessionId));
  for (const run of app.store.list<ControllerRun>('factory-controller-runs')) {
    const review=app.store.get<ControllerReviewContinuation>('factory-controller-reviews',run.id);
    if(review?.status==='waiting'&&run.status==='running') { app.store.set('factory-controller-runs',{...run,status:'waiting',updatedAt:now()}); continue; }
    if (run.status === 'starting' || run.status === 'running') app.store.set('factory-controller-runs', { ...run, status: 'interrupted', error: 'The device service restarted before this decision completed. Its conversation and environment remain inspectable.', updatedAt: now() });
  }
  const checkExecutor=dockerCheckExecutor({ image:process.env.ENOUGHFACTORY_CHECK_IMAGE,dockerRuntime:app.runtime.endpoint });
  const hostChecks=hostCheckExecutor({checksRoot:path.join(app.dataDir,'workspace-data','checks'),integrationRoot:path.join(app.dataDir,'workspace-data','integration')});
  const workspaces: WorkspaceManager = new WorkspaceManager({
    dataDir: path.join(app.dataDir, 'workspace-data'), deviceId: app.device.id,
    checkExecutor: Object.assign((context: Parameters<typeof checkExecutor>[0]) => {
      if(context.command===UI_QUALITY_CHECK_COMMAND)return app.withServiceOperation(async serviceSignal=>{
        const signal=context.signal?AbortSignal.any([serviceSignal,context.signal]):serviceSignal;if(signal.aborted)throw new Error('UI quality verification was canceled.');
        const startedAt=now(),verification=context.verification as FactoryVerificationContext|undefined;
        const result:CheckResult=verification?.quality&&inspection.qualityCheck
          ?await inspection.qualityCheck({...verification,quality:verification.quality,candidate:context.candidate,path:context.path,workingDirectories:context.workingDirectories,checkedCommit:context.commit,signal})
          :{command:UI_QUALITY_CHECK_COMMAND,passed:false,output:'UI quality policy requires the configured inspection service and the frozen attempt verification context.',exitCode:1,candidateCommit:context.candidate.commit,checkedCommit:context.commit};
        if(result.command!==UI_QUALITY_CHECK_COMMAND||result.candidateCommit!==context.candidate.commit||result.checkedCommit!==context.commit)throw new Error('UI quality evidence does not identify the exact candidate and checked source.');
        return {command:context.command,exitCode:result.passed?0:1,stdout:result.output||'',stderr:'',startedAt,endedAt:now(),factoryQuality:result};
      });
      if(isAppleCheckCommand(context.command))return app.withServiceOperation(async signal=>{
        const result=await appleCheckExecutor({checksRoot:path.join(app.dataDir,'workspace-data',path.dirname(context.path)===path.join(app.dataDir,'workspace-data','integration')?'integration':'checks'),artifacts:workspaces.artifacts})({...context,signal:context.signal?AbortSignal.any([signal,context.signal]):signal});
        rememberArtifacts(...appleCheckArtifacts(result));return result;
      });
      if(context.executionTargetKind==='host-macos')return app.withServiceOperation(signal=>hostChecks({...context,signal:context.signal?AbortSignal.any([signal,context.signal]):signal}));
      return app.withRuntimeOperation(async signal=>{
        const check={...context,signal:context.signal?AbortSignal.any([signal,context.signal]):signal};
        await app.ensureRuntimeReady();await app.runtime.prepareWorkspace(context.path);
        for(const root of context.workingDirectories||[])await app.runtime.prepareWorkspace(root.path);
        return checkExecutor(check);
      });
    }, { release: async(checkPath:string)=>{await hostChecks.release?.(checkPath);await checkExecutor.release?.(checkPath);} }),
    artifactFs: new ArtifactFsWorkspaceProvider({
      rootDirectory: path.join(app.dataDir, 'workspace-data'),
      dockerRuntime:app.runtime.endpoint,
      runtimeDirectory: process.env.ENOUGHFACTORY_RESOURCES
        ? path.join(process.env.ENOUGHFACTORY_RESOURCES, 'workspaces')
        : path.join(app.repositoryRoot, 'runtime/workspaces'),
    }),
  });
  const jobs = new Map<string, { phase: 'preparing' | 'executing' | 'capturing'; done: Promise<void> }>();
  const captureJobs = new Map<string, Promise<CandidateRef>>();
  const activeControllerOperations = new Set<string>();
  let terminalCleanup:TerminalSessionCleanup|undefined;
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
  const track = (id: string, phase: 'preparing' | 'executing' | 'capturing', operation: () => Promise<void>) => {
    if (jobs.has(id)) return;
    // Register ownership before invoking the operation, including its final cleanup.
    const running = Promise.resolve().then(operation).catch(error => {
      const record = worker(id);
      if (record.status === 'canceled') return;
      if (error instanceof HostDiskHeadroomError && (phase === 'preparing' || phase === 'executing')) {
        patchWorker(id, { status: phase === 'executing' ? 'prepared' : 'preparing', capacityWait: error.message, error: undefined,
          result: { status: 'waiting', text: '', agentStarted: false, waitReason: error.message, wakeCondition: 'host-disk-space', sessionId: record.sessionId, chatId: record.chatId } });
        return;
      }
      const uncertain = factoryExecutionIsUncertain(error);
      const result: ExecutionResult = { status: uncertain ? 'unknown' : 'failed', text: '', error: error.message, sessionId: record.sessionId, chatId: record.chatId };
      patchWorker(id, { status: uncertain ? 'unknown' : 'failed', error: error.message, result });
    }).finally(() => { if (jobs.get(id)?.done === running) jobs.delete(id); });
    jobs.set(id, { phase, done: running });
  };
  async function rpc<T>(peerId: string, method: string, route: string, body?: unknown): Promise<T> {
    if (!network) throw new Error('Device networking is not configured.');
    const response = await network.peers.request(peerId, { method, path: route, body }, 60_000);
    if (response.status >= 400 && (response.body as { code?: string })?.code === 'HOST_DISK_HEADROOM') throw new FactoryCapacityError((response.body as { error?: string })?.error || 'The worker is waiting for host disk space.');
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
  function validationInstructions(target:'container'|'host-macos'='container'): string {
    const common = (target==='host-macos'?'This author and its ordinary checks run natively on the configured Mac host in private project snapshots. This is full same-user host access, not a container security sandbox. Use actual supplied host paths; Apple SDK commands are available only when their prerequisites are verified. Browser/native UI interaction still requires the advertised inspection tools. ':'Authoring agents and ordinary shell checks run in Linux containers, including on a Mac device. ')+ ' Keep compilation, real native UI interaction and live-service evidence distinct. Do not claim Apple execution from a Linux shell or UI success from compilation. Choose checks that actually match each task and its available inputs; never require later implementation files to accept earlier architecture work. For tasks requiring coordinator-supplied verification evidence, declare requiredCheckEnvironment in the task plan using the needed supported input names: ENOUGH_EVIDENCE_ROOT, ENOUGH_NATIVE_INDEX_SHA256, ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR, ENOUGH_ACCEPTANCE_INDEX_SHA256. This is an enforced dispatch prerequisite; prose alone does not prevent dispatch. Native UI interaction evidence must come from a capable native execution owner, separately from compilation. Keep repository paths portable across operating systems: do not create files or directories that differ only by letter case.';
    if (process.platform !== 'darwin') return common;
    return `${common} The coordinator can run fixed Apple validation profiles on exact saved candidates. Use a check string such as enoughfactory:apple-build {"tool":"swift","package":".","action":"build"} or enoughfactory:apple-build {"tool":"xcodebuild","project":"EnoughMail.xcodeproj","scheme":"EnoughMail","platform":"macos","configuration":"Debug"}; ios-simulator is also supported. These are structured check profiles, not container shell commands. Native validation has private build output, no network, personal files, keychain, signing or simulator launch. Vendor required dependencies inside the primary repository and use portable relative paths. A passing Xcode build retains unsigned app products as artifacts. Only the recorded check result is build evidence; a profile in a plan is not proof that it passed. Credential-dependent or signed distribution checks must remain explicitly unresolved until their real inputs exist.`;
  }
  function toolchainInstructions(toolchain?:DevelopmentToolchain):string{return toolchain?`This environment has the fixed Swift ${toolchain.swiftVersion} and Node ${toolchain.nodeVersion} toolchain. Both are available through bash -lc. Use that toolchain directly; the factory checks the saved candidate with the same pinned recipe. Native Apple validation remains a separate recorded check.`:'';}
  const isHostAttempt=(attempt:Pick<Attempt,'executionTargetKind'>)=>attempt.executionTargetKind==='host-macos';
  function withAttemptOperation<T>(attempt:Pick<Attempt,'executionTargetKind'>,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{return isHostAttempt(attempt)?app.withServiceOperation(operation):app.withRuntimeOperation(operation);}
  function goalAuthorizesHost(goal:Goal):boolean {
    if(goal.execution)return ['host-macos','auto'].includes(goal.execution.target??'container');
    return app.store.list<FactoryTask>('tasks').some(task=>task.goalId===goal.id&&(task.execution?.target==='host-macos'||task.execution?.requiredCapabilities?.includes('mac-shell')));
  }
  function readyHostTarget(){return app.device.executionTargets?.find(target=>target.kind==='host-macos'&&target.protocolVersion===1&&target.readiness==='ready'&&target.capabilities.some(cap=>cap.kind==='mac-shell'&&cap.readiness==='ready'));}
  function containerAvailable():boolean {
    try{app.assertRuntimeCanRun();return app.diagnostics.containerRuntime?.state==='ready';}catch{return false;}
  }
  function configuredControllerTarget(goal:Goal) {
    if(!goal.execution)return undefined;
    let containerAllowed=true;try{app.assertRuntimeCanRun();}catch{containerAllowed=false;}
    const device={...app.device,executionTargets:(app.device.executionTargets??[]).filter(target=>target.kind!=='container'||containerAllowed)};
    return selectExecutionTarget({execution:goal.execution},device,'git',goal.runtime);
  }
  function controllerHostTarget(goal:Goal) {
    if(goal.execution){const selected=configuredControllerTarget(goal);return selected?.kind==='host-macos'?selected:undefined;}
    return goal.runtime==='codex'&&goalAuthorizesHost(goal)&&!containerAvailable()?readyHostTarget():undefined;
  }
  function assertHostAssignment(attempt:Attempt,runtime:Goal['runtime'],task:FactoryTask):void{
    if(!isHostAttempt(attempt))return;const target=app.device.executionTargets?.find(item=>item.id===attempt.executionTargetId&&item.kind==='host-macos');
    if(runtime!=='codex'||process.platform!=='darwin'||!target||target.protocolVersion!==1||target.readiness!=='ready'||selectExecutionTarget(task,{...app.device,executionTargets:[target]},'git',runtime)?.id!==target.id)throw new HttpError(409,'The assigned native Mac execution target is not ready or does not support this provider.','EXECUTION_CAPABILITY_UNAVAILABLE');
  }
  function executionInstructions(text:string,sessionId:string):string{const execution=app.sessions.execution(sessionId);if(execution.kind!=='host-macos')return text;const mappings=(app.sessions.record(sessionId).workingDirectories||[]).map(root=>[`/workspaces/${root.name}`,root.path]);if(execution.referenceContainerPath&&execution.referencePath)mappings.push([execution.referenceContainerPath,execution.referencePath]);for(const[from,to]of mappings.sort((a,b)=>b[0]!.length-a[0]!.length))text=text.split(from!).join(to!);return text;}
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
  async function releaseLocalWorker(id: string): Promise<void> {
    if (jobs.has(id) || jobs.has(`capture-${id}`) || captureJobs.has(id)) throw new HttpError(409, 'Wait for the worker and its source capture to finish before releasing inputs.');
    await releaseWorkerInputs({ attemptId: id, dataDir: app.dataDir, store: app.store, sessions: app.sessions,
      directoryManager: app.sessions.directoryManager, artifacts: workspaces.artifacts, workspaces,
      retireContainer: async (sessionId,assertCurrent) => {
        const conversations=app.store.list<import('@enoughfactory/contracts').Chat>('chats').filter(chat=>chat.sessionId===sessionId);
        if(conversations.some(chat=>chats.isRunning(chat.id)))throw new HttpError(409,'Wait for the worker conversations to finish before retiring its container.');
        if(app.sessions.record(sessionId).executionTargetKind==='host-macos'){assertCurrent();await app.sessions.disposeHostWorkspace(sessionId);return;}
        const releaseDisk=hostDisk.reserve(`retire:${sessionId}`);
        try{await chats.manager.withIdleContainer(app.sessions.retirementContainerName(sessionId),()=>app.sessions.retireWorkerContainer(sessionId,app.dataDir,assertCurrent,()=>hostDisk.assert()));}
        finally{releaseDisk();}
      },
      disposeWorkspace: async () => {
        try { await workspaces.dispose(id); }
        catch(error) {
          if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
          // A peer can retry release after losing its acknowledgment. Missing
          // workspace metadata alone is not proof that its directory was released.
          try{await lstat(path.join(app.dataDir,'workspace-data','workspaces',id));}
          catch(missing){if((missing as NodeJS.ErrnoException).code==='ENOENT')return;throw missing;}
          throw error;
        }
      } });
  }
  async function sourceRootsForAttempt(attemptId:string,project:Project,previous?:CandidateRef,checkInputs?:FrozenTaskCheckInputs):Promise<WorkingDirectorySource[]>{
    return factoryAttemptWorkingDirectorySources(app.dataDir,app.sessions,attemptId,project,previous?.workingDirectories as WorkingDirectoryCapture[]|undefined,checkInputs?.workingDirectoryIds);
  }
  async function prepareLocal(record: WorkerRecord, project = record.project, previousCandidate?: CandidateRef): Promise<void> {
    return withAttemptOperation(record.attempt,async signal=>{
    const host=isHostAttempt(record.attempt);
    const assertCurrent = () => {
      const current = worker(record.id);
      if(signal.aborted||current.status==='canceled'||current.attempt.generation!==record.attempt.generation||current.task.id!==record.task.id||current.goal.id!==record.goal.id||current.goal.revision!==record.goal.revision)throw new Error('Worker preparation was canceled or its assignment changed.');
      if(record.coordinatorId===app.device.id)assertCurrentWorkerAssignment(app.store,record);
    };
    try {
    assertCurrent();
    hostDisk.assert();
    assertHostAssignment(record.attempt,record.goal.runtime,record.task);
    if(host)await chats.manager.provisionHost(signal);else await app.ensureRuntimeReady();
    assertCurrent();
    // Runtime readiness does not prove either host or guest storage is writable.
    hostDisk.assert();
    const developmentToolchain=host?'default':await resolveToolchain(project,signal,record.developmentToolchain);
    assertCurrent();
    hostDisk.assert();
    patchWorker(record.id,{developmentToolchain});
    const name = sessionName(record.id);
    const config = await projectConfig(project);
    let workspace = await workspaces.create({ projectPath: project.path, goalId: record.goal.id,
      taskId: record.task.id, attemptId: record.id, provider: host?'git':sourceProvider(record.goal), fallbackToGit: true, executionTargetKind:host?'host-macos':'container',sessionName: name,
      workspaceBranch: `${config ? envmuxBranchPrefix(config) : 'envmux/'}${name}`,developmentToolchain:developmentToolchain==='default'?undefined:developmentToolchain,checkInputs:record.checkInputs });
    assertCurrent();
    if (previousCandidate) {
      const promoted = await workspaces.promotePreviousCandidate({ candidateId: previousCandidate.id, workspaceId: workspace.id });
      if (promoted.conflicts.length) app.store.set('factory-repair-input', { id: record.id, conflicts: promoted.conflicts, message: promoted.message });
      workspace = await workspaces.workspace(workspace.id);
    }
    assertCurrent();
    if(!host)await configureHandoff(workspace);
    hostDisk.assert();
    const workingDirectorySources=record.workingDirectorySources||await sourceRootsForAttempt(record.id,project,previousCandidate,record.checkInputs);
    assertCurrent();
    patchWorker(record.id,{workingDirectorySources});
    hostDisk.assert();
    const referenceContext=record.referenceContext||(record.coordinatorId===app.device.id?await prepareWorkerContext({goal:record.goal,task:record.task,attempt:record.attempt,project,store:app.store,workspaces,directoryManager:app.sessions.directoryManager,dataDir:app.dataDir,reservedNames:workingDirectorySources.map(root=>root.name),assertCurrent}):undefined);
    assertCurrent();
    if(referenceContext){assertWorkerContext(referenceContext,record);patchWorker(record.id,{referenceContext});}
    const owned = internalProject({...project,runtime:record.goal.runtime}, workspace, record.task.title);
    const state = workspace.providerState;
    hostDisk.assert();
    const session = host?await app.sessions.createHost(owned,name,{workspace,workingDirectorySources,referenceContext:referenceContext?.source,assertCurrent,executionTargetId:record.attempt.executionTargetId,onCreated:session=>patchWorker(record.id,{workspace:ref(workspace,session.id),sessionId:session.id})}):await app.sessions.create(owned, name,{workingDirectorySources,referenceContext:referenceContext?.source,assertCurrent,developmentToolchain,...(state && typeof state.bindSource === 'string' && typeof state.stateVolume === 'string'
      ? { workspace: { bindSource: state.bindSource, stateVolume: state.stateVolume } } : {})});
    patchWorker(record.id, { workspace: ref(workspace, session.id), sessionId: session.id });
    await app.sessions.waitExecutionReady(session.id);
    assertCurrent();
    patchWorker(record.id,{workspace:{...ref(workspace,session.id),workingDirectories:app.sessions.record(session.id).workingDirectories}});
    if (worker(record.id).status === 'canceled') { await app.sessions.stop(session.id); return; }
    patchWorker(record.id, { status: 'prepared' });
    } catch(error) {
      const latest=worker(record.id);
      if(latest.sessionId&&app.sessions.needsTermination(latest.sessionId)){await app.sessions.stop(latest.sessionId);await app.sessions.waitStopped(latest.sessionId);}
      throw error;
    } finally {
      await disposeWorkerContext(app.dataDir,record.id,record.attempt.generation);
      const latest=worker(record.id);
      if(latest.sessionId&&!app.sessions.needsTermination(latest.sessionId))await app.sessions.disposeReferenceContext(latest.sessionId);
    }
    });
  }
  function beginWorker(input: Omit<WorkerRecord, 'status' | 'updatedAt'>): WorkerRecord {
    const previous = app.store.get<WorkerRecord>(journal, input.id);
    if (previous) {
      if (previous.coordinatorId !== input.coordinatorId || previous.attempt.generation !== input.attempt.generation
        || previous.goal.id !== input.goal.id || previous.goal.revision !== input.goal.revision || previous.task.id !== input.task.id
        || JSON.stringify(previous.checkInputs)!==JSON.stringify(input.checkInputs)
        || previous.attempt.executionTargetKind!==input.attempt.executionTargetKind||previous.attempt.executionTargetId!==input.attempt.executionTargetId
        || previous.preparationIdentity && input.preparationIdentity && previous.preparationIdentity !== input.preparationIdentity
        || input.coordinatorId!==app.device.id&&previous.referenceContext?.source.sourceArtifact.sha256 !== input.referenceContext?.source.sourceArtifact.sha256)
        throw new HttpError(409, 'Attempt identity is already bound to a different assignment.');
      return previous;
    }
    const record: WorkerRecord = { ...input, status: 'preparing', updatedAt: now() };
    app.store.set(journal, record); app.changed(); return record;
  }
  function assertExecutionAssignment(record: WorkerRecord): void {
    if(record.coordinatorId===app.device.id){const detail=app.store.get<AttemptDetail>('factory-attempt-details',record.id);assertCurrentWorkerAssignment(app.store,{...record,goal:{...record.goal,revision:detail?.assignmentGoalRevision??record.referenceContext?.assignment.goalRevision??record.goal.revision}});}
    if(record.referenceContext)assertWorkerContext(record.referenceContext,{...record,goal:{...record.goal,revision:record.referenceContext.assignment.goalRevision}});
  }
  async function startPreparedExecution(record: WorkerRecord, goal: Goal, project: Project, prompt: string): Promise<void> {
    const pending = jobs.get(record.id);
    // Readiness can be published before preparation releases its cleanup/operation
    // lease. Join that phase so an execution request cannot be silently dropped.
    // A repeated request for an already executing worker never joins its provider turn.
    if (pending?.phase === 'preparing') await pending.done;
    const current = worker(record.id);
    if (current.status !== 'prepared' || jobs.has(record.id)) return;
    if (current.coordinatorId !== record.coordinatorId || current.attempt.generation !== record.attempt.generation
      || current.task.id !== record.task.id || current.goal.id !== record.goal.id || current.goal.revision !== record.goal.revision)
      throw new HttpError(409, 'The worker assignment changed before execution could start.');
    const execution = { ...current, goal, project };
    assertExecutionAssignment(execution);
    // No await separates the final authority check and execution ownership.
    patchWorker(record.id, { goal, project, capacityWait: undefined, result: undefined });
    track(record.id, 'executing', () => executeLocal(execution, prompt));
  }
  async function executeLocal(record: WorkerRecord, prompt: string): Promise<void> {
    // Provisioning happens inside chats.run. Its real completion boundary is the
    // turn promise, so retain conservative capacity ownership through that turn.
    const releaseDisk = hostDisk.reserve(`provider:${record.id}`);
    try {
    if (!record.sessionId) throw new Error('The prepared attempt has no execution workspace.');
    if (worker(record.id).status === 'canceled') return;
    if(app.sessions.archivedEnvironment(record.sessionId))await app.sessions.restart(record.sessionId);
    await app.sessions.waitExecutionReady(record.sessionId);
    if (worker(record.id).status === 'canceled') return;
    assertExecutionAssignment(record);
    hostDisk.assert();
    const ownedProject = app.store.get<Project>('projects', app.sessions.record(record.sessionId).projectId);
    if (ownedProject) app.store.set('projects', { ...ownedProject, rules: record.project.rules, runtime: record.goal.runtime, approvalMode: record.goal.approvalMode });
    const chat = record.chatId ? chats.get(record.chatId) : chats.create({ sessionId: record.sessionId,
      runtime: record.goal.runtime, approvalMode: record.goal.approvalMode, title: record.task.title, attemptId: record.id });
    patchWorker(record.id, { status: 'running', chatId: chat.id });
    const attempt = app.store.get<Attempt>('attempts', record.id);
    if (attempt) app.store.set('attempts', { ...attempt, sessionId: record.sessionId, chatId: chat.id });
    const repair = app.store.get<{ id: string; conflicts: string[]; message?: string }>('factory-repair-input', record.id);
    const executionPrompt=executionInstructions([repair ? `${prompt}\n\nRetained work was merged as repair input. Resolve conflict markers in these files before completing: ${repair.conflicts.join(', ')}. ${repair.message || ''}` : prompt,record.referenceContext?.instructions,record.checkInputs?`Coordinator-configured verification inputs are frozen for this attempt: ${JSON.stringify(record.checkInputs)}. Factory checks receive exactly this environment. Use these mounted evidence paths and expected digests when inspecting the supplied inputs; missing or invalid evidence remains a check failure.`:undefined].filter(Boolean).join('\n\n'),record.sessionId);
    const result = await chats.run(chat.id, executionPrompt, { attemptId: record.id, autonomous: record.goal.autonomy === 'autonomous',
      systemInstructions: executionInstructions(`You are implementing an assigned EnoughFactory task toward this goal:\n${record.goal.objective}\n\n${isHostAttempt(record.attempt)?'You run natively on the configured Mac with full same-user host permissions in a private attempt workspace; this is not a security sandbox.':'You have full permissions inside this container.'} Enough owns the configured ${record.goal.approvalMode} policy. Make routine implementation decisions and execute the task completely. Do not stop at a plan or ask for permission already granted. Keep verification proportionate. Preserve changes and describe concrete evidence and any remaining work. The factory will independently capture, check, integrate and evaluate your result.\n\n${validationInstructions(isHostAttempt(record.attempt)?'host-macos':'container')}\n\n${factoryQualityInstructions('worker')}\n\n${toolchainInstructions(app.sessions.record(record.sessionId).developmentToolchain)}\n\n${record.referenceContext?.instructions??''}`,record.sessionId) });
    if (worker(record.id).status === 'canceled') return;
    patchWorker(record.id, { status: 'succeeded', result: { status: 'succeeded', text: result.text, sessionId: record.sessionId, chatId: chat.id } });
    } finally { releaseDisk(); }
  }
  async function reconcileLocal(id: string): Promise<WorkerRecord> {
    const record = worker(id);
    if (jobs.has(id)) return record;
    if (record.capacityWait) return record;
    if ((record.status === 'running' || record.status === 'unknown') && record.chatId) {
      if (chats.isRunning(record.chatId)) {
        if (record.status === 'unknown') patchWorker(id, { status: 'running', error: undefined, result: undefined });
        return worker(id);
      }
      const completed = app.store.get<{ id: string; result: TurnResult; attemptId?: string; completedAt?: string }>('chat-results', record.chatId);
      if (completed?.attemptId === record.id) {
        patchWorker(id, { status: 'succeeded', error: undefined, result: { status: 'succeeded', text: completed.result.text,
          chatId: record.chatId, sessionId: record.sessionId } });
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
      if (record.capacityWait && !jobs.has(attemptId)) return record;
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
    const operation = withAttemptOperation(record.attempt,async () => {
      if(app.sessions.archivedEnvironment(record.sessionId!)){
        await app.sessions.restart(record.sessionId!);
        await app.sessions.waitExecutionReady(record.sessionId!);
      }
      const session = app.sessions.record(record.sessionId!);
      let commit = app.store.get<{ id: string; commit: string }>('factory-capture-input', id)?.commit;
      if (session.status !== 'stopped'||isHostAttempt(record.attempt)) {
        if (record.workspace!.provider === 'git') {
          // The application owns preservation; a provider final answer need not have committed its work.
          const execution=app.sessions.execution(session.id);await app.sessions.assertHostExecutionCurrent(session.id);
          const captureGit=async(...args:string[])=>{if(execution.kind==='host-macos')return (await exec('git',['-c','core.hooksPath=/dev/null','-C',execution.workdir,...args],{maxBuffer:16*1024*1024})).stdout;const invocation=dockerInvocation(app.runtime.endpoint,['exec',execution.containerId!,'git','-c','safe.directory=*','-c','core.hooksPath=/dev/null','-C',execution.workdir,...args]);return (await exec(invocation.command,invocation.args,{env:invocation.env,maxBuffer:16*1024*1024})).stdout;};
          if(session.status==='stopped'&&commit&&((await captureGit('rev-parse','HEAD')).trim()!==commit||(await captureGit('status','--porcelain')).trim()))throw new HttpError(409,'The stopped native workspace changed after its recorded source capture. Its files remain retained; inspect them before preserving a continuation.','CAPTURE_SOURCE_CHANGED');
          await stageCapturedSource(captureGit,{isRegularFile:async relativePath=>{if(execution.kind==='host-macos'){try{const entry=await lstat(path.join(execution.workdir,relativePath));return entry.isFile()&&!entry.isSymbolicLink();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}const invocation=dockerInvocation(app.runtime.endpoint,['exec',execution.containerId!,'sh','-c','test -f "$1" && test ! -L "$1"','capture-source',path.posix.join(execution.workdir,relativePath)]);try{await exec(invocation.command,invocation.args,{env:invocation.env});return true;}catch(error){if((error as{code?:unknown}).code===1)return false;throw error;}}});
          const staged=await captureGit('diff','--cached','--name-only');
          if(staged)await captureGit('-c','user.name=EnoughFactory','-c','user.email=factory@enoughtools.com','commit','-m',`Preserve EnoughFactory attempt ${id}`);
          commit=(await captureGit('rev-parse','HEAD')).trim();
          app.store.set('factory-capture-input', { id, commit });
        }
        if(session.status!=='stopped')await app.sessions.stop(session.id);
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
    qualityChecks:inspection.qualityCheck?true:undefined,
    async prepare({ goal, task, attempt, project, previousCandidate }) {
      goal={...goal,revision:app.store.get<AttemptDetail>('factory-attempt-details',attempt.id)?.assignmentGoalRevision??goal.revision};
      const assertCurrent=()=>assertCurrentWorkerAssignment(app.store,{goal,task,attempt});
      assertCurrent();
      const checkInputs=freezeTaskCheckInputs(app.store,task.id,attempt.id,project);
      const releaseDisk=reserveDisk(`attempt:${attempt.id}`,workerPreparationBytes(goal,task,attempt,previousCandidate));
      try {
      const host=isHostAttempt(attempt);
      const toolchainProfile=host?'default':await developmentToolchainChoice(project);
      assertCurrent();
      project={...project,developmentToolchain:toolchainProfile};
      if (local(attempt.deviceId)) {
        const record = beginWorker({ id: attempt.id, coordinatorId: app.device.id, goal, task, attempt, project,checkInputs });
        if (record.status === 'preparing') { patchWorker(record.id, { capacityWait: undefined, result: undefined }); track(record.id, 'preparing', () => prepareLocal(record, project, previousCandidate)); }
      } else {
        if(toolchainProfile!=='default'){
          const health=await rpc<{deviceId:string;capabilities?:{developmentToolchains?:Array<{id:string;recipeSha256:string}>}}>(attempt.deviceId,'GET','/api/health');
          if(health.deviceId!==attempt.deviceId||!health.capabilities?.developmentToolchains?.some(profile=>profile.id===toolchainProfile&&profile.recipeSha256===SWIFT_TOOLCHAIN.recipeSha256))throw new Error('Update the selected worker device to the same fixed Swift toolchain recipe before dispatching this task.');
        }
        if(project.workingDirectories?.length||(previousCandidate?.workingDirectories as unknown[]|undefined)?.length){const health=await rpc<{deviceId:string;capabilities?:{workingDirectories?:boolean}}>(attempt.deviceId,'GET','/api/health');if(health.deviceId!==attempt.deviceId||health.capabilities?.workingDirectories!==true)throw new Error('Update the selected worker device before using additional working folders.');}
        const {source,config}=await factoryAttemptTransferSource(app.store,attempt.id,()=>workspaces.exportSource({projectPath:project.path}),()=>projectConfig(project));
        rememberArtifacts(source);
        await sendArtifact(attempt.deviceId, source);
        const workingDirectorySources=await sourceRootsForAttempt(attempt.id,project,previousCandidate,checkInputs);
        const referenceContext=await prepareWorkerContext({goal,task,attempt,project,store:app.store,workspaces,directoryManager:app.sessions.directoryManager,dataDir:app.dataDir,reservedNames:workingDirectorySources.map(root=>root.name),assertCurrent});
        try {
        for(const root of workingDirectorySources){rememberArtifacts(root.sourceArtifact);await sendArtifact(attempt.deviceId,root.sourceArtifact);}
        if(referenceContext){rememberArtifacts(referenceContext.source.sourceArtifact);await sendArtifact(attempt.deviceId,referenceContext.source.sourceArtifact);}
        if (previousCandidate) {
          const prior = await workspaces.candidate(previousCandidate.id);
          for(const artifact of candidateArtifacts(prior))await sendArtifact(attempt.deviceId,artifact);
        }
        assertCurrent();
        await rpc(attempt.deviceId, 'POST', '/api/factory/worker/prepare', { goal, task, attempt,
          project: publicWorkerProject(project), source, workingDirectorySources, referenceContext, config, previousCandidate,
          workspaceProvider: host?'git':sourceProvider(goal),checkInputs,toolchainRecipe:toolchainProfile==='default'?undefined:{id:SWIFT_TOOLCHAIN.id,recipeSha256:SWIFT_TOOLCHAIN.recipeSha256} });
        } finally {await disposeWorkerContext(app.dataDir,attempt.id,attempt.generation);}
      }
      const record = await waitWorker(attempt.deviceId, attempt.id, 'prepared');
      assertCurrent();
      if (record.capacityWait) throw new FactoryCapacityError(record.capacityWait);
      if (!record.workspace || !['prepared', 'running', 'succeeded'].includes(record.status)) throw new Error(record.error || 'Worker preparation did not complete.');
      if(record.attempt.executionTargetKind!==attempt.executionTargetKind||record.attempt.executionTargetId!==attempt.executionTargetId)throw new Error('The worker did not honor its frozen execution target.');
      if(toolchainProfile!=='default')validatePreparedToolchain(record.workspace.developmentToolchain);
      else if(record.workspace.developmentToolchain)throw new Error('The worker did not honor the selected default development environment.');
      if(JSON.stringify(record.workspace.checkInputs)!==JSON.stringify(checkInputs))throw new Error('The worker did not confirm the frozen coordinator check inputs.');
      const frozen=app.store.get<{id:string;context?:WorkerEvidenceContext}>('factory-worker-context',attempt.id)?.context;
      if(frozen?.source.sourceArtifact.sha256!==record.referenceContext?.source.sourceArtifact.sha256)throw new Error('The worker did not confirm its exact frozen retained reference evidence.');
      const sources=local(attempt.deviceId)?worker(attempt.id).workingDirectorySources||[]:await app.sessions.directoryManager.sourceSnapshots(attempt.id);
      const mounts=record.workspace.workingDirectories as import('@enoughfactory/contracts').WorkingDirectoryMount[]|undefined;
      if(sources.length&&(!mounts||mounts.length!==sources.length||sources.some(source=>!mounts.some(root=>root.id===source.id&&root.name===source.name&&root.path===(host?path.join(path.dirname(path.dirname(path.dirname(record.workspace!.path))),'host-sessions',record.sessionId!,'roots',source.id,'repository'):source.containerPath)&&root.baseCommit===source.baseCommit&&root.kind===source.kind))))throw new Error('The worker did not confirm the exact additional working folder snapshots. No task execution was authorized.');
      return record.workspace;
      } finally { releaseDisk(); }
    },
    async capture(workspace, { attempt }) {
      if (local(workspace.deviceId)) return captureLocal(attempt.id);
      await rpc(workspace.deviceId!, 'POST', `/api/factory/worker/${attempt.id}/capture`);
      for (;;) {
        const record = await rpc<WorkerRecord>(workspace.deviceId!, 'GET', `/api/factory/worker/${attempt.id}`);
        if (record.candidate) {
          const value = record.candidate as unknown as Candidate;
          if(JSON.stringify(value.developmentToolchain)!==JSON.stringify(workspace.developmentToolchain))throw new Error('The captured candidate does not match its prepared development toolchain.');
          if(JSON.stringify(value.checkInputs)!==JSON.stringify(workspace.checkInputs))throw new Error('The captured candidate does not match its frozen coordinator check inputs.');
          assertCapturedRoots(value.workingDirectories||[],(workspace.workingDirectories as import('@enoughfactory/contracts').WorkingDirectoryMount[]|undefined)||[]);
          if (candidateArtifacts(value).every(manifest => app.store.get<ReceivedArtifact>('peer-artifacts', manifest.id)?.peerId === workspace.deviceId)) {
            await acceptRemoteCandidate(workspace.deviceId!, record.candidate); return record.candidate;
          }
        }
        if (record.error) throw new Error(record.error);
        await sleep(1500);
      }
    },
    async check(_project, candidate, commands,verification) {
      return withCheckCapacity(async () => {
      const report = await workspaces.verify({ candidateId: candidate.id, commands,verification }); rememberArtifacts(report.logArtifact);
      return checkResults(report, candidate.commit);
      }, candidate);
    },
    async integrate(project, candidate, input) {
      return withCheckCapacity(async () => {
      const result = await workspaces.integrate({ candidateId: candidate.id, projectPath: project.path, commands: input.checks, isCurrent: input.isCurrent,verification:input.verification });
      if (result.report) rememberArtifacts(result.report.logArtifact);
      if(result.status==='checks-failed'&&result.report){
        const pending=checkResults(result.report,candidate.commit).find(check=>!check.passed&&check.recovery?.condition==='inspection-evidence');
        if(pending?.recovery)throw new FactoryVerificationWaitError(pending.recovery.reason);
      }
      if (result.status !== 'integrated' || !result.commit) {
        const kind = result.status === 'conflict' ? 'conflict' : result.status === 'checks-failed' ? 'checks-failed' : 'stale';
        throw new FactoryOperationError(kind, result.message || `Integration ${result.status}${result.conflicts?.length ? `: ${result.conflicts.join(', ')}` : ''}.`);
      }
      return { commit: result.commit, previousHead: result.previousCommit, candidateCommit: candidate.commit,
        checks: result.report ? checkResults(result.report, candidate.commit) : [] };
      }, candidate);
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
      return withCheckCapacity(async () => {
      const host=!!controllerHostTarget(goal);
      const developmentToolchain=host||commands.every(isAppleCheckCommand)?'default':await app.withRuntimeOperation(async signal=>{await app.ensureRuntimeReady();return resolveToolchain(project,signal);});
      const repository=await workspacePort.inspect(project),operation=randomUUID();
      if(repository.status.trim())throw new Error('Goal checks require a clean primary working tree so they can verify the integrated commit. Commit or preserve the remaining primary edits before evaluating.');
      const workspace=await workspaces.create({projectPath:project.path,goalId:goal.id,taskId:'goal-check',attemptId:operation,baseCommit:repository.head,executionTargetKind:host?'host-macos':'container',developmentToolchain:developmentToolchain==='default'?undefined:developmentToolchain});
      let candidate:Candidate|undefined,report:CheckReport|undefined;
      try{
        const roots=await app.sessions.directoryManager.prepare({identity:operation,sources:project.workingDirectories||[]});
        const workingDirectories:WorkingDirectoryCapture[]=[];for(const root of roots)workingDirectories.push(await app.sessions.directoryManager.captureFromPath(root,root.path));
        candidate=await workspaces.capture({workspaceId:workspace.id,reference:workspace.branch,workingDirectories});
        rememberArtifacts(...candidateArtifacts(candidate));
        report=await workspaces.verify({candidateId:candidate.id,commands});rememberArtifacts(report.logArtifact);
        return {repository,checks:checkResults(report,candidate.commit)};
      }finally{
        await workspaces.dispose(workspace.id);
        if(candidate&&report)try{await releaseGoalCheckInputs({operation,candidate,report,dataDir:app.dataDir,store:app.store,directoryManager:app.sessions.directoryManager,artifacts:workspaces.artifacts,workspaces});}
        catch(error){app.store.set('factory-worker-cleanup',{id:operation,error:(error as Error).message,updatedAt:now()});}
      }
      });
    },
    async reconcileIntegration(project, candidate) {
      const result = await workspaces.reconcileIntegration({ candidateId: candidate.id, projectPath: project.path });
      if (!result || result.status !== 'integrated' || !result.commit) return undefined;
      return { commit: result.commit, previousHead: result.previousCommit, candidateCommit: candidate.commit,
        checks: result.report ? checkResults(result.report, candidate.commit) : [] };
    },
    async release(workspace) {
      try {
        if (local(workspace.deviceId)) await releaseLocalWorker(workspace.id);
        else {
          await rpc(workspace.deviceId!, 'POST', `/api/factory/worker/${workspace.id}/release`);
          await releaseCoordinatorWorkerInputs({attemptId:workspace.id,dataDir:app.dataDir,store:app.store,directoryManager:app.sessions.directoryManager,artifacts:workspaces.artifacts,workspaces});
        }
      } catch(error) { app.store.set('factory-worker-cleanup',{id:workspace.id,error:(error as Error).message,updatedAt:now()}); throw error; }
    },
  };
  function needsControllerReview(goal:Goal):boolean {
    return app.store.list<FactoryTask>('tasks').some(task=>task.goalId===goal.id&&task.status!=='canceled'&&!!task.quality);
  }
  const controllerReleases=new Map<string,Promise<void>>();
  async function releaseController(operation:string,sessionId:string|undefined,runtime:Goal['runtime']):Promise<void> {
    const existing=controllerReleases.get(operation);if(existing)return existing;
    const job=(async()=>{
    try {
      await releaseControllerInputs({operation,sessionId,dataDir:app.dataDir,store:app.store,sessions:app.sessions,directoryManager:app.sessions.directoryManager,artifacts:workspaces.artifacts,
        retireContainer:async(sid,assertCurrent)=>{if(app.sessions.record(sid).executionTargetKind==='host-macos'){assertCurrent();await app.sessions.disposeHostWorkspace(sid);return;}return app.sessions.withRetirementLease(sid,()=>chats.manager.withIdleContainer(app.sessions.retirementContainerName(sid),()=>app.sessions.retireEphemeralEnvironment(sid,app.dataDir,{assertCurrent,assertSpace:()=>hostDisk.assert(),runtimeKinds:[runtime]})));}});
    } catch(error) { app.store.set('factory-controller-cleanup',{id:operation,sessionId,error:(error as Error).message,updatedAt:now()}); }
    finally { activeControllerOperations.delete(operation);if(sessionId)terminalCleanup?.request(sessionId); }
    })();controllerReleases.set(operation,job);try{await job;}finally{if(controllerReleases.get(operation)===job)controllerReleases.delete(operation);}
  }
  async function reviewController(goal:Goal,run:ControllerRun,resultText:string,systemInstructions:string,repository:RepositoryEvidence,signal?:AbortSignal):Promise<string> {
    const assertCurrent=()=>{
      const current=app.store.get<Goal>('goals',goal.id);
      if(signal?.aborted||!current||current.revision!==goal.revision||['paused','completed','failed','canceled'].includes(current.status)||current.runtime!==goal.runtime||JSON.stringify(current.execution??null)!==JSON.stringify(goal.execution??null))throw new Error('The controller decision was revoked.');
    };
    assertCurrent();
    const check=()=>inspection.reviewController?.({goal,run:{...run,status:'running'},resultText,signal})??Promise.resolve({ready:false,reason:'Completion requires the configured visual inspection service.',evidenceIds:[]});
    let review=await check();
    assertCurrent();
    if(!review.ready){
      if(signal?.aborted)throw new Error('The controller decision was revoked.');
      const followup=await chats.run(run.chatId!,`Completion review needs more evidence: ${review.reason??'Inspect the current product screens and references.'}\nUse the inspection tools to view the actual current integrated product and relevant references. Return the full evaluator JSON again, including visualReview with the current source and concrete comparisons. If behavior or design is deficient, return a specific follow-up plan instead of marking the goal complete.`,{autonomous:goal.autonomy==='autonomous',systemInstructions});
      resultText=followup.text;review=await check();
      assertCurrent();
    }
    if(review.ready){app.store.delete('factory-controller-reviews',run.id);return resultText;}
    app.store.set<ControllerReviewContinuation>('factory-controller-reviews',{id:run.id,goalId:goal.id,goalRevision:goal.revision,runtime:goal.runtime,execution:JSON.stringify(goal.execution??null),sessionId:run.sessionId!,chatId:run.chatId!,repository,resultText,systemInstructions,status:'waiting',reason:review.reason,updatedAt:now()});
    app.store.set('factory-controller-runs',{...run,status:'waiting',result:resultText,error:review.reason,updatedAt:now()});
    throw new FactoryControllerError(review.reason??'Completion is waiting for current product screen and reference evidence.','inspection-evidence');
  }
  async function resumeControllerReview(goal:Goal,continuation:ControllerReviewContinuation,signal?:AbortSignal):Promise<{text:string;chatId:string}> {
    const operation=continuation.id,run=app.store.get<ControllerRun>('factory-controller-runs',operation);
    if(!run||run.chatId!==continuation.chatId||run.sessionId!==continuation.sessionId||app.sessions.record(continuation.sessionId).status!=='ready')throw new FactoryControllerError('The retained completion review environment is unavailable; its source and conversation remain saved.','controller-retry-required');
    activeControllerOperations.add(operation);
    let waiting=false;
    const cancel=()=>{void chats.interrupt(continuation.chatId).catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
    app.store.set('factory-controller-runs',{...run,status:'running',error:undefined,updatedAt:now()});
    const chat=app.store.get<import('@enoughfactory/contracts').Chat>('chats',continuation.chatId);
    if(chat)app.store.set('chats',{...chat,approvalMode:goal.approvalMode});
    try {
      const text=await reviewController(goal,{...run,status:'running'},continuation.resultText,continuation.systemInstructions,continuation.repository,signal);
      app.store.set('factory-controller-runs',{...run,status:'completed',error:undefined,result:text,updatedAt:now()});
      return {text,chatId:continuation.chatId};
    } catch(error){
      waiting=error instanceof FactoryControllerError&&error.recovery==='inspection-evidence';
      if(!waiting){app.store.delete('factory-controller-reviews',operation);app.store.set('factory-controller-runs',{...run,status:signal?.aborted?'interrupted':'failed',error:(error as Error).message,updatedAt:now()});}
      throw error;
    } finally {signal?.removeEventListener('abort',cancel);if(waiting)activeControllerOperations.delete(operation);else await releaseController(operation,continuation.sessionId,continuation.runtime);}
  }
  const runtime: FactoryRuntimePort = {
    controllerRecordReferences: true,
    async complete({ goal, role, prompt, project, signal, recordRequirements }) {
      if(role==='evaluator'){
        const retained=app.store.list<ControllerReviewContinuation>('factory-controller-reviews').filter(item=>item.goalId===goal.id&&item.status==='waiting');
        const currentRepository=retained.length?await workspacePort.inspect(project):undefined;
        for(const continuation of retained){
          if(continuation.goalRevision===goal.revision&&continuation.runtime===goal.runtime&&continuation.execution===JSON.stringify(goal.execution??null)&&continuation.repository?.head===currentRepository?.head&&continuation.repository?.fingerprint===currentRepository?.fingerprint)return app.withServiceOperation(serviceSignal=>resumeControllerReview(goal,continuation,signal?AbortSignal.any([signal,serviceSignal]):serviceSignal));
          app.store.delete('factory-controller-reviews',continuation.id);
          const staleRun=app.store.get<ControllerRun>('factory-controller-runs',continuation.id);if(staleRun)app.store.set('factory-controller-runs',{...staleRun,status:'interrupted',error:'The goal changed before this completion review finished.',updatedAt:now()});
          await releaseController(continuation.id,continuation.sessionId,continuation.runtime);
        }
      }
      const hostTarget=controllerHostTarget(goal),host=!!hostTarget;
      if(goal.execution&&!configuredControllerTarget(goal))throw new FactoryControllerError('The controller is waiting for an execution target matching the configured goal capabilities and provider.','execution-capability');
      if(!goal.execution&&!host&&goalAuthorizesHost(goal)&&goal.runtime==='codex'&&!containerAvailable())throw new FactoryControllerError('The controller is waiting for its configured native Mac execution capability.','execution-capability');
      let providerInvoked = false;
      let releaseDisk=()=>{};
      return (host?app.withServiceOperation.bind(app):app.withRuntimeOperation.bind(app))(async runtimeSignal=>{
      // Completion audits inspect the integrated tree and stored evidence;
      // duplicating every historical candidate would scale with all past work.
      const sourceCandidates = role === 'evaluator' ? [] : controllerCandidates(app.store, goal.id, role);
      releaseDisk=hostDisk.reserve(`controller:${goal.id}:${role}`,preparationArtifactBytes(preparationArtifacts(sourceCandidates.map(item=>item.candidate))));
      signal=signal?AbortSignal.any([signal,runtimeSignal]):runtimeSignal;
      if (signal?.aborted) throw new Error('The controller decision was revoked.');
      if(host)await chats.manager.provisionHost(signal);else await app.ensureRuntimeReady();
      hostDisk.assert();
      const developmentToolchain=host?'default':await resolveToolchain(project,signal);
      hostDisk.assert();
      const operation = randomUUID();
      activeControllerOperations.add(operation);
      app.store.set('factory-controller-inputs', { id: operation, goalId: goal.id, role, status: 'preparing', updatedAt: now() });
      let sessionId: string | undefined;
      let record: ControllerRun | undefined;
      let chatId: string | undefined;
      let reviewWaiting = false;
      const cancel = () => {
        if (chatId) void chats.interrupt(chatId).catch(() => {});
        else if (sessionId) void app.sessions.stop(sessionId).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (signal?.aborted) throw new Error('The controller decision was revoked.');
        const controllerRepository=role==='evaluator'&&needsControllerReview(goal)?await workspacePort.inspect(project):undefined;
        const workspace = await workspaces.create({ projectPath: project.path, goalId: goal.id, taskId: `control-${role}`, attemptId: operation,executionTargetKind:host?'host-macos':'container',developmentToolchain:developmentToolchain==='default'?undefined:developmentToolchain });
        if(!host)await configureHandoff(workspace);
        const context = await prepareControllerContext({ operation, goalId: goal.id, role, project, store: app.store,
          workspaces, directoryManager: app.sessions.directoryManager, dataDir: app.dataDir, recordRequirements, selected: sourceCandidates });
        if (signal?.aborted) throw new Error('The controller decision was revoked.');
        hostDisk.assert();
        const owned = internalProject({...project,runtime:goal.runtime}, workspace, `${goal.title} · ${role}`);
        const session = host?await app.sessions.createHost(owned,sessionName(operation),{workspace,workingDirectorySources:context.workingDirectorySources,executionTargetId:hostTarget!.id,assertCurrent:()=>{if(signal?.aborted)throw new Error('The controller decision was revoked.');},onCreated:session=>{sessionId=session.id;record={id:operation,goalId:goal.id,role,sessionId:session.id,status:'starting',updatedAt:now()};app.store.set('factory-controller-runs',record);app.store.set('factory-controller-inputs',{id:operation,goalId:goal.id,role,sessionId:session.id,status:'preparing',updatedAt:now()});}}):await app.sessions.create(owned, sessionName(operation), { workingDirectorySources: context.workingDirectorySources,developmentToolchain });
        sessionId = session.id;
        record = { id: operation, goalId: goal.id, role, sessionId, status: 'starting', updatedAt: now() };
        app.store.set('factory-controller-runs', record);
        app.store.set('factory-controller-inputs', { id: operation, goalId: goal.id, role, sessionId, status: 'prepared', updatedAt: now() });
        await app.sessions.waitExecutionReady(session.id);
        hostDisk.assert();
        if (signal?.aborted) throw new Error('The controller decision was revoked.');
        const chat = chats.create({ sessionId: session.id, runtime: goal.runtime, approvalMode: goal.approvalMode, title: `${goal.title} · ${role}` });
        chatId = chat.id;
        app.store.set('factory-controller-runs', { ...record, chatId: chat.id, status: 'running', updatedAt: now() });
        providerInvoked = true;
        const systemInstructions = [`You are the EnoughFactory ${role}. ${host?'You run on the configured Mac with full same-user host access in a private Git snapshot; this is not a container sandbox.':'This container contains an isolated snapshot of the current project repository with full container permissions.'} Inspect the actual source and relevant runtime evidence to make your decision under ${goal.approvalMode} policy. Your role is to decide the next factory action; implementation belongs to assigned worker tasks. Do not modify product source as part of this decision. Return the structured JSON requested in the prompt. Goal: ${goal.objective}`, role === 'evaluator' ? 'Audit current behavior in the integrated primary repository. Historical candidate source bundles are not duplicated into this audit; full stored task/attempt contracts, checks and integration records remain available through the evidence manifest. Historical artifact references do not promise their bodies are present and cannot be claimed inspected.' : '', validationInstructions(host?'host-macos':'container'),factoryQualityInstructions(role),toolchainInstructions(app.sessions.record(session.id).developmentToolchain),executionInstructions(context.instructions,session.id)].filter(Boolean).join('\n\n');
        const result = await chats.run(chat.id, prompt, { autonomous: goal.autonomy === 'autonomous',systemInstructions });
        const running={...record,chatId:chat.id,status:'running' as const};
        const text=role==='evaluator'&&needsControllerReview(goal)?await reviewController(goal,running,result.text,systemInstructions,controllerRepository!,signal):result.text;
        app.store.set('factory-controller-runs', { ...record, chatId: chat.id, status: 'completed', updatedAt: now(), result: text });
        return { text, chatId: chat.id };
      } catch (error) {
        reviewWaiting=error instanceof FactoryControllerError&&error.recovery==='inspection-evidence';
        if (record&&!reviewWaiting) app.store.set('factory-controller-runs', { ...record, chatId, status: signal?.aborted ? 'interrupted' : 'failed', error: (error as Error).message, updatedAt: now() });
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        if(reviewWaiting)activeControllerOperations.delete(operation);
        else await releaseController(operation,sessionId,goal.runtime);
      }
      }).catch(error => { throw controllerError(error, { providerInvoked, runtimeReady:host||app.diagnostics.containerRuntime?.state === 'ready' }); }).finally(() => releaseDisk());
    },
    async execute({ attempt, goal, project, prompt, assignmentGoalRevision }) {
      const currentProject = app.store.get<Project>('projects', project.id) || project;
      if (local(attempt.deviceId)) {
        const record = worker(attempt.id);
        if (record.status === 'prepared') await startPreparedExecution(record, goal, currentProject, prompt);
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
    if (running) await running.done;
    const latest = worker(id);
    if (latest.sessionId && app.sessions.record(latest.sessionId).status !== 'stopped') {
      await app.sessions.stop(latest.sessionId); await app.sessions.waitStopped(latest.sessionId);
    }
    patchWorker(id, { cancellationAcknowledged: true, result: { status: 'failed', text: '', error: 'Cancellation acknowledged by the owning service.', sessionId: record.sessionId, chatId: record.chatId } });
  }
  const coordinator = new FactoryCoordinator({ store: app.store, runtime, workspaces: workspacePort,
    deviceId: app.device.id, devices: () => app.devices, project: id => app.store.get<Project>('projects', id), admission, onChange: () => app.changed() });
  const runtimeReady = (topic: string, data: unknown) => {
    if (topic !== 'runtime' || (data as ContainerRuntimeStatus).state !== 'ready') return;
    try { app.assertRuntimeCanRun(); } catch { return; }
    coordinator.notifyCondition('runtime-available');
  };
  const reviewCleanupJobs=new Map<string,Promise<void>>();
  const cleanupRevokedControllerReviews=()=>{
    for(const continuation of app.store.list<ControllerReviewContinuation>('factory-controller-reviews')){
      const goal=app.store.get<Goal>('goals',continuation.goalId);
      if(goal&&!['completed','failed','canceled'].includes(goal.status)&&goal.revision===continuation.goalRevision&&goal.runtime===continuation.runtime&&JSON.stringify(goal.execution??null)===continuation.execution)continue;
      if(reviewCleanupJobs.has(continuation.id))continue;
      const job=(async()=>{
        app.store.delete('factory-controller-reviews',continuation.id);
        const run=app.store.get<ControllerRun>('factory-controller-runs',continuation.id);
        if(run)app.store.set('factory-controller-runs',{...run,status:'interrupted',error:'The goal changed or ended before this completion review finished.',updatedAt:now()});
        if(chats.isRunning(continuation.chatId)){await chats.interrupt(continuation.chatId);await chats.waitForIdle(continuation.chatId);}
        await releaseController(continuation.id,continuation.sessionId,continuation.runtime);
      })().catch(error=>{app.store.set('factory-controller-cleanup',{id:continuation.id,sessionId:continuation.sessionId,error:(error as Error).message,updatedAt:now()});}).finally(()=>{reviewCleanupJobs.delete(continuation.id);});
      reviewCleanupJobs.set(continuation.id,job);
    }
  };
  const cleanupReviewState=(topic:string)=>{if(topic==='state')cleanupRevokedControllerReviews();};
  app.listeners.add(cleanupReviewState);cleanupRevokedControllerReviews();
  app.closers.push(async()=>{app.listeners.delete(cleanupReviewState);await Promise.allSettled(reviewCleanupJobs.values());});
  const executionReady=(topic:string)=>{
    if(topic==='execution-capabilities'){
      coordinator.notifyCondition('execution-capability');
      // A verifier waiting for a locked/offline inspection target keeps its
      // original succeeded author. Capability recovery resumes that same gate.
      coordinator.notifyCondition('inspection-evidence');
    }
    if(topic==='inspection-evidence')coordinator.notifyCondition('inspection-evidence');
  };
  app.listeners.add(executionReady);
  app.closers.push(()=>{app.listeners.delete(executionReady);});
  app.listeners.add(runtimeReady);
  app.closers.push(() => { app.listeners.delete(runtimeReady); });
  if (app.diagnostics.containerRuntime?.state === 'ready') runtimeReady('runtime', app.diagnostics.containerRuntime);

  app.extensions.push(async (call: ApiCall) => {
    const { method, url, body } = call, route = url.pathname;
    const checkInputRoute=route.match(/^\/api\/tasks\/([^/]+)\/check-inputs$/);
    if(method==='POST'&&checkInputRoute){
      if(call.peerId)throw new HttpError(403,'Check inputs must be configured on the owning local coordinator.');
      const configured=configureTaskCheckInputs(checkInputRoute[1]!,body,{store:app.store,deviceId:app.device.id,workerBusy:id=>jobs.has(id)||captureJobs.has(id),chatIsRunning:id=>chats.isRunning(id)});
      app.changed();return configured;
    }
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
        // Validate every control before changing either the goal or its provider.
        const controls = steeringInput(body);
        if (body.workspaceProvider !== undefined) {
          if (!['git', 'artifactfs'].includes(String(body.workspaceProvider))) throw new HttpError(400, 'Unknown workspace provider.');
          const workspaceProvider = body.workspaceProvider as 'git' | 'artifactfs';
          app.store.set('goals', { ...goal, workspaceProvider }); app.store.set<GoalOptions>('factory-options', { id: goal.id, workspaceProvider });
        }
        if (body.objective !== undefined || body.context !== undefined || body.criteria !== undefined) await coordinator.steer(goal.id, controls);
        coordinator.configure(goal.id, { ...controls, runtime: body.runtime as Goal['runtime'] | undefined, concurrency: numberOption(body.concurrency),
          maxAttempts: body.maxAttempts === null ? null : numberOption(body.maxAttempts),
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
      const retainedAttempt=app.store.get<Attempt>('attempts',input.attemptId);if(!retainedAttempt)throw new HttpError(404,'Attempt not found.');
      return withAttemptOperation(retainedAttempt,() => retainManualContinuation(input, {
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
          if(app.sessions.archivedEnvironment(context.sessionId)){await app.sessions.restart(context.sessionId);await app.sessions.waitExecutionReady(context.sessionId);}
          const session=app.sessions.record(context.sessionId);
          if(session.status!=='ready')throw new HttpError(409,'Reconnect the retained environment before preserving its completed manual repair.');
          const execution=app.sessions.execution(session.id);await app.sessions.assertHostExecutionCurrent(session.id);
          const captureGit=async(...args:string[])=>{
            if(execution.kind==='host-macos')return (await exec('git',['-c','core.hooksPath=/dev/null','-C',execution.workdir,...args],{maxBuffer:16*1024*1024})).stdout;
            const invocation=dockerInvocation(app.runtime.endpoint,['exec',execution.containerId!,'git','-c','safe.directory=*','-c','core.hooksPath=/dev/null','-C',execution.workdir,...args]);
            return (await exec(invocation.command,invocation.args,{env:invocation.env,maxBuffer:16*1024*1024})).stdout;
          };
          await stageCapturedSource(captureGit,{isRegularFile:async relativePath=>{
            if(execution.kind==='host-macos'){try{const entry=await lstat(path.join(execution.workdir,relativePath));return entry.isFile()&&!entry.isSymbolicLink();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
            const invocation=dockerInvocation(app.runtime.endpoint,['exec',execution.containerId!,'sh','-c','test -f "$1" && test ! -L "$1"','capture-source',path.posix.join(execution.workdir,relativePath)]);
            try{await exec(invocation.command,invocation.args,{env:invocation.env});return true;}catch(error){if((error as {code?:unknown}).code===1)return false;throw error;}
          }});
          if((await captureGit('diff','--cached','--name-only')).trim())await captureGit('-c','user.name=EnoughFactory','-c','user.email=factory@enoughtools.com','commit','-m',`Preserve completed manual repair for EnoughFactory attempt ${context.attempt.id}`);
          return (await captureGit('rev-parse','HEAD')).trim();
        },
        captureExtras:context=>app.sessions.captureWorkingDirectories(context.sessionId),
        async validateGitCommit(context,commit) {
          if(app.sessions.record(context.sessionId).status==='stopped')return;
          const execution=app.sessions.execution(context.sessionId);await app.sessions.assertHostExecutionCurrent(context.sessionId);
          const sourceGit=async(...args:string[])=>{
            if(execution.kind==='host-macos')return (await exec('git',['-c','core.hooksPath=/dev/null','-C',execution.workdir,...args],{maxBuffer:16*1024*1024})).stdout.trim();
            const invocation=dockerInvocation(app.runtime.endpoint,['exec',execution.containerId!,'git','-c','safe.directory=*','-c','core.hooksPath=/dev/null','-C',execution.workdir,...args]);
            return (await exec(invocation.command,invocation.args,{env:invocation.env,maxBuffer:16*1024*1024})).stdout.trim();
          };
          if(await sourceGit('rev-parse','HEAD')!==commit||await sourceGit('status','--porcelain'))throw new HttpError(409,'The retained environment has newer source changes than this repair capture. It has been left running; preserve and inspect those edits before retrying this retention.','MANUAL_CONTINUATION_SOURCE_CHANGED');
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
      app.assertServiceAvailable();
      const goal = body.goal as Goal, task = body.task as FactoryTask, attempt = body.attempt as Attempt, project = body.project as Project;
      if (!goal || !task || !attempt || !project || attempt.deviceId !== app.device.id || task.goalId !== goal.id || attempt.taskId !== task.id || goal.coordinatorId !== peerId)
        throw new HttpError(400, 'The worker assignment does not match its coordinator, task and device.');
      if(isHostAttempt(attempt))assertHostAssignment(attempt,goal.runtime,task);else app.assertRuntimeCanRun();
      const toolchainProfile=parseDevelopmentToolchain(project.developmentToolchain);
      if(toolchainProfile==='swift-6.0.3'){
        const recipe=body.toolchainRecipe as {id?:unknown;recipeSha256?:unknown}|undefined;
        if(recipe?.id!==SWIFT_TOOLCHAIN.id||recipe.recipeSha256!==SWIFT_TOOLCHAIN.recipeSha256)throw new HttpError(409,'The coordinator and worker must agree on the exact fixed Swift toolchain recipe.');
      }else if(body.toolchainRecipe!==undefined)throw new HttpError(400,'A toolchain recipe must match the selected development toolchain.');
      for (const value of [attempt.id, task.id, goal.id]) if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new HttpError(400, 'Invalid factory identity.');
      const source = body.source as ArtifactManifest;
      const workingDirectorySources=body.workingDirectorySources as WorkingDirectorySource[]|undefined;
      const checkInputs=validateCheckInputs(body.checkInputs,workingDirectorySources||[]);
      if(project.workingDirectories?.length&&!workingDirectorySources?.length)throw new HttpError(409,'The coordinator did not transfer the configured additional working folders.');
      const previousCandidate = body.previousCandidate as CandidateRef | undefined;
      const referenceContext=body.referenceContext as WorkerEvidenceContext|undefined;
      if(referenceContext)assertWorkerContext(referenceContext,{goal,task,attempt});
      const preparationIdentity=createHash('sha256').update(JSON.stringify({source:source?.sha256,roots:workingDirectorySources?.map(root=>[root.id,root.name,root.sourceArtifact.sha256]),reference:referenceContext?.source.sourceArtifact.sha256,previous:previousCandidate?.id,config:body.config,checkInputs,executionTargetId:attempt.executionTargetId,executionTargetKind:attempt.executionTargetKind})).digest('hex');
      const existing=app.store.get<WorkerRecord>(journal,attempt.id);
      // Claim identity synchronously, before the first artifact import can yield.
      const record=beginWorker({id:attempt.id,coordinatorId:peerId,goal,task,attempt,project,workingDirectorySources,referenceContext,preparationIdentity,checkInputs});
      if(existing&&(existing.status!=='preparing'||!existing.capacityWait))return record;
      let releaseDisk:()=>void;
      try { releaseDisk=hostDisk.reserve(`remote-attempt:${attempt.id}`,preparationArtifactBytes([source,...(workingDirectorySources||[]).map(root=>root.sourceArtifact),...(referenceContext?[referenceContext.source.sourceArtifact]:[]),...preparationArtifacts(previousCandidate?[previousCandidate]:[])])); }
      catch(error){if(error instanceof HostDiskHeadroomError){patchWorker(record.id,{capacityWait:error.message,result:{status:'waiting',text:'',agentStarted:false,waitReason:error.message,wakeCondition:'host-disk-space'}});return worker(record.id);}throw error;}
      patchWorker(record.id,{capacityWait:undefined,result:undefined});
      app.store.set<GoalOptions>('factory-options', { id: goal.id, workspaceProvider: body.workspaceProvider === 'artifactfs' ? 'artifactfs' : 'git' });
      track(record.id, 'preparing', async () => {
        try {
        hostDisk.assert();
        await importReceived(peerId, source);
        for(const root of workingDirectorySources||[])await importReceived(peerId,root.sourceArtifact);
        if(referenceContext)await importReceived(peerId,referenceContext.source.sourceArtifact);
        if(previousCandidate)await acceptRemoteCandidate(peerId,previousCandidate);
        const sourcePath = path.join(app.dataDir, 'worker-source', record.id);
        await mkdir(path.dirname(sourcePath), { recursive: true });
        try { await git(sourcePath, 'rev-parse', 'HEAD'); }
        catch { await workspaces.importSource({ artifact: source, targetPath: sourcePath }); }
        if (typeof body.config === 'string') await writeFile(path.join(sourcePath, '.envmux.json'), body.config, { mode: 0o600 });
        await prepareLocal(record, { ...project, path: sourcePath, deviceId: app.device.id }, previousCandidate);
        } finally { releaseDisk(); }
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
        await startPreparedExecution(record, goal, project, body.prompt);
      }
      else if (!['running', 'succeeded', 'failed', 'unknown', 'canceled'].includes(record.status)) throw new HttpError(409, 'The worker is not prepared.');
      return worker(record.id);
    }
    if (method === 'POST' && action === 'cancel') { await cancelLocal(record.id); return { ok: true }; }
    if (method === 'POST' && action === 'capture') {
      patchWorker(record.id, { error: undefined });
      track(`capture-${record.id}`, 'capturing', async () => {
        try {
          const candidate = await captureLocal(record.id) as unknown as Candidate;
          for(const artifact of candidateArtifacts(candidate))await sendArtifact(peerId,artifact);
          patchWorker(record.id, { error: undefined });
        } catch (error) { patchWorker(record.id, { error: (error as Error).message }); }
      });
      return { ok: true };
    }
    if (method === 'POST' && action === 'release') {
      await releaseLocalWorker(record.id); return { ok: true };
    }
    return undefined;
  });
  app.runtimeStopHooks.unshift(async()=>{
    for(const goal of app.store.list<Goal>('goals').filter(goal=>goal.coordinatorId===app.device.id&&!['completed','canceled','failed'].includes(goal.status)&&!goalAuthorizesHost(goal)))coordinator.pause(goal.id);
    for(const record of app.store.list<WorkerRecord>(journal).filter(record=>record.attempt.deviceId===app.device.id&&!isHostAttempt(record.attempt)&&['preparing','prepared','running','unknown'].includes(record.status))){
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
  let archiveImportJob:Promise<void>|undefined;
  const importArchives=()=>{
    if(archiveImportJob)return archiveImportJob;
    const job=app.withRuntimeOperation(()=>importFactoryEnvironmentArchives({dataDir:app.dataDir,store:app.store,sessions:app.sessions,endpoint:app.runtime.endpoint,assertCurrent:()=>app.assertServiceAvailable()}))
      .then(()=>{}).catch(error=>{app.store.set('session-archive-imports',{id:'startup',status:'deferred',reason:(error as Error).message,updatedAt:now()});})
      .finally(()=>{if(archiveImportJob===job)archiveImportJob=undefined;});
    archiveImportJob=job;return job;
  };
  await importArchives();
  terminalCleanup=new TerminalSessionCleanup({store:app.store,sessions:app.sessions,
    runtimeReady:()=>app.diagnostics.containerRuntime?.state==='ready',eligible:session=>session.executionTargetKind!=='host-macos'&&['stopped','failed','unknown'].includes(session.status)&&!app.sessions.archivedEnvironment(session.id),
    identity:session=>app.sessions.retirementIdentityKey(session.id),
    busy:sessionId=>app.store.list<WorkerRecord>(journal).some(record=>record.sessionId===sessionId&&(jobs.has(record.id)||jobs.has(`capture-${record.id}`)||captureJobs.has(record.id)))
      ||app.store.list<ControllerRun>('factory-controller-runs').some(run=>run.sessionId===sessionId&&(activeControllerOperations.has(run.id)||!!app.store.get<ControllerReviewContinuation>('factory-controller-reviews',run.id))),
    retire:async(sessionId,assertCurrent)=>app.withRuntimeOperation(()=>app.sessions.withRetirementLease(sessionId,()=>chats.manager.withIdleContainer(app.sessions.retirementContainerName(sessionId),()=>{
      const runtimeKinds=[...new Set(app.store.list<import('@enoughfactory/contracts').Chat>('chats').filter(chat=>chat.sessionId===sessionId).map(chat=>chat.runtime))];
      return app.sessions.retireEphemeralEnvironment(sessionId,app.dataDir,{assertCurrent,assertSpace:()=>hostDisk.assert(),runtimeKinds});
    }))),
  });
  const requestCleanup=(sessionId:string)=>terminalCleanup?.request(sessionId);
  app.sessions.afterTerminal.push(requestCleanup);
  const cleanupRuntimeReady=(topic:string,data:unknown)=>{if(topic==='runtime'&&(data as ContainerRuntimeStatus).state==='ready')void importArchives().then(()=>terminalCleanup?.reconcile());};
  app.listeners.add(cleanupRuntimeReady);
  app.closers.unshift(async()=>{coordinator.stop();app.listeners.delete(cleanupRuntimeReady);const index=app.sessions.afterTerminal.indexOf(requestCleanup);if(index>=0)app.sessions.afterTerminal.splice(index,1);await archiveImportJob;await terminalCleanup?.close();});
  terminalCleanup.start();
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
function checkResults(report: CheckReport, candidateCommit: string): CheckResult[] {
  const results:CheckResult[] = report.commands.map(command => {
    if(command.command===UI_QUALITY_CHECK_COMMAND){
      const quality=command.factoryQuality as CheckResult|undefined;
      if(quality&&typeof quality==='object'&&!Array.isArray(quality)&&quality.command===UI_QUALITY_CHECK_COMMAND&&quality.candidateCommit===candidateCommit&&quality.checkedCommit===report.commit)return {...quality,passed:quality.passed===true&&command.exitCode===0&&!command.timedOut};
      return {command:command.command,passed:false,output:'Recorded UI quality evidence does not identify the exact checked source.',exitCode:1,candidateCommit,checkedCommit:report.commit};
    }
    return {command:command.command,passed:command.exitCode===0&&!command.timedOut,output:`${command.stdout}${command.stderr}`,exitCode:command.exitCode,candidateCommit,checkedCommit:report.commit,developmentToolchain:command.developmentToolchain,executionTargetKind:command.executionTargetKind,hostPermissions:command.hostPermissions,...((command as Partial<AppleCheckResult>).appleValidation?{appleValidation:(command as AppleCheckResult).appleValidation}:{})};
  });
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
    runtime: body.runtime as Goal['runtime'] | undefined,execution:controls.execution,
    concurrency: numberOption(body.concurrency), maxAttempts: numberOption(body.maxAttempts), maxDurationMs: numberOption(body.maxDurationMs) };
}
function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, 'Budgets and concurrency must be numbers.'); return value;
}
function executionOption(value:unknown):Goal['execution'] {
  try{return validateTaskExecution(value);}catch(error){throw new HttpError(400,error instanceof Error?error.message:String(error));}
}
function steeringInput(body: Record<string, unknown>) {
  if (body.autonomy !== undefined && !['manual', 'assisted', 'autonomous'].includes(String(body.autonomy))) throw new HttpError(400, 'Unknown autonomy mode.');
  if (body.approvalMode !== undefined && !['approve-all', 'rules', 'manual'].includes(String(body.approvalMode))) throw new HttpError(400, 'Unknown approval policy.');
  return { objective: typeof body.objective === 'string' ? body.objective : undefined,
    context: typeof body.context === 'string' ? body.context : undefined,execution:executionOption(body.execution),
    criteria: body.criteria === undefined ? undefined : stringArray(body.criteria),
    autonomy: body.autonomy as Goal['autonomy'] | undefined, approvalMode: body.approvalMode as Goal['approvalMode'] | undefined };
}
