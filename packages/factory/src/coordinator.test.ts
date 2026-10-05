import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Attempt, Decision, Device, FactoryTask, Goal, Project } from "@enoughfactory/contracts";
import { FactoryCoordinator } from "./coordinator.js";
import { readPlan } from "./protocol.js";
import type {
  AttemptDetail, CandidateRef, EvaluationRecord, EvaluationResponse, ExecutionResult, FactoryRuntimePort,
  FactoryStore, FactoryWorkspacePort, PlanResponse,
} from "./types.js";

/** Reads cannot mutate committed records and a failed transaction cannot leave half a transition. */
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const device: Device = {
  id: "coordinator", name: "Factory device", platform: "linux", arch: "x64",
  online: true, local: true, lastSeen: "2026-10-05T00:00:00.000Z", capacity: 2,
};
const project: Project = {
  id: "project", name: "Release project", path: "/workspace/project", deviceId: device.id,
  runtime: "codex", approvalMode: "approve-all", rules: [], createdAt: device.lastSeen,
};
const criteria = ["Feature works in the app", "Release artifact is available"];
const plan: PlanResponse = {
  summary: "Implement and verify the requested release", criteria: [criteria[0]!],
  checks: ["npm run verify"], tasks: [{
    key: "implement", title: "Implement release", description: "Build and release the feature",
    dependsOn: [], checks: ["npm run verify"],
  }],
};
const completeEvaluation: EvaluationResponse = {
  complete: true, summary: "The app and release were verified",
  criteria: criteria.map((criterion, index) => ({ criterion, satisfied: true, evidence: [`artifact:proof-${index}`] })),
};

function harness() {
  const store = new MemoryStore();
  const calls = { planner: 0, evaluator: 0, diagnosis: 0, execute: 0, reconcile: 0, cancel: 0, prepare: 0, capture: 0, check: 0, integrate: 0, integrationFences: 0, reconcileIntegration: 0 };
  const executionPrompts: string[] = [];
  let planning: () => Promise<PlanResponse> = async () => plan;
  let evaluating: () => Promise<EvaluationResponse> = async () => completeEvaluation;
  let executing: () => Promise<ExecutionResult> = async () => ({ status: "succeeded", text: "Implementation complete" });
  let reconciling: FactoryRuntimePort["reconcile"] = async () => ({ status: "unknown" });
  let beforeIntegrationWrite: () => Promise<void> = async () => {};
  let afterIntegrationWrite: () => Promise<void> = async () => {};
  let beforeCheck: () => Promise<void> = async () => {};
  let reconcilingIntegration: FactoryWorkspacePort["reconcileIntegration"];
  let inspecting: FactoryWorkspacePort["inspect"] = async () => ({ head: "integrated-head", branch: "main", status: "", artifacts: [{ name: "Release", sha256: "release-hash" }] });
  const runtime: FactoryRuntimePort = {
    async complete(input) {
      if (input.role === "planner") { calls.planner++; return { text: JSON.stringify(await planning()) }; }
      if (input.role === "evaluator") { calls.evaluator++; return { text: JSON.stringify(await evaluating()) }; }
      calls.diagnosis++;
      return { text: JSON.stringify({ action: "retry", reason: "The expected route was missing", instructions: "Add the missing route and verify the response" }) };
    },
    async execute(input) { calls.execute++; executionPrompts.push(input.prompt); return executing(); },
    async reconcile(attempt) { calls.reconcile++; return reconciling(attempt); },
    async cancel() { calls.cancel++; },
  };
  const candidate: CandidateRef = { id: "candidate", commit: "candidate-commit", baseCommit: "initial-head" };
  const workspaces: FactoryWorkspacePort = {
    async prepare({ attempt }) { calls.prepare++; return { id: attempt.id, path: `/workspace/${attempt.id}`, baseCommit: "initial-head", provider: "git" }; },
    async capture() { calls.capture++; return candidate; },
    async check(_project, current, commands) {
      calls.check++;
      await beforeCheck();
      return commands.map(command => ({ command, passed: true, output: "verified", exitCode: 0, candidateCommit: current.commit }));
    },
    async integrate(_project, current, input) {
      await beforeIntegrationWrite();
      calls.integrationFences++;
      if (!input.isCurrent()) throw new Error("Integration authority has been revoked");
      calls.integrate++;
      await afterIntegrationWrite();
      return { commit: "integrated-head", previousHead: "initial-head", candidateCommit: current.commit,
        checks: input.checks.map(command => ({ command, passed: true, output: "Combined result verified", exitCode: 0, candidateCommit: current.commit, checkedCommit: "integrated-head" })) };
    },
    async inspect(current) { return inspecting(current); },
    async reconcileIntegration(current, retainedCandidate) {
      calls.reconcileIntegration++;
      return reconcilingIntegration?.(current, retainedCandidate);
    },
    async release() {},
  };
  const options = { store, runtime, workspaces, deviceId: device.id, devices: () => [device], project: (id: string) => id === project.id ? project : undefined };
  const coordinator = new FactoryCoordinator(options);
  const goal = () => coordinator.create({ projectId: project.id, objective: "Build the feature and publish its release", criteria, autonomy: "autonomous", approvalMode: "approve-all", concurrency: 1 });
  return {
    store, calls, coordinator, goal, executionPrompts, recover: () => new FactoryCoordinator(options),
    planning(fn: typeof planning) { planning = fn; },
    evaluating(fn: typeof evaluating) { evaluating = fn; },
    executing(fn: typeof executing) { executing = fn; },
    reconciling(fn: typeof reconciling) { reconciling = fn; },
    beforeIntegrationWrite(fn: typeof beforeIntegrationWrite) { beforeIntegrationWrite = fn; },
    afterIntegrationWrite(fn: typeof afterIntegrationWrite) { afterIntegrationWrite = fn; },
    beforeCheck(fn: typeof beforeCheck) { beforeCheck = fn; },
    reconcileIntegration(fn: NonNullable<typeof reconcilingIntegration>) { reconcilingIntegration = fn; },
    inspect(fn: typeof inspecting) { inspecting = fn; },
  };
}

