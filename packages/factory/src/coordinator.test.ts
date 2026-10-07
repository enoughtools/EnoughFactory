import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Attempt, Decision, Device, FactoryTask, Goal, Project } from "@enoughfactory/contracts";
import { FactoryCoordinator } from "./coordinator.js";
import { FactoryControllerError } from "./errors.js";
import { readPlan } from "./protocol.js";
import type {
  AttemptDetail, CandidateRef, ControlRecord, EvaluationRecord, EvaluationResponse, ExecutionResult, FactoryRuntimePort,
  FactoryStore, FactoryWorkspacePort, PlanRecord, PlanResponse, TaskDetail,
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

function harness(devices: Device[] = [device], now?: () => Date) {
  const store = new MemoryStore();
  const calls = { planner: 0, evaluator: 0, diagnosis: 0, execute: 0, reconcile: 0, cancel: 0, prepare: 0, capture: 0, check: 0, goalCheck: 0, integrate: 0, integrationFences: 0, reconcileIntegration: 0 };
  const executionPrompts: string[] = [];
  const planningPrompts: string[] = [];
  const evaluationPrompts: string[] = [], candidateCommands: string[][] = [], integrationCommands: string[][] = [], goalCommands: string[][] = [];
  let planning: () => Promise<PlanResponse> = async () => plan;
  let evaluating: () => Promise<EvaluationResponse> = async () => completeEvaluation;
  let executing: () => Promise<ExecutionResult> = async () => ({ status: "succeeded", text: "Implementation complete" });
  let diagnosing = async () => ({ action: "retry", reason: "The expected route was missing", instructions: "Add the missing route and verify the response" });
  const diagnosisPrompts: string[] = [];
  let reconciling: FactoryRuntimePort["reconcile"] = async () => ({ status: "unknown" });
  let beforeIntegrationWrite: () => Promise<void> = async () => {};
  let afterIntegrationWrite: () => Promise<void> = async () => {};
  let beforeCheck: () => Promise<void> = async () => {};
  let reconcilingIntegration: FactoryWorkspacePort["reconcileIntegration"];
  let inspecting: FactoryWorkspacePort["inspect"] = async () => ({ head: "integrated-head", branch: "main", status: "", artifacts: [{ name: "Release", sha256: "release-hash" }] });
  let checkingGoal = async (current: Project, commands: string[]) => {
    const repository = await inspecting(current);
    return { repository, checks: commands.map(command => ({ command, passed: true, output: "Goal verified", exitCode: 0, candidateCommit: repository.head, checkedCommit: repository.head })) };
  };
  const runtime: FactoryRuntimePort = {
    async complete(input) {
      if (input.role === "planner") { calls.planner++; planningPrompts.push(input.prompt); return { text: JSON.stringify(await planning()) }; }
      if (input.role === "evaluator") { calls.evaluator++; evaluationPrompts.push(input.prompt); return { text: JSON.stringify(await evaluating()) }; }
      calls.diagnosis++;
      diagnosisPrompts.push(input.prompt);
      return { text: JSON.stringify(await diagnosing()) };
    },
    async execute(input) { calls.execute++; executionPrompts.push(input.prompt); return executing(); },
    async reconcile(attempt) { calls.reconcile++; return reconciling(attempt); },
    async cancel() { calls.cancel++; },
  };
  const candidate: CandidateRef = { id: "candidate", commit: "candidate-commit", baseCommit: "initial-head" };
  let capturing: FactoryWorkspacePort["capture"] = async () => candidate;
  const workspaces: FactoryWorkspacePort = {
    async prepare({ attempt }) { calls.prepare++; return { id: attempt.id, path: `/workspace/${attempt.id}`, baseCommit: "initial-head", provider: "git" }; },
    async capture(workspace, input) { calls.capture++; return capturing(workspace, input); },
    async check(_project, current, commands) {
      calls.check++;
      candidateCommands.push([...commands]);
      await beforeCheck();
      return commands.map(command => ({ command, passed: true, output: "verified", exitCode: 0, candidateCommit: current.commit }));
    },
    async integrate(_project, current, input) {
      await beforeIntegrationWrite();
      calls.integrationFences++;
      if (!input.isCurrent()) throw new Error("Integration authority has been revoked");
      calls.integrate++;
      integrationCommands.push([...input.checks]);
      await afterIntegrationWrite();
      return { commit: "integrated-head", previousHead: "initial-head", candidateCommit: current.commit,
        checks: input.checks.map(command => ({ command, passed: true, output: "Combined result verified", exitCode: 0, candidateCommit: current.commit, checkedCommit: "integrated-head" })) };
    },
    async inspect(current) { return inspecting(current); },
    async checkGoal(current, commands) { calls.goalCheck++; goalCommands.push([...commands]); return checkingGoal(current, commands); },
    async reconcileIntegration(current, retainedCandidate) {
      calls.reconcileIntegration++;
      return reconcilingIntegration?.(current, retainedCandidate);
    },
    async release() {},
  };
  const options = { store, runtime, workspaces, deviceId: device.id, devices: () => devices, project: (id: string) => id === project.id ? project : undefined, now };
  const coordinator = new FactoryCoordinator(options);
  const goal = () => coordinator.create({ projectId: project.id, objective: "Build the feature and publish its release", criteria, autonomy: "autonomous", approvalMode: "approve-all", concurrency: 1 });
  return {
    store, calls, coordinator, goal, planningPrompts, executionPrompts, evaluationPrompts, diagnosisPrompts, candidateCommands, integrationCommands, goalCommands, workspaces, recover: () => new FactoryCoordinator(options),
    planning(fn: typeof planning) { planning = fn; },
    evaluating(fn: typeof evaluating) { evaluating = fn; },
    executing(fn: typeof executing) { executing = fn; },
    diagnosing(fn: typeof diagnosing) { diagnosing = fn; },
    capturing(fn: typeof capturing) { capturing = fn; },
    reconciling(fn: typeof reconciling) { reconciling = fn; },
    beforeIntegrationWrite(fn: typeof beforeIntegrationWrite) { beforeIntegrationWrite = fn; },
    afterIntegrationWrite(fn: typeof afterIntegrationWrite) { afterIntegrationWrite = fn; },
    beforeCheck(fn: typeof beforeCheck) { beforeCheck = fn; },
    reconcileIntegration(fn: NonNullable<typeof reconcilingIntegration>) { reconcilingIntegration = fn; },
    inspect(fn: typeof inspecting) { inspecting = fn; },
    goalChecking(fn: typeof checkingGoal) { checkingGoal = fn; },
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

test("controllers retain every contract and exact evidence identity without embedding a large accepted history", async () => {
  const factory = harness(), created = factory.goal();
  const originalCriteria = Array.from({ length: 9 }, (_, index) => `Original completion criterion ${index}: deliver the actual native behavior`);
  const goal = { ...created, criteria: originalCriteria, revision: 13 };
  factory.store.set("goals", goal);
  const output = `Check began\n${'\u0000\\"\n'.repeat(30_000)}\nFINAL FAILURE: concrete native launch error`;
  const accepted: FactoryTask[] = [];
  for (let index = 0; index < 38; index++) {
    const task: FactoryTask = { id: `accepted-${index}`, goalId: goal.id, title: `Accepted task ${index}`, description: `Full accepted contract ${index}`,
      kind: "feature", acceptanceCriteria: [`Behavior ${index} must work`], expectedOutputs: [`deliverable-${index}`], writePaths: [`Packages/Feature${index}`],
      dependsOn: index ? [`accepted-${index - 1}`] : [], status: "completed", currentAttemptId: `accepted-attempt-${index}`, createdAt: device.lastSeen, updatedAt: device.lastSeen };
    accepted.push(task);
    factory.store.set("tasks", task);
    factory.store.set<TaskDetail>("factory-task-details", { id: task.id, key: `accepted-key-${index}`, checks: [`check-feature-${index}`], planRevision: 12, selected: false, failureSignatures: [] });
    factory.store.set<Attempt>("attempts", { id: task.currentAttemptId!, taskId: task.id, generation: 1, deviceId: device.id, status: "succeeded", startedAt: device.lastSeen });
    const checks = [{ command: `check-feature-${index}`, passed: true, output, exitCode: 0, candidateCommit: `accepted-source-${index}`, checkedCommit: `accepted-merge-${index}` }];
    factory.store.set<AttemptDetail>("factory-attempt-details", { id: task.currentAttemptId!, goalId: goal.id, goalRevision: 12, cancellation: "none", phase: "done",
      contract: { title: task.title, description: task.description, kind: task.kind, acceptanceCriteria: task.acceptanceCriteria, expectedOutputs: task.expectedOutputs,
        dependsOn: task.dependsOn, checks: checks.map(check => check.command), planRevision: 12 },
      candidate: { id: `accepted-candidate-${index}`, commit: `accepted-source-${index}`, baseCommit: `accepted-base-${index}`,
        bundleArtifact: { id: `bundle-${index}`, sha256: `bundle-sha-${index}`, metadata: { hugeInventory: output } }, ignoredProviderState: output },
      result: { status: "succeeded", text: output }, checks,
      integration: { commit: `accepted-merge-${index}`, previousHead: `accepted-base-${index}`, candidateCommit: `accepted-source-${index}`, checks } });
  }
  const retainedTask: FactoryTask = { id: "current-repair", goalId: goal.id, title: "Current integration", description: "Wire the remaining actual application",
    acceptanceCriteria: ["Current wiring contract"], expectedOutputs: ["Native fixture launch"], dependsOn: [accepted[37]!.id], status: "failed", createdAt: device.lastSeen, updatedAt: device.lastSeen };
  factory.store.set("tasks", retainedTask);
  factory.store.set<TaskDetail>("factory-task-details", { id: retainedTask.id, key: "current-integration", checks: ["check-current"], planRevision: 12,
    lastError: output, lastCandidate: { id: "newest-retained-candidate", commit: "newest-retained-commit", baseCommit: "latest-base" }, selected: false, failureSignatures: [] });
  factory.store.set<PlanRecord>("factory-plans", { id: goal.id, goalId: goal.id, revision: 12, summary: "Current whole-goal contract", checks: ["prior-whole-goal-check"], checkScope: "goal",
    taskKeys: Object.fromEntries([...accepted.map((task, index) => [`accepted-key-${index}`, task.id]), ["current-integration", retainedTask.id]]), createdAt: device.lastSeen });
  factory.store.set<ControlRecord>("factory-control", { ...factory.store.get<ControlRecord>("factory-control", goal.id)!, stage: "plan",
    steering: ["Preserve all nine criteria and accepted work"], replanInstructions: "Use the newest retained candidate and finish actual wiring", replanReason: `Legacy diagnostic reason embedded a complete log: ${output}` });
  factory.planning(async () => ({ summary: "Continue exact retained integration", criteria: originalCriteria, checks: ["check-whole-goal"], tasks: [{
    key: "current-integration", title: retainedTask.title, description: retainedTask.description, acceptanceCriteria: retainedTask.acceptanceCriteria,
    expectedOutputs: retainedTask.expectedOutputs, dependsOn: ["accepted-key-37"], checks: ["check-current"],
  }] }));
  const durableBefore = factory.store.get<AttemptDetail>("factory-attempt-details", "accepted-attempt-37")!;
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.planner, 1, "large evidence must reach the provider rather than fail its input schema");
  const planningPrompt = factory.planningPrompts[0]!;
  for (const task of accepted) {
    const index = Number(task.id.split("-")[1]);
    for (const expected of [task.description, task.acceptanceCriteria![0]!, task.expectedOutputs![0]!, `accepted-key-${index}`, `check-feature-${index}`, `accepted-source-${index}`, `accepted-merge-${index}`, `accepted-candidate-${index}`, `bundle-sha-${index}`]) assert.ok(planningPrompt.includes(expected), expected);
  }
  for (const value of [...originalCriteria, "newest-retained-candidate", "newest-retained-commit", "Use the newest retained candidate and finish actual wiring", "Preserve all nine criteria and accepted work", "prior-whole-goal-check"]) assert.ok(planningPrompt.includes(value), value);

  const replacement = factory.store.get<FactoryTask>("tasks", retainedTask.id)!;
  const failedAttempt: Attempt = { id: "current-failed-attempt", taskId: replacement.id, generation: 2, deviceId: device.id, status: "failed", error: output, startedAt: device.lastSeen };
  factory.store.set("attempts", failedAttempt);
  factory.store.set("tasks", { ...replacement, status: "failed", currentAttemptId: failedAttempt.id });
  factory.store.set<AttemptDetail>("factory-attempt-details", { id: failedAttempt.id, goalId: goal.id, goalRevision: goal.revision, cancellation: "none", phase: "done",
    candidate: { id: "newest-retained-candidate", commit: "newest-retained-commit", baseCommit: "latest-base" }, result: { status: "failed", text: output },
    checks: [{ command: "check-current", passed: false, output, exitCode: 1, candidateCommit: "newest-retained-commit" }] });
  factory.store.set<ControlRecord>("factory-control", { ...factory.store.get<ControlRecord>("factory-control", goal.id)!, stage: "diagnose", diagnosisTaskId: replacement.id });
  factory.diagnosing(async () => ({ action: "wait", reason: "Need native evidence", instructions: "Preserve current candidate" }));
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.diagnosis, 1);
  assert.ok(factory.diagnosisPrompts[0]!.includes("FINAL FAILURE: concrete native launch error"), "repair retains the actual failure tail");
  assert.ok(factory.diagnosisPrompts[0]!.includes("newest-retained-commit"));

  factory.store.set("tasks", { ...factory.store.get<FactoryTask>("tasks", replacement.id)!, status: "canceled" });
  const repository = { head: "final-primary", branch: "main", status: "", fingerprint: "exact-tree", diff: output };
  factory.inspect(async () => repository);
  factory.goalChecking(async (_project, commands) => ({ repository, checks: commands.map(command => ({ command, passed: false, output, exitCode: 1, candidateCommit: repository.head, checkedCommit: repository.head })) }));
  factory.evaluating(async () => ({ complete: false, summary: "Repair actual launch failure", criteria: originalCriteria.map(criterion => ({ criterion, satisfied: false, evidence: [] })) }));
  factory.coordinator.requestEvaluation(goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.evaluator, 1);
  const evaluationPrompt = factory.evaluationPrompts[0]!;
  assert.ok(evaluationPrompt.includes("FINAL FAILURE: concrete native launch error"));
  assert.ok(evaluationPrompt.includes("factory-goal-checks/"));
  assert.ok(evaluationPrompt.includes('"passed":false'));
  for (const task of accepted) assert.ok(evaluationPrompt.includes(task.acceptanceCriteria![0]!), task.id);
  for (const prompt of [planningPrompt, factory.diagnosisPrompts[0]!, evaluationPrompt]) {
    assert.ok(prompt.length < 768 * 1024, `actual serialized controller prompt is ${prompt.length} characters`);
    for (const criterion of originalCriteria) assert.ok(prompt.includes(criterion));
    assert.ok(prompt.includes("characters omitted"));
    assert.ok(prompt.includes("sha256"));
  }
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", "accepted-attempt-37"), durableBefore, "summarization never changes retained evidence");
  const receipt = factory.store.list<import("./types.js").GoalCheckRecord>("factory-goal-checks")[0]!;
  assert.equal(receipt.checks[0]!.output, output, "the whole-goal receipt preserves the full failure");
  assert.ok(factory.store.get<ControlRecord>("factory-control", goal.id)!.replanReason!.length < 100_000, "future replans do not re-embed the full check log");
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, originalCriteria);
});

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

