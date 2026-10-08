import type { Attempt, AttemptInspection, Device, ExecutionCapability, ExecutionReadiness, ExecutionTargetAdvertisement, FactoryTask, Goal, RuntimeKind } from "@enoughfactory/contracts";
import type { TaskDetail } from "./types.js";

const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Goal defaults never replace an explicit task contract or an allocated attempt's frozen requirements. */
export function effectiveTaskExecution(task: FactoryTask, goal: Pick<Goal, "execution">): FactoryTask {
  return task.execution === undefined && goal.execution !== undefined ? { ...task, execution: goal.execution } : task;
}

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

/** Older services advertise only their existing container, never inferred Mac or visual tools. */
export function deviceExecutionTargets(device: Device): ExecutionTargetAdvertisement[] {
  if (device.executionTargets !== undefined) return device.executionTargets.filter(target => target.protocolVersion === 1);
  return [{ id: `${device.id}:container`, kind: "container", protocolVersion: 1,
    readiness: device.online ? "ready" : "offline", capabilities: [{ kind: "linux-shell", readiness: device.online ? "ready" : "offline" }],
    capacity: device.capacity ?? 2, resources: device.workerResources, workspaceProviders: device.workspaceProviders ?? ["git"] }];
}

function supportsWorkspace(target: ExecutionTargetAdvertisement, device: Device, provider: "git" | "artifactfs"): boolean {
  return (target.workspaceProviders ?? (target.kind === "container" ? device.workspaceProviders ?? ["git"] : ["git"])).includes(provider);
}

function authorTargets(task: Pick<FactoryTask, "execution">, device: Device, provider: "git" | "artifactfs" = "git", runtime?: RuntimeKind): ExecutionTargetAdvertisement[] {
  const preference = task.execution?.target ?? "container";
  return deviceExecutionTargets(device).filter(target => (preference === "auto" || target.kind === preference) && supportsWorkspace(target, device, provider) &&
    (runtime === undefined || (target.runtimes ?? (target.kind === "host-macos" ? ["codex"] : ["codex", "antigravity", "claude"])).includes(runtime)))
    .sort((left, right) => Number(left.kind !== "container") - Number(right.kind !== "container") || lexical(left.id, right.id));
}

function localCapabilities(task: Pick<FactoryTask, "execution">, target: ExecutionTargetAdvertisement): ExecutionCapability[] {
  return [...new Set<ExecutionCapability>([target.kind === "container" ? "linux-shell" : "mac-shell", ...task.execution?.requiredCapabilities ?? []])];
}

function readyAuthorTarget(task: Pick<FactoryTask, "execution">, target: ExecutionTargetAdvertisement): boolean {
  return target.readiness === "ready" && localCapabilities(task, target).every(kind => target.capabilities.some(capability => capability.kind === kind && capability.readiness === "ready"));
}

/** Resolve author location only. Delegated tools can be supplied by a different device. */
export function selectExecutionTarget(task: Pick<FactoryTask, "execution">, device: Device, provider: "git" | "artifactfs" = "git", runtime: RuntimeKind = "codex"): ExecutionTargetAdvertisement | undefined {
  return device.online ? authorTargets(task, device, provider, runtime).find(target => readyAuthorTarget(task, target)) : undefined;
}

export interface ExecutionCapabilityBlocker {
  kind: "execution-capability"; readiness: Exclude<ExecutionReadiness, "ready">; reason: string;
  capabilities?: ExecutionCapability[]; deviceIds?: string[]; targetIds?: string[];
}

const readinessRank: Record<Exclude<ExecutionReadiness, "ready">, number> = { busy: 0, preparing: 1, offline: 2, "setup-required": 3, unsupported: 4 };

