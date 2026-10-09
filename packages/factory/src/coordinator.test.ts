import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Attempt, Decision, Device, FactoryTask, Goal, Project } from "@enoughfactory/contracts";
import { FactoryCoordinator } from "./coordinator.js";
import { FactoryControllerError, FactoryVerificationWaitError } from "./errors.js";
import { readPlan } from "./protocol.js";
import { CONTROLLER_PROMPT_LIMIT, controllerTaskContract, controllerAttemptContract } from "./controller-evidence.js";
import type {
  AttemptDetail, CandidateRef, CheckResult, ControlRecord, EvaluationRecord, EvaluationResponse, ExecutionResult, FactoryRuntimePort,
  FactoryStore, FactoryWorkspacePort, PlanRecord, PlanResponse, TaskDetail, TaskCheckInputsConfiguration,
} from "./types.js";
import { UI_QUALITY_CHECK_COMMAND } from "./types.js";

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
  const controllerInputs: Parameters<FactoryRuntimePort["complete"]>[0][] = [];
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
      controllerInputs.push(structuredClone({ ...input, signal: undefined }));
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
  const goal = (acceptance?: Goal["acceptance"]) => coordinator.create({ projectId: project.id, objective: "Build the feature and publish its release", criteria, autonomy: "autonomous", approvalMode: "approve-all", concurrency: 1, acceptance });
  return {
    store, calls, coordinator, goal, planningPrompts, executionPrompts, evaluationPrompts, diagnosisPrompts, candidateCommands, integrationCommands, goalCommands, workspaces, runtime, controllerInputs, recover: () => new FactoryCoordinator(options),
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

const nativeInputNames = ["ENOUGH_EVIDENCE_ROOT", "ENOUGH_NATIVE_INDEX_SHA256", "ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR"];
function configuredNativeInputs(goal: Goal, environment: Record<string, string>, attemptId: string | null = null): TaskCheckInputsConfiguration {
  return { configurationRevision: 1, workingDirectoryIds: [], environment, goalRevision: goal.revision,
    configuredAgainstAttemptId: attemptId, configuredAt: device.lastSeen, configuredByDeviceId: device.id };
}
const nativeInputValues = { ENOUGH_EVIDENCE_ROOT: "/workspaces/evidence", ENOUGH_NATIVE_INDEX_SHA256: "a".repeat(64), ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR: "/workspaces/evidence/native-ui.json" };

test("missing native capability waits through restart without consuming author attempts, then freezes host placement", async t => {
  const worker: Device = { ...device, platform: "darwin", capacity: 0, executionTargets: [
    { id: "container", kind: "container", protocolVersion: 1, readiness: "ready", capacity: 1, capabilities: [{ kind: "linux-shell", readiness: "ready" }] },
    { id: "mac-host", kind: "host-macos", protocolVersion: 1, readiness: "setup-required", reason: "Install the configured Mac author runtime.", capacity: 1, capabilities: [{ kind: "mac-shell", readiness: "setup-required" }] },
  ] };
  const factory = harness([worker]);
  factory.planning(async () => ({ ...plan, tasks: [
    { ...plan.tasks[0]!, execution: { target: "auto", requiredCapabilities: ["mac-shell"] } },
    { key: "independent", title: "Portable work", description: "Continue useful work", dependsOn: [], checks: [] },
  ] }));
  const goal = factory.goal();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const native = factory.store.list<FactoryTask>("tasks").find(task => task.title === plan.tasks[0]!.title)!;
  assert.equal(factory.calls.execute, 1, "Independent portable work uses its separate container pool");
  assert.equal(factory.store.list<Attempt>("attempts").some(attempt => attempt.taskId === native.id), false);
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.waitingFor, "execution-capability");
  assert.match(factory.store.get<Goal>("goals", goal.id)!.nextAction!, /Install the configured Mac author runtime/);
  const recovered = factory.recover();
  t.after(() => recovered.stop());
  await recovered.start();
  for (let index = 0; index < 3; index++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.diagnosis, 0);
  worker.executionTargets![1]!.readiness = "ready";
  worker.executionTargets![1]!.capabilities[0]!.readiness = "ready";
  recovered.notifyCondition("execution-capability");
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.execute, 2);
  const attempt = factory.store.list<Attempt>("attempts").find(attempt => attempt.taskId === native.id)!;
  assert.equal(attempt.generation, 1);
  assert.equal(attempt.executionTargetId, "mac-host");
  assert.equal(attempt.executionTargetKind, "host-macos");
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.contract!.execution, native.execution);
  assert.match(factory.executionPrompts[1]!, /on the configured Mac host/);
  assert.match(factory.planningPrompts[0]!, /Execution inventory/);
});

test("an explicit goal execution default bootstraps planning and freezes omitted task requirements", async () => {
  const worker: Device = { ...device, executionTargets: [
    { id: "container", kind: "container", protocolVersion: 1, readiness: "setup-required", capabilities: [{ kind: "linux-shell", readiness: "setup-required" }] },
    { id: "mac-host", kind: "host-macos", protocolVersion: 1, readiness: "ready", capacity: 1, workspaceProviders: ["git"], runtimes: ["codex"], capabilities: [{ kind: "mac-shell", readiness: "ready" }] },
  ] };
  const factory = harness([worker]);
  const execution = { target: "host-macos" as const, requiredCapabilities: ["mac-shell" as const] };
  const goal = factory.coordinator.create({ projectId: project.id, objective: "Build a native utility", criteria, execution, concurrency: 1 });
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.deepEqual(factory.controllerInputs[0]!.goal.execution, execution, "The initial controller receives explicit placement before any tasks exist");
  assert.match(factory.planningPrompts[0]!, /Goal execution default/);
  const preparing = deferred<void>(), originalPrepare = factory.workspaces.prepare, originalExecute = factory.runtime.execute;
  factory.workspaces.prepare = async input => {
    assert.deepEqual(input.task.execution, execution);
    await preparing.promise;
    return originalPrepare(input);
  };
  factory.runtime.execute = async input => {
    assert.deepEqual(input.task.execution, execution, "Later default changes cannot alter an allocated author's contract");
    return originalExecute(input);
  };
  await factory.coordinator.tick();
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  factory.coordinator.configure(goal.id, { execution: { target: "container" } });
  preparing.resolve(); await factory.coordinator.waitForIdle();
  assert.equal(attempt.executionTargetKind, "host-macos");
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.execution, undefined, "The stored task remains an explicit override only when the planner supplied one");
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.contract!.execution, execution);
  assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
  assert.equal(factory.calls.execute, 1);
});

test("goal execution input is validated and steering retains the chosen default", async () => {
  const factory = harness();
  assert.throws(() => factory.coordinator.create({ projectId: project.id, objective: "Native work", execution: { target: "host-linux" as never } }), /execution/i);
  assert.equal(factory.store.list<Goal>("goals").length, 0);
  const execution = { target: "host-macos" as const, requiredCapabilities: ["mac-shell" as const] };
  const goal = factory.coordinator.create({ projectId: project.id, objective: "Native work", execution });
  assert.throws(() => factory.coordinator.configure(goal.id, { execution: { requiredCapabilities: ["fake-capability" as never] } }), /capabilit/i);
  await factory.coordinator.steer(goal.id, { context: "Keep the original native target." });
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.execution, execution);
  await factory.coordinator.steer(goal.id, { execution: { target: "container" } });
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.execution, { target: "container" });
});

test("explicit UI quality survives authoring and cannot be accepted without exact candidate and combined-source checks", async t => {
  const quality = { platforms: ["macos" as const], workflows: [{ id: "compose-close", platform: "macos" as const }], referenceIds: ["mail-reference"] };
  const native: Device = { ...device, executionTargets: [
    { id: "container", kind: "container", protocolVersion: 1, readiness: "ready", capabilities: [{ kind: "linux-shell", readiness: "ready" }] },
    { id: "mac-ui", kind: "host-macos", protocolVersion: 1, readiness: "ready", capabilities: [{ kind: "macos-app-inspection", readiness: "ready" }] },
  ] };
  for (const scenario of ["adapter-missing", "candidate-stale", "combined-stale", "valid"] as const) await t.test(scenario, async () => {
    const factory = harness([native]);
    factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, quality }] }));
    if (scenario !== "adapter-missing") factory.workspaces.qualityChecks = true;
    factory.workspaces.check = async (_project, candidate, commands, verification) => {
      assert.deepEqual(verification!.quality, quality);
      assert.ok(commands.includes(UI_QUALITY_CHECK_COMMAND));
      return commands.map(command => ({ command, passed: true, output: "Verified original inspection receipts", exitCode: 0, candidateCommit: candidate.commit, checkedCommit: scenario === "candidate-stale" ? "old-preview" : candidate.commit }));
    };
    const originalIntegration = factory.workspaces.integrate;
    factory.workspaces.integrate = async (project, candidate, input) => {
      assert.deepEqual(input.verification!.quality, quality);
      const integration = await originalIntegration(project, candidate, input);
      if (scenario === "combined-stale") integration.checks = integration.checks.map(check => check.command === UI_QUALITY_CHECK_COMMAND ? { ...check, checkedCommit: candidate.commit } : check);
      return integration;
    };
    await planGoal(factory);
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    const task = factory.store.list<FactoryTask>("tasks")[0]!, attempt = factory.store.get<Attempt>("attempts", task.currentAttemptId!)!;
    assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.contract!.quality, quality);
    if (scenario === "valid") {
      assert.equal(task.status, "completed");
      assert.equal(factory.calls.integrate, 1);
    } else {
      assert.notEqual(task.status, "completed");
      assert.equal(factory.calls.integrate, scenario === "combined-stale" ? 1 : 0);
      assert.equal(attempt.status, scenario === "combined-stale" ? "unknown" : "failed", "A potentially written combined result stays uncertain rather than permitting a blind retry");
    }
  });
});