test("fail-fast verification retains the actual failed command without diagnosing unrun checks as omitted", async () => {
  const factory = harness();
  factory.planning(async () => ({ ...plan, checks: [], tasks: plan.tasks.map(task => ({ ...task, checks: ["npm run verify", "npm run release"] })) }));
  const stderr = "Error: regression route /health returned 503";
  factory.workspaces.check = async (_project, candidate) => {
    factory.calls.check++;
    return [{ command: "npm run verify", passed: false, output: stderr, exitCode: 1, candidateCommit: candidate.commit }];
  };
  await planGoal(factory);
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();

  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error!, /Candidate checks failed/);
  assert.match(attempt.error!, /npm run verify/);
  assert.ok(attempt.error!.includes(stderr), "repair must receive the real command error");
  assert.doesNotMatch(attempt.error!, /omitted/);
  const detail = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  assert.deepEqual(detail.checks, [{ command: "npm run verify", passed: false, output: stderr, exitCode: 1, candidateCommit: "candidate-commit" }]);
  assert.equal(factory.calls.integrate, 0, "a partial failed report cannot authorize integration");
});

test("ArtifactFS work waits for a capable device and wakes when one connects", async () => {
  const devices: Device[] = [{ ...device, workspaceProviders: ["git"] }];
  const factory = harness(devices);
  const goal = await planGoal(factory);
  factory.store.set("goals", { ...factory.store.get<Goal>("goals", goal.id)!, workspaceProvider: "artifactfs" });
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "waiting");
  assert.equal(factory.calls.execute, 0);
  assert.equal(factory.store.list<Attempt>("attempts").length, 0);

  devices.push({ ...device, id: "mount-capable-worker", platform: "darwin", local: false, workspaceProviders: ["git", "artifactfs"] });
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  assert.equal(attempt.deviceId, "mount-capable-worker");
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
});

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