/** Unsupported requirements wait before an attempt exists; transient delegated tools queue their jobs. */
export function taskCapabilityBlocker(task: FactoryTask, devices: Device[], authorDevices = devices, provider: "git" | "artifactfs" = "git", runtime: RuntimeKind = "codex"): ExecutionCapabilityBlocker | undefined {
  const authors = authorDevices.filter(device => !task.deviceId || task.deviceId === device.id);
  if (!authors.some(device => selectExecutionTarget(task, device, provider, runtime))) {
    const failures: ExecutionCapabilityBlocker[] = [];
    for (const device of authors) for (const target of authorTargets(task, device, provider, runtime)) {
      const requirements = localCapabilities(task, target);
      const unavailable = requirements.filter(kind => !target.capabilities.some(capability => capability.kind === kind && capability.readiness === "ready"));
      const advertised = unavailable.map(kind => target.capabilities.find(capability => capability.kind === kind));
      const readiness: ExecutionCapabilityBlocker["readiness"] = !device.online ? "offline" : target.readiness !== "ready" ? target.readiness
        : advertised.some(capability => !capability) ? "unsupported" : advertised.map(capability => capability!.readiness).filter((state): state is ExecutionCapabilityBlocker["readiness"] => state !== "ready").sort((left, right) => readinessRank[left] - readinessRank[right])[0] ?? "unsupported";
      failures.push({ kind: "execution-capability", readiness, capabilities: unavailable, deviceIds: [device.id], targetIds: [target.id],
        reason: target.reason ?? advertised.find(capability => capability?.reason)?.reason ?? `Waiting for ${unavailable.join(", ") || `${target.kind} execution`} on ${device.name} (${readiness}).` });
    }
    return failures.sort((left, right) => readinessRank[left.readiness] - readinessRank[right.readiness])[0] ?? {
      kind: "execution-capability", readiness: "unsupported", deviceIds: authors.map(device => device.id),
      capabilities: task.execution?.requiredCapabilities, reason: `No configured ${task.execution?.target === "host-macos" ? "Mac host" : "compatible author"} execution target supports this task with ${runtime} and ${provider}.`,
    };
  }
  const qualityCapabilities: ExecutionCapability[] = (task.quality?.platforms ?? []).map(platform => platform === "web" ? "chromium-inspection" : platform === "macos" ? "macos-app-inspection" : "ios-simulator-inspection");
  for (const kind of new Set([...task.execution?.delegatedCapabilities ?? [], ...qualityCapabilities])) {
    const available = devices.flatMap(device => deviceExecutionTargets(device).map(target => ({ device, target, capability: target.capabilities.find(capability => capability.kind === kind) })));
    if (available.some(({ device, target, capability }) => device.online && ["ready", "busy", "preparing"].includes(target.readiness) && capability && ["ready", "busy", "preparing"].includes(capability.readiness))) continue;
    const failures = available.filter(item => item.capability).map(({ device, target, capability }): ExecutionCapabilityBlocker => {
      const readiness = !device.online ? "offline" : target.readiness !== "ready" ? target.readiness : capability!.readiness;
      return { kind: "execution-capability", readiness: readiness === "ready" ? "unsupported" : readiness, capabilities: [kind], deviceIds: [device.id], targetIds: [target.id],
        reason: capability!.reason ?? target.reason ?? `Waiting for ${kind} on ${device.name} (${readiness}).` };
    });
    return failures.sort((left, right) => readinessRank[left.readiness] - readinessRank[right.readiness])[0] ?? {
      kind: "execution-capability", readiness: "unsupported", capabilities: [kind], reason: `No configured device supports the required ${kind} tool.`,
    };
  }
  return undefined;
}

/** The caller supplies live/reserved attempts as tasks, including unresolved remote cancellation. */
export function placementConstraint(task: FactoryTask, device: Device, activeTasks: FactoryTask[], provider: "git" | "artifactfs" = "git", runtime: RuntimeKind = "codex"): string | undefined {
  const target = selectExecutionTarget(task, device, provider, runtime);
  if (!target) return "No ready execution target supports this task.";
  const active = activeTasks.filter(item => !verificationOnlyReservation(item) && (!item.deviceId || item.deviceId === device.id) &&
    ((item as FactoryTask & Pick<Attempt, "executionTargetKind">).executionTargetKind ?? "container") === target.kind);
  const capacity = target.capacity ?? (target.kind === "container" ? device.capacity ?? 2 : 1);
  if (active.length >= capacity) return `Worker capacity reached (${active.length} / ${capacity} active tasks).`;
  const resources = target.resources ?? (target.kind === "container" ? device.workerResources : undefined);
  if (!resources) return undefined;
  const cpus = task.resources?.cpus ?? 1, memoryGiB = task.resources?.memoryGiB ?? 1;
  const availableCpus = resources.cpus - active.reduce((sum, item) => sum + (item.resources?.cpus ?? 1), 0);
  const availableMemory = resources.memoryGiB - active.reduce((sum, item) => sum + (item.resources?.memoryGiB ?? 1), 0);
  if (cpus > availableCpus) return `Needs ${cpus} CPU; ${Math.max(0, availableCpus)} CPU available on ${device.name}.`;
  if (memoryGiB > availableMemory) return `Needs ${memoryGiB} GiB memory; ${Math.max(0, availableMemory)} GiB available on ${device.name}.`;
  return undefined;
}

export interface SchedulingBlocker {
  kind: "dependency" | "write-conflict" | "goal-capacity" | "device-capacity" | "resource" | "device-unavailable" | "execution-capability";
  reason: string;
  taskIds?: string[];
  deviceIds?: string[];
  readiness?: ExecutionCapabilityBlocker["readiness"]; capabilities?: ExecutionCapability[]; targetIds?: string[];
}

/** Source ownership remains reserved while a finished author waits for its separate verifier. */
export function verificationOnlyReservation(task: FactoryTask): boolean {
  return (task as FactoryTask & { verificationOnly?: boolean }).verificationOnly === true;
}

export interface CheckInputBlocker {
  kind: "verification-inputs";
  reason: string;
  missingEnvironment: string[];
}

