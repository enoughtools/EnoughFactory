import assert from "node:assert/strict";
import test from "node:test";
import type { Attempt, AttemptInspection, Device, FactoryTask, Goal } from "@enoughfactory/contracts";
import { activeExecutionTasks, criticalPathMinutes, descendants, deviceExecutionTargets, placementConstraint, selectExecutionTarget, sortReadyTasks, taskCapabilityBlocker, taskSchedulingBlocker, taskCheckInputBlocker, tasksConflict, verificationOnlyReservation, effectiveTaskExecution } from "./scheduler.js";
import type { TaskCheckInputsConfiguration } from "./types.js";

function task(id: string, patch: Partial<FactoryTask> = {}): FactoryTask {
  return { id, goalId: "goal", title: id, description: id, dependsOn: [], status: "queued",
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", ...patch };
}
function device(patch: Partial<Device> = {}): Device {
  return { id: "worker", name: "Worker", platform: "linux", arch: "x64", online: true, local: true,
    lastSeen: "2026-10-05T00:00:00.000Z", ...patch };
}

function macDevice(patch: Partial<Device> = {}): Device {
  return device({ id: "mac", name: "Mac", platform: "darwin", executionTargets: [
    { id: "mac:container", kind: "container", protocolVersion: 1, readiness: "ready", capacity: 1, capabilities: [{ kind: "linux-shell", readiness: "ready" }] },
    { id: "mac:host", kind: "host-macos", protocolVersion: 1, readiness: "ready", capacity: 1, resources: { cpus: 2, memoryGiB: 4 }, capabilities: [{ kind: "mac-shell", readiness: "ready" }, { kind: "macos-app-inspection", readiness: "ready" }] },
  ], ...patch });
}

test("host OS does not imply native execution and legacy placement stays inside its container", () => {
  const legacyMac = device({ platform: "darwin" });
  assert.deepEqual(deviceExecutionTargets(legacyMac).map(target => target.kind), ["container"]);
  assert.equal(selectExecutionTarget(task("legacy"), macDevice())?.kind, "container");
  assert.equal(selectExecutionTarget(task("native", { execution: { target: "host-macos" } }), legacyMac), undefined);
  assert.equal(taskCapabilityBlocker(task("native", { execution: { target: "auto", requiredCapabilities: ["mac-shell"] } }), [legacyMac])?.readiness, "unsupported");
  assert.equal(selectExecutionTarget(task("native", { execution: { target: "auto", requiredCapabilities: ["mac-shell"] } }), macDevice())?.id, "mac:host");
  assert.equal(selectExecutionTarget(task("blocked"), device({ executionTargets: [] })), undefined, "An explicit unsupported registry cannot fall back to a legacy container");
});

test("delegated inspection may run elsewhere, while unavailable support blocks before placement", () => {
  const author = device(), native = macDevice();
  const work = task("inspect", { deviceId: author.id, execution: { delegatedCapabilities: ["macos-app-inspection"] } });
  assert.equal(taskCapabilityBlocker(work, [author, native]), undefined);
  assert.equal(taskSchedulingBlocker(work, goal(), [work], [], [], [author, native]), undefined);
  const busy = structuredClone(native);
  busy.executionTargets![1]!.capabilities[1]!.readiness = "busy";
  assert.equal(taskCapabilityBlocker(work, [author, busy]), undefined, "Busy delegated tools queue jobs without forcing another author attempt");
  busy.executionTargets![1]!.capabilities[1]!.readiness = "preparing";
  assert.equal(taskCapabilityBlocker(work, [author, busy]), undefined);
  busy.executionTargets![1]!.capabilities[1]!.readiness = "setup-required";
  busy.executionTargets![1]!.capabilities[1]!.reason = "Enable accessibility for Mac testing.";
  assert.equal(taskCapabilityBlocker(work, [author, busy])?.reason, "Enable accessibility for Mac testing.");
  assert.equal(taskSchedulingBlocker(work, goal(), [work], [], [], [author, busy])?.readiness, "setup-required");
  assert.equal(taskCapabilityBlocker(work, [author, { ...native, online: false }])?.readiness, "offline");
  assert.deepEqual(taskCapabilityBlocker(work, [author])?.capabilities, ["macos-app-inspection"]);
});

test("local target readiness and budgets stay independent of container capacity", () => {
  const native = macDevice({ capacity: 0, workerResources: { cpus: 1, memoryGiB: 1 } });
  const work = task("native", { execution: { target: "host-macos" }, resources: { cpus: 2, memoryGiB: 4 } });
  const containerWork = task("container-work", { deviceId: native.id });
  assert.equal(placementConstraint(work, native, [containerWork]), undefined);
  const hostReservation = activeExecutionTasks([task("host-work", { deviceId: native.id, currentAttemptId: "running" })], [attempt("running", "host-work", { deviceId: native.id, executionTargetId: "mac:host", executionTargetKind: "host-macos" })]);
  assert.match(placementConstraint(work, native, hostReservation)!, /capacity reached/);
  assert.equal(placementConstraint(task("container-next"), native, hostReservation), undefined);
  native.executionTargets![1]!.readiness = "preparing";
  assert.equal(taskCapabilityBlocker(work, [native])?.readiness, "preparing");
  native.executionTargets![1]!.readiness = "busy";
  assert.equal(taskCapabilityBlocker(work, [native])?.readiness, "busy");
});

test("container workspace support cannot silently grant ArtifactFS to a host worker", () => {
  const native = macDevice({ workspaceProviders: ["git", "artifactfs"] });
  const work = task("native", { execution: { target: "host-macos" } });
  assert.equal(selectExecutionTarget(work, native, "artifactfs"), undefined);
  assert.equal(taskSchedulingBlocker(work, goal({ workspaceProvider: "artifactfs" }), [work], [], [], [native])?.kind, "execution-capability");
  native.executionTargets![1]!.workspaceProviders = ["git", "artifactfs"];
  assert.equal(selectExecutionTarget(work, native, "artifactfs")?.id, "mac:host");
  assert.equal(taskSchedulingBlocker(work, goal({ workspaceProvider: "artifactfs" }), [work], [], [], [native]), undefined);
});

test("host dispatch refuses an unadvertised provider without restricting legacy container providers", () => {
  const native = macDevice(), work = task("native", { execution: { target: "host-macos" } });
  assert.equal(selectExecutionTarget(work, native, "git", "claude"), undefined);
  assert.match(taskSchedulingBlocker(work, goal({ runtime: "claude" }), [work], [], [], [native])!.reason, /supports this task with claude/);
  assert.equal(selectExecutionTarget(task("legacy"), device(), "git", "antigravity")?.kind, "container");
  native.executionTargets![1]!.runtimes = ["codex", "claude"];
  assert.equal(selectExecutionTarget(work, native, "git", "claude")?.kind, "host-macos");
});

test("verification gating uses configured nonempty values and never infers requirements from source or checks", () => {
  const requiredCheckEnvironment = ["ENOUGH_EVIDENCE_ROOT", "ENOUGH_NATIVE_INDEX_SHA256"];
  const configured: TaskCheckInputsConfiguration = { configurationRevision: 1, workingDirectoryIds: [], environment: {}, goalRevision: 1, configuredAgainstAttemptId: null, configuredAt: "2026-10-08T00:00:00Z", configuredByDeviceId: "worker" };
  assert.equal(taskCheckInputBlocker({}), undefined);
  assert.equal(taskCheckInputBlocker({ requiredCheckEnvironment: [] }), undefined);
  assert.deepEqual(taskCheckInputBlocker({ requiredCheckEnvironment })?.missingEnvironment, requiredCheckEnvironment);
  const partial = { ...configured, environment: { ENOUGH_EVIDENCE_ROOT: "/workspaces/evidence", ENOUGH_NATIVE_INDEX_SHA256: "  " } };
  assert.deepEqual(taskCheckInputBlocker({ requiredCheckEnvironment, checkInputs: partial }), {
    kind: "verification-inputs", missingEnvironment: ["ENOUGH_NATIVE_INDEX_SHA256"], reason: "Waiting for verification evidence from the coordinator.",
  });
  assert.equal(taskCheckInputBlocker({ requiredCheckEnvironment, checkInputs: { ...partial, environment: { ...partial.environment, ENOUGH_NATIVE_INDEX_SHA256: "a".repeat(64) } } }), undefined);
  assert.deepEqual(partial.environment.ENOUGH_NATIVE_INDEX_SHA256, "  ", "eligibility never rewrites configuration or frozen attempt inputs");
});

test("ready work prioritizes the weighted critical path without dispatching blocked tasks", () => {
  const tasks = [
    task("standalone", { estimatedMinutes: 5 }), task("foundation", { estimatedMinutes: 2 }),
    task("ui", { dependsOn: ["foundation"], estimatedMinutes: 4 }),
    task("integration", { dependsOn: ["foundation"], estimatedMinutes: 7 }),
    task("delivery", { dependsOn: ["ui", "integration"], estimatedMinutes: 3 }),
    task("old", { status: "completed", estimatedMinutes: 100 }),
    task("canceled", { status: "canceled", estimatedMinutes: 100 }),
    task("missing", { dependsOn: ["absent"] }),
  ];
  const ranks = criticalPathMinutes(tasks);
  assert.equal(ranks.get("foundation"), 12);
  assert.equal(ranks.get("integration"), 10);
  assert.equal(ranks.get("ui"), 7);
  assert.equal(ranks.get("old"), 0);
  assert.equal(ranks.get("canceled"), 0);
  assert.deepEqual(sortReadyTasks(tasks).map(item => item.id), ["foundation", "standalone"]);
  const completed = tasks.map(item => item.id === "foundation" ? { ...item, status: "completed" as const } : item);
  assert.deepEqual(sortReadyTasks(completed).map(item => item.id), ["integration", "ui", "standalone"]);
});

test("default durations and stable lexical keys make equal-priority dispatch deterministic", () => {
  const tasks = [task("b"), task("a"), task("c", { dependsOn: ["a"], status: "completed" })];
  assert.deepEqual([...criticalPathMinutes(tasks)].sort(), [["a", 1], ["b", 1], ["c", 0]]);
  assert.deepEqual(sortReadyTasks(tasks).map(item => item.id), ["a", "b"]);
  assert.deepEqual(sortReadyTasks([...tasks].reverse()).map(item => item.id), ["a", "b"]);
  assert.deepEqual(sortReadyTasks(tasks, new Map([["a", "z"], ["b", "a"]])).map(item => item.id), ["b", "a"]);
});

test("write footprints reserve nested paths and conservative glob prefixes", () => {
  const conflicting = [
    ["src/components", "src/components/button.tsx"], ["./src/components/", "src/components"],
    ["src/**/*.ts", "src/app/main.ts"], ["src/foo*.ts", "src/foobar.ts"],
    ["src/foo*.ts", "src/foobar/utils.ts"], ["src/foo*", "src/fool*.js"],
    ["*.json", "packages/app/package.json"], [".", "src/index.ts"],
  ];
  for (const [left, right] of conflicting) {
    const a = task("a", { writePaths: [left!] }), b = task("b", { writePaths: [right!] });
    assert.equal(tasksConflict(a, b), true, `${left} should reserve ${right}`);
    assert.equal(tasksConflict(b, a), true, "Conflict detection must be symmetric");
  }
  for (const [left, right] of [["src/foo", "src/foobar.ts"], ["src/**", "src2/main.ts"], ["src/foo*", "src/bar.ts"], ["apps/web", "apps/device"]]) {
    assert.equal(tasksConflict(task("a", { writePaths: [left!] }), task("b", { writePaths: [right!] })), false);
  }
  assert.equal(tasksConflict(task("legacy"), task("new", { writePaths: ["*"] })), true, "An unscoped uncertain reservation holds legacy incoming work");
  assert.equal(tasksConflict(task("new", { writePaths: ["**"] }), task("legacy")), true);
  assert.equal(tasksConflict(task("legacy"), task("known", { writePaths: ["src"] })), false);
  assert.equal(tasksConflict(task("read-only", { writePaths: [] }), task("new", { writePaths: ["*"] })), false);
});

test("placement accounts for available slots, CPU and memory on the selected device", () => {
  const worker = device({ capacity: 4, workerResources: { cpus: 4, memoryGiB: 8 } });
  const active = [task("working", { deviceId: "worker", resources: { cpus: 2, memoryGiB: 6 } }),
    task("elsewhere", { deviceId: "other", resources: { cpus: 20, memoryGiB: 20 } })];
  assert.equal(placementConstraint(task("fits", { resources: { cpus: 2, memoryGiB: 2 } }), worker, active), undefined);
  assert.match(placementConstraint(task("cpu", { resources: { cpus: 3 } }), worker, active)!, /Needs 3 CPU; 2 CPU available/);
  assert.match(placementConstraint(task("memory", { resources: { memoryGiB: 3 } }), worker, active)!, /Needs 3 GiB memory; 2 GiB available/);
  assert.match(placementConstraint(task("new"), device({ capacity: 1 }), active)!, /capacity reached/);
});

test("legacy tasks use unit resource estimates while devices without budgets retain slot placement", () => {
  const worker = device({ capacity: 4, workerResources: { cpus: 2, memoryGiB: 2 } });
  const legacy = [task("active")];
  assert.equal(placementConstraint(task("next"), worker, legacy), undefined);
  assert.match(placementConstraint(task("next"), worker, [...legacy, task("another")])!, /0 CPU available/);
  assert.equal(placementConstraint(task("heavy", { resources: { cpus: 100, memoryGiB: 100 } }), device(), legacy), undefined);
  assert.match(placementConstraint(task("next"), device(), [...legacy, task("another")])!, /2 \/ 2 active tasks/);
});

test("descendants traverse converging branches and exclude supplied roots", () => {
  const tasks = [task("root"), task("left", { dependsOn: ["root"] }), task("right", { dependsOn: ["root"] }),
    task("join", { dependsOn: ["left", "right"] }), task("tail", { dependsOn: ["join"] }), task("unrelated")];
  assert.deepEqual([...descendants(tasks, ["root"])].sort(), ["join", "left", "right", "tail"]);
  assert.deepEqual([...descendants(tasks, ["root", "left", "join"])].sort(), ["right", "tail"]);
  assert.deepEqual([...descendants(tasks, ["absent"])], []);
});

function goal(patch: Partial<Goal> = {}): Goal {
  return { id: "goal", projectId: "project", coordinatorId: "worker", title: "Product", objective: "Deliver",
    criteria: [], status: "running", autonomy: "autonomous", approvalMode: "approve-all", runtime: "codex",
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", revision: 1, concurrency: 4, ...patch };
}
function attempt(id: string, taskId: string, patch: Partial<Attempt> = {}): Attempt {
  return { id, taskId, generation: 1, deviceId: "worker", status: "running", startedAt: "2026-10-05T00:00:00.000Z", ...patch };
}

test("shared scheduling blockers explain dependency, ownership, resource and concurrency decisions", () => {
  const next = task("next", { writePaths: ["src"] }), active = task("active", { writePaths: ["src/main.ts"], deviceId: "worker" });
  const blocked = { ...next, dependsOn: ["dependency"] };
  assert.equal(taskSchedulingBlocker(blocked, goal(), [blocked, task("dependency")], [], [], [device()])?.kind, "dependency");
  assert.equal(taskSchedulingBlocker(next, goal(), [next], [next], [], [device()])?.kind, "write-conflict");
  assert.deepEqual(taskSchedulingBlocker(next, goal(), [next], [active], [active], [device()])?.taskIds, ["active"]);
  assert.equal(taskSchedulingBlocker(next, goal({ concurrency: 1 }), [next], [active], [], [device()])?.kind, "goal-capacity");
  assert.equal(taskSchedulingBlocker(next, goal(), [next], [], [], [device({ online: false })])?.kind, "device-unavailable");
  assert.equal(taskSchedulingBlocker(next, goal({ workspaceProvider: "artifactfs" }), [next], [], [], [device()])?.kind, "device-unavailable");
  assert.equal(taskSchedulingBlocker(next, goal(), [next], [active], [], [device({ capacity: 1 })])?.kind, "device-capacity");
  assert.equal(taskSchedulingBlocker(next, goal(), [next], [active], [], [device({ workerResources: { cpus: 1, memoryGiB: 4 } })])?.kind, "resource");
  assert.equal(taskSchedulingBlocker(next, goal(), [next], [active], [], [device({ capacity: 1 }), device({ id: "other" })]), undefined);
});

test("unknown and retired unconfirmed executions retain distinct original reservations", () => {
  const current = task("same", { currentAttemptId: "current", writePaths: ["new"], resources: { cpus: 1 } });
  const unknown = task("uncertain", { currentAttemptId: "unknown" });
  const review = task("review", { status: "review", currentAttemptId: "review-attempt" });
  const attempts = [attempt("current", "same"), attempt("retired", "same", { status: "retired", deviceId: "old-worker" }),
    attempt("unknown", "uncertain", { status: "unknown" }), attempt("stale", "same"),
    attempt("review-attempt", "review", { status: "succeeded" })];
  const contracts = new Map<string, AttemptInspection["contract"]>([["retired", {
    title: "Old task", description: "Old contract", dependsOn: [], checks: [], planRevision: 1,
    writePaths: ["old"], resources: { cpus: 3, memoryGiB: 4 }, estimatedMinutes: 8,
  }]]);
  const reservations = activeExecutionTasks([current, unknown, review], attempts, new Set(["retired"]), contracts);
  assert.equal(reservations.length, 4);
  const retained = reservations.find(item => item.currentAttemptId === "retired")!;
  assert.equal(retained.deviceId, "old-worker");
  assert.deepEqual(retained.writePaths, ["old"]);
  assert.deepEqual(retained.resources, { cpus: 3, memoryGiB: 4 });
  assert.equal(retained.estimatedMinutes, 8);
  assert.deepEqual(reservations.find(item => item.id === "uncertain")!.writePaths, ["**"]);
  assert.equal(reservations.some(item => item.currentAttemptId === "stale"), false);
  assert.equal(reservations.find(item => item.id === "review")!.deviceId, "worker");
  assert.deepEqual(activeExecutionTasks([current], [attempt("retired", "same", { status: "retired" })], new Set(["retired"]))[0]!.writePaths, ["**"]);
  assert.equal(activeExecutionTasks([task("legacy", { currentAttemptId: "known" })], [attempt("known", "legacy")])[0]!.writePaths, undefined);
});

test("settled inspection waits release author capacity but retain source ownership and uncertain executions", () => {
  const reviewing = task("review", { status: "review", currentAttemptId: "review-attempt", writePaths: ["apps/mail"], resources: { cpus: 4 } });
  const waiting = new Set(["review-attempt"]), author = attempt("review-attempt", reviewing.id, { status: "succeeded" });
  const active = activeExecutionTasks([reviewing], [author], undefined, undefined, waiting);
  assert.equal(verificationOnlyReservation(active[0]!), true);
  const independent = task("independent", { writePaths: ["docs"] });
  const worker = device({ capacity: 1, workerResources: { cpus: 1, memoryGiB: 1 } });
  assert.equal(taskSchedulingBlocker(independent, goal({ concurrency: 1 }), [reviewing, independent], active, active, [worker]), undefined);
  const overlapping = task("overlap", { writePaths: ["apps/mail/src"] });
  assert.equal(taskSchedulingBlocker(overlapping, goal({ concurrency: 1 }), [reviewing, overlapping], active, active, [worker])!.kind, "write-conflict");
  for (const status of ["unknown", "retired"] as const) {
    const uncertain = activeExecutionTasks([reviewing], [{ ...author, status }], new Set([author.id]), undefined, waiting);
    assert.equal(verificationOnlyReservation(uncertain[0]!), false, `A ${status} execution still owns runtime resources`);
    assert.match(placementConstraint(independent, worker, uncertain)!, /capacity reached/);
  }
});

test("goal execution defaults apply before allocation while explicit task requirements replace them", () => {
  const execution = { target: "host-macos" as const, requiredCapabilities: ["mac-shell" as const] };
  const nativeGoal = goal({ execution }), legacy = task("legacy"), portable = task("portable", { execution: { target: "container" } });
  assert.equal(effectiveTaskExecution(legacy, goal()), legacy, "Legacy omission keeps ordinary container execution");
  assert.deepEqual(effectiveTaskExecution(legacy, nativeGoal).execution, execution);
  assert.equal(effectiveTaskExecution(portable, nativeGoal), portable);
  assert.equal(taskSchedulingBlocker(legacy, nativeGoal, [legacy], [], [], [device()])!.kind, "execution-capability");
  assert.equal(taskSchedulingBlocker(portable, nativeGoal, [portable], [], [], [device()]), undefined);
  const mac = macDevice();
  assert.equal(taskSchedulingBlocker(legacy, nativeGoal, [legacy], [], [], [mac]), undefined);
  assert.equal(selectExecutionTarget(effectiveTaskExecution(legacy, nativeGoal), mac)!.kind, "host-macos");
});