test("stale retirement cannot revoke a newer running repair attempt", async () => {
  const factory = harness();
  const execution = deferred<ExecutionResult>();
  const entered = deferred<void>();
  factory.executing(async () => {
    if (factory.calls.execute === 1) return { status: "failed", text: "The route returned 404" };
    entered.resolve(); return execution.promise;
  });
  const goal = factory.goal();
  try {
    await factory.coordinator.start();
    await entered.promise;
    const attempts = factory.store.list<Attempt>("attempts");
    assert.deepEqual(attempts.map(attempt => attempt.generation), [1, 2]);
    assert.equal(attempts[0]!.status, "failed");
    const current = attempts[1]!;
    const taskBefore = factory.store.get<FactoryTask>("tasks", current.taskId)!;
    const decisionsBefore = factory.store.list<Decision>("decisions");
    assert.equal(taskBefore.currentAttemptId, current.id);
    assert.equal(current.status, "running");

    await assert.rejects(factory.coordinator.retireAttempt(attempts[0]!.id), /no longer owns its task's execution authority/);
    assert.deepEqual(factory.store.get<FactoryTask>("tasks", current.taskId), taskBefore);
    assert.deepEqual(factory.store.list<Attempt>("attempts"), attempts);
    assert.deepEqual(factory.store.list<Decision>("decisions"), decisionsBefore);
    assert.equal(factory.calls.cancel, 0);
    await factory.coordinator.tick();
    assert.equal(factory.calls.execute, 2);
    assert.equal(factory.store.list<Attempt>("attempts").length, 2);

    execution.resolve({ status: "succeeded", text: "Repaired route and verified release" });
    await factory.coordinator.waitForIdle();
    assert.equal(factory.store.get<FactoryTask>("tasks", current.taskId)!.currentAttemptId, current.id);
    assert.equal(factory.store.get<FactoryTask>("tasks", current.taskId)!.status, "completed");
    assert.equal(factory.calls.integrate, 1);
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  } finally {
    factory.coordinator.stop();
    execution.resolve({ status: "succeeded", text: "Cleanup retained execution" });
    await factory.coordinator.waitForIdle();
  }
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

test("restart preserves failed repair history and recovers only the current successful candidate", async () => {
  const factory = harness();
  const goal = await planGoal(factory);
  const current = retainedAttempt(factory, goal, {
    phase: "checking", workspace: { id: "retained-workspace", path: "/workspace/retained", baseCommit: "initial-head", provider: "git" },
    candidate: { id: "retained-candidate", commit: "candidate-commit", baseCommit: "initial-head" },
    result: { status: "succeeded", text: "The third repair completed before restart" },
  });
  factory.store.set("attempts", { ...current, generation: 4, status: "succeeded" });
  const history = [
    { ...current, id: "first-failed", generation: 1, status: "failed" as const, error: "npm run verify failed: missing route", endedAt: device.lastSeen },
    { ...current, id: "second-failed", generation: 2, status: "failed" as const, error: "combined check failed: missing artifact", endedAt: device.lastSeen },
    { ...current, id: "retired-repair", generation: 3, status: "retired" as const, endedAt: device.lastSeen },
  ];
  for (const [index, attempt] of history.entries()) {
    factory.store.set("attempts", attempt);
    factory.store.set<AttemptDetail>("factory-attempt-details", {
      ...factory.store.get<AttemptDetail>("factory-attempt-details", current.id)!, id: attempt.id,
      phase: index === 1 ? "integrating" : "checking", cancellation: attempt.status === "retired" ? "acknowledged" : "none",
    });
  }
  factory.coordinator.pause(goal.id);
  const recovered = factory.recover();
  try {
    await recovered.start();
    await recovered.waitForIdle();
    for (const attempt of history) assert.deepEqual(factory.store.get<Attempt>("attempts", attempt.id), attempt);
    assert.equal(factory.store.get<Attempt>("attempts", current.id)!.status, "succeeded");
    assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.currentAttemptId, current.id);
    const recoveredDecisions = factory.store.list<Decision>("decisions").filter(decision => decision.kind === "attempt-recovered");
    assert.equal(recoveredDecisions.length, 1, "only current execution authority needs reconciliation");
    assert.equal((recoveredDecisions[0]!.data as { attemptId: string }).attemptId, current.id);
    assert.equal(factory.calls.execute, 0);
    assert.equal(factory.calls.capture, 0);
    assert.equal(factory.calls.check, 0);
    assert.equal(factory.calls.integrate, 0);
    assert.equal(factory.calls.diagnosis, 0);
    assert.equal(factory.calls.planner, 1, "restart does not request fresh planning");
  } finally { recovered.stop(); }
});

test("restart preserves the original completion time of a successful candidate awaiting resume", async () => {
  let time = "2026-10-05T01:00:00.000Z";
  const factory = harness([device], () => new Date(time));
  const goal = await planGoal(factory);
  factory.executing(async () => {
    time = "2026-10-05T01:05:00.000Z";
    factory.coordinator.pause(goal.id);
    return { status: "succeeded", text: "Implementation complete before service restart" };
  });
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  const original = factory.store.list<Attempt>("attempts")[0]!;
  const originalDetail = factory.store.get<AttemptDetail>("factory-attempt-details", original.id)!;
  assert.equal(original.endedAt, time, "a fresh result records its actual completion time");
  assert.equal(original.status, "succeeded");
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "review");
  assert.ok(originalDetail.candidate);
  factory.coordinator.stop();
  time = "2026-10-05T02:00:00.000Z";
  const recovered = factory.recover();
  try {
    await recovered.start();
    await recovered.waitForIdle();
    assert.deepEqual(factory.store.get<Attempt>("attempts", original.id), original);
    const recoveredDetail = factory.store.get<AttemptDetail>("factory-attempt-details", original.id)!;
    assert.deepEqual(recoveredDetail.candidate, originalDetail.candidate);
    assert.deepEqual(recoveredDetail.checks, originalDetail.checks);
    assert.deepEqual(recoveredDetail.workspace, originalDetail.workspace);
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "paused");
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.calls.capture, 1);
    assert.equal(factory.calls.check, 0);
    assert.equal(factory.calls.integrate, 0);
  } finally { recovered.stop(); }
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

test("bounded tasks integrate with their own checks before whole-goal checks run on the complete repository", async () => {
  const factory = harness();
  factory.planning(async () => ({ ...plan, checks: ["npm run check-product"], tasks: [
    { key: "api", title: "Implement API", description: "Deliver the API contract", dependsOn: [], checks: ["npm run check-api"] },
    { key: "web", title: "Implement UI", description: "Use the delivered API", dependsOn: ["api"], checks: ["npm run check-web"] },
  ] }));
  const goal = factory.goal();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<PlanRecord>("factory-plans", goal.id)!.checkScope, "goal");
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.store.list<FactoryTask>("tasks").filter(task => task.status === "completed").length, 1);
  assert.deepEqual(factory.candidateCommands, [["npm run check-api"]]);
  assert.equal(factory.calls.goalCheck, 0, "a partly implemented product is checked against the bounded task contract");
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.deepEqual(factory.candidateCommands, [["npm run check-api"], ["npm run check-web"]]);
  assert.deepEqual(factory.integrationCommands, factory.candidateCommands);
  assert.equal(factory.calls.goalCheck, 0);
  const contracts = factory.store.list<AttemptDetail>("factory-attempt-details").map(detail => detail.contract!.checks);
  assert.deepEqual(contracts, factory.candidateCommands);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.deepEqual(factory.goalCommands, [["npm run check-product"]]);
  assert.equal(factory.calls.evaluator, 1);
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
});