test("application plans cannot omit a required platform or its representative workflows", async t => {
  const acceptance: Goal["acceptance"] = { kind: "application", platforms: ["web", "macos"], referenceIds: ["primary"] };
  for (const scenario of ["omitted", "missing-platform", "empty-workflow"] as const) await t.test(scenario, async () => {
    const factory = harness();
    const quality = scenario === "omitted" ? undefined : { platforms: ["web" as const, ...(scenario === "empty-workflow" ? ["macos" as const] : [])], workflows: [{ id: "compose-close", platform: "web" as const }], referenceIds: [] };
    factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, quality }] }));
    const goal = factory.goal(acceptance);
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(factory.store.list<FactoryTask>("tasks").length, 0, "An incomplete application policy cannot become dispatched work");
    assert.equal(factory.calls.execute, 0);
    assert.match(factory.store.get<ControlRecord>("factory-control", goal.id)!.replanReason!, /workflow|macos/i);
    assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, criteria);
    assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.acceptance, acceptance);
  });
});

test("application creation rejects missing references and retains the explicit immutable template", () => {
  const factory = harness();
  assert.throws(() => factory.goal({ kind: "application", platforms: ["web"], referenceIds: ["removed-folder"] }), /available reference/);
  assert.equal(factory.store.list<Goal>("goals").length, 0);
  const acceptance: NonNullable<Goal["acceptance"]> = { kind: "application", platforms: ["web"], referenceIds: ["primary"] };
  const goal = factory.goal(acceptance);
  acceptance.platforms.push("macos"); acceptance.referenceIds.push("removed-folder");
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.acceptance, { kind: "application", platforms: ["web"], referenceIds: ["primary"] });
});

test("application references freeze into UI authors while backend work remains independent", async () => {
  const worker: Device = { ...device, executionTargets: [{ id: "container", kind: "container", protocolVersion: 1, readiness: "ready", capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] }] };
  const factory = harness([worker]); factory.workspaces.qualityChecks = true;
  factory.planning(async () => ({ ...plan, tasks: [
    { ...plan.tasks[0]!, quality: { platforms: ["web"], workflows: [{ id: "compose-close", platform: "web" }], referenceIds: [] } },
    { key: "backend", title: "Persist drafts", description: "Implement durable draft storage", kind: "unit", dependsOn: [], checks: [] },
  ] }));
  const originalCheck = factory.workspaces.check;
  factory.workspaces.check = async (...input) => (await originalCheck(...input)).map(check => ({ ...check, checkedCommit: input[1].commit }));
  const acceptance: Goal["acceptance"] = { kind: "application", platforms: ["web"], referenceIds: ["primary"] };
  const goal = factory.goal(acceptance);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const planned = factory.store.list<FactoryTask>("tasks");
  assert.deepEqual(planned.find(task => task.title === "Persist drafts")!.quality, undefined);
  assert.deepEqual(planned.find(task => task.title !== "Persist drafts")!.quality!.referenceIds, ["primary"]);
  for (let i = 0; i < 2; i++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
  const uiTask = factory.store.list<FactoryTask>("tasks").find(task => task.title !== "Persist drafts")!;
  assert.equal(uiTask.status, "completed");
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", uiTask.currentAttemptId!)!.contract!.quality!.referenceIds, ["primary"]);
  assert.match(factory.planningPrompts[0]!, /Required application acceptance/);
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, criteria);
});

test("final application coverage cannot disappear when its only UI task is canceled", async () => {
  const factory = harness();
  factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, quality: { platforms: ["web"], workflows: [{ id: "compose-close", platform: "web" }], referenceIds: [] } }] }));
  const goal = factory.goal({ kind: "application", platforms: ["web"], referenceIds: [] });
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const task = factory.store.list<FactoryTask>("tasks")[0]!;
  factory.store.set("tasks", { ...task, status: "canceled" });
  const control = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  factory.store.set("factory-control", { ...control, stage: "evaluate" });
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.evaluator, 0, "Model completion cannot bypass missing application evidence policies");
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "planning");
  assert.match(factory.store.get<ControlRecord>("factory-control", goal.id)!.replanReason!, /representative workflow/);
});

test("an explicit native quality policy requires its inspection capability before allocation", async () => {
  const factory = harness();
  factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, quality: { platforms: ["macos"], workflows: [], referenceIds: [] } }] }));
  const goal = await planGoal(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.execute, 0);
  assert.equal(factory.store.list<Attempt>("attempts").length, 0);
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.waitingFor, "execution-capability");
  assert.match(factory.store.get<Goal>("goals", goal.id)!.nextAction!, /macos-app-inspection/);
});

test("pending UI receipts retain the author through restart while independent work uses the released slot", async t => {
  const worker: Device = { ...device, capacity: 1, executionTargets: [
    { id: "container", kind: "container", protocolVersion: 1, readiness: "ready", capacity: 1,
      capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] },
  ] };
  const factory = harness([worker]);
  factory.workspaces.qualityChecks = true;
  factory.planning(async () => ({ ...plan, tasks: [
    { ...plan.tasks[0]!, estimatedMinutes: 100, writePaths: ["apps/mail"], quality: { platforms: ["web"], workflows: [], referenceIds: [] } },
    { key: "independent", title: "Independent implementation", description: "Ship unrelated work", dependsOn: [], checks: [], estimatedMinutes: 1, writePaths: ["docs"] },
  ] }));
  let receiptsReady = false;
  const originalCheck = factory.workspaces.check;
  factory.workspaces.check = async (project, candidate, commands, verification) => {
    const checks = await originalCheck(project, candidate, commands, verification);
    return checks.map(check => check.command === UI_QUALITY_CHECK_COMMAND && !receiptsReady ? {
      ...check, passed: false, output: "Waiting for the exact source screenshot receipt", recovery: { condition: "inspection-evidence" as const, reason: "Capture and review this saved source." },
    } : { ...check, checkedCommit: candidate.commit });
  };
  const goal = factory.goal();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const task = factory.store.list<FactoryTask>("tasks").find(task => task.title === plan.tasks[0]!.title)!;
  const attempt = factory.store.get<Attempt>("attempts", task.currentAttemptId!)!;
  const retained = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  assert.equal(task.status, "review");
  assert.equal(attempt.status, "succeeded");
  assert.equal(retained.verificationWait!.condition, "inspection-evidence");
  assert.equal(retained.candidate!.commit, "candidate-commit");
  assert.equal(factory.calls.integrate, 0);
  const recovered = factory.recover();
  t.after(() => recovered.stop());
  await recovered.start(); await recovered.waitForIdle();
  for (let index = 0; index < 3; index++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.execute, 2, "The unrelated task uses the one released author slot");
  assert.equal(factory.calls.check, 2, "The waiting source is not polled; only the unrelated task adds a check");
  assert.equal(factory.calls.diagnosis, 0);
  assert.equal(factory.calls.reconcile, 0, "A settled author does not become unknown on restart");
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.currentAttemptId, attempt.id);
  assert.equal(factory.store.list<FactoryTask>("tasks").find(item => item.id !== task.id)!.status, "completed");
  receiptsReady = true;
  recovered.notifyCondition("inspection-evidence", goal.id);
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.execute, 2, "Verifier continuation cannot burn another author attempt");
  assert.equal(factory.calls.capture, 2, "The original source remains retained");
  assert.equal(factory.calls.check, 3);
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.generation, 1);
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.verificationWait, undefined);
});

test("explicit public resume wakes a retained inspection wait after restart without replacing its author or waking another goal", async t => {
  const worker: Device = { ...device, executionTargets: [{ id: "container", kind: "container", protocolVersion: 1, readiness: "ready",
    capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] }] };
  const factory = harness([worker]); factory.workspaces.qualityChecks = true;
  factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, writePaths: ["apps/mail"], quality: { platforms: ["web"], workflows: [], referenceIds: [] } }] }));
  let ready = false;
  const originalCheck = factory.workspaces.check;
  factory.workspaces.check = async (project, candidate, commands, verification) => (await originalCheck(project, candidate, commands, verification)).map(check =>
    check.command === UI_QUALITY_CHECK_COMMAND && !ready ? { ...check, passed: false, recovery: { condition: "inspection-evidence" as const, reason: "The previous service instance is stopping." } }
      : { ...check, checkedCommit: candidate.commit });
  const goal = await planGoal(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const task = factory.store.list<FactoryTask>("tasks")[0]!, attempt = factory.store.get<Attempt>("attempts", task.currentAttemptId!)!;
  const detail = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  factory.coordinator.pause(goal.id);
  const otherGoal = factory.goal(); factory.coordinator.pause(otherGoal.id);
  const otherTask = { ...task, id: "other-goal-task", goalId: otherGoal.id, currentAttemptId: "other-goal-author" };
  factory.store.set("tasks", otherTask);
  factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", task.id)!, id: otherTask.id });
  factory.store.set("attempts", { ...attempt, id: otherTask.currentAttemptId, taskId: otherTask.id });
  factory.store.set("factory-attempt-details", { ...detail, id: otherTask.currentAttemptId, goalId: otherGoal.id, goalRevision: otherGoal.revision });
  const recovered = factory.recover(); t.after(() => recovered.stop());
  await recovered.start(); await recovered.waitForIdle();
  for (let index = 0; index < 3; index++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.check, 1, "Restart preserves a known inspection wait without polling its source.");
  assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
  ready = true;
  recovered.resume(goal.id);
  const resumedTask = factory.store.get<FactoryTask>("tasks", task.id)!;
  const resumedDetail = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  assert.equal(resumedTask.status, "review"); assert.equal(resumedTask.currentAttemptId, attempt.id);
  assert.deepEqual(resumedTask.writePaths, ["apps/mail"]);
  assert.deepEqual(resumedDetail.candidate, detail.candidate); assert.deepEqual(resumedDetail.contract, detail.contract);
  assert.equal(resumedDetail.verificationWait, undefined);
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", otherTask.currentAttemptId)!.verificationWait, detail.verificationWait);
  assert.equal(factory.store.get<Goal>("goals", otherGoal.id)!.status, "paused");
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1); assert.equal(factory.calls.check, 2);
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.generation, attempt.generation);
  assert.equal(factory.store.list<Attempt>("attempts").length, 2, "Only the original authors exist, including the separately paused goal.");
});

