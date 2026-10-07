import type { Attempt, Chat, FactoryTask, Goal } from '@enoughfactory/contracts';
import type { AttemptDetail, FactoryStore } from '@enoughfactory/factory';
import { HttpError } from './util.ts';

interface ChatWorker {
  id: string; coordinatorId: string; chatId?: string; sessionId?: string;
  status: string; goal: Goal; task: FactoryTask; attempt: Attempt;
}

/** A new provider turn cannot modify an ended candidate or bypass its task by opening another chat. */
export function assertFactoryChatCanStartTurn(store: FactoryStore, chat: Chat, deviceId: string, requestedAttemptId?: string): ReturnType<typeof factoryChatBinding> {
  const workers = store.list<ChatWorker>('factory-workers');
  const worker = workers.find(record => record.chatId === chat.id) ?? workers.find(record => record.sessionId === chat.sessionId);
  if (!worker && !chat.attemptId) return undefined;
  const attemptId = worker?.id ?? chat.attemptId!;
  const attempt = store.get<Attempt>('attempts', attemptId);
  const task = store.get<FactoryTask>('tasks', worker?.task.id ?? attempt?.taskId ?? '');
  const detail = store.get<AttemptDetail>('factory-attempt-details', attemptId);
  const binding = factoryChatBinding(store, chat, deviceId);
  const localAuthority = !worker || worker.coordinatorId === deviceId;
  const ended = !!worker && !['prepared', 'running', 'unknown'].includes(worker.status) ||
    !!attempt && ['failed', 'succeeded', 'retired'].includes(attempt.status) ||
    !!task && ['review', 'completed', 'failed', 'canceled'].includes(task.status);
  const stale = !binding || (requestedAttemptId !== undefined && requestedAttemptId !== binding.attemptId) ||
    (localAuthority && (!detail || detail.cancellation !== 'none' || !!detail.candidate || !!detail.integration));
  if (!ended && !stale) return binding;
  throw new HttpError(409,
    'This factory attempt has ended or changed. Open its task and choose Retry task with instructions to continue in a new attempt. Its existing changes and checks remain preserved.',
    'FACTORY_TASK_RETRY_REQUIRED', {
      goalId: task?.goalId ?? worker?.goal.id ?? detail?.goalId ?? '', taskId: task?.id ?? worker?.task.id ?? attempt?.taskId ?? '',
      attemptId, taskStatus: task?.status ?? worker?.task.status ?? 'unknown', reason: ended ? 'attempt-ended' : 'authority-changed',
    });
}

/** Recover conversation ownership from the worker journal, never from a prompt or a title. */
export function factoryChatBinding(store: FactoryStore, chat: Chat, deviceId: string): { attemptId: string; instructions: string } | undefined {
  const worker = store.list<ChatWorker>('factory-workers').find(record => record.chatId === chat.id && record.sessionId === chat.sessionId && ['prepared', 'running', 'unknown'].includes(record.status));
  if (!worker || (chat.attemptId && chat.attemptId !== worker.id)) return undefined;
  let goal = worker.goal, task = worker.task;
  let contract = store.get<AttemptDetail>('factory-attempt-details', worker.id)?.contract;
  if (worker.coordinatorId === deviceId) {
    const attempt = store.get<Attempt>('attempts', worker.id), currentTask = store.get<FactoryTask>('tasks', worker.task.id);
    const currentGoal = store.get<Goal>('goals', worker.goal.id), detail = store.get<AttemptDetail>('factory-attempt-details', worker.id);
    if (!attempt || !currentTask || !currentGoal || !detail || attempt.status === 'retired' || attempt.generation !== worker.attempt.generation || currentTask.currentAttemptId !== worker.id || currentTask.status === 'canceled' || detail.goalRevision !== currentGoal.revision || ['completed', 'canceled', 'failed'].includes(currentGoal.status)) return undefined;
    goal = currentGoal; task = currentTask;
    contract = detail.contract;
  }
  const assignment = contract ?? task;
  const instructions = `Continue the assigned EnoughFactory task in its existing workspace.\nGoal:\n${goal.objective}\nGoal criteria:\n${goal.criteria.join('\n')}\nTask:\n${assignment.title}\n${assignment.description}\nAcceptance criteria:\n${(assignment.acceptanceCriteria ?? []).join('\n')}\nExpected outputs:\n${(assignment.expectedOutputs ?? []).join('\n')}\nChecks:\n${(contract?.checks ?? []).join('\n')}\nMake routine decisions and deliver the task completely. The factory owns continuation, capture, checks and integration. Preserve prior work and inspect it before repeating actions. You have full permissions inside this container; Enough owns the ${goal.approvalMode} approval policy.`;
  return { attemptId: worker.id, instructions };
}
