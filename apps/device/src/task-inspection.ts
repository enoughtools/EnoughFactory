import type { Artifact, Attempt, AttemptInspection, ControllerRun, Device, FactoryTask, Goal, GoalInspection, Project, TaskCheck, TaskInspection, TaskOverview } from '@enoughfactory/contracts';
import type { AttemptDetail, ControlRecord, FactoryStore, PlanRecord, TaskDetail } from '@enoughfactory/factory';
import { activeExecutionTasks, taskSchedulingBlocker } from '@enoughfactory/factory';
import type { WorkingDirectoryCapture } from '@enoughfactory/workspaces';
import type { WorkingDirectoryMount } from '@enoughfactory/contracts';

/** Shared by read inspection and manual dispatch. Current execution contracts own reservations. */
export function taskDispatchBlocker(store: FactoryStore, devices: Device[], task: FactoryTask, goal: Goal) {
  const tasks = store.list<FactoryTask>('tasks').map(item => item.id === task.id ? task : item);
  const attempts = store.list<Attempt>('attempts');
  const details = store.list<AttemptDetail>('factory-attempt-details');
  const unconfirmed = new Set(details.filter(item => item.cancellation === 'requested').map(item => item.id));
  const contracts = new Map(details.map(item => [item.id, item.contract]));
  const active = activeExecutionTasks(tasks, attempts, unconfirmed, contracts);
  const projectPath = store.get<Project>('projects', goal.projectId)?.path;
  const conflicts = active.filter(item => {
    const other = store.get<Goal>('goals', item.goalId);
    return !!other && (other.projectId === goal.projectId || (!!projectPath && store.get<Project>('projects', other.projectId)?.path === projectPath));
  });
  return taskSchedulingBlocker(task, goal, tasks, active, conflicts, devices);
}

export function taskControlReason(task: FactoryTask, control: ControlRecord | undefined): string | undefined {
  if (control?.stage === 'evaluate') return 'The factory is evaluating the goal.';
  if (control?.stage === 'plan' && (!control.replanTaskIds?.length || control.replanTaskIds.includes(task.id))) return control.replanTaskIds?.length ? 'The factory is revising this dependency branch.' : 'The factory is planning the goal.';
  if (control?.stage === 'diagnose' && (!control.diagnosisTaskId || control.diagnosisTaskId === task.id)) return 'The factory is diagnosing this task\'s failure.';
  if (control?.stage === 'wait') return control.waitReason || 'The factory is waiting for its configured condition.';
  if (control?.stage === 'done') return 'The coordinator has finished this goal.';
  return undefined;
}

/** A read projection of coordinator receipts. It never advances or retries work. */
export function inspectAttempt(store: FactoryStore, attempt: Attempt): AttemptInspection {
  const detail = store.get<AttemptDetail>('factory-attempt-details', attempt.id);
  const candidate = detail?.candidate, workspace = detail?.workspace, result = detail?.result, integration = detail?.integration;
  const captures=candidate?.workingDirectories as WorkingDirectoryCapture[]|undefined;
  const workingDirectories=captures?.map(root=>({id:root.id,name:root.name,path:root.containerPath,kind:root.kind,baseCommit:root.baseCommit,status:'captured' as const,capture:{commit:root.commit,bundleArtifactId:root.bundleArtifact.id,diffArtifactId:root.diffArtifact.id}}))||workspace?.workingDirectories as WorkingDirectoryMount[]|undefined;
  return { attempt, phase: detail?.phase, cancellation: detail?.cancellation, contract: detail?.contract,
    ...(workspace ? { workspace: { id: workspace.id, provider: workspace.provider, baseCommit: workspace.baseCommit, sessionId: workspace.sessionId, deviceId: workspace.deviceId,workingDirectories } } : {}),
    ...(candidate ? { candidate: { id: candidate.id, commit: candidate.commit, baseCommit: candidate.baseCommit, branch: candidate.branch, tree: candidate.tree, deviceId: candidate.deviceId } } : {}),
    ...(result ? { result: { status: result.status, text: result.text, error: result.error, waitReason: result.waitReason, wakeCondition: result.wakeCondition } } : {}),
    ...(detail?.checks ? { checks: detail.checks.map(publicCheck) } : {}),
    ...(integration ? { integration: { commit: integration.commit, previousHead: integration.previousHead, candidateCommit: integration.candidateCommit, checks: integration.checks.map(publicCheck) } } : {}) };
}

function publicCheck(check: TaskCheck): TaskCheck {
  // Full logs remain immutable artifacts; keep inspection RPCs bounded for remote devices.
  const limit = 64 * 1024;
  return { command: check.command, passed: check.passed, output: check.output.slice(0, limit), exitCode: check.exitCode,
    candidateCommit: check.candidateCommit, checkedCommit: check.checkedCommit,
    ...(check.output.length > limit ? { outputTruncated: true } : {}) };
}