test("inspection notification during public resume never requeues failed or unknown author outcomes", async () => {
  const factory = harness(), goal = await planGoal(factory);
  const base = factory.store.list<FactoryTask>("tasks")[0]!;
  factory.coordinator.pause(goal.id);
  for (const status of ["succeeded", "failed", "unknown"] as const) {
    const id = `${status}-author`, task = { ...base, id: `${status}-task`, currentAttemptId: id, status: status === "failed" ? "failed" as const : "review" as const };
    factory.store.set("tasks", task);
    factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", base.id)!, id: task.id, ...(status === "failed" ? { waitingFor: "inspection-evidence" } : {}) });
    factory.store.set<Attempt>("attempts", { id, taskId: task.id, generation: 1, deviceId: device.id, status, startedAt: device.lastSeen });
    factory.store.set<AttemptDetail>("factory-attempt-details", { id, goalId: goal.id, goalRevision: goal.revision, phase: "checking", cancellation: "none", candidate: { id: "retained", commit: "C", baseCommit: "B" }, verificationWait: { condition: "inspection-evidence", reason: "Waiting", since: device.lastSeen } });
  }
  factory.coordinator.resume(goal.id);
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", "succeeded-author")!.verificationWait, undefined);
  for (const status of ["failed", "unknown"] as const) {
    assert.equal(factory.store.get<Attempt>("attempts", `${status}-author`)!.status, status);
    assert.equal(factory.store.get<FactoryTask>("tasks", `${status}-task`)!.currentAttemptId, `${status}-author`);
    assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", `${status}-author`)!.verificationWait!.condition, "inspection-evidence");
  }
  assert.equal(factory.store.get<FactoryTask>("tasks", "failed-task")!.status, "failed");
  assert.equal(factory.store.get<TaskDetail>("factory-task-details", "failed-task")!.waitingFor, "inspection-evidence");
  assert.equal(factory.calls.execute, 0);
});

test("a confirmed pre-write combined-source inspection wait resumes the same candidate", async () => {
  const worker: Device = { ...device, executionTargets: [
    { id: "container", kind: "container", protocolVersion: 1, readiness: "ready",
      capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] },
  ] };
  const factory = harness([worker]);
  factory.workspaces.qualityChecks = true;
  factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, quality: { platforms: ["web"], workflows: [], referenceIds: [] } }] }));
  const originalCheck = factory.workspaces.check, originalIntegrate = factory.workspaces.integrate;
  factory.workspaces.check = async (project, candidate, commands, verification) => (await originalCheck(project, candidate, commands, verification)).map(check => ({ ...check, checkedCommit: candidate.commit }));
  let combinedReady = false;
  factory.workspaces.integrate = async (project, candidate, input) => {
    if (!combinedReady) throw new FactoryVerificationWaitError("Review the combined source before integration writes.");
    return originalIntegrate(project, candidate, input);
  };
  const goal = await planGoal(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const task = factory.store.list<FactoryTask>("tasks")[0]!, attemptId = task.currentAttemptId!;
  assert.equal(task.status, "review");
  assert.equal(factory.store.get<Attempt>("attempts", attemptId)!.status, "succeeded");
  assert.equal(factory.calls.integrate, 0, "No repository write occurred");
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attemptId)!.verificationWait!.condition, "inspection-evidence");
  combinedReady = true;
  factory.coordinator.notifyCondition("inspection-evidence", goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.capture, 1);
  assert.equal(factory.calls.check, 1, "The exact candidate check was already settled");
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.currentAttemptId, attemptId);
});

test("inspection receipts arriving before the wait is persisted cannot lose their wakeup", async t => {
  for (const phase of ["candidate", "combined"] as const) await t.test(phase, async () => {
    const worker: Device = { ...device, executionTargets: [
      { id: "container", kind: "container", protocolVersion: 1, readiness: "ready",
        capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] },
    ] };
    const factory = harness([worker]);
    factory.workspaces.qualityChecks = true;
    factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, quality: { platforms: ["web"], workflows: [], referenceIds: [] } }] }));
    let pending = true;
    const originalCheck = factory.workspaces.check, originalIntegrate = factory.workspaces.integrate;
    factory.workspaces.check = async (project, candidate, commands, verification) => {
      const checks = (await originalCheck(project, candidate, commands, verification)).map(check => ({ ...check, checkedCommit: candidate.commit }));
      if (phase === "candidate" && pending) {
        pending = false;
        factory.coordinator.notifyCondition("inspection-evidence");
        return checks.map(check => check.command === UI_QUALITY_CHECK_COMMAND ? { ...check, passed: false, recovery: { condition: "inspection-evidence" as const, reason: "A receipt arrived while the pending response was returning." } } : check);
      }
      return checks;
    };
    factory.workspaces.integrate = async (project, candidate, input) => {
      if (phase === "combined" && pending) {
        pending = false;
        factory.coordinator.notifyCondition("inspection-evidence");
        throw new FactoryVerificationWaitError("The combined receipt arrived before this response.");
      }
      return originalIntegrate(project, candidate, input);
    };
    await planGoal(factory);
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    const attemptId = factory.store.list<Attempt>("attempts")[0]!.id;
    assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attemptId)!.verificationWait, undefined, "A recorded event must cause one retained-source recheck");
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(factory.store.list<FactoryTask>("tasks")[0]!.status, "completed");
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.calls.capture, 1);
    assert.equal(factory.calls.check, phase === "candidate" ? 2 : 1);
    assert.equal(factory.calls.integrate, 1);
  });
});

test("an unavailable branch cannot globally suspend progress unlocked by inspection evidence", async () => {
  const worker: Device = { ...device, executionTargets: [
    { id: "container", kind: "container", protocolVersion: 1, readiness: "ready",
      capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] },
  ] };
  const factory = harness([worker]);
  factory.workspaces.qualityChecks = true;
  factory.planning(async () => ({ ...plan, tasks: [
    { ...plan.tasks[0]!, estimatedMinutes: 100, quality: { platforms: ["web"], workflows: [], referenceIds: [] } },
    { key: "unsupported", title: "Mac-only branch", description: "Needs a Mac shell", dependsOn: [], checks: [], execution: { target: "host-macos", requiredCapabilities: ["mac-shell"] }, estimatedMinutes: 10 },
    { key: "dependent", title: "Follow-up work", description: "Use the reviewed implementation", dependsOn: ["implement"], checks: [], estimatedMinutes: 1 },
  ] }));
  let receiptsReady = false;
  const originalCheck = factory.workspaces.check;
  factory.workspaces.check = async (project, candidate, commands, verification) => (await originalCheck(project, candidate, commands, verification)).map(check => check.command === UI_QUALITY_CHECK_COMMAND && !receiptsReady ? {
    ...check, passed: false, recovery: { condition: "inspection-evidence" as const, reason: "Review this saved source." },
  } : { ...check, checkedCommit: candidate.commit });
  const goal = factory.goal();
  for (let index = 0; index < 3; index++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "running", "A pending verifier still has a possible progress event");
  receiptsReady = true;
  factory.coordinator.notifyCondition("inspection-evidence", goal.id);
  for (let index = 0; index < 2; index++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
  assert.equal(factory.store.list<FactoryTask>("tasks").find(task => task.title === "Follow-up work")!.status, "completed");
  assert.equal(factory.calls.execute, 2);
  assert.equal(factory.store.list<Attempt>("attempts").some(attempt => attempt.taskId === factory.store.list<FactoryTask>("tasks").find(task => task.title === "Mac-only branch")!.id), false);
});

test("missing UI receipts cannot hide an observed shell check failure", async () => {
  const worker: Device = { ...device, executionTargets: [
    { id: "container", kind: "container", protocolVersion: 1, readiness: "ready",
      capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] },
  ] };
  const factory = harness([worker]);
  factory.workspaces.qualityChecks = true;
  factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, quality: { platforms: ["web"], workflows: [], referenceIds: [] } }] }));
  factory.workspaces.check = async (_project, candidate, commands) => commands.map(command => ({ command, passed: false, candidateCommit: candidate.commit,
    output: command === UI_QUALITY_CHECK_COMMAND ? "Receipt not submitted" : "The implementation does not compile",
    ...(command === UI_QUALITY_CHECK_COMMAND ? { recovery: { condition: "inspection-evidence" as const, reason: "Submit the receipt" } } : {}) }));
  await planGoal(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error!, /does not compile/);
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.verificationWait, undefined);
});

test("completion audits retain legacy accepted contracts when their task detail record is absent", async () => {
  const factory = harness();
  const goal = await finishTask(factory);
  const task = factory.store.list<FactoryTask>("tasks")[0]!;
  factory.store.delete("factory-task-details", task.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  assert.equal(factory.calls.execute, 1);
  assert.match(factory.evaluationPrompts[0]!, /Build and release the feature/);
  assert.equal(factory.store.get<TaskDetail>("factory-task-details", task.id), undefined, "Audits must not rewrite missing legacy history");
});

test("native verification waits before allocation while independent work runs, including after restart", async t => {
  const factory = harness();
  factory.planning(async () => ({ ...plan, tasks: [
    { ...plan.tasks[0]!, requiredCheckEnvironment: nativeInputNames },
    { key: "independent", title: "Independent implementation", description: "Ship useful work without native evidence", dependsOn: [], checks: [] },
  ] }));
  const goal = factory.goal();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const native = factory.store.list<FactoryTask>("tasks").find(task => task.title === plan.tasks[0]!.title)!;
  const independent = factory.store.list<FactoryTask>("tasks").find(task => task.id !== native.id)!;
  assert.equal(independent.status, "completed");
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.store.list<Attempt>("attempts").some(attempt => attempt.taskId === native.id), false);
  assert.equal(factory.store.get<FactoryTask>("tasks", native.id)!.status, "queued");
  const detail = factory.store.get<TaskDetail>("factory-task-details", native.id)!;
  factory.store.set("factory-task-details", { ...detail, checkInputs: configuredNativeInputs(goal, { ...nativeInputValues, ENOUGH_NATIVE_INDEX_SHA256: " " }) });
  const recovered = factory.recover();
  t.after(() => recovered.stop());
  await recovered.start();
  for (let i = 0; i < 4; i++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.execute, 1, "neither repeated ticks nor a service restart allocates an unconfigured attempt");
  assert.match(factory.store.get<Goal>("goals", goal.id)!.nextAction!, /Waiting for verification evidence from the coordinator/);
  assert.equal(factory.calls.diagnosis, 0, "missing coordinator input is not a source failure");
  factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", native.id)!, checkInputs: configuredNativeInputs(goal, nativeInputValues) });
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.execute, 2);
  assert.equal(factory.store.get<FactoryTask>("tasks", native.id)!.status, "completed");
  assert.equal(factory.store.list<Attempt>("attempts").find(attempt => attempt.taskId === native.id)!.generation, 1, "waiting never consumes an attempt generation");
});

