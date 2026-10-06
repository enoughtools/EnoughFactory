import assert from "node:assert/strict";
import test from "node:test";
import type { Attempt, AttemptInspection, Device, FactoryTask, Goal } from "@enoughfactory/contracts";
import { activeExecutionTasks, criticalPathMinutes, descendants, placementConstraint, sortReadyTasks, taskSchedulingBlocker, tasksConflict } from "./scheduler.js";

function task(id: string, patch: Partial<FactoryTask> = {}): FactoryTask {
  return { id, goalId: "goal", title: id, description: id, dependsOn: [], status: "queued",
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", ...patch };
}
function device(patch: Partial<Device> = {}): Device {
  return { id: "worker", name: "Worker", platform: "linux", arch: "x64", online: true, local: true,
    lastSeen: "2026-10-05T00:00:00.000Z", ...patch };
}

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