test("whole-goal check receipts are reused only for the same revision, commands and exact repository state", async () => {
  const factory = harness();
  const repository = { head: "integrated-head", branch: "main", status: "", fingerprint: "content-one", diff: "" };
  factory.inspect(async () => ({ ...repository }));
  factory.evaluating(async () => ({ ...completeEvaluation, complete: false, waitReason: "Waiting for deployment", wakeCondition: "deployment-ready" }));
  const goal = await finishTask(factory);
  async function evaluateAgain() {
    factory.coordinator.notifyCondition("deployment-ready", goal.id);
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "waiting");
  }
  await evaluateAgain();
  assert.equal(factory.calls.goalCheck, 1);
  await evaluateAgain();
  assert.equal(factory.calls.goalCheck, 1, "unchanged evaluation does not repeat the same verification");
  const changes = [
    () => { repository.fingerprint = "content-two"; },
    () => { repository.status = " M app.ts"; },
    () => { repository.diff = "Changed application content"; },
    () => { repository.head = "new-integrated-head"; },
    () => { const current = factory.store.get<PlanRecord>("factory-plans", goal.id)!; factory.store.set("factory-plans", { ...current, checks: ["npm run changed-product-check"] }); },
    () => { const current = factory.store.get<Goal>("goals", goal.id)!; factory.store.set("goals", { ...current, revision: current.revision + 1 }); },
  ];
  for (const [index, change] of changes.entries()) {
    change(); await evaluateAgain();
    assert.equal(factory.calls.goalCheck, index + 2, "changed receipt inputs require fresh exact-state evidence");
  }
  assert.equal(factory.calls.evaluator, 8);
  assert.equal(factory.calls.check, 1, "accepted task checks are not repeated during goal evaluation");
  assert.equal(factory.calls.integrate, 1);
});