test("stable task replans preserve native prerequisite waits and failed evidence until authenticated inputs arrive", async t => {
  const factory = harness();
  factory.executing(async () => ({ status: "failed", text: "No authenticated native evidence was supplied" }));
  factory.diagnosing(async () => ({ action: "wait", reason: "Coordinator native evidence required", instructions: "Keep the exact retained source" }));
  const goal = await planGoal(factory);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const originalTask = factory.store.list<FactoryTask>("tasks")[0]!, originalDetail = factory.store.get<TaskDetail>("factory-task-details", originalTask.id)!;
  assert.equal(originalDetail.waitingFor, "external-condition");
  const failed = factory.store.get<Attempt>("attempts", originalTask.currentAttemptId!)!;
  const failedDetail = factory.store.get<AttemptDetail>("factory-attempt-details", failed.id)!;
  factory.planning(async () => ({ ...plan, tasks: [
    { ...plan.tasks[0]!, description: "Verify the improved native app", requiredCheckEnvironment: nativeInputNames },
    { key: "independent", title: "Independent repair", description: "Fix another in-scope issue", dependsOn: [], checks: [] },
  ] }));
  factory.coordinator.requestPlan(goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const replanned = factory.store.get<FactoryTask>("tasks", originalTask.id)!;
  const replannedDetail = factory.store.get<TaskDetail>("factory-task-details", originalTask.id)!;
  assert.equal(replanned.description, "Verify the improved native app", "current contracts can improve without claiming the external prerequisite arrived");
  assert.equal(replanned.status, "failed");
  assert.equal(replanned.currentAttemptId, failed.id);
  assert.equal(replannedDetail.waitingFor, originalDetail.waitingFor);
  assert.equal(replannedDetail.waitReason, originalDetail.waitReason);
  assert.equal(replannedDetail.waitSince, originalDetail.waitSince);
  factory.coordinator.notifyCondition("external-condition", goal.id);
  assert.equal(factory.store.get<FactoryTask>("tasks", originalTask.id)!.currentAttemptId, failed.id, "an unfulfilled manual wake retains failed attempt identity");
  assert.equal(factory.store.get<TaskDetail>("factory-task-details", originalTask.id)!.waitingFor, "external-condition");
  factory.executing(async () => ({ status: "succeeded", text: "Independent implementation complete" }));
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const accepted = factory.store.list<FactoryTask>("tasks").find(task => task.id !== originalTask.id)!;
  assert.equal(accepted.status, "completed");
  const acceptedDetail = factory.store.get<TaskDetail>("factory-task-details", accepted.id)!;
  factory.planning(async () => ({ ...plan, tasks: [{ ...plan.tasks[0]!, description: "Verify the final integrated source" }] }));
  factory.coordinator.requestPlan(goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.deepEqual(factory.store.get<TaskDetail>("factory-task-details", originalTask.id)!.requiredCheckEnvironment, nativeInputNames, "omitting a prerequisite on a stable-key replan preserves it");
  assert.deepEqual(factory.store.get<FactoryTask>("tasks", accepted.id), accepted);
  assert.deepEqual(factory.store.get<TaskDetail>("factory-task-details", accepted.id), acceptedDetail);
  const recovered = factory.recover();
  t.after(() => recovered.stop());
  await recovered.start();
  for (let i = 0; i < 3; i++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.execute, 2);
  assert.deepEqual(factory.store.get<Attempt>("attempts", failed.id), failed);
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", failed.id), failedDetail, "replans and restart do not relabel old failed evidence");
  const currentGoal = factory.store.get<Goal>("goals", goal.id)!;
  factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", originalTask.id)!, checkInputs: configuredNativeInputs(currentGoal, nativeInputValues, failed.id) });
  recovered.notifyCondition("external-condition", goal.id);
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.store.get<FactoryTask>("tasks", originalTask.id)!.status, "completed");
  assert.equal(factory.store.list<Attempt>("attempts").filter(attempt => attempt.taskId === originalTask.id).length, 2);
  assert.deepEqual(factory.store.get<Attempt>("attempts", failed.id), failed);
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", failed.id), failedDetail);
});

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

test("a 57-task evaluation uses verified full contract references and reuses its failed final-check receipt", async () => {
  const factory = harness(), created = factory.goal();
  const originalCriteria = Array.from({ length: 9 }, (_, index) => `Exact original criterion ${index}: deliver the complete native behavior`);
  const goal: Goal = { ...created, revision: 25, status: "running", criteria: originalCriteria };
  const repository = { head: "exact-final-source", branch: "main", status: "", fingerprint: "exact-final-tree" };
  const command = "bash scripts/final-internal-acceptance.sh";
  factory.store.set("goals", goal);
  factory.store.set<ControlRecord>("factory-control", { ...factory.store.get<ControlRecord>("factory-control", goal.id)!, stage: "evaluate", steering: ["Preserve every original requirement and all accepted implementation."] });
  factory.store.set<PlanRecord>("factory-plans", { id: goal.id, goalId: goal.id, revision: 25, summary: "Whole product acceptance", checks: [command], checkScope: "goal", taskKeys: {}, createdAt: device.lastSeen });
  const contracts = new Map<string, unknown>();
  for (let index = 0; index < 57; index++) {
    const task: FactoryTask = { id: `accepted-${index}`, goalId: goal.id, title: `Accepted behavior ${index}`,
      description: `Complete contract ${index}: ${"Preserve the full product behavior, integration, recovery and delivery requirements. ".repeat(120)}`,
      kind: "feature", acceptanceCriteria: [`Unique required behavior ${index}`], expectedOutputs: [`Unique required deliverable ${index}`],
      dependsOn: [], status: "completed", currentAttemptId: `attempt-${index}`, createdAt: device.lastSeen, updatedAt: device.lastSeen };
    const detail: TaskDetail = { id: task.id, key: `accepted-key-${index}`, checks: [`check-feature-${index}`], planChecks: [], planRevision: 24, selected: false, failureSignatures: [] };
    const historical = { title: task.title, description: task.description, kind: task.kind, acceptanceCriteria: task.acceptanceCriteria,
      expectedOutputs: task.expectedOutputs, dependsOn: task.dependsOn, checks: detail.checks, planRevision: 24 };
    factory.store.set("tasks", task); factory.store.set("factory-task-details", detail);
    factory.store.set<Attempt>("attempts", { id: task.currentAttemptId!, taskId: task.id, generation: 1, deviceId: device.id, status: "succeeded", startedAt: device.lastSeen });
    factory.store.set<AttemptDetail>("factory-attempt-details", { id: task.currentAttemptId!, goalId: goal.id, goalRevision: 24, phase: "done", cancellation: "none", contract: historical,
      candidate: { id: `candidate-${index}`, commit: `source-${index}`, baseCommit: "base" },
      result: { status: "succeeded", text: `Worker claims completion ${index}` },
      checks: [{ command: detail.checks[0]!, passed: true, exitCode: 0, output: "Focused check passed", candidateCommit: `source-${index}` }],
      integration: { commit: `integrated-${index}`, previousHead: "base", candidateCommit: `source-${index}`, checks: [] } });
    contracts.set(`tasks/${task.id}`, controllerTaskContract(task, detail));
    contracts.set(`factory-attempt-details/${task.currentAttemptId}`, controllerAttemptContract(historical));
  }
  const attemptsBefore = factory.store.list<AttemptDetail>("factory-attempt-details");
  factory.inspect(async () => repository);
  factory.goalChecking(async () => ({ repository, checks: [{ command, passed: false, output: "Missing native.AccountServices account-provisioning mapping", exitCode: 1, candidateCommit: repository.head, checkedCommit: repository.head }] }));
  factory.evaluating(async () => ({ complete: false, summary: "Repair the actual account provisioning boundary", criteria: originalCriteria.map(criterion => ({ criterion, satisfied: false, evidence: [] })),
    additionalTasks: [{ key: "repair-provisioning", title: "Repair account provisioning", description: "Wire the missing native account provisioning boundary", dependsOn: [], checks: ["check-provisioning"] }] }));
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.evaluator, 0, "a runtime without mounted record support cannot silently omit the contracts");
  assert.equal(factory.calls.goalCheck, 1);
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "waiting");
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, originalCriteria);
  const receiptBefore = factory.store.list<import("./types.js").GoalCheckRecord>("factory-goal-checks");
  factory.runtime.controllerRecordReferences = true;
  factory.coordinator.resume(goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.evaluator, 1, "the entire goal reaches evaluation without manual splitting");
  assert.equal(factory.calls.goalCheck, 1, "the unchanged failed final snapshot receipt is reused after context recovery");
  assert.deepEqual(factory.store.list("factory-goal-checks"), receiptBefore);
  const input = factory.controllerInputs[0]!;
  assert.ok(Buffer.byteLength(input.prompt) < CONTROLLER_PROMPT_LIMIT);
  assert.ok(input.prompt.includes(goal.objective));
  for (const criterion of originalCriteria) assert.ok(input.prompt.includes(criterion));
  assert.ok(input.prompt.includes("Inspect every accepted task contract"));
  assert.ok(input.prompt.includes("Missing native.AccountServices account-provisioning mapping"));
  assert.equal(input.recordRequirements!.length, 114, "all current and historical contracts remain accessible");
  for (const reference of input.recordRequirements!) {
    const canonical = JSON.stringify(contracts.get(reference.record));
    assert.equal(reference.field, ".contract");
    assert.equal(reference.sha256, createHash("sha256").update(canonical).digest("hex"));
    assert.equal(reference.size, Buffer.byteLength(canonical));
    assert.ok(input.prompt.includes(reference.record));
    assert.ok(input.prompt.includes(reference.sha256));
  }
  assert.deepEqual(factory.store.list("factory-attempt-details"), attemptsBefore, "the reference projection cannot alter historical contracts or their evidence");
  assert.equal(factory.store.list<FactoryTask>("tasks").filter(task => task.status === "completed").length, 57);
  assert.equal(factory.store.list<FactoryTask>("tasks").filter(task => task.status === "queued").length, 1);
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