async function planGoal(factory: ReturnType<typeof harness>): Promise<Goal> {
  const goal = factory.goal();
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.planner, 1);
  assert.equal(factory.store.list<FactoryTask>("tasks").length, 1);
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, criteria, "Planning cannot remove the user's release criterion");
  return goal;
}

async function finishTask(factory: ReturnType<typeof harness>): Promise<Goal> {
  const goal = await planGoal(factory);
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
  return goal;
}

function retainedAttempt(factory: ReturnType<typeof harness>, goal: Goal, retained: Pick<AttemptDetail, "phase"> & Partial<Pick<AttemptDetail, "workspace" | "candidate" | "result">>): Attempt {
  const task = factory.store.list<FactoryTask>("tasks")[0]!;
  const attempt: Attempt = { id: "retained-attempt", taskId: task.id, generation: 1, deviceId: device.id, status: "unknown", startedAt: device.lastSeen };
  factory.store.transaction(() => {
    factory.store.set("attempts", attempt);
    factory.store.set("tasks", { ...task, status: retained.phase === "preparing" ? "running" as const : "review" as const, currentAttemptId: attempt.id, deviceId: device.id });
    factory.store.set<AttemptDetail>("factory-attempt-details", { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, cancellation: "none", ...retained });
  });
  return attempt;
}

test("late success from a retired attempt cannot capture or integrate source", async () => {
  const factory = harness();
  const execution = deferred<ExecutionResult>();
  const entered = deferred<void>();
  factory.executing(() => { entered.resolve(); return execution.promise; });
  await planGoal(factory);
  await factory.coordinator.tick();
  await entered.promise;
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  await factory.coordinator.retireAttempt(attempt.id);
  execution.resolve({ status: "succeeded", text: "Late success after authority was revoked" });
  await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "retired");
  assert.equal(factory.calls.cancel, 1);
  assert.equal(factory.calls.capture, 0);
  assert.equal(factory.calls.check, 0);
  assert.equal(factory.calls.integrate, 0);
  assert.notEqual(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
});

