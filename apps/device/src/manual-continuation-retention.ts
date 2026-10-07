import { createHash } from 'node:crypto';
import type { Attempt, Chat, ChatEvent, Decision, FactoryTask, Goal, WorkingDirectoryMount } from '@enoughfactory/contracts';
import type { AttemptDetail, CandidateRef, FactoryStore, TaskDetail, WorkspaceRef } from '@enoughfactory/factory';
import type { WorkingDirectoryCapture } from '@enoughfactory/workspaces';
import { HttpError } from './util.ts';

/** Explicit adoption of one conclusively ended, unbound legacy turn as unchecked repair input. */
export interface ManualContinuationInput {
  goalId: string; taskId: string; goalRevision: number; attemptId: string;
  oldCandidateId: string; chatId: string;
  turn: { userMessageSeq: number; lastEventSeq: number; completedAt: string };
}
export interface ManualContinuationContext {
  input: ManualContinuationInput; goal: Goal; task: FactoryTask; attempt: Attempt;
  workspace: WorkspaceRef; sessionId: string; chat: Chat; oldCandidate: CandidateRef;
  manualTurnOutcome: 'succeeded' | 'failed';
}
export interface ManualContinuationReceipt {
  id: string; input: ManualContinuationInput; createdAt: string; updatedAt: string;
  status: 'pending' | 'retained';
  manualTurnOutcome?: 'succeeded' | 'failed';
  commit?: string; workingDirectories?: WorkingDirectoryCapture[]; candidate?: CandidateRef;
}
export interface ManualContinuationDependencies {
  store: FactoryStore; deviceId: string;
  /** Complete transcript, including its latest event; callers must paginate stored events. */
  readChatEvents(chatId: string): ChatEvent[];
  chatIsRunning(chatId: string): boolean;
  workerJobsBusy(attemptId: string): boolean;
  /** Commit all primary work in the owned container before it is stopped. */
  captureGitCommit(context: ManualContinuationContext): Promise<string>;
  /** Refresh every additional folder while the ended turn's container is still available. */
  captureExtras(context: ManualContinuationContext): Promise<WorkingDirectoryCapture[]>;
  /** Refuse stopping if the journaled primary commit no longer represents every current source edit. */
  validateGitCommit(context: ManualContinuationContext, commit: string): Promise<void>;
  /** Stop and confirm envmux has harvested the primary repository. Must be idempotent. */
  stopSession(context: ManualContinuationContext): Promise<void>;
  /** A fresh WorkspaceManager.capture, never the worker's cached captureLocal result. */
  capture(context: ManualContinuationContext, input: { reference: string; workingDirectories: WorkingDirectoryCapture[] }): Promise<CandidateRef>;
  now?: () => Date; onChange?: () => void;
}

export const manualContinuationReceiptTable = 'factory-manual-continuation-retentions';
interface ChatCompletion { id: string; attemptId?: string; completedAt?: string; result: { threadId?: string; stopReason?: string }; }
interface ChatFailure { id: string; attemptId?: string; completedAt?: string; executionEnded?: boolean; }
interface RetentionWorker {
  id: string; coordinatorId: string; status: string; chatId?: string; sessionId?: string;
  goal: Goal; task: FactoryTask; attempt: Attempt; workspace?: WorkspaceRef; candidate?: CandidateRef;
}
const inFlight = new WeakMap<FactoryStore, Map<string, { key: string; operation: Promise<ManualContinuationReceipt> }>>();
function conflict(text: string): never { throw new HttpError(409, text, 'MANUAL_CONTINUATION_NOT_RETAINABLE'); }

/** Does not resume, verify, integrate, retire or rewrite any original attempt evidence. */
export async function retainManualContinuation(input: ManualContinuationInput, deps: ManualContinuationDependencies): Promise<ManualContinuationReceipt> {
  if (!input || !input.turn) throw new HttpError(400, 'Identify the exact completed manual turn.', 'INVALID_MANUAL_CONTINUATION');
  const stableInput: ManualContinuationInput = {
    goalId: input.goalId, taskId: input.taskId, goalRevision: input.goalRevision,
    attemptId: input.attemptId, oldCandidateId: input.oldCandidateId, chatId: input.chatId,
    turn: { userMessageSeq: input.turn.userMessageSeq, lastEventSeq: input.turn.lastEventSeq, completedAt: input.turn.completedAt },
  };
  if (!Number.isInteger(stableInput.goalRevision) || stableInput.goalRevision < 1 ||
      !Number.isInteger(stableInput.turn.userMessageSeq) || stableInput.turn.userMessageSeq < 1 ||
      !Number.isInteger(stableInput.turn.lastEventSeq) || stableInput.turn.lastEventSeq < stableInput.turn.userMessageSeq ||
      !Number.isFinite(Date.parse(stableInput.turn.completedAt)) ||
      [stableInput.goalId, stableInput.taskId, stableInput.attemptId, stableInput.oldCandidateId, stableInput.chatId].some(value => typeof value !== 'string' || !value)) {
    throw new HttpError(400, 'Identify the exact failed attempt, old candidate and completed manual turn.', 'INVALID_MANUAL_CONTINUATION');
  }
  const key = `manual-${createHash('sha256').update(JSON.stringify(stableInput)).digest('hex')}`;
  const existing = deps.store.get<ManualContinuationReceipt>(manualContinuationReceiptTable, key);
  if (existing?.status === 'retained') return existing;
  let jobs = inFlight.get(deps.store);
  if (!jobs) { jobs = new Map(); inFlight.set(deps.store, jobs); }
  const running = jobs.get(stableInput.attemptId);
  if (running) {
    if (running.key !== key) conflict('This attempt is already retaining a different manual turn. Wait for it to finish.');
    return running.operation;
  }
  const operation = performRetention(stableInput, key, deps).finally(() => jobs!.delete(stableInput.attemptId));
  jobs.set(stableInput.attemptId, { key, operation });
  return operation;
}