test("failed whole-goal checks retain repair evidence and prevent a model's complete=true from completing the goal", async () => {
  const factory = harness();
  const failureOutput = "Product scenario failed: the integrated API and UI disagree";
  factory.goalChecking(async (_project, commands) => ({
    repository: { head: "integrated-head", branch: "main", status: "" },
    checks: commands.map(command => ({ command, passed: false, output: failureOutput, exitCode: 1, candidateCommit: "integrated-head", checkedCommit: "integrated-head" })),
  }));
  const goal = await finishTask(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.goalCheck, 1);
  assert.equal(factory.calls.evaluator, 1, "the evaluator receives the failure to choose proportionate repair work");
  assert.ok(factory.evaluationPrompts[0]!.includes(failureOutput));
  assert.notEqual(factory.store.get<Goal>("goals", goal.id)!.status, "completed", "green task checks and a positive model response cannot overrule the failing product scenario");
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed", "a whole-goal failure retains the accepted bounded task");
  assert.equal(factory.calls.diagnosis, 0);
  assert.equal(factory.calls.integrate, 1);
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

test("controller preparation retries retain deadlines and a bounded budget across service recovery", async t => {
  let at = Date.parse("2026-10-06T00:00:00Z");
  const factory = harness([device], () => new Date(at));
  factory.planning(async () => { throw new FactoryControllerError(`Download connection failure ${factory.calls.planner}`, "retry"); });
  const goal = factory.goal();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.planner, 1);
  const first = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  assert.equal(first.waitingFor, "controller-retry");
  assert.equal(Date.parse(first.wakeAt!) - at, 30_000);

  const recovered = factory.recover();
  t.after(() => recovered.stop());
  await recovered.start(); await recovered.waitForIdle();
  assert.equal(factory.calls.planner, 1, "restarting the service does not consume the wait or reset its budget");
  for (const [index, delayMs] of [30_000, 120_000, 300_000].entries()) {
    const current = factory.store.get<ControlRecord>("factory-control", goal.id)!;
    assert.equal(current.controllerFailures!.count, index + 1);
    assert.equal(Date.parse(current.wakeAt!) - at, delayMs);
    at = Date.parse(current.wakeAt!) - 1;
    await recovered.tick(); await recovered.waitForIdle();
    assert.equal(factory.calls.planner, index + 1, "a regular tick cannot bypass backoff");
    at++;
    await recovered.tick(); await recovered.waitForIdle();
    assert.equal(factory.calls.planner, index + 2);
  }
  const exhausted = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  assert.equal(exhausted.controllerFailures!.count, 4);
  assert.equal(exhausted.waitingFor, "controller-retry-required");
  assert.equal(exhausted.wakeAt, undefined);
  at += 3_600_000;
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.planner, 4, "equivalent transient errors eventually require changed conditions or explicit intervention");
});

