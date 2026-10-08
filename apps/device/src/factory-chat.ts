import type { Attempt, Chat, FactoryTask, Goal, InspectionVerificationRun, Session } from '@enoughfactory/contracts';
import type { AttemptDetail, FactoryStore } from '@enoughfactory/factory';
import { HttpError } from './util.ts';
import { inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verifier.ts';
import { inspectionGoalQuality } from './inspection-goal-quality.ts';

interface ChatWorker {
  id: string; coordinatorId: string; chatId?: string; sessionId?: string;
  status: string; goal: Goal; task: FactoryTask; attempt: Attempt;
}

/** A new provider turn cannot modify an ended candidate or bypass its task by opening another chat. */
export function assertFactoryChatCanStartTurn(store: FactoryStore, chat: Chat, deviceId: string, requestedAttemptId?: string,requestedVerificationRunId?:string): ReturnType<typeof factoryChatBinding> {
  if(chat.verificationRunId||requestedVerificationRunId){
    assertVerificationChatCanStartTurn(store,chat,deviceId,requestedAttemptId,requestedVerificationRunId);
    return undefined;
  }
  const workers = store.list<ChatWorker>('factory-workers');
  const worker = workers.find(record => record.chatId === chat.id) ?? workers.find(record => record.sessionId === chat.sessionId);
  const session = store.get<Session>('sessions', chat.sessionId);
  const verificationReserved = !!session?.verificationRunId || store.list<InspectionVerificationRun>('inspection-verifier-runs').some(run => run.chatId === chat.id || run.sessionId === chat.sessionId);
  if (verificationReserved) throw new HttpError(409, 'This session belongs to a factory inspection verifier. Continue through its task verification.', 'INSPECTION_VERIFICATION_STALE');
  // Worker environments are ephemeral; durable attempts remain authoritative
  // after their worker rows have been retired.
  const durableAttempt = store.list<Attempt>('attempts').find(attempt => attempt.chatId === chat.id || attempt.sessionId === chat.sessionId);
  if (!worker && !chat.attemptId && !durableAttempt) return undefined;
  const attemptId = worker?.id ?? chat.attemptId ?? durableAttempt!.id;
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

/** An independent verifier can inspect retained source after authoring ends. It
 * cannot reopen the author chat or use its marker to bypass ordinary task guards.
 */
function assertVerificationChatCanStartTurn(store:FactoryStore,chat:Chat,deviceId:string,requestedAttemptId?:string,requestedVerificationRunId?:string):void {
  const run=store.get<InspectionVerificationRun>('inspection-verifier-runs',chat.verificationRunId??'');
  const session=store.get<Session>('sessions',chat.sessionId);
  const authority=run?.authority;
  const attempt=authority&&store.get<Attempt>('attempts',authority.attemptId);
  const task=authority&&store.get<FactoryTask>('tasks',authority.taskId);
  const goal=authority&&store.get<Goal>('goals',authority.goalId);
  const detail=authority&&store.get<AttemptDetail>('factory-attempt-details',authority.attemptId);
  // Final verification preserves its accepted author identity while the current
  // goal revision and union of frozen requirements authorize the separate review.
  const finalGoal=run?.purpose==='goal-final';
  const purposeValid=finalGoal?Number.isSafeInteger(run.goalRevision)&&run.goalRevision!>=0:
    (run?.purpose===undefined||run.purpose==='task')&&run?.goalRevision===undefined;
  const trustedQuality=finalGoal&&goal?inspectionGoalQuality(store,goal.id):detail?.contract?detail.contract.quality:task?.quality;
  const taskCurrent=!!task&&!!goal&&!!detail&&(finalGoal?
    task.status==='completed'&&run.goalRevision===goal.revision&&detail.goalId===goal.id&&detail.goalRevision<=goal.revision&&
      !!detail.integration&&detail.integration.candidateCommit===detail.candidate?.commit&&
      store.list<FactoryTask>('tasks').filter(item=>item.goalId===goal.id).every(item=>item.status==='completed'||item.status==='canceled'):
    task.status==='review'&&!detail.integration&&detail.goalRevision===goal.revision);
  const workerOwnsSession=store.list<ChatWorker>('factory-workers').some(worker=>worker.sessionId===chat.sessionId||worker.chatId===chat.id)||store.list<Attempt>('attempts').some(author=>author.sessionId===chat.sessionId||author.chatId===chat.id);
  const valid=!!run&&!!authority&&!!session&&!!attempt&&!!task&&!!goal&&!!detail&&
    purposeValid&&taskCurrent&&
    !!requestedVerificationRunId&&chat.verificationRunId===requestedVerificationRunId&&run.id===requestedVerificationRunId&&
    chat.attemptId===undefined&&requestedAttemptId===authority.attemptId&&!workerOwnsSession&&
    run.chatId===chat.id&&run.sessionId===chat.sessionId&&run.ownerDeviceId===deviceId&&chat.deviceId===deviceId&&session.deviceId===deviceId&&
    session.verificationRunId===run.id&&session.executionTargetKind===run.executionTargetKind&&session.executionTargetId===run.executionTargetId&&
    run.status==='running'&&session.status==='ready'&&!session.archivedAt&&Date.parse(run.deadlineAt)>Date.now()&&
    attempt.chatId!==chat.id&&attempt.sessionId!==chat.sessionId&&attempt.taskId===task.id&&attempt.generation===authority.authorityGeneration&&attempt.status==='succeeded'&&
    task.goalId===goal.id&&task.currentAttemptId===attempt.id&&goal.coordinatorId===deviceId&&
    !['paused','completed','failed','canceled'].includes(goal.status)&&chat.approvalMode===goal.approvalMode&&detail.cancellation==='none'&&
    (detail.assignmentGoalRevision??detail.goalRevision)===authority.goalRevision&&authority.policyRevision===authority.goalRevision&&
    !!detail.candidate&&detail.candidate.id===run.source.candidateId&&detail.candidate.commit===run.source.candidateCommit&&
    !!trustedQuality&&run.policySha256===inspectionQualityPolicySha256(trustedQuality)&&run.policySha256===inspectionQualityPolicySha256(run.quality)&&run.id===inspectionVerificationKey(run)&&
    /^[a-f0-9]{64}$/.test(run.source.sha256)&&/^[a-f0-9]{40,64}$/.test(run.source.checkedCommit??'')&&/^[a-f0-9]{64}$/.test(run.policySha256);
  if(!valid)throw new HttpError(409,'This inspection verifier no longer owns the exact retained candidate. Its source, evidence and author history remain saved.','INSPECTION_VERIFICATION_STALE');
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
  const instructions = `Continue the assigned EnoughFactory task in its existing workspace.\nGoal:\n${goal.objective}\nGoal criteria:\n${goal.criteria.join('\n')}\nTask:\n${assignment.title}\n${assignment.description}\nAcceptance criteria:\n${(assignment.acceptanceCriteria ?? []).join('\n')}\nExpected outputs:\n${(assignment.expectedOutputs ?? []).join('\n')}\nChecks:\n${(contract?.checks ?? []).join('\n')}\nMake routine decisions and deliver the task completely. The factory owns continuation, capture, checks and integration. Preserve prior work and inspect it before repeating actions. ${worker.attempt.executionTargetKind==='host-macos'?'You run on the configured Mac with full same-user host access in a private workspace; this is not a container sandbox.':'You have full permissions inside this container.'} Enough owns the ${goal.approvalMode} approval policy.`;
  return { attemptId: worker.id, instructions };
}