function authority(input: ManualContinuationInput, deps: ManualContinuationDependencies): ManualContinuationContext {
  const { store } = deps;
  const goal = store.get<Goal>('goals', input.goalId), task = store.get<FactoryTask>('tasks', input.taskId);
  const attempt = store.get<Attempt>('attempts', input.attemptId), detail = store.get<AttemptDetail>('factory-attempt-details', input.attemptId);
  const taskDetail = store.get<TaskDetail>('factory-task-details', input.taskId), worker = store.get<RetentionWorker>('factory-workers', input.attemptId);
  const chat = store.get<Chat>('chats', input.chatId), completion = store.get<ChatCompletion>('chat-results', input.chatId);
  const failure = store.get<ChatFailure>('chat-turn-failures', input.chatId);
  if (!goal || goal.coordinatorId !== deps.deviceId || goal.status !== 'paused' || goal.revision !== input.goalRevision) conflict('Keep the same goal revision paused before retaining its manual repair.');
  if (!task || task.goalId !== goal.id || task.status !== 'failed' || task.currentAttemptId !== input.attemptId ||
      !attempt || attempt.taskId !== task.id || attempt.status !== 'failed' || attempt.deviceId !== deps.deviceId || !attempt.endedAt ||
      !detail || detail.goalId !== goal.id || detail.goalRevision !== goal.revision || detail.cancellation !== 'none' || detail.integration ||
      !worker || !['succeeded', 'failed'].includes(worker.status) || worker.coordinatorId !== deps.deviceId || worker.goal.id !== goal.id || worker.task.id !== task.id ||
      worker.attempt.id !== attempt.id || worker.attempt.generation !== attempt.generation) {
    conflict('Only the current confirmed failed local attempt can retain this legacy manual repair.');
  }
  const oldCandidate = detail.candidate, workspace = detail.workspace;
  if (!oldCandidate || oldCandidate.id !== input.oldCandidateId || taskDetail?.lastCandidate?.id !== oldCandidate.id ||
      taskDetail.lastCandidate.commit !== oldCandidate.commit || worker.candidate?.id !== oldCandidate.id ||
      worker.candidate.commit !== oldCandidate.commit || attempt.candidate !== oldCandidate.commit ||
      !workspace || workspace.provider !== 'git' || worker.workspace?.id !== workspace.id ||
      (workspace.deviceId && workspace.deviceId !== deps.deviceId) || !worker.sessionId ||
      workspace.sessionId !== worker.sessionId || attempt.sessionId !== worker.sessionId ||
      attempt.chatId !== input.chatId || worker.chatId !== input.chatId) {
    conflict('The failed attempt, retained candidate, conversation and Git environment no longer have the expected ownership.');
  }
  if (!chat || chat.sessionId !== worker.sessionId || chat.deviceId !== deps.deviceId ||
      (chat.attemptId && chat.attemptId !== attempt.id) || !['idle', 'failed'].includes(chat.status) ||
      deps.chatIsRunning(chat.id) || deps.workerJobsBusy(attempt.id) ||
      store.list<Chat>('chats').some(other => other.sessionId === worker.sessionId && (deps.chatIsRunning(other.id) || other.status === 'running' || other.status === 'waiting'))) {
    conflict('An agent is active or its outcome is unknown. Wait for confirmed completion before retaining source.');
  }
  const succeeded = chat.status === 'idle' && completion?.attemptId === undefined && completion?.completedAt === input.turn.completedAt &&
    !!completion.result.threadId && completion.result.threadId === chat.threadId &&
    ['completed', 'end_turn', 'stop'].includes(completion.result.stopReason ?? '') && !failure;
  const failed = chat.status === 'failed' && !completion && failure?.attemptId === undefined &&
    failure?.completedAt === input.turn.completedAt && failure.executionEnded === true;
  if (!succeeded && !failed) {
    conflict('The latest conversation result is not the expected conclusively ended unbound manual turn. Interrupted or unknown outcomes cannot be retained this way.');
  }
  const events = deps.readChatEvents(chat.id), users = events.filter(event => event.chatId === chat.id && event.kind === 'message' && event.role === 'user');
  const latestUser = users.reduce<ChatEvent | undefined>((latest, event) => !latest || event.seq > latest.seq ? event : latest, undefined);
  const latestEvent = events.reduce<ChatEvent | undefined>((latest, event) => !latest || event.seq > latest.seq ? event : latest, undefined);
  const endedAt = Date.parse(attempt.endedAt), completedAt = Date.parse(input.turn.completedAt);
  if (!latestUser || latestUser.seq !== input.turn.userMessageSeq || !latestEvent || latestEvent.seq !== input.turn.lastEventSeq ||
      events.some(event => event.chatId !== chat.id) || !Number.isFinite(endedAt) ||
      !(Date.parse(latestUser.at) > endedAt) || !(completedAt >= Date.parse(latestUser.at)) ||
      !(completedAt >= Date.parse(latestEvent.at))) {
    conflict('The requested event range does not identify the latest manual turn after the original attempt ended.');
  }
  return { input, goal, task, attempt, workspace, sessionId: worker.sessionId, chat, oldCandidate, manualTurnOutcome: failed ? 'failed' : 'succeeded' };
}