test("cancellation revokes an integration already waiting at its write boundary", async () => {
  const factory = harness();
  const entered = deferred<void>();
  const write = deferred<void>();
  factory.beforeIntegrationWrite(() => { entered.resolve(); return write.promise; });
  const goal = await planGoal(factory);
  await factory.coordinator.tick();
  await entered.promise;
  await factory.coordinator.cancel(goal.id);
  write.resolve();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.integrationFences, 1);
  assert.equal(factory.calls.integrate, 0);
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "canceled");
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "canceled");
});

test("pause at the integration fence retains the successful candidate for resume", async () => {
  const factory = harness();
  const entered = deferred<void>();
  const write = deferred<void>();
  factory.beforeIntegrationWrite(() => { entered.resolve(); return write.promise; });
  const goal = await planGoal(factory);
  await factory.coordinator.tick();
  await entered.promise;
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  factory.coordinator.pause(goal.id);
  write.resolve();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "paused");
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "succeeded");
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "review");
  assert.equal(factory.calls.integrate, 0);
  assert.equal(factory.calls.diagnosis, 0);

  factory.beforeIntegrationWrite(async () => {});
  factory.coordinator.resume(goal.id);
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
  assert.equal(factory.store.list<Attempt>("attempts").length, 1);
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.candidate, "candidate-commit");
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.capture, 1);
  assert.equal(factory.calls.check, 1);
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.calls.diagnosis, 0);
});

for (const action of ["pause", "cancel"] as const) {
  test(`${action} during planning rejects the late plan without creating work`, async () => {
    const factory = harness();
    const planning = deferred<PlanResponse>();
    const entered = deferred<void>();
    factory.planning(() => { entered.resolve(); return planning.promise; });
    const goal = factory.goal();
    await factory.coordinator.tick();
    await entered.promise;
    await factory.coordinator[action](goal.id);
    planning.resolve(plan);
    await factory.coordinator.waitForIdle();
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, action === "pause" ? "paused" : "canceled");
    assert.equal(factory.store.list<FactoryTask>("tasks").length, 0);
    assert.equal(factory.calls.execute, 0);
  });
}

test("unknown execution is reconciled without duplicating its effects", async () => {
  const factory = harness();
  factory.executing(async () => ({ status: "unknown", text: "Worker connection disappeared" }));
  await planGoal(factory);
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  assert.equal(attempt.status, "unknown");
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.store.list<Attempt>("attempts").length, 1);
  assert.equal(factory.calls.integrate, 0);
  factory.reconciling(async () => ({ status: "succeeded", result: { status: "succeeded", text: "Owner confirmed the original work succeeded" } }));
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.capture, 1);
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
});

test("service recovery observes the previous running attempt without busy polling or redispatch", async () => {
  const factory = harness();
  const entered = deferred<void>();
  const execution = deferred<ExecutionResult>();
  const laterObservation = deferred<Awaited<ReturnType<FactoryRuntimePort["reconcile"]>>>();
  factory.executing(() => { entered.resolve(); return execution.promise; });
  factory.reconciling(async () => factory.calls.reconcile === 1 ? { status: "unknown" } : laterObservation.promise);
  await planGoal(factory);
  await factory.coordinator.tick();
  await entered.promise;
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  assert.equal(attempt.status, "running");
  const recovered = factory.recover();
  try {
    await recovered.start();
    await delay(50);
    assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "unknown");
    assert.equal(factory.calls.reconcile, 1, "An unchanged unknown observation waits for a timer or owner event");
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.store.list<Attempt>("attempts").length, 1);
    assert.equal(factory.calls.integrate, 0);
  } finally {
    recovered.stop();
    laterObservation.resolve({ status: "unknown" });
    execution.resolve({ status: "unknown", text: "The previous connection also lost its observation" });
    await Promise.all([recovered.waitForIdle(), factory.coordinator.waitForIdle()]);
  }
});