test("localized planning retries preserve their scope while independent work completes", async () => {
  let at = Date.parse("2026-10-06T00:00:00Z");
  const factory = harness([device], () => new Date(at));
  factory.planning(async () => factory.calls.planner === 1 ? { ...plan, tasks: [
    { ...plan.tasks[0]!, key: "repair", title: "Repair branch" },
    { ...plan.tasks[0]!, key: "independent", title: "Independent branch" },
  ] } : factory.calls.planner === 2 ? Promise.reject(new FactoryControllerError("curl: (56) unexpected EOF", "retry")) : { ...plan, tasks: [{ ...plan.tasks[0]!, key: "repair", title: "Revised branch" }] });
  const goal = factory.goal();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const tasks = factory.store.list<FactoryTask>("tasks");
  const affected = tasks.find(task => task.title === "Repair branch")!;
  const independent = tasks.find(task => task.title === "Independent branch")!;
  const control = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  factory.store.set("tasks", { ...affected, status: "canceled" as const });
  factory.store.set("factory-control", { ...control, stage: "plan", replanTaskIds: [affected.id], replanReason: "Correct the affected branch" });
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const waiting = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "running");
  assert.equal(waiting.waitingFor, "controller-retry");
  assert.equal(waiting.stage, "plan");
  assert.deepEqual(waiting.replanTaskIds, [affected.id]);
  assert.equal(factory.store.get<FactoryTask>("tasks", independent.id)!.status, "completed", "repair preparation cannot stop a separate branch");
  at = Date.parse(waiting.wakeAt!);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.planner, 3);
  assert.equal(factory.store.get<FactoryTask>("tasks", independent.id)!.status, "completed");
  const after = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  assert.equal(after.controllerFailures, undefined, "a successful structured plan resets the consecutive failure budget");
  assert.equal(after.waitingFor, undefined);
  assert.equal(after.wakeAt, undefined);
});

