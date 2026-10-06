import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextEvent } from "node:timers/promises";
import type { Attempt, Device, FactoryTask, Goal, Project } from "@enoughfactory/contracts";
import { FactoryCoordinator } from "./coordinator.js";
import type { AttemptDetail, ControlRecord, ExecutionResult, FactoryRuntimePort, FactoryStore, FactoryWorkspacePort, PlanRecord, PlanResponse, PlannedTask, TaskDetail } from "./types.js";

class MemoryStore implements FactoryStore {
  private tables = new Map<string, Map<string, unknown>>();
  list<T>(table: string): T[] { return structuredClone([...this.tables.get(table)?.values() ?? []]) as T[]; }
  get<T>(table: string, id: string): T | undefined { return structuredClone(this.tables.get(table)?.get(id)) as T | undefined; }
  set<T extends { id: string }>(table: string, value: T): void {
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    this.tables.get(table)!.set(value.id, structuredClone(value));
  }
  delete(table: string, id: string): void { this.tables.get(table)?.delete(id); }
  transaction<T>(fn: () => T): T {
    const before = structuredClone(this.tables);
    try { return fn(); } catch (error) { this.tables = before; throw error; }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function settle(condition: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (condition()) return;
    await nextEvent();
  }
  assert.fail(`Coordinator did not settle: ${description}`);
}

function planned(key: string, options: Partial<PlannedTask> = {}): PlannedTask {
  return { key, title: key, description: `Implement ${key}`, dependsOn: [], checks: [`check-${key}`], writePaths: [`src/${key}`], estimatedMinutes: 1, resources: { cpus: 1, memoryGiB: 1 }, ...options };
}

function plan(tasks: PlannedTask[], checks = ["original-project-check"]): PlanResponse {
  return { summary: "Deliver independent work and its required dependencies", criteria: ["Requested behavior works"], checks, tasks };
}

function harness(initialPlan: PlanResponse, options: { capacity?: number; cpus?: number; coordinatorId?: string } = {}) {
  const store = new MemoryStore();
  const device: Device = {
    id: "worker", name: "Factory worker", platform: "linux", arch: "x64", online: true, local: true,
    lastSeen: "2026-10-05T00:00:00.000Z", capacity: options.capacity ?? 2,
    workerResources: { cpus: options.cpus ?? 2, memoryGiB: 16 },
  };
  const project: Project = { id: "project", name: "Project", path: "/workspace/project", deviceId: device.id, runtime: "codex", approvalMode: "approve-all", rules: [], createdAt: device.lastSeen };
  const nextPlan = deferred<PlanResponse>();
  const diagnosis = deferred<Record<string, string>>();
  const executions = new Map<string, { attempt: Attempt; completion: ReturnType<typeof deferred<ExecutionResult>> }>();
  const executionHistory: Array<ReturnType<typeof deferred<ExecutionResult>>> = [];
  let cancellation: (attempt: Attempt) => Promise<void> = async () => {};
  let reconciliation: FactoryRuntimePort["reconcile"] = async () => ({ status: "unknown" });
  const calls = { plans: [] as string[], diagnoses: [] as string[], executions: [] as string[], executionInputs: [] as Parameters<FactoryRuntimePort["execute"]>[0][], cancelled: [] as string[], checks: [] as { candidate: string; commands: string[] }[], integrated: [] as string[] };
  const keyFor = (id: string) => store.get<TaskDetail>("factory-task-details", id)!.key;
  const runtime: FactoryRuntimePort = {
    async complete(input) {
      if (input.role === "planner") {
        calls.plans.push(input.prompt);
        return { text: JSON.stringify(calls.plans.length === 1 ? initialPlan : await nextPlan.promise) };
      }
      if (input.role === "diagnosis") { calls.diagnoses.push(input.prompt); return { text: JSON.stringify(await diagnosis.promise) }; }
      return { text: JSON.stringify({ complete: true, summary: "Verified", criteria: [{ criterion: "Requested behavior works", satisfied: true, evidence: ["artifact:integration"] }] }) };
    },
    async execute(input) {
      const { attempt, task } = input;
      const key = keyFor(task.id), completion = deferred<ExecutionResult>();
      calls.executions.push(key); executions.set(key, { attempt, completion });
      calls.executionInputs.push(structuredClone(input));
      executionHistory.push(completion);
      return completion.promise;
    },
    async reconcile(attempt) { return reconciliation(attempt); },
    async cancel(attempt) { calls.cancelled.push(attempt.id); await cancellation(attempt); },
  };
  const workspaces: FactoryWorkspacePort = {
    async prepare({ attempt, task }) { return { id: attempt.id, path: `/workspace/${attempt.id}`, baseCommit: "base", provider: "git", sessionId: `session-${keyFor(task.id)}-${attempt.generation}` }; },
    async capture(workspace) { return { id: workspace.id, commit: `candidate-${workspace.id}`, baseCommit: workspace.baseCommit }; },
    async check(_project, candidate, commands) {
      calls.checks.push({ candidate: candidate.commit, commands: [...commands] });
      return commands.map(command => ({ command, passed: true, output: "verified", exitCode: 0, candidateCommit: candidate.commit }));
    },
    async integrate(_project, candidate, input) {
      assert.ok(input.isCurrent(), "the existing attempt must retain integration authority");
      calls.integrated.push(candidate.commit);
      return { commit: `integrated-${candidate.commit}`, previousHead: "base", candidateCommit: candidate.commit,
        checks: input.checks.map(command => ({ command, passed: true, output: "combined result verified", exitCode: 0, candidateCommit: candidate.commit, checkedCommit: `integrated-${candidate.commit}` })) };
    },
    async inspect() { return { head: "integrated-head", branch: "main", status: "" }; },
  };
  const coordinator = new FactoryCoordinator({ store, runtime, workspaces, deviceId: options.coordinatorId ?? device.id, devices: () => [device], project: id => id === project.id ? project : undefined });
  const goal = coordinator.create({ projectId: project.id, objective: "Deliver the requested behavior", criteria: ["Requested behavior works"] });
  const task = (key: string) => store.list<FactoryTask>("tasks").find(task => keyFor(task.id) === key)!;
  const detail = (key: string) => store.get<TaskDetail>("factory-task-details", task(key).id)!;
  const attempt = (key: string) => store.get<Attempt>("attempts", task(key).currentAttemptId!)!;
  const attemptDetail = (key: string) => store.get<AttemptDetail>("factory-attempt-details", attempt(key).id)!;
  const control = () => store.get<ControlRecord>("factory-control", goal.id)!;
  const finish = (key: string, status: ExecutionResult["status"] = "succeeded") => executions.get(key)!.completion.resolve({ status, text: status === "failed" ? "Confirmed missing implementation" : `Finished ${key}` });
  return {
    store, coordinator, goal, device, calls, nextPlan, diagnosis, task, detail, attempt, attemptDetail, control, finish,
    cancelling(fn: typeof cancellation) { cancellation = fn; },
    reconciling(fn: typeof reconciliation) { reconciliation = fn; },
    async startPlan() { await coordinator.tick(); await coordinator.waitForIdle(); assert.equal(calls.plans.length, 1); },
    async close() {
      cancellation = async () => {};
      await coordinator.cancel(goal.id);
      nextPlan.resolve(initialPlan); diagnosis.resolve({ action: "retry", reason: "Cleanup" });
      for (const completion of executionHistory) completion.resolve({ status: "succeeded", text: "Cleanup" });
      await coordinator.waitForIdle();
    },
  };
}

test("localized replanning preserves unrelated running authority, immutable checks and queued work", async () => {
  const factory = harness(plan([
    planned("broken", { estimatedMinutes: 100, writePaths: ["packages/shared"] }),
    planned("dependent", { dependsOn: ["broken"] }),
    planned("app", { estimatedMinutes: 50, writePaths: ["apps/web"] }),
    planned("docs", { resources: { cpus: 2 }, writePaths: ["docs"] }),
  ]));
  try {
    await factory.startPlan();
    const legacyPlan = factory.store.get<PlanRecord>("factory-plans", factory.goal.id)!;
    delete legacyPlan.checkScope;
    factory.store.set("factory-plans", legacyPlan);
    factory.store.set("factory-task-details", { ...factory.detail("app"), planChecks: ["original-project-check"] });
    const legacyDocs = factory.detail("docs");
    delete legacyDocs.planChecks;
    factory.store.set("factory-task-details", legacyDocs);
    await factory.coordinator.tick();
    await settle(() => factory.calls.executions.length === 2, "parallel authors entered");
    assert.deepEqual(factory.calls.executions, ["broken", "app"]);
    const app = factory.attempt("app"), appDetail = factory.attemptDetail("app"), docs = factory.task("docs"), docsDetail = factory.detail("docs");
    factory.finish("broken", "failed");
    await settle(() => factory.task("broken").status === "failed", "confirmed failure retained");
    await factory.coordinator.tick();
    await factory.coordinator.tick();
    await settle(() => factory.calls.diagnoses.length === 1, "diagnosis entered");
    factory.diagnosis.resolve({ action: "replan", reason: "Split the failed branch", instructions: "Preserve unrelated work" });
    await settle(() => factory.control().stage === "plan", "localized revision persisted");
    assert.equal(factory.store.get<Goal>("goals", factory.goal.id)!.revision, 2);
    assert.equal(factory.task("broken").status, "canceled");
    assert.equal(factory.task("dependent").status, "canceled");
    assert.deepEqual(factory.attempt("app"), app, "session identity and generation remain authoritative");
    assert.equal(factory.attemptDetail("app").goalRevision, 2);
    assert.deepEqual(factory.attemptDetail("app").contract, appDetail.contract);
    assert.deepEqual(factory.attemptDetail("app").workspace, appDetail.workspace);
    assert.deepEqual(factory.task("docs"), docs);
    assert.deepEqual(factory.detail("docs"), docsDetail);
    assert.ok(!factory.calls.cancelled.includes(app.id));

    await factory.coordinator.tick();
    await settle(() => factory.calls.plans.length === 2, "repair planner entered");
    assert.match(factory.calls.plans[1]!, /localized repair/);
    factory.nextPlan.resolve(plan([
      planned("broken", { title: "Repaired shared contract", writePaths: ["packages/shared"], checks: ["repair-check"] }),
      planned("dependent", { dependsOn: ["broken"] }),
    ], ["new-project-check"]));
    await settle(() => factory.control().stage === "dispatch", "repair plan accepted");
    assert.deepEqual(factory.attemptDetail("app").contract, appDetail.contract);
    assert.deepEqual(factory.task("docs"), docs);
    assert.deepEqual(factory.detail("docs"), { ...docsDetail, planChecks: ["original-project-check"] }, "the legacy queued task's old plan checks are pinned before the plan is replaced");
    assert.equal(factory.task("app").currentAttemptId, app.id);
    factory.finish("app");
    await settle(() => factory.task("app").status === "completed", "preserved author integrated");
    assert.deepEqual(factory.calls.checks.find(check => check.candidate === `candidate-${app.id}`)!.commands, ["original-project-check", "check-app"]);
    assert.equal(factory.attempt("app").sessionId, app.sessionId);
    assert.equal(factory.attemptDetail("app").contract!.planRevision, 1);
    factory.device.capacity = 3;
    factory.device.workerResources!.cpus = 3;
    await factory.coordinator.tick();
    await settle(() => factory.calls.executions.includes("docs"), "preserved legacy queued author dispatched");
    assert.deepEqual(factory.attemptDetail("docs").contract!.checks, ["original-project-check", "check-docs"]);
    assert.equal(factory.attemptDetail("docs").contract!.planRevision, 1);
    factory.finish("docs");
    await settle(() => factory.task("docs").status === "completed", "legacy queued author integrated");
    assert.deepEqual(factory.calls.checks.find(check => check.candidate === `candidate-${factory.attempt("docs").id}`)!.commands, ["original-project-check", "check-docs"]);
  } finally { await factory.close(); }
});

test("a preserved remote preparation keeps its assignment revision when execution resumes after localized replanning", async () => {
  const factory = harness(plan([
    planned("broken", { estimatedMinutes: 100, writePaths: ["packages/shared"] }),
    planned("dependent", { dependsOn: ["broken"] }),
    planned("prepared", { writePaths: ["apps/web"] }),
  ]), { coordinatorId: "coordinator" });
  factory.device.local = false;
  try {
    await factory.startPlan();
    const task = factory.task("prepared");
    const original: Attempt = { id: "prepared-remote-attempt", taskId: task.id, deviceId: factory.device.id, generation: 1, status: "unknown", startedAt: factory.device.lastSeen };
    const workspace = { id: original.id, path: "/workspace/prepared-remote", baseCommit: "prepared-base", provider: "git" as const, sessionId: "prepared-remote-session", deviceId: factory.device.id };
    factory.store.transaction(() => {
      factory.store.set("attempts", original);
      factory.store.set("tasks", { ...task, status: "running" as const, deviceId: original.deviceId, currentAttemptId: original.id });
      factory.store.set<AttemptDetail>("factory-attempt-details", {
        id: original.id, goalId: factory.goal.id, goalRevision: 1, cancellation: "none", phase: "preparing", workspace,
        contract: { title: task.title, description: task.description, dependsOn: task.dependsOn, writePaths: task.writePaths, resources: task.resources, checks: ["original-project-check", "check-prepared"], planRevision: 1 },
      });
    });
    await factory.coordinator.tick();
    await settle(() => factory.calls.executions.includes("broken"), "failed branch author entered");
    factory.finish("broken", "failed");
    await settle(() => factory.task("broken").status === "failed", "failed branch settled");
    await factory.coordinator.tick(); await factory.coordinator.tick();
    await settle(() => factory.calls.diagnoses.length === 1, "localized diagnosis entered");
    factory.diagnosis.resolve({ action: "replan", reason: "Repair the failed branch while retaining remote preparation" });
    await settle(() => factory.control().stage === "plan", "goal revision advanced");
    assert.equal(factory.attemptDetail("prepared").goalRevision, 2);
    assert.equal(factory.attemptDetail("prepared").assignmentGoalRevision, 1, "legacy preparations pin the original worker binding before the active goal authority advances");
    await factory.coordinator.tick();
    await settle(() => factory.calls.plans.length === 2, "localized planner entered");
    factory.reconciling(async attempt => attempt.id === original.id ? { status: "prepared", workspace } : { status: "unknown" });
    await nextEvent();
    await factory.coordinator.tick();
    await settle(() => factory.calls.executions.includes("prepared"), "prepared remote execution resumed");
    const execution = factory.calls.executionInputs.find(input => input.attempt.id === original.id)!;
    assert.equal(execution.goal.revision, 2);
    assert.equal(execution.assignmentGoalRevision, 1);
    assert.equal(execution.attempt.id, original.id);
    assert.equal(execution.attempt.generation, 1);
    assert.equal(execution.attempt.deviceId, original.deviceId);
    assert.equal(execution.attempt.baseCommit, workspace.baseCommit);
    assert.equal(execution.attempt.sessionId, workspace.sessionId);
    assert.deepEqual(execution.workspace, workspace);
    assert.equal(factory.store.list<Attempt>("attempts").filter(attempt => attempt.taskId === task.id).length, 1, "reconciliation resumes the existing worker preparation without creating an assignment");
  } finally { await factory.close(); }
});

test("worker reconnection resumes healthy work without re-diagnosing a locally waiting failure", async () => {
  const factory = harness(plan([
    planned("broken", { estimatedMinutes: 100 }),
    planned("dependent", { dependsOn: ["broken"] }),
    planned("healthy", { resources: { cpus: 2 } }),
  ]));
  try {
    await factory.startPlan(); await factory.coordinator.tick();
    await settle(() => factory.calls.executions.length === 1, "failed branch author entered");
    factory.finish("broken", "failed");
    await settle(() => factory.task("broken").status === "failed", "failure settled");
    factory.device.online = false;
    await factory.coordinator.tick(); await factory.coordinator.tick();
    await settle(() => factory.calls.diagnoses.length === 1, "repair supervisor entered");
    factory.diagnosis.resolve({ action: "wait", reason: "The package registry is unavailable", waitReason: "Wait for registry connectivity", wakeCondition: "registry-ready" });
    await settle(() => factory.detail("broken").waitingFor === "registry-ready", "only the failed branch waits for its external dependency");
    await factory.coordinator.tick();
    assert.equal(factory.store.get<Goal>("goals", factory.goal.id)!.status, "waiting");
    assert.equal(factory.control().waitingFor, "device-online");
    assert.deepEqual(factory.calls.executions, ["broken"]);

    factory.device.online = true;
    await factory.coordinator.tick();
    await settle(() => factory.calls.executions.includes("healthy"), "healthy author resumed after worker reconnect");
    assert.equal(factory.calls.diagnoses.length, 1, "the repair wait stays scoped to its branch");
    assert.equal(factory.detail("broken").waitingFor, "registry-ready");
    assert.equal(factory.task("broken").status, "failed");
    assert.equal(factory.task("dependent").status, "queued");
    assert.equal(factory.control().stage, "dispatch");
    assert.equal(factory.store.get<Goal>("goals", factory.goal.id)!.error, undefined);
  } finally { await factory.close(); }
});

for (const action of ["retire", "cancel"] as const) {
test(`an unconfirmed ${action === "retire" ? "retired attempt" : "canceled goal"} holds its reservation until cancellation is acknowledged after reconnect`, async () => {
  const factory = harness(plan([planned("author", { estimatedMinutes: 100, writePaths: ["packages/shared"] }), planned("independent", { writePaths: ["apps/client"] })]), { capacity: 1 });
  const acknowledgement = deferred<void>();
  try {
    await factory.startPlan(); await factory.coordinator.tick();
    await settle(() => factory.calls.executions.length === 1, "original author entered");
    const original = factory.attempt("author");
    factory.cancelling(async () => {
      if (!factory.device.online) throw new Error("Owning device is offline");
      await acknowledgement.promise;
    });
    factory.device.online = false;
    if (action === "retire") await factory.coordinator.retireAttempt(original.id);
    else await factory.coordinator.cancel(factory.goal.id);
    assert.equal(factory.store.get<Attempt>("attempts", original.id)!.status, "retired");
    assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", original.id)!.cancellation, "requested");
    await factory.coordinator.tick();
    assert.deepEqual(factory.calls.cancelled, [original.id], "offline ownership does not produce repeated cancellation calls");
    assert.deepEqual(factory.calls.executions, ["author"]);

    factory.device.online = true;
    await factory.coordinator.tick();
    await settle(() => factory.calls.cancelled.length === 2, "cancellation retried after owner reconnect");
    assert.deepEqual(factory.calls.executions, ["author"], "replacement remains blocked until acknowledgement arrives");
    await factory.coordinator.tick();
    assert.equal(factory.calls.cancelled.length, 2, "a pending acknowledgement is not duplicated");
    acknowledgement.resolve();
    await settle(() => factory.store.get<AttemptDetail>("factory-attempt-details", original.id)!.cancellation === "acknowledged", "owner acknowledged termination");
    await factory.coordinator.tick();
    if (action === "retire") {
      await settle(() => factory.calls.executions.length === 2, "replacement dispatched after acknowledgement");
      assert.deepEqual(factory.calls.executions, ["author", "author"]);
      assert.notEqual(factory.attempt("author").id, original.id);
      assert.equal(factory.attempt("author").generation, 2);
    } else {
      assert.deepEqual(factory.calls.executions, ["author"], "a terminal goal cannot dispatch replacement work");
      assert.equal(factory.store.get<Goal>("goals", factory.goal.id)!.status, "canceled");
    }
    assert.equal(factory.store.get<Attempt>("attempts", original.id)!.status, "retired");
  } finally { acknowledgement.resolve(); await factory.close(); }
});
}

test("a held diagnosis and localized planner each allow independent dispatch as resources become free", async () => {
  const factory = harness(plan([
    planned("broken", { estimatedMinutes: 100 }),
    planned("dependent", { dependsOn: ["broken"] }),
    planned("occupied", { estimatedMinutes: 10 }),
    planned("next", { estimatedMinutes: 2, resources: { cpus: 2 } }),
    planned("later", { resources: { cpus: 2 } }),
  ]));
  try {
    await factory.startPlan(); await factory.coordinator.tick();
    await settle(() => factory.calls.executions.length === 2, "initial authors entered");
    factory.finish("broken", "failed");
    await settle(() => factory.task("broken").status === "failed", "failure settled");
    await factory.coordinator.tick(); await factory.coordinator.tick();
    await settle(() => factory.calls.diagnoses.length === 1, "held diagnosis entered");
    assert.deepEqual(factory.calls.executions, ["broken", "occupied"]);
    factory.finish("occupied");
    await settle(() => factory.task("occupied").status === "completed", "worker resources released");
    await factory.coordinator.tick();
    await settle(() => factory.calls.executions.includes("next"), "dispatch continued during diagnosis");
    assert.equal(factory.control().operation!.kind, "diagnosis");
    assert.equal(factory.calls.plans.length, 1);
    assert.equal(factory.task("dependent").status, "queued");

    factory.diagnosis.resolve({ action: "replan", reason: "Repair the failed branch only" });
    await settle(() => factory.control().stage === "plan", "repair revision settled");
    await factory.coordinator.tick();
    await settle(() => factory.calls.plans.length === 2, "held repair planner entered");
    factory.finish("next");
    await settle(() => factory.task("next").status === "completed", "independent author integrated during planner");
    await factory.coordinator.tick();
    await settle(() => factory.calls.executions.includes("later"), "dispatch continued during planner");
    assert.equal(factory.control().operation!.kind, "planner");
    assert.equal(factory.task("broken").status, "canceled");
    assert.equal(factory.task("dependent").status, "canceled");
    assert.deepEqual(new Set(factory.control().replanTaskIds), new Set([factory.task("broken").id, factory.task("dependent").id]));
    factory.nextPlan.resolve(plan([planned("broken"), planned("dependent", { dependsOn: ["broken"] })]));
    await settle(() => factory.control().stage === "dispatch", "repair plan completed");
  } finally { await factory.close(); }
});

test("actual dispatch prioritizes the critical dependency chain and respects write ownership and device resources", async () => {
  const factory = harness(plan([
    planned("small", { writePaths: ["docs"], estimatedMinutes: 1 }),
    planned("overlap", { writePaths: ["packages/shared/test.ts"], estimatedMinutes: 90 }),
    planned("critical", { writePaths: ["packages/shared"], estimatedMinutes: 1, resources: { cpus: 2, memoryGiB: 3 } }),
    planned("downstream", { dependsOn: ["critical"], estimatedMinutes: 100 }),
    planned("resource-heavy", { writePaths: ["apps/web"], estimatedMinutes: 80, resources: { cpus: 2, memoryGiB: 3 } }),
  ]), { capacity: 4, cpus: 3 });
  try {
    assert.equal(factory.goal.concurrency, 8);
    await factory.startPlan(); await factory.coordinator.tick();
    await settle(() => factory.calls.executions.length === 2, "resource-aware authors entered");
    assert.deepEqual(factory.calls.executions, ["critical", "small"], "the chain outranks an individually longer overlapping task; light independent work fills the remaining CPU");
    assert.equal(factory.task("overlap").status, "queued");
    assert.equal(factory.task("resource-heavy").status, "queued");
    assert.equal(factory.task("downstream").status, "queued");
    assert.deepEqual(factory.attemptDetail("critical").contract!.writePaths, ["packages/shared"]);
    assert.deepEqual(factory.attemptDetail("critical").contract!.resources, { cpus: 2, memoryGiB: 3 });
    assert.equal(factory.attemptDetail("critical").contract!.estimatedMinutes, 1);
  } finally { await factory.close(); }
});

for (const declaredScope of [true, false]) {
  test(`an unknown ${declaredScope ? "scoped" : "legacy unscoped"} author ${declaredScope ? "permits disjoint" : "reserves repository"} work while blocking descendants`, async () => {
    const unknown = planned("uncertain", { estimatedMinutes: 100, ...(declaredScope ? { writePaths: ["packages/server"] } : { writePaths: undefined }) });
    const factory = harness(plan([unknown, planned("dependent", { dependsOn: ["uncertain"] }), planned("independent", { writePaths: ["apps/client"] })]), { capacity: 1, cpus: 3 });
    try {
      await factory.startPlan(); await factory.coordinator.tick();
      await settle(() => factory.calls.executions.length === 1, "uncertain author entered");
      factory.finish("uncertain", "unknown");
      await settle(() => factory.attempt("uncertain").status === "unknown", "unknown outcome retained");
      factory.device.capacity = 3;
      await factory.coordinator.tick(); await nextEvent();
      if (declaredScope) await settle(() => factory.calls.executions.includes("independent"), "disjoint author entered");
      assert.deepEqual(factory.calls.executions, declaredScope ? ["uncertain", "independent"] : ["uncertain"]);
      assert.equal(factory.task("dependent").status, "queued");
      assert.equal(factory.store.list<Attempt>("attempts").filter(attempt => attempt.taskId === factory.task("uncertain").id).length, 1, "the unknown execution is never duplicated");
      assert.equal(factory.calls.integrated.length, 0);
    } finally { await factory.close(); }
  });
}