test("a lost integration acknowledgement stays unknown until recovery confirms the original commit", async () => {
  const factory = harness();
  factory.afterIntegrationWrite(async () => { throw new Error("Connection closed after the repository write"); });
  const goal = await planGoal(factory);
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  assert.equal(attempt.status, "unknown");
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.calls.diagnosis, 0);
  factory.reconcileIntegration(async (_project, candidate) => ({ commit: "integrated-head", previousHead: "initial-head", candidateCommit: candidate.commit,
    checks: [{ command: "npm run verify", passed: true, output: "Recovered combined verification", candidateCommit: candidate.commit, checkedCommit: "integrated-head" }] }));
  const recovered = factory.recover();
  try {
    await recovered.start();
    await recovered.waitForIdle();
    assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
    assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "succeeded");
    assert.equal(factory.store.list<Attempt>("attempts").length, 1);
    assert.equal(factory.calls.reconcileIntegration, 1);
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.calls.integrate, 1);
    assert.equal(factory.calls.diagnosis, 0);
    assert.equal(factory.store.list<Decision>("decisions").some(decision => decision.kind === "integration-recovered"), true);
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  } finally { recovered.stop(); }
});

test("a recovered prepared workspace stays paused and resumes the same execution authority", async () => {
  const factory = harness();
  const goal = await planGoal(factory);
  const attempt = retainedAttempt(factory, goal, { phase: "preparing" });
  const workspace = { id: "prepared-workspace", path: "/workspace/prepared", baseCommit: "initial-head", provider: "git" as const };
  factory.reconciling(async () => ({ status: "prepared", workspace }));
  factory.coordinator.pause(goal.id);
  const recovered = factory.recover();
  try {
    await recovered.start();
    await recovered.waitForIdle();
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "paused");
    assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.workspace, workspace);
    assert.equal(factory.calls.execute, 0);
    assert.equal(factory.calls.prepare, 0);
    recovered.resume(goal.id);
    await recovered.tick();
    await recovered.waitForIdle();
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.calls.prepare, 0);
    assert.equal(factory.calls.diagnosis, 0);
    assert.equal(factory.store.list<Attempt>("attempts").length, 1);
    const resumed = factory.store.get<Attempt>("attempts", attempt.id)!;
    assert.equal(resumed.generation, attempt.generation);
    assert.equal(resumed.status, "succeeded");
    assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.currentAttemptId, attempt.id);
    assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
  } finally { recovered.stop(); }
});

test("an extra tick cannot duplicate processing while recovered candidate checks are pending", async () => {
  const factory = harness();
  const goal = await planGoal(factory);
  retainedAttempt(factory, goal, {
    phase: "checking", workspace: { id: "retained-workspace", path: "/workspace/retained", baseCommit: "initial-head", provider: "git" },
    candidate: { id: "retained-candidate", commit: "candidate-commit", baseCommit: "initial-head" },
    result: { status: "succeeded", text: "The original worker completed before the coordinator restarted" },
  });
  const entered = deferred<void>();
  const checks = deferred<void>();
  factory.beforeCheck(() => { entered.resolve(); return checks.promise; });
  const recovered = factory.recover();
  try {
    await recovered.start();
    await entered.promise;
    await recovered.tick();
    assert.equal(factory.calls.check, 1);
    assert.equal(factory.calls.execute, 0);
    assert.equal(factory.calls.capture, 0);
    assert.equal(factory.calls.integrate, 0);
    checks.resolve();
    await recovered.waitForIdle();
    assert.equal(factory.calls.check, 1);
    assert.equal(factory.calls.integrate, 1);
    assert.equal(factory.store.list<Attempt>("attempts").length, 1);
    assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
  } finally {
    recovered.stop(); checks.resolve();
    await recovered.waitForIdle();
  }
});