async function performRetention(input: ManualContinuationInput, key: string, deps: ManualContinuationDependencies): Promise<ManualContinuationReceipt> {
  let context = authority(input, deps);
  const timestamp = () => (deps.now?.() ?? new Date()).toISOString();
  let receipt = deps.store.get<ManualContinuationReceipt>(manualContinuationReceiptTable, key) ??
    { id: key, input, status: 'pending' as const, createdAt: timestamp(), updatedAt: timestamp() };
  const save = (fields: Partial<ManualContinuationReceipt>) => {
    receipt = { ...receipt, ...fields, updatedAt: timestamp() };
    deps.store.set(manualContinuationReceiptTable, receipt);
  };
  save({ manualTurnOutcome: context.manualTurnOutcome });
  if (!receipt.commit) {
    const commit = await deps.captureGitCommit(context);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Manual repair preservation did not return an exact Git commit.');
    save({ commit });
  }
  context = authority(input, deps);
  if (!receipt.workingDirectories) {
    const roots = await deps.captureExtras(context), expected = context.workspace.workingDirectories as WorkingDirectoryMount[] | undefined;
    if (roots.length !== (expected?.length ?? 0) || expected?.some(root => !roots.some(capture => capture.id === root.id && capture.name === root.name && capture.baseCommit === root.baseCommit))) {
      throw new Error('Every additional working folder must have a fresh retained snapshot before the manual repair can be saved.');
    }
    save({ workingDirectories: roots });
  }
  context = authority(input, deps);
  await deps.validateGitCommit(context, receipt.commit!);
  context = authority(input, deps);
  await deps.stopSession(context);
  context = authority(input, deps);
  if (!receipt.candidate) {
    const candidate = await deps.capture(context, { reference: receipt.commit!, workingDirectories: receipt.workingDirectories! });
    if (!candidate.id || candidate.id === input.oldCandidateId || candidate.commit !== receipt.commit || candidate.baseCommit !== context.workspace.baseCommit ||
        candidate.workspaceId !== context.workspace.id || candidate.goalId !== input.goalId || candidate.taskId !== input.taskId ||
        candidate.attemptId !== input.attemptId || candidate.deviceId !== deps.deviceId ||
        JSON.stringify(candidate.workingDirectories ?? []) !== JSON.stringify(receipt.workingDirectories) ||
        JSON.stringify(candidate.developmentToolchain) !== JSON.stringify(context.workspace.developmentToolchain)) {
      throw new Error('Manual repair capture must create a new immutable candidate for the exact preserved source.');
    }
    save({ candidate });
  }
  deps.store.transaction(() => {
    authority(input, deps);
    const taskDetail = deps.store.get<TaskDetail>('factory-task-details', input.taskId)!;
    deps.store.set('factory-task-details', { ...taskDetail, lastCandidate: receipt.candidate });
    const decision: Decision = {
      id: key, goalId: input.goalId, at: timestamp(), kind: 'manual-continuation-retained',
      text: `${context.manualTurnOutcome === 'failed' ? 'Partial source from the conclusively failed manual turn' : 'The completed manual repair'} was retained as a new unchecked candidate for a future task attempt. Original attempt checks remain attached to their original candidate.`,
      data: { taskId: input.taskId, attemptId: input.attemptId, chatId: input.chatId, turn: input.turn, manualTurnOutcome: context.manualTurnOutcome, oldCandidateId: input.oldCandidateId, candidate: receipt.candidate, unchecked: true },
    };
    deps.store.set('decisions', decision);
    save({ status: 'retained' });
  });
  deps.onChange?.();
  return receipt;
}
