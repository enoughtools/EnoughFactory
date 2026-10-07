import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Attempt, FactoryTask, Goal, Project } from '@enoughfactory/contracts';
import type { AttemptDetail, FactoryStore, PlanRecord, TaskDetail } from '@enoughfactory/factory';
import type { WorkingDirectoryManager, WorkingDirectorySource, WorkspaceManager } from '@enoughfactory/workspaces';
import { prepareControllerContext, type SelectedCandidate } from './controller-context.ts';

const maxCandidates = 8;
const maxBundleBytes = 256 * 1024 * 1024;
export interface WorkerEvidenceContext {
  version: 1;
  assignment: { goalId: string; goalRevision: number; taskId: string; attemptId: string; generation: number };
  source: WorkingDirectorySource;
  candidates: Array<{ id: string; taskId: string; commit: string; baseCommit: string }>;
  instructions: string;
}

/** Current authority may advance for an independent branch; its assignment stays frozen. */
export function assertCurrentWorkerAssignment(store: FactoryStore, input: { goal: Goal; task: FactoryTask; attempt: Attempt }): void {
  const goal = store.get<Goal>('goals', input.goal.id), task = store.get<FactoryTask>('tasks', input.task.id);
  const attempt = store.get<Attempt>('attempts', input.attempt.id), detail = store.get<AttemptDetail>('factory-attempt-details', input.attempt.id);
  const frozen = detail?.contract;
  if (!goal || !task || !attempt || !detail || goal.coordinatorId !== input.goal.coordinatorId || detail.goalId !== goal.id
    || task.goalId !== goal.id || task.currentAttemptId !== input.attempt.id || task.status === 'canceled'
    || attempt.taskId !== task.id || attempt.generation !== input.attempt.generation || attempt.deviceId !== input.attempt.deviceId || attempt.status === 'retired'
    || detail.cancellation !== 'none' || detail.goalRevision !== goal.revision || ['completed', 'canceled', 'failed'].includes(goal.status)
    || (detail.assignmentGoalRevision ?? detail.goalRevision) !== input.goal.revision
    || frozen && assignmentFingerprint(frozen) !== assignmentFingerprint(input.task)) throw new Error('Worker preparation or execution authority changed; retained reference inputs cannot authorize this assignment.');
}