test("unknown controller outcomes and external waits never acquire an automatic deadline", async () => {
  for (const error of [new Error("Provider acknowledgement was lost"), new FactoryControllerError("Sign in to the provider", "credentials-changed"), new FactoryControllerError("Provider quota exceeded", "provider-available")]) {
    let at = Date.parse("2026-10-06T00:00:00Z");
    const factory = harness([device], () => new Date(at));
    factory.planning(async () => { throw error; });
    const goal = factory.goal();
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    const control = factory.store.get<ControlRecord>("factory-control", goal.id)!;
    assert.equal(control.waitingFor, error instanceof FactoryControllerError ? error.recovery : "controller-retry-required");
    assert.equal(control.wakeAt, undefined);
    at += 3_600_000;
    factory.coordinator.notifyCondition("runtime-available");
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(factory.calls.planner, 1, "runtime refresh does not substitute for authentication, quota or a reconciled outcome");
  }
});

test("pausing, cancellation and changed goal authority fence scheduled controller retries", async () => {
  for (const action of ["pause", "cancel", "steer"] as const) {
    let at = Date.parse("2026-10-06T00:00:00Z");
    const factory = harness([device], () => new Date(at));
    factory.planning(async () => { throw new FactoryControllerError("Download interrupted", "retry"); });
    const goal = factory.goal();
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    const wait = factory.store.get<ControlRecord>("factory-control", goal.id)!;
    if (action === "pause") factory.coordinator.pause(goal.id);
    if (action === "cancel") await factory.coordinator.cancel(goal.id);
    if (action === "steer") {
      factory.coordinator.pause(goal.id);
      await factory.coordinator.steer(goal.id, { context: "Use the revised delivery requirements" });
      const revised = factory.store.get<ControlRecord>("factory-control", goal.id)!;
      assert.equal(revised.controllerFailures, undefined);
      assert.equal(revised.wakeAt, undefined);
    }
    at = Date.parse(wait.wakeAt!) + 1;
    factory.coordinator.notifyCondition("controller-retry");
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(factory.calls.planner, 1, `${action} cannot be undone by a queued deadline or condition notification`);
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, action === "cancel" ? "canceled" : "paused");
  }
});

test("replanning preserves authoritative goal criteria and explicit steering without accumulating planner paraphrases", async () => {
  for (const explicitCriteria of [criteria, []]) {
    const factory = harness();
    factory.planning(async () => ({ ...plan, criteria: factory.calls.planner === 1
      ? ["The requested app and release are usable"]
      : ["The application works", "The app is complete", "Publish a usable release"] }));
    const goal = factory.coordinator.create({ projectId: project.id, objective: "Build and release the complete app", criteria: explicitCriteria });
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    const authoritative = explicitCriteria.length ? explicitCriteria : ["The requested app and release are usable"];
    assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, authoritative, "only a goal without criteria derives them from the initial plan");
    factory.coordinator.requestPlan(goal.id);
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, authoritative, "a new plan cannot multiply exact-match evaluator obligations");
    const steeredCriteria = [...authoritative, "The new user-requested offline scenario works"];
    await factory.coordinator.steer(goal.id, { criteria: steeredCriteria, context: "Include the additional offline scenario" });
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, steeredCriteria, "explicit user scope remains authoritative after steering triggers another plan");
  }
});

