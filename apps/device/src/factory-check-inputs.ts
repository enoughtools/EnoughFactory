import { randomUUID } from 'node:crypto';
import type { Attempt, Chat, Decision, FactoryTask, Goal, Project } from '@enoughfactory/contracts';
import type { AttemptDetail, ControlRecord, FactoryStore, FrozenTaskCheckInputs, TaskCheckInputsConfiguration, TaskDetail } from '@enoughfactory/factory';
import { validateCheckInputs } from '@enoughfactory/workspaces';
import { HttpError } from './util.ts';

interface CheckInputRequest {
  expectedGoalRevision?: unknown; expectedAttemptId?: unknown; workingDirectoryIds?: unknown; environment?: unknown;
}
interface Dependencies {
  store: FactoryStore; deviceId: string; workerBusy(attemptId: string): boolean; chatIsRunning(chatId: string): boolean;
  now?: () => string;
}
function conflict(message: string): never { throw new HttpError(409, message, 'CHECK_INPUTS_CHANGED'); }

/** Synchronous compare-and-set: configuration changes neither dispatch nor waiting state. */
export function configureTaskCheckInputs(taskId: string, input: CheckInputRequest, deps: Dependencies): TaskCheckInputsConfiguration {
  const { store } = deps;
  return store.transaction(() => {
    if (!Number.isInteger(input.expectedGoalRevision) || Number(input.expectedGoalRevision) < 1 ||
        input.expectedAttemptId !== null && (typeof input.expectedAttemptId !== 'string' || !input.expectedAttemptId)) throw new HttpError(400, 'Identify the exact goal revision and current attempt, or null for a task without an attempt.');
    const task = store.get<FactoryTask>('tasks', taskId), detail = store.get<TaskDetail>('factory-task-details', taskId);
    if (!task || !detail) throw new HttpError(404, 'Task not found.');
    const goal = store.get<Goal>('goals', task.goalId), control = store.get<ControlRecord>('factory-control', task.goalId);
    if (!goal || goal.coordinatorId !== deps.deviceId || goal.revision !== input.expectedGoalRevision ||
        ['completed', 'failed', 'canceled'].includes(goal.status) || control?.operation ||
        !['queued', 'ready', 'failed'].includes(task.status) || (task.deviceId && task.deviceId !== deps.deviceId) ||
        (task.currentAttemptId ?? null) !== input.expectedAttemptId) conflict('The local task or goal changed, is active, or no longer accepts check inputs.');
    const attempt = task.currentAttemptId ? store.get<Attempt>('attempts', task.currentAttemptId) : undefined;
    const attemptDetail = task.currentAttemptId ? store.get<AttemptDetail>('factory-attempt-details', task.currentAttemptId) : undefined;
    const worker = task.currentAttemptId ? store.get<{ coordinatorId: string; status: string; result?: { status: string } }>('factory-workers', task.currentAttemptId) : undefined;
    if (task.currentAttemptId && (!attempt || attempt.taskId !== task.id || attempt.deviceId !== deps.deviceId ||
        attempt.status !== 'failed' || !attempt.endedAt || !attemptDetail || attemptDetail.goalId !== goal.id ||
        attemptDetail.cancellation !== 'none' || deps.workerBusy(attempt.id) || worker &&
        (worker.coordinatorId !== deps.deviceId || !['succeeded', 'failed'].includes(worker.status) || worker.result?.status === 'unknown'))) conflict('The current attempt is active, revoked or has an uncertain execution outcome.');
    if (task.currentAttemptId && store.list<Chat>('chats').some(chat => (chat.attemptId === task.currentAttemptId || !!attempt?.sessionId && chat.sessionId === attempt.sessionId) &&
        (['running', 'waiting', 'interrupted'].includes(chat.status) || deps.chatIsRunning(chat.id)))) conflict('The task has an active or unresolved conversation.');
    if (task.currentAttemptId && store.list<{ input?: { attemptId?: string }; status?: string }>('factory-manual-continuation-retentions').some(retention => retention.input?.attemptId === task.currentAttemptId && retention.status !== 'retained')) conflict('A manual source retention is still pending.');
    const project = store.get<Project>('projects', goal.projectId);
    if (!project || project.deviceId !== deps.deviceId) conflict('The configured check inputs must belong to this local project.');
    let frozen: FrozenTaskCheckInputs;
    try {
      frozen = validateCheckInputs({ configurationRevision: (detail.checkInputs?.configurationRevision ?? 0) + 1,
        workingDirectoryIds: input.workingDirectoryIds, environment: input.environment },
      (project.workingDirectories ?? []).map(root => ({ id: root.id, containerPath: `/workspaces/${root.name}` })))!;
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error), 'INVALID_CHECK_INPUTS'); }
    const at = deps.now?.() ?? new Date().toISOString();
    const configuration: TaskCheckInputsConfiguration = { ...frozen, goalRevision: goal.revision,
      configuredAgainstAttemptId: task.currentAttemptId ?? null, configuredAt: at, configuredByDeviceId: deps.deviceId };
    store.set('factory-task-details', { ...detail, checkInputs: configuration });
    store.set<Decision>('decisions', { id: randomUUID(), goalId: goal.id, at, kind: 'task-check-inputs',
      text: `Configured verification inputs for ${task.title}; existing attempts and waiting state are unchanged.`,
      data: { taskId: task.id, ...configuration } });
    return configuration;
  });
}

/** Repeated preparation observes one attempt's original choice, including no configured inputs. */
export function freezeTaskCheckInputs(store: FactoryStore, taskId: string, attemptId: string, project: Project): FrozenTaskCheckInputs | undefined {
  return store.transaction(() => {
    const saved = store.get<{ id: string; checkInputs?: FrozenTaskCheckInputs }>('factory-attempt-check-inputs', attemptId);
    if (saved) return validateCheckInputs(saved.checkInputs);
    const configured = store.get<TaskDetail>('factory-task-details', taskId)?.checkInputs;
    const frozen = configured ? validateCheckInputs({ configurationRevision: configured.configurationRevision,
      workingDirectoryIds: configured.workingDirectoryIds, environment: configured.environment },
    (project.workingDirectories ?? []).map(root => ({ id: root.id, containerPath: `/workspaces/${root.name}` }))) : undefined;
    const detail = store.get<AttemptDetail>('factory-attempt-details', attemptId);
    if (!detail) throw new Error('Cannot freeze check inputs without the owning attempt record.');
    store.set('factory-attempt-check-inputs', { id: attemptId, checkInputs: frozen });
    store.set('factory-attempt-details', { ...detail, checkInputs: frozen });
    return frozen;
  });
}