/** Current goal guidance and unresolved retained work supplement dependency evidence. */
export function workerCandidates(store: FactoryStore, goal: Goal, task: FactoryTask, attempt: Attempt): { selected: SelectedCandidate[]; omitted: number } {
  const detail = store.get<AttemptDetail>('factory-attempt-details', attempt.id);
  const assignment = detail?.contract ?? task;
  const taskDetail = store.get<TaskDetail>('factory-task-details', task.id);
  const plan = store.get<PlanRecord>('factory-plans', goal.id), currentGoal = store.get<Goal>('goals', goal.id);
  const text = [assignment.title, assignment.description, ...(assignment.acceptanceCriteria ?? []), ...(assignment.expectedOutputs ?? []), taskDetail?.repairInstructions, taskDetail?.replanInstructions,
    plan?.goalId === goal.id && plan.revision === (currentGoal?.revision ?? goal.revision) ? plan.summary : undefined].filter(Boolean).join('\n');
  const tasks = new Map(store.list<FactoryTask>('tasks').filter(item => item.goalId === goal.id && item.id !== task.id).map(item => [item.id, item]));
  const inventory = new Map<string, SelectedCandidate>();
  const latest = new Map<string, SelectedCandidate>();
  function add(owner: FactoryTask, candidate: SelectedCandidate['candidate'] | undefined, preferred = false) {
    if (!candidate) return;
    const existing = inventory.get(candidate.id);
    if (existing && (existing.task.id !== owner.id || existing.candidate.commit !== candidate.commit || existing.candidate.baseCommit !== candidate.baseCommit)) throw new Error('Retained candidate references have inconsistent task or commit ownership.');
    const item = { task: owner, candidate };
    inventory.set(candidate.id, item);
    if (preferred || !latest.has(owner.id)) latest.set(owner.id, item);
  }
  for (const owner of tasks.values()) {
    const current = owner.currentAttemptId ? store.get<AttemptDetail>('factory-attempt-details', owner.currentAttemptId) : undefined;
    if (current?.goalId === goal.id) add(owner, current.candidate);
    add(owner, store.get<TaskDetail>('factory-task-details', owner.id)?.lastCandidate, true);
  }
  for (const previous of store.list<Attempt>('attempts').sort((left, right) => right.startedAt.localeCompare(left.startedAt))) {
    const owner = tasks.get(previous.taskId), retained = store.get<AttemptDetail>('factory-attempt-details', previous.id);
    if (owner && retained?.goalId === goal.id) add(owner, retained.candidate);
  }
  const selected = new Map<string, SelectedCandidate>();
  for (const item of inventory.values()) if (mentions(text, item.candidate.id) || mentions(text, item.candidate.commit)) selected.set(item.candidate.id, item);
  // A repair can need an unfinished sibling without depending on it (that edge
  // would create a cycle). Its retained output is reference evidence, not source
  // automatically accepted into this task's tree. Prefer recent plan ownership.
  for (const owner of [...tasks.values()].filter(owner => owner.status !== 'completed').sort((left, right) =>
    (store.get<TaskDetail>('factory-task-details', right.id)?.planRevision ?? 0) - (store.get<TaskDetail>('factory-task-details', left.id)?.planRevision ?? 0)
    || right.updatedAt.localeCompare(left.updatedAt))) {
    const item = latest.get(owner.id); if (item) selected.set(item.candidate.id, item);
  }
  const dependencyIds = new Set<string>();
  const visit = (id: string) => {
    if (dependencyIds.has(id)) return;
    const owner = tasks.get(id); if (!owner) return;
    dependencyIds.add(id);
    for (const parent of owner.dependsOn) visit(parent);
  };
  for (const id of assignment.dependsOn) visit(id);
  for (const owner of tasks.values()) if (mentions(text, owner.id)) dependencyIds.add(owner.id);
  for (const id of dependencyIds) {
    const item = latest.get(id);
    if (item) selected.set(item.candidate.id, item);
  }
  const all = [...selected.values()];
  return { selected: all.slice(0, maxCandidates), omitted: Math.max(0, all.length - maxCandidates) };
}

