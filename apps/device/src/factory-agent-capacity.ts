import type { Store } from './store.ts';

type CapacityStore = Pick<Store, 'list' | 'get'>;
interface ActorClaim { id: string; chatIds: Set<string> }
interface WorkerClaim {
  id: string; goal: { id: string }; status: string; chatId?: string;
  attempt?: { id: string; chatId?: string };
}
interface AttemptClaim { id: string; taskId: string; status: string; chatId?: string }
interface TaskClaim { goalId: string; currentAttemptId?: string }
interface ReviewClaim {
  id: string; authority: { goalId: string }; status: string; chatId?: string;
  providerUnresolved?: boolean; retirementStatus?: string;
}
interface ControllerClaim { id: string; goalId: string; status: string; chatId?: string; providerUnresolved?: boolean }

/**
 * Count durable agent reservations across author and independent review lanes.
 * Preparing claims reserve capacity before a chat exists. Unknown execution keeps
 * its slot until its owner records reconciliation; an idle chat alone is no proof.
 * Exclusions name the current actor, for example `verifier:verify-...`.
 */
export function goalAgentCount(store: CapacityStore, goalId: string, exclude: string[] = [], includeWorkers = true): number {
  const excluded = new Set(exclude), actors = new Map<string, ActorClaim>();
  const add = (id: string, ...chatIds: Array<string | undefined>) => {
    if (excluded.has(id)) return;
    const actor = actors.get(id) ?? { id, chatIds: new Set<string>() };
    for (const chatId of chatIds) if (chatId) actor.chatIds.add(chatId);
    actors.set(id, actor);
  };

  if (includeWorkers) {
    const workers = store.list<WorkerClaim>('factory-workers'), workerAttempts = new Set<string>();
    for (const worker of workers) {
      const attemptId = worker.attempt?.id ?? worker.id;
      workerAttempts.add(attemptId);
      if (worker.goal?.id !== goalId || !['preparing', 'prepared', 'running', 'unknown'].includes(worker.status)) continue;
      const attempt = store.get<AttemptClaim>('attempts', attemptId);
      add(`worker:${attemptId}`, worker.chatId, worker.attempt?.chatId, attempt?.chatId);
    }
    for (const attempt of store.list<AttemptClaim>('attempts')) {
      if (workerAttempts.has(attempt.id) || !['created', 'running', 'unknown'].includes(attempt.status)) continue;
      const task = store.get<TaskClaim>('tasks', attempt.taskId);
      if (task?.goalId === goalId && task.currentAttemptId === attempt.id) add(`worker:${attempt.id}`, attempt.chatId);
    }
  }

  for (const audit of store.list<ReviewClaim>('inspection-profile-audits')) {
    if (audit.authority?.goalId !== goalId || audit.retirementStatus && audit.providerUnresolved !== true) continue;
    if (['preparing', 'running'].includes(audit.status) || audit.status === 'unknown' && (!!audit.chatId || audit.providerUnresolved === true)) {
      add(`audit:${audit.id}`, audit.chatId);
    }
  }
  for (const verifier of store.list<ReviewClaim>('inspection-verifier-runs')) {
    if (verifier.authority?.goalId === goalId && ['preparing', 'running', 'unknown'].includes(verifier.status)) add(`verifier:${verifier.id}`, verifier.chatId);
  }

  const controllers = store.list<ControllerClaim>('factory-controller-runs'), controllerIds = new Set(controllers.map(run => run.id));
  for (const input of store.list<ControllerClaim>('factory-controller-inputs')) {
    if (input.goalId === goalId && !controllerIds.has(input.id) && ['preparing', 'prepared'].includes(input.status)) add(`controller:${input.id}`, input.chatId);
  }
  for (const controller of controllers) {
    if (controller.goalId !== goalId) continue;
    const chat = controller.chatId && store.get<{ status: string }>('chats', controller.chatId);
    if (controller.status === 'starting' || controller.status === 'unknown' || controller.providerUnresolved === true
      || controller.status === 'running' && chat && ['running', 'waiting'].includes(chat.status)) add(`controller:${controller.id}`, controller.chatId);
  }

  // Several durable journals can name one provider. Union all shared chat edges
  // so even transitive duplicate claims occupy a single inference slot.
  const parents = new Map([...actors.keys()].map(id => [id, id])), chatOwners = new Map<string, string>();
  const root = (id: string): string => {
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current)!;
    let previous = id;
    while (parents.get(previous) !== current) { const next = parents.get(previous)!; parents.set(previous, current); previous = next; }
    return current;
  };
  for (const actor of actors.values()) for (const chatId of actor.chatIds) {
    const owner = chatOwners.get(chatId);
    if (owner) parents.set(root(actor.id), root(owner));
    else chatOwners.set(chatId, actor.id);
  }
  return new Set([...actors.keys()].map(root)).size;
}