const invalidEvaluations: Array<[string, EvaluationResponse]> = [
  ["an explicit criterion is missing", { ...completeEvaluation, criteria: completeEvaluation.criteria.slice(0, 1) }],
  ["a criterion has no evidence", { ...completeEvaluation, criteria: completeEvaluation.criteria.map((criterion, index) => index ? { ...criterion, evidence: [] } : criterion) }],
  ["a criterion is unsatisfied", { ...completeEvaluation, criteria: completeEvaluation.criteria.map((criterion, index) => index ? { ...criterion, satisfied: false } : criterion) }],
  ["the evaluator identifies outstanding work", { ...completeEvaluation, additionalTasks: [{ key: "follow-up", title: "Verify published release", description: "Complete the remaining release verification", dependsOn: [], checks: [] }] }],
];
for (const [reason, evaluation] of invalidEvaluations) {
  test(`complete=true cannot complete a goal when ${reason}`, async () => {
    const factory = harness();
    factory.evaluating(async () => evaluation);
    const goal = await finishTask(factory);
    await factory.coordinator.tick();
    await factory.coordinator.waitForIdle();
    assert.equal(factory.calls.evaluator, 1);
    assert.notEqual(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  });
}

test("completion records evidence for every explicit criterion after all work is integrated", async () => {
  assert.deepEqual(readPlan(`Planner explanation before JSON.\n${JSON.stringify(plan)}\nThe nested task belongs to this outer plan.`), plan);
  const factory = harness();
  const goal = await finishTask(factory);
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  assert.equal(factory.calls.evaluator, 1);
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.store.list<FactoryTask>("tasks").every(task => task.status === "completed"), true);
  const evidence = factory.store.list<EvaluationRecord>("factory-evaluations");
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0]!.evaluation.criteria, completeEvaluation.criteria);
  assert.equal(evidence[0]!.head, "integrated-head");
});

test("dirty content changing during evaluation invalidates completion even when HEAD and status stay the same", async () => {
  const factory = harness();
  let fingerprint = "content-before";
  factory.inspect(async () => ({ head: "integrated-head", branch: "main", status: " M app.ts", fingerprint }));
  const entered = deferred<void>();
  const evaluation = deferred<EvaluationResponse>();
  factory.evaluating(async () => {
    if (factory.calls.evaluator === 1) { entered.resolve(); return evaluation.promise; }
    return completeEvaluation;
  });
  const goal = await finishTask(factory);
  await factory.coordinator.tick();
  await entered.promise;
  fingerprint = "content-after";
  evaluation.resolve(completeEvaluation);
  await factory.coordinator.waitForIdle();
  assert.notEqual(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  assert.equal(factory.store.list<EvaluationRecord>("factory-evaluations").length, 0);
  assert.equal(factory.store.list<Decision>("decisions").some(decision => decision.kind === "evaluation-stale"), true);

  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.evaluator, 2);
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  assert.equal(factory.store.list<EvaluationRecord>("factory-evaluations").length, 1);
  assert.equal(factory.calls.execute, 1);
});

test("autonomous continuation repairs a confirmed failure and reaches evaluated completion", async () => {
  const factory = harness();
  factory.executing(async () => factory.calls.execute === 1
    ? { status: "failed", text: "Expected a successful route response but received 404" }
    : { status: "succeeded", text: "Added the missing route; app and release verified" });
  const goal = factory.goal();
  try {
    await factory.coordinator.start();
    await factory.coordinator.waitForIdle();
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
    assert.equal(factory.calls.planner, 1);
    assert.equal(factory.calls.diagnosis, 1);
    assert.equal(factory.calls.execute, 2);
    assert.equal(factory.calls.integrate, 1);
    assert.equal(factory.calls.evaluator, 1);
    const attempts = factory.store.list<Attempt>("attempts");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map(attempt => attempt.generation), [1, 2]);
    assert.deepEqual(attempts.map(attempt => attempt.status), ["failed", "succeeded"]);
    assert.match(factory.executionPrompts[1]!, /Add the missing route and verify the response/);
    const decisions = factory.store.list<Decision>("decisions");
    assert.equal(decisions.some(decision => decision.kind === "repair"), true);
    assert.equal(decisions.some(decision => decision.kind === "completed"), true);
  } finally { factory.coordinator.stop(); }
});
