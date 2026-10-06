import type { Attempt, AttemptInspection, Device, FactoryTask, Goal } from "@enoughfactory/contracts";

const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Longest remaining dependency chain, including the task itself. Estimates guide order, not deadlines. */
export function criticalPathMinutes(tasks: FactoryTask[]): Map<string, number> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) continue;
      const next = dependents.get(dependency) ?? [];
      next.push(task.id);
      dependents.set(dependency, next);
    }
  }
  const ranks = new Map<string, number>(), visiting = new Set<string>();
  const rank = (id: string): number => {
    const cached = ranks.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id)!;
    if (task.status === "completed" || task.status === "canceled") {
      ranks.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}.`);
    visiting.add(id);
    const duration = task.estimatedMinutes ?? 1;
    const remaining = duration + Math.max(0, ...(dependents.get(id) ?? []).map(rank));
    visiting.delete(id);
    ranks.set(id, remaining);
    return remaining;
  };
  for (const task of tasks) rank(task.id);
  return ranks;
}

/** Dispatchable work first by its longest downstream chain, then by stable plan key or task ID. */
export function sortReadyTasks(tasks: FactoryTask[], stableKeys?: Map<string, string>): FactoryTask[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ranks = criticalPathMinutes(tasks);
  return tasks.filter(task => (task.status === "queued" || task.status === "ready") &&
    task.dependsOn.every(id => byId.get(id)?.status === "completed"))
    .sort((left, right) => ranks.get(right.id)! - ranks.get(left.id)! ||
      lexical(stableKeys?.get(left.id) ?? left.id, stableKeys?.get(right.id) ?? right.id) || lexical(left.id, right.id));
}

interface Footprint { path: string; partial: boolean; }

function footprint(value: string): Footprint {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^(?:\.\/)+/, "");
  const wildcard = normalized.search(/[*?\[\]{]/);
  const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
  const path = prefix.replace(/\/+$/, "");
  return { path: path === "." ? "" : path, partial: wildcard >= 0 && !!prefix && !prefix.endsWith("/") };
}

/** A footprint names a file or subtree; globs conservatively reserve their literal prefix. */
export function tasksConflict(left: FactoryTask, right: FactoryTask): boolean {
  if ((left.writePaths && !left.writePaths.length) || (right.writePaths && !right.writePaths.length)) return false;
  if (!left.writePaths?.length || !right.writePaths?.length) {
    // An unscoped uncertain execution reserves the whole repository, including legacy incoming work.
    return (left.writePaths ?? right.writePaths ?? []).some(value => !footprint(value).path);
  }
  return left.writePaths.some(leftPath => {
    const a = footprint(leftPath);
    return right.writePaths!.some(rightPath => {
      const b = footprint(rightPath);
      return !a.path || !b.path || a.path === b.path ||
        a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`) ||
        (a.partial && b.path.startsWith(a.path)) || (b.partial && a.path.startsWith(b.path));
    });
  });
}

/** The caller supplies live/reserved attempts as tasks, including unresolved remote cancellation. */
export function placementConstraint(task: FactoryTask, device: Device, activeTasks: FactoryTask[]): string | undefined {
  const active = activeTasks.filter(item => !item.deviceId || item.deviceId === device.id);
  const capacity = device.capacity ?? 2;
  if (active.length >= capacity) return `Worker capacity reached (${active.length} / ${capacity} active tasks).`;
  if (!device.workerResources) return undefined;
  const cpus = task.resources?.cpus ?? 1, memoryGiB = task.resources?.memoryGiB ?? 1;
  const availableCpus = device.workerResources.cpus - active.reduce((sum, item) => sum + (item.resources?.cpus ?? 1), 0);
  const availableMemory = device.workerResources.memoryGiB - active.reduce((sum, item) => sum + (item.resources?.memoryGiB ?? 1), 0);
  if (cpus > availableCpus) return `Needs ${cpus} CPU; ${Math.max(0, availableCpus)} CPU available on ${device.name}.`;
  if (memoryGiB > availableMemory) return `Needs ${memoryGiB} GiB memory; ${Math.max(0, availableMemory)} GiB available on ${device.name}.`;
  return undefined;
}

export interface SchedulingBlocker {
  kind: "dependency" | "write-conflict" | "goal-capacity" | "device-capacity" | "resource" | "device-unavailable";
  reason: string;
  taskIds?: string[];
  deviceIds?: string[];
}