test("repair captures a confirmed failed attempt after storage recovery before preparing diagnosis", async () => {
  const factory = harness();
  let spaceAvailable = false;
  const partial: CandidateRef = { id: "retained-failed-source", commit: "exact-partial-commit", baseCommit: "initial-head" };
  let originalAttempt: Attempt | undefined;
  factory.executing(async () => ({ status: "failed", text: "Failed to load workspace requirements" }));
  factory.capturing(async (workspace, input) => {
    if (originalAttempt) assert.equal(input.attempt.id, originalAttempt.id);
    assert.equal(workspace.id, input.attempt.id, "capture uses the same preserved workspace");
    if (!spaceAvailable) throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    return partial;
  });
  const goal = await planGoal(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  originalAttempt = factory.store.list<Attempt>("attempts")[0]!;
  const task = factory.store.list<FactoryTask>("tasks")[0]!;
  const originalWorkspace = factory.store.get<AttemptDetail>("factory-attempt-details", originalAttempt.id)!.workspace;
  assert.equal(originalAttempt.status, "failed");
  assert.equal(factory.calls.capture, 1);
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", originalAttempt.id)!.candidate, undefined);

  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const waiting = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  assert.equal(waiting.stage, "diagnose");
  assert.equal(waiting.waitingFor, "controller-retry-required");
  assert.match(waiting.waitReason!, /original environment is preserved.*storage or runtime problem/i);
  assert.equal(factory.calls.capture, 2);
  assert.equal(factory.calls.diagnosis, 0, "controller preparation must wait for failed source retention");
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.currentAttemptId, originalAttempt.id);
  assert.equal(factory.store.get<Attempt>("attempts", originalAttempt.id)!.status, "failed");

  spaceAvailable = true;
  factory.diagnosing(async () => {
    const retained = factory.store.get<AttemptDetail>("factory-attempt-details", originalAttempt!.id)!;
    assert.deepEqual(retained.candidate, partial, "exact source is durable before the controller context is constructed");
    assert.deepEqual(retained.workspace, originalWorkspace);
    assert.equal(retained.checks, undefined, "partial source is not evidence of passed checks");
    assert.equal(factory.store.get<Attempt>("attempts", originalAttempt!.id)!.status, "failed");
    if (factory.calls.diagnosis === 1) throw new FactoryControllerError("Diagnosis environment preparation was interrupted", "controller-retry-required");
    return { action: "retry", reason: "Resume from the retained source", instructions: "Continue the original assigned contract" };
  });
  factory.coordinator.notifyCondition("controller-retry-required", goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.capture, 3);
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", originalAttempt.id)!.candidate, partial);
  assert.deepEqual(factory.store.get<TaskDetail>("factory-task-details", task.id)!.lastCandidate, partial);
  assert.equal(factory.store.get<Attempt>("attempts", originalAttempt.id)!.candidate, partial.commit);
  assert.match(factory.diagnosisPrompts[0]!, /exact-partial-commit/);
  assert.equal(factory.calls.execute, 1, "retention never repeats the failed provider turn");
  assert.equal(factory.calls.check, 0);
  assert.equal(factory.calls.integrate, 0);

  factory.coordinator.notifyCondition("controller-retry-required", goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.capture, 3, "an already retained candidate is not captured again");
  assert.equal(factory.calls.diagnosis, 2);
  assert.equal(factory.calls.execute, 1);
  const decisions = factory.store.list<Decision>("decisions").filter(decision => decision.kind === "partial-work-retained");
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0]!.data, { attemptId: originalAttempt.id, candidate: partial.commit });
});

test("explicit retry cannot retire confirmed failed work until its source is retained", async () => {
  const factory = harness();
  let spaceAvailable = false;
  const partial: CandidateRef = { id: "saved-before-retirement", commit: "saved-failed-commit", baseCommit: "initial-head" };
  factory.executing(async () => ({ status: "failed", text: "Preparation ran out of disk space" }));
  factory.capturing(async () => {
    if (!spaceAvailable) throw new Error("No space left on device");
    return partial;
  });
  await planGoal(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  await assert.rejects(factory.coordinator.retireAttempt(attempt.id), /original environment is preserved/);
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "failed");
  assert.equal(factory.store.get<FactoryTask>("tasks", attempt.taskId)!.currentAttemptId, attempt.id);
  assert.equal(factory.calls.cancel, 0, "failed capture must not terminate the preserved environment");
  spaceAvailable = true;
  await factory.coordinator.retireAttempt(attempt.id);
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "retired");
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.candidate, partial);
  assert.equal(factory.calls.execute, 1);
});