test("an unchanged capture failure stays quiescent across ticks and restart without repeating the author", async t => {
  let clock = new Date("2026-10-08T12:00:00.000Z"), captureReady = false;
  const factory = harness([device], () => clock);
  factory.capturing(async () => {
    if (!captureReady) throw new Error("An ignored build directory prevented source capture");
    return { id: "retained-native-source", commit: "candidate-commit", baseCommit: "initial-head" };
  });
  const goal = await planGoal(factory);
  await factory.coordinator.start(); await factory.coordinator.waitForIdle();
  t.after(() => factory.coordinator.stop());
  const attempt = factory.store.list<Attempt>("attempts")[0]!;
  const unknownDecisions = () => factory.store.list<Decision>("decisions").filter(decision => decision.kind === "execution-unknown");
  assert.equal(attempt.status, "unknown");
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.capture, 1);
  for (let index = 0; index < 20; index++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
  await delay(25);
  assert.equal(factory.calls.capture, 1, "Review recovery cannot bypass the uncertain-effect reconciliation lane");
  assert.equal(unknownDecisions().length, 1);
  factory.coordinator.stop();
  const recovered = factory.recover();
  t.after(() => recovered.stop());
  await recovered.start(); await recovered.waitForIdle();
  assert.equal(factory.calls.capture, 1, "Service restart preserves the retry deadline");
  clock = new Date(clock.getTime() + 31_000);
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.capture, 2, "The same preserved capture may be retried after backoff");
  assert.equal(unknownDecisions().length, 1, "An unchanged outcome cannot grow the decision history");
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.recoveryObservation!.failures, 2);
  for (let index = 0; index < 20; index++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.capture, 2);
  captureReady = true;
  recovered.resume(goal.id);
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.capture, 3);
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.store.list<Attempt>("attempts").length, 1);
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.generation, 1);
  assert.equal(factory.store.get<FactoryTask>("tasks", attempt.taskId)!.status, "completed");
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.recoveryObservation, undefined);
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

test("evaluation dispatches independent follow-up work before waiting for external evidence", async () => {
  const factory = harness();
  const goal = await finishTask(factory);
  const accepted = factory.store.list<FactoryTask>("tasks")[0]!;
  const acceptedDetail = factory.store.get<TaskDetail>("factory-task-details", accepted.id)!;
  const attemptsBefore = factory.store.list<AttemptDetail>("factory-attempt-details");
  const waitReason = "Native UI, live services and signing evidence need external access; this does not block the independent implementation repair.";
  const wakeCondition = "native-live-signing-evidence";
  const evaluation: EvaluationResponse = { complete: false, summary: "Repair the missing account provisioning workflow",
    criteria: completeEvaluation.criteria.map((criterion, index) => index ? { ...criterion, satisfied: false, evidence: [] } : criterion),
    additionalTasks: [{ key: "account-provisioning-native-workflow", title: "Wire native account provisioning",
      description: "Implement the missing account provisioning mapping without requiring signing or live credentials",
      dependsOn: ["implement"], checks: ["check-account-provisioning"] }], waitReason, wakeCondition };
  factory.evaluating(async () => evaluation);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const continuing = factory.store.get<Goal>("goals", goal.id)!;
  assert.equal(continuing.status, "running");
  assert.equal(continuing.revision, goal.revision + 1);
  assert.deepEqual(continuing.criteria, goal.criteria);
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.stage, "dispatch");
  const repair = factory.store.list<FactoryTask>("tasks").find(task => task.id !== accepted.id)!;
  assert.equal(repair.status, "queued");
  assert.deepEqual(repair.dependsOn, [accepted.id]);
  assert.deepEqual(factory.store.get<FactoryTask>("tasks", accepted.id), accepted);
  assert.deepEqual(factory.store.get<TaskDetail>("factory-task-details", accepted.id), acceptedDetail);
  assert.deepEqual(factory.store.list<AttemptDetail>("factory-attempt-details"), attemptsBefore);
  const retainedEvaluation = factory.store.list<EvaluationRecord>("factory-evaluations")[0]!;
  assert.deepEqual(retainedEvaluation.evaluation, evaluation, "external wait requirements remain immutable evidence while independent work runs");
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.calls.execute, 2, "the independent repair is actually dispatched");
  assert.equal(factory.store.get<FactoryTask>("tasks", repair.id)!.status, "completed");
  factory.evaluating(async () => ({ ...evaluation, additionalTasks: undefined }));
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "waiting", "external evidence remains required after implementation finishes");
  assert.deepEqual(factory.store.get<Goal>("goals", goal.id)!.criteria, goal.criteria);
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.waitingFor, wakeCondition);
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.waitReason, waitReason);
  assert.deepEqual(factory.store.get<EvaluationRecord>("factory-evaluations", retainedEvaluation.id), retainedEvaluation);
  assert.equal(factory.store.list<EvaluationRecord>("factory-evaluations")[1]!.evaluation.criteria[1]!.satisfied, false);
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

test("manual completion inspection waits survive restart without consuming controller retries or losing evaluation intent", async t => {
  const factory = harness(), goal = await finishTask(factory);
  factory.coordinator.configure(goal.id, { autonomy: "manual" });
  let ready = false;
  factory.evaluating(async () => {
    if (!ready) throw new FactoryControllerError("The retained completion chat must view the source's screenshots.", "inspection-evidence");
    return completeEvaluation;
  });
  factory.coordinator.requestEvaluation(goal.id);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const waiting = factory.store.get<ControlRecord>("factory-control", goal.id)!;
  assert.equal(waiting.waitingFor, "inspection-evidence");
  assert.equal(waiting.wakeAt, undefined);
  assert.equal(waiting.controllerFailures, undefined);
  assert.equal(waiting.manualAction, "evaluate");
  assert.equal(waiting.stage, "evaluate");
  const recovered = factory.recover();
  t.after(() => recovered.stop());
  await recovered.start(); await recovered.waitForIdle();
  for (let index = 0; index < 3; index++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.evaluator, 1, "Waiting for inspected pixels cannot repeatedly restart the evaluator");
  ready = true;
  recovered.notifyCondition("inspection-evidence", goal.id);
  await recovered.tick(); await recovered.waitForIdle();
  assert.equal(factory.calls.evaluator, 2);
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  assert.equal(factory.calls.execute, 1);
  assert.equal(factory.store.list<Attempt>("attempts").length, 1);
  assert.equal(factory.store.list<Decision>("decisions").some(decision => decision.kind === "controller-error"), false);
});

test("controller inspection evidence arriving during the wait response cannot strand completion", async () => {
  const factory = harness(), goal = await finishTask(factory);
  factory.evaluating(async () => {
    if (factory.calls.evaluator === 1) {
      factory.coordinator.notifyCondition("inspection-evidence", goal.id);
      throw new FactoryControllerError("The image delivery arrived while the pending response returned.", "inspection-evidence");
    }
    return completeEvaluation;
  });
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.waitingFor, undefined);
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.controllerFailures, undefined);
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
  assert.equal(factory.calls.evaluator, 2);
  assert.equal(factory.calls.execute, 1);
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

