import type { Attempt, Chat, FactoryTask, Goal } from '@enoughfactory/contracts';
import type { AttemptDetail, FactoryStore } from '@enoughfactory/factory';

interface ChatWorker {
  id: string; coordinatorId: string; chatId?: string; sessionId?: string;
  status: string; goal: Goal; task: FactoryTask; attempt: Attempt;
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
