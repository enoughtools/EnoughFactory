import type { Artifact, Attempt, AttemptInspection, ControllerRun, Device, FactoryTask, Goal, GoalInspection, TaskCheck, TaskInspection, TaskOverview } from '@enoughfactory/contracts';
import type { AttemptDetail, ControlRecord, FactoryStore, PlanRecord, TaskDetail } from '@enoughfactory/factory';

/** A read projection of coordinator receipts. It never advances or retries work. */
export function inspectAttempt(store: FactoryStore, attempt: Attempt): AttemptInspection {
  const detail = store.get<AttemptDetail>('factory-attempt-details', attempt.id);
  const candidate = detail?.candidate, workspace = detail?.workspace, result = detail?.result, integration = detail?.integration;
  return { attempt, phase: detail?.phase, cancellation: detail?.cancellation, contract: detail?.contract,
    ...(workspace ? { workspace: { id: workspace.id, provider: workspace.provider, baseCommit: workspace.baseCommit, sessionId: workspace.sessionId, deviceId: workspace.deviceId } } : {}),
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
  if (task.status === 'failed') return { ...base, state: 'failed', reason: detail?.lastError || attempt?.error };
  if (attempt?.status === 'unknown') return { ...base, state: 'unknown', reason: attempt?.error || 'Reconcile the execution owner before authorizing a replacement.' };
  if (task.status === 'running' || task.status === 'review') {
    const phase = attemptDetail?.phase;
    return { ...base, state: phase && phase !== 'done' ? phase : task.status,
      reason: goal?.status === 'paused' && !!attemptDetail?.candidate ? 'Candidate retained; integration waits for the goal to resume.' : undefined };
  }
  const dependencies = task.dependsOn.map(id => store.get<FactoryTask>('tasks', id));
  const blocked = task.dependsOn.filter((_, index) => dependencies[index]?.status !== 'completed');
  if (blocked.length) return { ...base, state: 'blocked', reason: `Waiting for ${blocked.map(id => dependencies.find(item => item?.id === id)?.title || id).join(', ')}.` };
  if (!goal) return { ...base, state: 'waiting', reason: 'The coordinating goal is unavailable.' };
  if (goal.status === 'paused') return { ...base, state: 'waiting', reason: 'Goal paused.' };
  if (['canceled', 'failed', 'completed'].includes(goal.status)) return { ...base, state: 'waiting', reason: `Goal ${goal.status}; no new work will be dispatched.` };
  if (goal.status === 'waiting') return { ...base, state: 'waiting', reason: control?.waitReason || goal.nextAction };
  const siblingTasks = store.list<FactoryTask>('tasks').filter(item => item.goalId === goal.id);
  if (siblingTasks.some(item => item.currentAttemptId && store.get<Attempt>('attempts', item.currentAttemptId)?.status === 'unknown')) return { ...base, state: 'waiting', reason: 'The coordinator must reconcile an unknown execution outcome before dispatching more work.' };
  if (siblingTasks.some(item => item.status === 'failed')) return { ...base, state: 'queued', reason: 'The coordinator must diagnose the confirmed failure before dispatching more work.' };
  if (control && ['plan', 'diagnose', 'evaluate'].includes(control.stage)) return { ...base, state: 'queued', reason: `The factory is ${control.stage === 'plan' ? 'planning' : control.stage === 'diagnose' ? 'diagnosing a failure' : 'evaluating the goal'}.` };
  if (goal.autonomy !== 'autonomous' && !detail?.selected) return { ...base, state: 'queued', reason: 'Select this task to authorize execution.' };
  const tasks = store.list<FactoryTask>('tasks');
  const occupied = tasks.filter(item => item.goalId === goal.id && ['running', 'review'].includes(item.status)).length;
  if (occupied >= goal.concurrency) return { ...base, state: 'queued', reason: `Waiting for a slot in the goal's ${goal.concurrency} concurrent tasks.` };
  const active = store.list<Attempt>('attempts').filter(item => ['created', 'running', 'unknown'].includes(item.status));
  const available = devices.some(device => device.online && (!task.deviceId || device.id === task.deviceId)
    && (goal.workspaceProvider !== 'artifactfs' || device.workspaceProviders?.includes('artifactfs'))
    && active.filter(item => item.deviceId === device.id).length < (device.capacity ?? 2));
  if (!available) return { ...base, state: 'waiting', reason: `Waiting for an online ${goal.workspaceProvider === 'artifactfs' ? 'ArtifactFS-capable ' : ''}worker with capacity${task.deviceId ? ' on the assigned device' : ''}.` };
  return { ...base, state: 'ready', reason: 'Dependencies satisfied; eligible for dispatch.' };
}

export function inspectTask(store: FactoryStore, devices: Device[], task: FactoryTask): TaskInspection {
  const detail = store.get<TaskDetail>('factory-task-details', task.id);
  const plan = store.get<PlanRecord>('factory-plans', task.goalId);
  const tasks = store.list<FactoryTask>('tasks');
  return { ...inspectTaskOverview(store, devices, task), detailsAvailable: !!detail, checks: [...new Set([...(plan?.checks ?? []), ...(detail?.checks ?? [])])],
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
    ...(control ? { control: { stage: control.stage, waitingFor: control.waitingFor, waitReason: control.waitReason, wakeAt: control.wakeAt, replanReason: control.replanReason, diagnosisTaskId: control.diagnosisTaskId,
      operation: control.operation ? { kind: control.operation.kind, revision: control.operation.revision } : undefined, spent: control.spent, unpricedTurns: control.unpricedTurns, maxDurationMs: control.maxDurationMs } } : {}) };
}