test("legacy monetary waits recover while attempt and time limits remain enforced", async t => {
  await t.test("old monetary fields neither block continuation nor change retained history", async () => {
    const factory = harness(), goal = factory.goal();
    assert.equal(Object.hasOwn(factory.store.get<ControlRecord>("factory-control", goal.id)!, "spent"), false);
    const historical = { id: "legacy-cost-history", goalId: goal.id, at: device.lastSeen, kind: "configuration", text: "Legacy settings", data: { maxSpend: 0.01 } };
    factory.store.set("decisions", historical);
    factory.store.set("goals", { ...goal, status: "waiting", maxSpend: 0.01 });
    factory.store.set("factory-control", { ...factory.store.get<ControlRecord>("factory-control", goal.id)!, spent: 99, unpricedTurns: 7,
      waitingFor: "budget-changed", waitReason: "Configured spend budget reached (99)." });
    factory.executing(async () => ({ status: "succeeded", text: "Legacy adapter response", chatId: "legacy-chat", sessionId: "legacy-session", spend: 12.34 }));
    const recovered = factory.recover();
    for (let step = 0; step < 3; step++) { await recovered.tick(); await recovered.waitForIdle(); }
    assert.equal(factory.calls.planner, 1);
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.calls.evaluator, 1);
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "completed");
    const retained = factory.store.get<ControlRecord & { spent: number; unpricedTurns: number }>("factory-control", goal.id)!;
    assert.equal(retained.spent, 99, "old stored amounts are not updated");
    assert.equal(retained.unpricedTurns, 7, "controller turns no longer record missing prices");
    assert.equal((factory.store.get<Goal>("goals", goal.id) as Goal & { maxSpend: number }).maxSpend, 0.01);
    assert.deepEqual(factory.store.get("decisions", historical.id), historical, "historical decisions remain intact");
    const detail = factory.store.list<AttemptDetail>("factory-attempt-details")[0]!;
    assert.equal(Object.hasOwn(detail, "usageAccounted"), false);
    assert.equal(Object.hasOwn(detail, "accountedSpend"), false);
    assert.equal(Object.hasOwn(detail.result!, "spend"), false, "an older adapter cannot persist a new monetary value");
    assert.deepEqual(detail.result, { status: "succeeded", text: "Legacy adapter response", chatId: "legacy-chat", sessionId: "legacy-session" });
  });
  await t.test("the real attempt limit still waits before diagnosis or another attempt", async () => {
    const factory = harness(), goal = await planGoal(factory);
    factory.store.set("goals", { ...factory.store.get<Goal>("goals", goal.id)!, maxAttempts: 1 });
    factory.executing(async () => ({ status: "failed", text: "Repair required", error: "Meaningful execution failure" }));
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    factory.store.set("goals", { ...factory.store.get<Goal>("goals", goal.id)!, status: "waiting", maxSpend: 0.01 });
    factory.store.set("factory-control", { ...factory.store.get<ControlRecord>("factory-control", goal.id)!, spent: 99,
      waitingFor: "budget-changed", waitReason: "Configured spend budget reached (99)." });
    for (let step = 0; step < 2; step++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.calls.diagnosis, 0);
    assert.equal(factory.store.list<Attempt>("attempts").length, 1);
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "waiting");
    assert.match(factory.store.get<ControlRecord>("factory-control", goal.id)!.waitReason!, /attempt budget reached/);
  });
  await t.test("the real time limit still waits until its setting changes", async () => {
    let now = Date.parse(device.lastSeen);
    const factory = harness([device], () => new Date(now)), goal = await planGoal(factory);
    factory.coordinator.configure(goal.id, { maxDurationMs: 1000 }); now += 1000;
    for (let step = 0; step < 2; step++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
    assert.equal(factory.calls.execute, 0);
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "waiting");
    assert.match(factory.store.get<ControlRecord>("factory-control", goal.id)!.waitReason!, /time budget reached/);
    factory.coordinator.configure(goal.id, { maxDurationMs: null });
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(factory.calls.execute, 1);
    assert.equal(factory.calls.integrate, 1);
  });
});

/** Exercise a real author/capture/check failure, then authenticate its retained outcome. */
async function retainedVerificationFailure(interrupted = true) {
  const worker: Device = { ...device, executionTargets: [{ id: "container", kind: "container", protocolVersion: 1, readiness: "ready",
    capabilities: [{ kind: "linux-shell", readiness: "ready" }, { kind: "chromium-inspection", readiness: "ready" }] }] };
  const factory = harness([worker]);
  const quality = { platforms: ["web" as const], workflows: [{ id: "compose-reopen", platform: "web" as const }], referenceIds: ["primary"] };
  const commands = ["sh scripts/check-client.sh", "sh scripts/check-release.sh", UI_QUALITY_CHECK_COMMAND];
  factory.workspaces.qualityChecks = true;
  factory.planning(async () => ({ ...plan, checks: [], tasks: [{ ...plan.tasks[0]!, checks: commands.slice(0, 2), quality, requiredCheckEnvironment: nativeInputNames }] }));
  factory.executing(async () => ({ status: "succeeded", text: "The client source is complete", chatId: "original-author-chat", sessionId: "original-author-session" }));
  let outcome: "interrupted" | "pass" | "defect" | "stale-ui" = interrupted ? "interrupted" : "defect";
  const originalCheck = factory.workspaces.check;
  factory.workspaces.check = async (...input) => (await originalCheck(...input)).map((check, index): CheckResult => ({
    ...check, checkedCommit: outcome === "stale-ui" && check.command === UI_QUALITY_CHECK_COMMAND ? "foreign-source" : input[1].commit,
    ...(index === 0 && ["interrupted", "defect"].includes(outcome) ? { passed: false, exitCode: 1,
      output: outcome === "interrupted" ? "The original check owner stopped before publishing its result" : "The compose route returns 503",
      ...(outcome === "interrupted" ? { recovery: { condition: "check-interrupted" as const, reason: "The original check effect has positively ended" } } : {}) } : {}),
  }));
  const goal = await planGoal(factory), task = factory.store.list<FactoryTask>("tasks")[0]!;
  factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", task.id)!, checkInputs: configuredNativeInputs(goal, nativeInputValues) });
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const attempt = factory.store.get<Attempt>("attempts", factory.store.get<FactoryTask>("tasks", task.id)!.currentAttemptId!)!;
  const detail = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  assert.equal(attempt.status, "failed"); assert.equal(detail.phase, "checking"); assert.equal(factory.calls.integrate, 0);
  factory.reconciling(async () => ({ status: "succeeded", result: structuredClone(detail.result!) }));
  const proofs: Parameters<NonNullable<FactoryWorkspacePort["confirmCheckRecovery"]>>[0][] = [];
  factory.workspaces.confirmCheckRecovery = async input => {
    proofs.push(structuredClone(input));
    return { status: "settled", automatic: true, evidenceIds: ["original-check-effect", "original-exact-source"] };
  };
  const expected = { goalRevision: goal.revision, candidateId: detail.candidate!.id, candidateCommit: detail.candidate!.commit };
  return { factory, worker, goal, task, attempt, detail, quality, commands, expected, proofs, outcome(value: typeof outcome) { outcome = value; } };
}

test("retained verification recovery authenticates read-only eligibility and rechecks every frozen input without another author", async () => {
  const { factory, goal, task, attempt, detail, quality, commands, expected, proofs, outcome } = await retainedVerificationFailure();
  const tables = ["goals", "tasks", "attempts", "factory-attempt-details", "factory-task-details", "factory-control", "decisions"];
  const before = tables.map(table => factory.store.list(table));
  assert.deepEqual(await factory.coordinator.verificationRecovery(attempt.id), { ...expected, attemptId: attempt.id, eligible: true });
  assert.deepEqual(tables.map(table => factory.store.list(table)), before, "Discovering eligibility cannot rewrite the failed checks, statuses or decisions");
  assert.deepEqual(proofs[0]!.previousChecks, detail.checks); assert.deepEqual(proofs[0]!.commands, commands);
  assert.deepEqual(proofs[0]!.candidate, detail.candidate); assert.deepEqual(proofs[0]!.quality, quality);
  const currentTask = factory.store.get<TaskDetail>("factory-task-details", task.id)!;
  factory.store.set("factory-task-details", { ...currentTask, checks: ["sh scripts/new-unrelated-check.sh"],
    checkInputs: { ...currentTask.checkInputs!, configurationRevision: 2, environment: { ENOUGH_EVIDENCE_ROOT: "/different/input" } } });
  outcome("pass");
  await factory.coordinator.recheckAttempt(attempt.id, expected); await factory.coordinator.waitForIdle();
  const accepted = factory.store.get<Attempt>("attempts", attempt.id)!, saved = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.currentAttemptId, attempt.id);
  for (const key of ["id", "generation", "deviceId", "chatId", "sessionId", "candidate", "startedAt"] as const) assert.equal(accepted[key], attempt[key]);
  assert.deepEqual(saved.result, detail.result); assert.deepEqual(saved.contract, detail.contract);
  assert.deepEqual(saved.workspace, detail.workspace); assert.deepEqual(saved.candidate, detail.candidate); assert.deepEqual(saved.checkInputs, detail.checkInputs);
  assert.deepEqual(saved.checkRecoveryHistory!.map(({ at: _at, ...history }) => history), [{ automatic: false, checks: detail.checks, error: attempt.error,
    evidenceIds: ["original-check-effect", "original-exact-source"] }]);
  assert.deepEqual(factory.candidateCommands, [commands, commands]); assert.deepEqual(factory.integrationCommands, [commands]);
  assert.ok(saved.integration!.checks.every(check => check.candidateCommit === expected.candidateCommit && check.checkedCommit === saved.integration!.commit));
  assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.prepare, 1); assert.equal(factory.calls.capture, 1);
  assert.equal(factory.store.list<Attempt>("attempts").length, 1); assert.equal(factory.calls.diagnosis, 0);
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.revision, goal.revision);
  assert.equal(await factory.coordinator.verificationRecovery(attempt.id), undefined, "Accepted work cannot acquire another recovery action");
});

test("retained verification recovery cannot accept a new defect or UI evidence for another candidate or combined source", async t => {
  for (const outcomeName of ["defect", "stale-ui", "combined-defect", "combined-ui"] as const) await t.test(outcomeName, async () => {
    const { factory, task, attempt, detail, expected, commands, outcome } = await retainedVerificationFailure();
    const combined = outcomeName.startsWith("combined");
    outcome(combined ? "pass" : outcomeName as "defect" | "stale-ui");
    if (combined) {
      const originalIntegration = factory.workspaces.integrate;
      factory.workspaces.integrate = async (...input) => {
        const integration = await originalIntegration(...input);
        integration.checks = integration.checks.map((check, index) => outcomeName === "combined-defect" && index === 0 ? { ...check, passed: false, output: "The combined compose route returns 503" }
          : outcomeName === "combined-ui" && check.command === UI_QUALITY_CHECK_COMMAND ? { ...check, checkedCommit: input[1].commit } : check);
        return integration;
      };
    }
    await factory.coordinator.recheckAttempt(attempt.id, expected); await factory.coordinator.waitForIdle();
    const failed = factory.store.get<Attempt>("attempts", attempt.id)!, saved = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
    assert.equal(failed.status, combined ? "unknown" : "failed"); assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, combined ? "review" : "failed");
    assert.match(failed.error!, outcomeName === "defect" ? /compose route returns 503/ : outcomeName === "stale-ui" ? /exact saved candidate/
      : outcomeName === "combined-defect" ? /combined repository did not pass/ : /actual combined integration source/);
    assert.deepEqual(saved.checkRecoveryHistory![0]!.checks, detail.checks);
    assert.deepEqual(saved.candidate, detail.candidate); assert.deepEqual(saved.contract, detail.contract);
    assert.deepEqual(factory.candidateCommands, [commands, commands]); assert.equal(factory.calls.integrate, combined ? 1 : 0);
    assert.equal(saved.integration, undefined, "A possibly written combined result requires reconciliation rather than an accepted merge record");
    assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
  });
});