export async function prepareWorkerContext(input: {
  goal: Goal; task: FactoryTask; attempt: Attempt; project: Project; store: FactoryStore;
  workspaces: WorkspaceManager; directoryManager: WorkingDirectoryManager; dataDir: string;
  reservedNames?: string[]; assertCurrent(): void;
}): Promise<WorkerEvidenceContext | undefined> {
  input.assertCurrent();
  const frozen = input.store.get<{ id: string; generation: number; goalId: string; goalRevision: number; taskId: string; assignment: string; context?: WorkerEvidenceContext }>('factory-worker-context', input.attempt.id);
  const fingerprint = assignmentFingerprint(input.task);
  if (frozen) {
    if (frozen.generation !== input.attempt.generation || frozen.goalId !== input.goal.id || frozen.goalRevision !== input.goal.revision || frozen.taskId !== input.task.id || frozen.assignment !== fingerprint) throw new Error('Worker reference evidence identity already belongs to a different frozen assignment.');
    if (frozen.context) { assertWorkerContext(frozen.context, input); await input.workspaces.artifacts.path(frozen.context.source.sourceArtifact); }
    input.assertCurrent();
    return frozen.context;
  }
  const save = (context?: WorkerEvidenceContext) => {
    input.assertCurrent();
    input.store.set('factory-worker-context', { id: input.attempt.id, generation: input.attempt.generation, goalId: input.goal.id, goalRevision: input.goal.revision, taskId: input.task.id, assignment: fingerprint, context });
    return context;
  };
  const { selected, omitted } = workerCandidates(input.store, input.goal, input.task, input.attempt);
  if (!selected.length) return save();
  const operation = workerContextOperation(input.attempt.id, input.attempt.generation);
  const used = new Set((input.reservedNames ?? []).map(name => name.toLowerCase()));
  const base = `ef-context-${input.attempt.id.slice(0, 24)}`;
  let name = base, suffix = 2;
  while (used.has(name.toLowerCase())) name = `${base}-${suffix++}`;
  const assignment = { goalId: input.goal.id, goalRevision: input.goal.revision, taskId: input.task.id, attemptId: input.attempt.id, generation: input.attempt.generation };
  try {
    const prepared = await prepareControllerContext({ ...input, operation, role: 'worker', goalId: input.goal.id,
      project: { ...input.project, workingDirectories: [] }, selected, contextName: name, bundlesOnly: true, maxBundleBytes,
      assignment, assertCurrent: input.assertCurrent });
    input.assertCurrent();
    const source = prepared.workingDirectorySources[0];
    if (!source || prepared.workingDirectorySources.length !== 1) throw new Error('Worker reference evidence must have one separate immutable source.');
    return save({ version: 1, assignment, source,
      candidates: selected.map(({ task, candidate }) => ({ id: candidate.id, taskId: task.id, commit: candidate.commit, baseCommit: candidate.baseCommit })),
      instructions: `Retained reference evidence is available at ${source.containerPath}. It is a disposable inspectable copy of verified immutable bundles, separate from your authored working folders. Treat it as read-only evidence; full container permissions can change the copy, but cannot change the retained originals. ${omitted ? `${omitted} additional relevant candidates were omitted by the ${maxCandidates}-candidate bound. ` : ''}${prepared.instructions}\nInspect the exact required commit and copy only the files or changes needed for your assigned task into the primary repository. Do not cherry-pick or replace the whole candidate implicitly. Preserve the current accepted tree, task ownership and unrelated work. Reference edits are excluded from candidate capture and integration.` });
  } catch (error) {
    await disposeWorkerContext(input.dataDir, input.attempt.id, input.attempt.generation);
    throw error;
  }
}

export function assertWorkerContext(context: WorkerEvidenceContext, assignment: { goal: Goal; task: FactoryTask; attempt: Attempt }): void {
  const expected = context?.assignment;
  if (context?.version !== 1 || !expected || expected.goalId !== assignment.goal.id || expected.goalRevision !== assignment.goal.revision
    || expected.taskId !== assignment.task.id || expected.attemptId !== assignment.attempt.id || expected.generation !== assignment.attempt.generation
    || !context.source || typeof context.instructions !== 'string' || !Array.isArray(context.candidates) || context.candidates.length > maxCandidates
    || context.candidates.some(candidate => candidate.taskId === assignment.task.id)) throw new Error('Worker reference evidence belongs to a different frozen assignment.');
}

export async function disposeWorkerContext(dataDir: string, attemptId: string, generation: number): Promise<void> {
  const operation = workerContextOperation(attemptId, generation);
  // Only disposable aggregate snapshots are removed; content-addressed retained
  // candidate artifacts remain available to later attempts and controllers.
  await rm(path.join(dataDir, 'workspace-data', 'working-directories', `${operation}-evidence-context`), { recursive: true, force: true });
}

function workerContextOperation(attemptId: string, generation: number) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(attemptId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid worker reference context identity.');
  return `worker-${createHash('sha256').update(attemptId).digest('hex').slice(0, 32)}-${generation}`;
}
function mentions(text: string, token: string) {
  return !!token && new RegExp(`(?<![a-zA-Z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_-])`).test(text);
}
function assignmentFingerprint(task: Pick<FactoryTask, 'title' | 'description' | 'kind' | 'acceptanceCriteria' | 'expectedOutputs' | 'writePaths' | 'resources' | 'dependsOn'>) {
  return JSON.stringify({ title: task.title, description: task.description, kind: task.kind, acceptanceCriteria: task.acceptanceCriteria ?? [], expectedOutputs: task.expectedOutputs ?? [], writePaths: task.writePaths ?? [], resources: task.resources, dependsOn: task.dependsOn });
}