export function inspectTaskOverview(store: FactoryStore, devices: Device[], task: FactoryTask): TaskOverview {
  const goal = store.get<Goal>('goals', task.goalId);
  const control = store.get<ControlRecord>('factory-control', task.goalId);
  const detail = store.get<TaskDetail>('factory-task-details', task.id);
  const attempt = task.currentAttemptId ? store.get<Attempt>('attempts', task.currentAttemptId) : undefined;
  const attemptDetail = attempt ? store.get<AttemptDetail>('factory-attempt-details', attempt.id) : undefined;
  const base = { task, phase: attemptDetail?.phase, attemptId: attempt?.id };
  if (task.status === 'completed') return { ...base, state: 'accepted' };
  if (task.status === 'canceled') return { ...base, state: 'canceled', reason: attemptDetail?.cancellation === 'requested' ? 'Authority revoked; runtime termination has not been acknowledged.' : undefined };
  if (task.status === 'failed') {
    const controllerWait = control?.stage === 'diagnose' && control.diagnosisTaskId === task.id && !!control.waitingFor;
    return { ...base, state: detail?.waitingFor || controllerWait ? 'waiting' : 'failed', reason: detail?.waitReason || (controllerWait ? control?.waitReason : undefined) || detail?.lastError || attempt?.error };
  }
  if (attempt?.status === 'unknown') return { ...base, state: 'unknown', reason: attempt?.error || 'Reconcile the execution owner before authorizing a replacement.' };
  if (task.status === 'running' || task.status === 'review') {
    const phase = attemptDetail?.phase;
    return { ...base, state: phase && phase !== 'done' ? phase : task.status,
      reason: goal?.status === 'paused' && !!attemptDetail?.candidate ? 'Candidate retained; integration waits for the goal to resume.' : undefined };
  }
  if (!goal) return { ...base, state: 'waiting', reason: 'The coordinating goal is unavailable.' };
  if (goal.status === 'paused') return { ...base, state: 'waiting', reason: 'Goal paused.' };
  if (['canceled', 'failed', 'completed'].includes(goal.status)) return { ...base, state: 'waiting', reason: `Goal ${goal.status}; no new work will be dispatched.` };
  if (goal.status === 'waiting') return { ...base, state: 'waiting', reason: control?.waitReason || goal.nextAction };
  const coordinating = taskControlReason(task, control);
  if (coordinating) return { ...base, state: 'queued', reason: coordinating };
  const blocker = taskDispatchBlocker(store, devices, task, goal);
  if (blocker) return { ...base, state: blocker.kind === 'dependency' || blocker.kind === 'write-conflict' ? 'blocked' : blocker.kind === 'goal-capacity' || blocker.kind === 'device-capacity' ? 'queued' : 'waiting', reason: blocker.reason };
  if (goal.autonomy !== 'autonomous' && !detail?.selected) return { ...base, state: 'queued', reason: 'Select this task to authorize execution.' };
  return { ...base, state: 'ready', reason: 'Dependencies satisfied; eligible for dispatch.' };
}

export function inspectTask(store: FactoryStore, devices: Device[], task: FactoryTask): TaskInspection {
  const detail = store.get<TaskDetail>('factory-task-details', task.id);
  const plan = store.get<PlanRecord>('factory-plans', task.goalId);
  const tasks = store.list<FactoryTask>('tasks');
  return { ...inspectTaskOverview(store, devices, task), detailsAvailable: !!detail, checks: [...new Set([...(detail?.planChecks ?? plan?.checks ?? []), ...(detail?.checks ?? [])])],
    planRevision: detail?.planRevision, repairInstructions: detail?.repairInstructions, lastError: detail?.lastError,
    dependencies: task.dependsOn.flatMap(id => { const dependency = tasks.find(item => item.id === id); return dependency ? [dependency] : []; }),
    dependents: tasks.filter(item => item.dependsOn.includes(task.id)),
    attempts: store.list<Attempt>('attempts').filter(attempt => attempt.taskId === task.id).sort((a, b) => b.generation - a.generation).map(attempt => inspectAttempt(store, attempt)),
    artifacts: store.list<Artifact>('artifacts').filter(artifact => artifact.taskId === task.id).map(publicArtifact) };
}

function publicArtifact(artifact: Artifact): Artifact {
  return { id: artifact.id, name: artifact.name, mime: artifact.mime, sha256: artifact.sha256, size: artifact.size,
    deviceId: artifact.deviceId, createdAt: artifact.createdAt, goalId: artifact.goalId, taskId: artifact.taskId, attemptId: artifact.attemptId };
}

export function inspectGoal(store: FactoryStore, devices: Device[], goal: Goal): GoalInspection {
  const plan = store.get<PlanRecord>('factory-plans', goal.id), control = store.get<ControlRecord>('factory-control', goal.id);
  return { goal, tasks: store.list<FactoryTask>('tasks').filter(task => task.goalId === goal.id).map(task => inspectTaskOverview(store, devices, task)),
    controllers: store.list<ControllerRun>('factory-controller-runs').filter(run => run.goalId === goal.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(run => ({ id: run.id, goalId: run.goalId, role: run.role, sessionId: run.sessionId, chatId: run.chatId, status: run.status, updatedAt: run.updatedAt, error: run.error })),
    ...(plan ? { plan: { revision: plan.revision, summary: plan.summary, checks: plan.checks, createdAt: plan.createdAt } } : {}),
    ...(control ? { control: { stage: control.stage, waitingFor: control.waitingFor, waitReason: control.waitReason, wakeAt: control.wakeAt, replanReason: control.replanReason, replanTaskIds: control.replanTaskIds, diagnosisTaskId: control.diagnosisTaskId,
      operation: control.operation ? { kind: control.operation.kind, revision: control.operation.revision } : undefined, spent: control.spent, unpricedTurns: control.unpricedTurns, maxDurationMs: control.maxDurationMs } } : {}) };
}