test("retained verification recovery rejects stale ownership, uncertain effects and exhausted limits without changing failed work", async t => {
  for (const scenario of ["selected-revision", "selected-candidate", "frozen-revision", "task-owner", "candidate-record", "task-source", "checked-source", "unchecked-source", "offline",
    "cancellation", "integrated", "missing-port", "unknown-author", "different-author-result", "unknown-proof", "empty-proof", "attempt-budget", "time-budget", "automatic-paused", "automatic-manual", "automatic-proof-denied"] as const) await t.test(scenario, async () => {
    const fixture = await retainedVerificationFailure(), { factory, worker, goal, task, attempt, detail } = fixture;
    let expected = { ...fixture.expected }, automatic = false;
    switch (scenario) {
      case "selected-revision": expected.goalRevision++; break;
      case "selected-candidate": expected.candidateId = "different-candidate"; break;
      case "frozen-revision": factory.store.set("factory-attempt-details", { ...detail, goalRevision: goal.revision + 1 }); break;
      case "task-owner": factory.store.set("tasks", { ...factory.store.get<FactoryTask>("tasks", task.id)!, currentAttemptId: "replacement-author" }); break;
      case "candidate-record": factory.store.set("attempts", { ...attempt, candidate: "different-source" }); break;
      case "task-source": factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", task.id)!, lastCandidate: { ...detail.candidate!, commit: "different-source" } }); break;
      case "checked-source": factory.store.set("factory-attempt-details", { ...detail, checks: detail.checks!.map(check => ({ ...check, checkedCommit: "different-source" })) }); break;
      case "unchecked-source": factory.store.set("factory-attempt-details", { ...detail, checks: detail.checks!.map(check => ({ ...check, checkedCommit: undefined })) }); break;
      case "offline": worker.online = false; break;
      case "cancellation": factory.store.set("factory-attempt-details", { ...detail, cancellation: "requested" }); break;
      case "integrated": factory.store.set("factory-attempt-details", { ...detail, integration: { commit: "already-integrated", previousHead: "initial-head", candidateCommit: detail.candidate!.commit, checks: [] } }); break;
      case "missing-port": factory.workspaces.confirmCheckRecovery = undefined; break;
      case "unknown-author": factory.reconciling(async () => ({ status: "unknown" })); break;
      case "different-author-result": factory.reconciling(async () => ({ status: "succeeded", result: { ...detail.result!, chatId: "different-author-chat" } })); break;
      case "unknown-proof": factory.workspaces.confirmCheckRecovery = async () => ({ status: "unknown", reason: "The owning check effect is still active" }); break;
      case "empty-proof": factory.workspaces.confirmCheckRecovery = async () => ({ status: "settled", automatic: true, evidenceIds: [] }); break;
      case "attempt-budget": factory.coordinator.configure(goal.id, { maxAttempts: 1 }); break;
      case "time-budget": factory.store.set("factory-control", { ...factory.store.get<ControlRecord>("factory-control", goal.id)!, maxDurationMs: 0 }); break;
      case "automatic-paused": factory.coordinator.pause(goal.id); automatic = true; break;
      case "automatic-manual": factory.coordinator.configure(goal.id, { autonomy: "manual" }); automatic = true; break;
      case "automatic-proof-denied": factory.workspaces.confirmCheckRecovery = async () => ({ status: "settled", automatic: false, evidenceIds: ["manual-proof"] }); automatic = true; break;
    }
    const savedAttempt = factory.store.get<Attempt>("attempts", attempt.id), savedDetail = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id);
    await assert.rejects(factory.coordinator.recheckAttempt(attempt.id, { ...expected, automatic }));
    await factory.coordinator.waitForIdle();
    assert.deepEqual(factory.store.get("attempts", attempt.id), savedAttempt); assert.deepEqual(factory.store.get("factory-attempt-details", attempt.id), savedDetail);
    assert.equal(factory.calls.check, 1); assert.equal(factory.calls.integrate, 0); assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
    assert.equal(factory.store.list<Decision>("decisions").some(decision => decision.kind === "verification-retry"), false);
  });
});

test("retained verification recovery reserves author and controller while proof is pending and rejects duplicate retries", async () => {
  const { factory, goal, attempt, expected, outcome } = await retainedVerificationFailure();
  const entered = deferred<void>(), proof = deferred<{ status: "settled"; automatic: boolean; evidenceIds: string[] }>();
  let confirmations = 0;
  factory.workspaces.confirmCheckRecovery = async () => { confirmations++; entered.resolve(); return proof.promise; };
  outcome("pass"); const recovery = factory.coordinator.recheckAttempt(attempt.id, expected); await entered.promise;
  await assert.rejects(factory.coordinator.recheckAttempt(attempt.id, expected), /another operation/);
  assert.equal((await factory.coordinator.verificationRecovery(attempt.id))!.eligible, false);
  for (let tick = 0; tick < 2; tick++) await factory.coordinator.tick();
  assert.equal(factory.calls.diagnosis, 0, "A diagnosis cannot replace the author while authenticated recovery holds its goal");
  assert.equal(factory.calls.check, 1); assert.equal(factory.calls.execute, 1);
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "running");
  proof.resolve({ status: "settled", automatic: true, evidenceIds: ["settled-original-effect"] });
  await recovery; await factory.coordinator.waitForIdle();
  assert.equal(confirmations, 1); assert.equal(factory.calls.check, 2); assert.equal(factory.calls.integrate, 1);
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.checkRecoveryHistory!.length, 1);
});

test("retained verification recovery revalidates authority after asynchronous owning proof", async t => {
  for (const change of ["steer", "retire", "pause", "contract", "budget"] as const) await t.test(change, async () => {
    const { factory, goal, attempt, detail, expected } = await retainedVerificationFailure();
    const entered = deferred<void>(), proof = deferred<{ status: "settled"; automatic: boolean; evidenceIds: string[] }>();
    factory.workspaces.confirmCheckRecovery = async () => { entered.resolve(); return proof.promise; };
    const recovery = assert.rejects(factory.coordinator.recheckAttempt(attempt.id, expected)); await entered.promise;
    if (change === "steer") await factory.coordinator.steer(goal.id, { context: "Change the acceptance scope" });
    else if (change === "retire") await factory.coordinator.retireAttempt(attempt.id);
    else if (change === "pause") factory.coordinator.pause(goal.id);
    else if (change === "contract") factory.store.set("factory-attempt-details", { ...detail, contract: { ...detail.contract!, checks: ["changed-check"] } });
    else factory.coordinator.configure(goal.id, { maxAttempts: 1 });
    proof.resolve({ status: "settled", automatic: true, evidenceIds: ["old-proof"] });
    await recovery; await factory.coordinator.waitForIdle();
    assert.equal(factory.calls.check, 1); assert.equal(factory.calls.integrate, 0); assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
    assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.checkRecoveryHistory, undefined);
    assert.notEqual(factory.store.get<FactoryTask>("tasks", attempt.taskId)!.status, "completed");
  });
});

test("retained verification recovery explicitly resumes a paused goal only after proof in one transition", async () => {
  const { factory, goal, task, attempt, detail, expected, outcome } = await retainedVerificationFailure();
  factory.coordinator.pause(goal.id);
  const entered = deferred<void>(), proof = deferred<{ status: "settled"; automatic: boolean; evidenceIds: string[] }>();
  factory.workspaces.confirmCheckRecovery = async () => { entered.resolve(); return proof.promise; };
  const checked = deferred<void>(), finishCheck = deferred<void>();
  factory.beforeCheck(async () => { checked.resolve(); await finishCheck.promise; }); outcome("pass");
  const recovery = factory.coordinator.recheckAttempt(attempt.id, expected); await entered.promise;
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "paused");
  assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.checks, detail.checks);
  proof.resolve({ status: "settled", automatic: false, evidenceIds: ["explicit-recovery-proof"] });
  await recovery; await checked.promise;
  assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "running");
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "review");
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "succeeded");
  const saved = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  assert.equal(saved.checks, undefined); assert.deepEqual(saved.checkRecoveryHistory![0]!.checks, detail.checks);
  assert.equal(factory.store.get<ControlRecord>("factory-control", goal.id)!.stage, "dispatch");
  finishCheck.resolve(); await factory.coordinator.waitForIdle();
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
  assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
});

test("retained verification recovery automatically retries an interrupted check once but never loops on a genuine defect", async () => {
  const { factory, goal, task, attempt, detail, outcome, proofs } = await retainedVerificationFailure();
  outcome("defect");
  await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
  const saved = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
  assert.equal(factory.store.get<Attempt>("attempts", attempt.id)!.status, "failed");
  assert.deepEqual(saved.checkRecoveryHistory![0]!.checks, detail.checks); assert.equal(saved.checkRecoveryHistory![0]!.automatic, true);
  assert.equal(factory.calls.check, 2); assert.equal(factory.calls.diagnosis, 0); assert.equal(proofs.length, 1);
  assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1); assert.equal(factory.calls.integrate, 0);
  factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", task.id)!, waitingFor: "external-condition" });
  for (const condition of ["inspection-evidence", "runtime-available", "execution-capability"]) factory.coordinator.notifyCondition(condition, goal.id);
  for (let tick = 0; tick < 2; tick++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
  assert.equal(factory.calls.check, 2); assert.equal(proofs.length, 1, "Later capability signals cannot repeat the same automatic recovery");
  const recovered = factory.recover();
  recovered.notifyCondition("runtime-available", goal.id);
  for (let tick = 0; tick < 2; tick++) { await recovered.tick(); await recovered.waitForIdle(); }
  assert.equal(factory.calls.check, 2); assert.equal(proofs.length, 1, "Durable automatic history survives a coordinator restart");
  const realFailure = await retainedVerificationFailure(false);
  realFailure.factory.store.set("factory-task-details", { ...realFailure.factory.store.get<TaskDetail>("factory-task-details", realFailure.task.id)!, waitingFor: "external-condition" });
  for (let tick = 0; tick < 2; tick++) { await realFailure.factory.coordinator.tick(); await realFailure.factory.coordinator.waitForIdle(); }
  realFailure.factory.coordinator.notifyCondition("inspection-evidence", realFailure.goal.id); await realFailure.factory.coordinator.waitForIdle();
  assert.equal(realFailure.proofs.length, 0); assert.equal(realFailure.factory.calls.check, 1);
  assert.equal(realFailure.factory.store.get<AttemptDetail>("factory-attempt-details", realFailure.attempt.id)!.checkRecoveryHistory, undefined);
});