/** Only authenticated coordinator configuration can satisfy a planned verification prerequisite. */
export function taskCheckInputBlocker(detail: Pick<TaskDetail, "requiredCheckEnvironment" | "checkInputs">): CheckInputBlocker | undefined {
  const missingEnvironment = [...new Set(detail.requiredCheckEnvironment ?? [])].filter(key => {
    const value = detail.checkInputs?.environment?.[key];
    return typeof value !== "string" || !value.trim();
  });
  return missingEnvironment.length ? { kind: "verification-inputs", missingEnvironment,
    reason: "Waiting for verification evidence from the coordinator." } : undefined;
}

/** Shared dispatch/inspection explanation. Repository ownership and unresolved attempts are supplied by the caller. */
export function taskSchedulingBlocker(task: FactoryTask, goal: Goal, tasks: FactoryTask[], activeTasks: FactoryTask[],
  conflictingTasks: FactoryTask[], devices: Device[]): SchedulingBlocker | undefined {
  task = effectiveTaskExecution(task, goal);
  const byId = new Map(tasks.map(item => [item.id, item]));
  const dependencies = task.dependsOn.filter(id => byId.get(id)?.status !== "completed");
  if (dependencies.length) return { kind: "dependency", taskIds: dependencies,
    reason: `Waiting for dependencies: ${dependencies.map(id => byId.get(id)?.title ?? id).join(", ")}.` };
  if (activeTasks.some(item => item.id === task.id)) return { kind: "write-conflict", taskIds: [task.id],
    reason: "Prior execution of this task remains active or its cancellation is unconfirmed." };
  const conflicts = [...new Map(conflictingTasks.filter(item => tasksConflict(task, item)).map(item => [item.id, item])).values()];
  if (conflicts.length) return { kind: "write-conflict", taskIds: conflicts.map(item => item.id),
    reason: `Waiting for overlapping write paths: ${conflicts.map(item => item.title).join(", ")}.` };
  const activeForGoal = activeTasks.filter(item => item.goalId === goal.id && !verificationOnlyReservation(item)).length;
  if (activeForGoal >= goal.concurrency) return { kind: "goal-capacity",
    reason: `Goal concurrency reached (${activeForGoal} / ${goal.concurrency} active tasks).` };
  const provider = goal.workspaceProvider ?? "git";
  const allowed = devices.filter(device => (!task.deviceId || task.deviceId === device.id) &&
    authorTargets(task, device, provider).length > 0);
  const eligible = allowed.filter(device => device.online);
  if (!eligible.length) {
    const candidates = devices.filter(device => !task.deviceId || task.deviceId === device.id);
    if ((task.execution !== undefined || task.quality !== undefined) && candidates.some(device => device.online)) {
      const blocker = taskCapabilityBlocker(task, devices, candidates, provider, goal.runtime);
      if (blocker) return blocker;
    }
    return { kind: "device-unavailable", deviceIds: allowed.map(device => device.id),
      reason: provider === "artifactfs" ? "Waiting for an online worker with ArtifactFS support." : "Waiting for an online worker." };
  }
  const capabilityBlocker = taskCapabilityBlocker(task, devices, allowed, provider, goal.runtime);
  if (capabilityBlocker) return capabilityBlocker;
  const constraints = eligible.map(device => ({ device, reason: placementConstraint(task, device, activeTasks, provider, goal.runtime) }));
  if (constraints.some(item => item.reason === undefined)) return undefined;
  const resource = constraints.find(item => !item.reason!.startsWith("Worker capacity reached"));
  return { kind: resource ? "resource" : "device-capacity", deviceIds: eligible.map(device => device.id),
    reason: resource?.reason ?? constraints[0]!.reason! };
}

/** One reservation per attempt. Retired-but-unconfirmed effects keep their original owner and write footprint. */
export function activeExecutionTasks(tasks: FactoryTask[], attempts: Attempt[], unconfirmedAttemptIds = new Set<string>(),
  contractsByAttempt?: Map<string, AttemptInspection["contract"]>, verificationWaitAttemptIds = new Set<string>()): FactoryTask[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const active: FactoryTask[] = [], included = new Set<string>();
  const reserve = (task: FactoryTask, attempt: Attempt, uncertain: boolean): void => {
    const contract = contractsByAttempt?.get(attempt.id);
    const reservation = { ...task, deviceId: attempt.deviceId, currentAttemptId: attempt.id,
      executionTargetId: attempt.executionTargetId, executionTargetKind: attempt.executionTargetKind ?? "container",
      verificationOnly: !uncertain && attempt.status === "succeeded" && verificationWaitAttemptIds.has(attempt.id) };
    if (contract) {
      reservation.estimatedMinutes = contract.estimatedMinutes;
      reservation.writePaths = contract.writePaths;
      reservation.resources = contract.resources;
      reservation.execution = contract.execution;
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