/** Shared dispatch/inspection explanation. Repository ownership and unresolved attempts are supplied by the caller. */
export function taskSchedulingBlocker(task: FactoryTask, goal: Goal, tasks: FactoryTask[], activeTasks: FactoryTask[],
  conflictingTasks: FactoryTask[], devices: Device[]): SchedulingBlocker | undefined {
  const byId = new Map(tasks.map(item => [item.id, item]));
  const dependencies = task.dependsOn.filter(id => byId.get(id)?.status !== "completed");
  if (dependencies.length) return { kind: "dependency", taskIds: dependencies,
    reason: `Waiting for dependencies: ${dependencies.map(id => byId.get(id)?.title ?? id).join(", ")}.` };
  if (activeTasks.some(item => item.id === task.id)) return { kind: "write-conflict", taskIds: [task.id],
    reason: "Prior execution of this task remains active or its cancellation is unconfirmed." };
  const conflicts = [...new Map(conflictingTasks.filter(item => tasksConflict(task, item)).map(item => [item.id, item])).values()];
  if (conflicts.length) return { kind: "write-conflict", taskIds: conflicts.map(item => item.id),
    reason: `Waiting for overlapping write paths: ${conflicts.map(item => item.title).join(", ")}.` };
  const activeForGoal = activeTasks.filter(item => item.goalId === goal.id).length;
  if (activeForGoal >= goal.concurrency) return { kind: "goal-capacity",
    reason: `Goal concurrency reached (${activeForGoal} / ${goal.concurrency} active tasks).` };
  const provider = goal.workspaceProvider ?? "git";
  const allowed = devices.filter(device => (!task.deviceId || task.deviceId === device.id) &&
    (provider === "git" || device.workspaceProviders?.includes(provider)));
  const eligible = allowed.filter(device => device.online);
  if (!eligible.length) return { kind: "device-unavailable", deviceIds: allowed.map(device => device.id),
    reason: provider === "artifactfs" ? "Waiting for an online worker with ArtifactFS support." : "Waiting for an online worker." };
  const constraints = eligible.map(device => ({ device, reason: placementConstraint(task, device, activeTasks) }));
  if (constraints.some(item => item.reason === undefined)) return undefined;
  const resource = constraints.find(item => !item.reason!.startsWith("Worker capacity reached"));
  return { kind: resource ? "resource" : "device-capacity", deviceIds: eligible.map(device => device.id),
    reason: resource?.reason ?? constraints[0]!.reason! };
}

/** One reservation per attempt. Retired-but-unconfirmed effects keep their original owner and write footprint. */
export function activeExecutionTasks(tasks: FactoryTask[], attempts: Attempt[], unconfirmedAttemptIds = new Set<string>(),
  contractsByAttempt?: Map<string, AttemptInspection["contract"]>): FactoryTask[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const active: FactoryTask[] = [], included = new Set<string>();
  const reserve = (task: FactoryTask, attempt: Attempt, uncertain: boolean): void => {
    const contract = contractsByAttempt?.get(attempt.id);
    const reservation = { ...task, deviceId: attempt.deviceId, currentAttemptId: attempt.id };
    if (contract) {
      reservation.estimatedMinutes = contract.estimatedMinutes;
      reservation.writePaths = contract.writePaths;
      reservation.resources = contract.resources;
    }
    if (uncertain && (!reservation.writePaths?.length || (attempt.status === "retired" && !contract))) reservation.writePaths = ["**"];
    active.push(reservation);
    included.add(attempt.id);
  };
  for (const attempt of attempts) {
    const task = byId.get(attempt.taskId);
    if (!task) continue;
    if (attempt.status === "retired" && unconfirmedAttemptIds.has(attempt.id)) reserve(task, attempt, true);
    else if (task.currentAttemptId === attempt.id && ["created", "running", "unknown"].includes(attempt.status)) {
      reserve(task, attempt, attempt.status === "unknown");
    }
  }
  for (const task of tasks.filter(item => item.status === "review")) {
    if (task.currentAttemptId && included.has(task.currentAttemptId)) continue;
    const attempt = attempts.find(item => item.id === task.currentAttemptId);
    if (attempt) reserve(task, attempt, false);
    else active.push({ ...task });
  }
  return active;
}

/** Descendants across the complete graph, excluding the supplied roots. */
export function descendants(tasks: FactoryTask[], rootIds: string[]): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      const next = dependents.get(dependency) ?? [];
      next.push(task.id);
      dependents.set(dependency, next);
    }
  }
  const roots = new Set(rootIds), found = new Set<string>(), queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    for (const id of dependents.get(queue[index]!) ?? []) {
      if (roots.has(id) || found.has(id)) continue;
      found.add(id);
      queue.push(id);
    }
  }
  return found;
}