test("retained verification recovery caches unknown automatic proof until a relevant owner signal", async () => {
  const { factory, goal, task, attempt, outcome } = await retainedVerificationFailure();
  factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", task.id)!, waitingFor: "external-condition" });
  let confirmations = 0, ready = false;
  factory.workspaces.confirmCheckRecovery = async () => {
    confirmations++;
    return ready ? { status: "settled", automatic: true, evidenceIds: ["now-settled-effect"] } : { status: "unknown", reason: "Check owner remains disconnected" };
  };
  for (let tick = 0; tick < 3; tick++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
  assert.equal(confirmations, 1); assert.equal(factory.calls.check, 1);
  factory.coordinator.notifyCondition("unrelated-condition", goal.id); await factory.coordinator.waitForIdle();
  assert.equal(confirmations, 1);
  ready = true; outcome("pass"); factory.coordinator.notifyCondition("runtime-available", goal.id); await factory.coordinator.waitForIdle();
  assert.equal(confirmations, 2); assert.equal(factory.calls.check, 2); assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
  assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
  assert.equal(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!.checkRecoveryHistory![0]!.automatic, true);
});

test("retained verification recovery ignores only obsolete owner spend while preserving exact original results", async t => {
  for (const scenario of ["legacy-spend", "changed-text", "additional-owner-field"] as const) await t.test(scenario, async () => {
    const { factory, task, attempt, detail, expected, outcome, proofs } = await retainedVerificationFailure();
    const legacyResult = { spend: 12.34, sessionId: detail.result!.sessionId, chatId: detail.result!.chatId, text: detail.result!.text, status: detail.result!.status,
      ...(scenario === "changed-text" ? { text: "A different author outcome" } : {}), ...(scenario === "additional-owner-field" ? { newExecutionId: "different-provider-run" } : {}) };
    factory.reconciling(async () => ({ status: "succeeded", result: legacyResult }));
    outcome("pass");
    if (scenario === "legacy-spend") {
      await factory.coordinator.recheckAttempt(attempt.id, expected); await factory.coordinator.waitForIdle();
      assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
      const saved = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
      assert.deepEqual(saved.result, detail.result); assert.equal(Object.hasOwn(saved.result!, "spend"), false);
      assert.deepEqual(saved.checkRecoveryHistory![0]!.checks, detail.checks); assert.equal(proofs.length, 1);
      assert.equal(factory.calls.check, 2); assert.equal(factory.calls.integrate, 1);
    } else {
      await assert.rejects(factory.coordinator.recheckAttempt(attempt.id, expected), /original successful result/);
      assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id), detail);
      assert.equal(proofs.length, 0); assert.equal(factory.calls.check, 1); assert.equal(factory.calls.integrate, 0);
    }
    assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
  });
});

test("retained verification recovery reprobes unknown effects after resume or configuration without automatically unpausing", async t => {
  for (const change of ["pause-resume", "configuration", "configuration-while-paused"] as const) await t.test(change, async () => {
    const { factory, goal, task, attempt, outcome } = await retainedVerificationFailure();
    factory.store.set("factory-task-details", { ...factory.store.get<TaskDetail>("factory-task-details", task.id)!, waitingFor: "external-condition" });
    let confirmations = 0, ready = false;
    factory.workspaces.confirmCheckRecovery = async () => {
      confirmations++;
      return ready ? { status: "settled", automatic: true, evidenceIds: ["resumed-owning-effect"] } : { status: "unknown", reason: "The check outcome has not settled" };
    };
    for (let tick = 0; tick < 3; tick++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
    assert.equal(confirmations, 1); assert.equal(factory.calls.check, 1);
    ready = true; outcome("pass");
    if (change === "configuration") factory.coordinator.configure(goal.id, { concurrency: 2 });
    else {
      factory.coordinator.pause(goal.id);
      if (change === "configuration-while-paused") factory.coordinator.configure(goal.id, { concurrency: 2 });
      for (let tick = 0; tick < 2; tick++) { await factory.coordinator.tick(); await factory.coordinator.waitForIdle(); }
      assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "paused");
      assert.equal(confirmations, 1, "Resetting a probe cannot dispatch verification for a paused goal");
      assert.equal(factory.calls.check, 1);
      factory.coordinator.resume(goal.id);
    }
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(confirmations, 2); assert.equal(factory.calls.check, 2); assert.equal(factory.calls.integrate, 1);
    assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, "completed");
    const saved = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
    assert.equal(saved.checkRecoveryHistory!.length, 1); assert.equal(saved.checkRecoveryHistory![0]!.automatic, true);
    assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1); assert.equal(factory.store.list<Attempt>("attempts").length, 1);
  });
});

test("retained verification recovery rejects owning proof returned after coordinator shutdown without allocating checks", async () => {
  const { factory, attempt, expected } = await retainedVerificationFailure();
  const entered = deferred<void>(), proof = deferred<{ status: "settled"; automatic: boolean; evidenceIds: string[] }>();
  factory.workspaces.confirmCheckRecovery = async () => { entered.resolve(); return proof.promise; };
  const rejected = assert.rejects(factory.coordinator.recheckAttempt(attempt.id, expected), /shutting down/);
  await entered.promise;
  const tables = ["goals", "tasks", "attempts", "factory-attempt-details", "factory-task-details", "factory-control", "decisions"];
  const before = tables.map(table => factory.store.list(table));
  factory.coordinator.stop();
  proof.resolve({ status: "settled", automatic: true, evidenceIds: ["late-owning-effect"] });
  await rejected; await factory.coordinator.waitForIdle();
  assert.deepEqual(tables.map(table => factory.store.list(table)), before);
  assert.equal(factory.calls.check, 1); assert.equal(factory.calls.integrate, 0); assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
  assert.deepEqual(factory.coordinator.serviceActivity(), { controllers: 0, attempts: 0, reconciliation: 0, pending: 0 });
});

test("retained verification recovery holds a paused goal until saved verification completes or reaches a typed wait", async t => {
  for (const result of ["completed", "inspection-wait"] as const) await t.test(result, async () => {
    const { factory, goal, task, attempt, detail, expected, outcome } = await retainedVerificationFailure();
    factory.coordinator.pause(goal.id);
    const independent: FactoryTask = { ...task, id: "independent-recovery-work", title: "Write independent release notes", description: "Deliver unrelated documentation",
      status: "queued", dependsOn: [], quality: undefined, writePaths: ["docs/release-notes"], currentAttemptId: undefined, sessionId: undefined };
    factory.store.set("tasks", independent);
    factory.store.set<TaskDetail>("factory-task-details", { id: independent.id, key: "independent-recovery-work", checks: ["sh scripts/check-release-notes.sh"],
      planRevision: detail.contract!.planRevision, planChecks: [], selected: false, failureSignatures: [] });
    const entered = deferred<void>(), completeCheck = deferred<void>();
    factory.beforeCheck(async () => { entered.resolve(); await completeCheck.promise; });
    outcome("pass");
    const originalCheck = factory.workspaces.check;
    factory.workspaces.check = async (...input) => (await originalCheck(...input)).map(check =>
      result === "inspection-wait" && input[3]!.attempt.id === attempt.id && check.command === UI_QUALITY_CHECK_COMMAND ? { ...check, passed: false,
        recovery: { condition: "inspection-evidence" as const, reason: "The exact-source screenshot receipt has not arrived" } } : check);
    await factory.coordinator.recheckAttempt(attempt.id, expected); await entered.promise;
    assert.equal(factory.store.get<Goal>("goals", goal.id)!.status, "running");
    assert.equal(factory.coordinator.serviceActivity().controllers, 1, "An explicit paused retry keeps the goal reservation through its asynchronous check");
    for (let tick = 0; tick < 3; tick++) await factory.coordinator.tick();
    assert.equal(factory.calls.execute, 1); assert.equal(factory.calls.capture, 1);
    assert.equal(factory.store.get<FactoryTask>("tasks", independent.id)!.currentAttemptId, undefined, "Unrelated author work cannot start before the saved verification returns");
    assert.equal(factory.calls.diagnosis, 0);
    completeCheck.resolve(); await factory.coordinator.waitForIdle();
    assert.equal(factory.coordinator.serviceActivity().controllers, 0, "Completed verification and typed waits both release the goal reservation");
    const saved = factory.store.get<AttemptDetail>("factory-attempt-details", attempt.id)!;
    assert.deepEqual(saved.candidate, detail.candidate); assert.deepEqual(saved.contract, detail.contract);
    assert.equal(saved.checkRecoveryHistory!.length, 1);
    assert.equal(factory.store.get<FactoryTask>("tasks", task.id)!.status, result === "completed" ? "completed" : "review");
    assert.equal(saved.verificationWait?.condition, result === "completed" ? undefined : "inspection-evidence");
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.equal(factory.calls.execute, 2); assert.equal(factory.calls.capture, 2);
    assert.equal(factory.store.get<FactoryTask>("tasks", independent.id)!.status, "completed", "Normal dispatch resumes after the verification reservation ends");
    assert.equal(factory.store.list<Attempt>("attempts").filter(item => item.taskId === task.id).length, 1, "The saved source still has its original author only");
  });
});
