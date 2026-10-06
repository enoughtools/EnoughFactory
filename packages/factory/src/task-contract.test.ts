import assert from "node:assert/strict";
import test from "node:test";
import type { Device, FactoryTask, Project, TaskKind } from "@enoughfactory/contracts";
import { FactoryCoordinator } from "./coordinator.js";
import type {
  AttemptDetail, FactoryRuntimePort, FactoryStore, FactoryWorkspacePort, PlannedTask, TaskDetail,
} from "./types.js";

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

function harness(plannedTasks: unknown[]) {
  const store = new MemoryStore();
  const device: Device = {
    id: "worker", name: "Owned device", platform: "linux", arch: "x64", online: true,
    local: true, lastSeen: "2026-10-05T00:00:00.000Z", capacity: 5,
  };
  const project: Project = {
    id: "project", name: "Product", path: "/workspace/product", deviceId: device.id,
    runtime: "codex", approvalMode: "approve-all", rules: [], createdAt: device.lastSeen,
  };
  const executions: Array<Parameters<FactoryRuntimePort["execute"]>[0]> = [];
  let prepared = 0, integrated = 0;
  const runtime: FactoryRuntimePort = {
    async complete({ role }) {
      assert.equal(role, "planner", "This journey only requests planning and dispatch");
      return { text: JSON.stringify({
        summary: "Deliver the requested product work", criteria: ["Requested work is integrated"],
        checks: [], tasks: plannedTasks,
      }) };
    },
    async execute(input) {
      executions.push(structuredClone(input));
      return { status: "succeeded", text: "Implemented the requested behavior with evidence" };
    },
    async reconcile() { return { status: "unknown" }; },
    async cancel() {},
  };
  const workspaces: FactoryWorkspacePort = {
    async prepare({ attempt }) {
      prepared++;
      return { id: attempt.id, path: `/workspace/${attempt.id}`, baseCommit: "base", provider: "git" };
    },
    async capture(workspace) { return { id: workspace.id, commit: `candidate-${workspace.id}`, baseCommit: "base" }; },
    async check(_project, candidate, commands) {
      return commands.map(command => ({ command, passed: true, output: "Passed", exitCode: 0, candidateCommit: candidate.commit }));
    },
    async integrate(_project, candidate, input) {
      assert.ok(input.isCurrent());
      integrated++;
      const commit = `integrated-${candidate.id}`;
      return { commit, previousHead: "base", candidateCommit: candidate.commit,
        checks: input.checks.map(command => ({ command, passed: true, output: "Passed", exitCode: 0, candidateCommit: candidate.commit, checkedCommit: commit })) };
    },
    async inspect() { return { head: "base", branch: "main", status: "" }; },
    async release() {},
  };
  const coordinator = new FactoryCoordinator({
    store, runtime, workspaces, deviceId: device.id, devices: () => [device],
    project: id => id === project.id ? project : undefined,
  });
  coordinator.create({
    projectId: project.id, objective: "Deliver all requested work", autonomy: "autonomous",
    approvalMode: "approve-all", concurrency: 5,
  });
  return { store, executions, coordinator, counts: () => ({ prepared, integrated }) };
}

async function planAndDispatch(factory: ReturnType<typeof harness>): Promise<void> {
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
  await factory.coordinator.tick();
  await factory.coordinator.waitForIdle();
}

const kinds: TaskKind[] = ["feature", "unit", "architecture", "test"];
const guidance: Record<TaskKind, RegExp> = {
  feature: /observable|user-facing|end-to-end|user behavior/i,
  unit: /bounded|small|focused implementation|local implementation|specific component/i,
  architecture: /boundar|trade.?offs|design|structure|interfaces/i,
  test: /meaningful checks|product scenarios|regression|assertion|reproduc/i,
};

test("planner contracts reach durable tasks and workers with kind-specific guidance; legacy work remains generic", async () => {
  const typed: PlannedTask[] = kinds.map((kind, index) => ({
    key: `work-${index}`, title: `Deliver work ${index}`, description: "Implement the requested change",
    kind, acceptanceCriteria: [`Observable result ${index} is demonstrated`],
    expectedOutputs: [`Proof artifact ${index} is retained`], dependsOn: [], checks: [`verify/work-${index}`],
  }));
  const legacy: PlannedTask = {
    key: "legacy", title: "Continue existing work", description: "Finish the previously planned change",
    dependsOn: [], checks: ["verify/legacy"],
  };
  const factory = harness([...typed, legacy]);
  await planAndDispatch(factory);

  assert.equal(factory.executions.length, 5);
  assert.deepEqual(factory.counts(), { prepared: 5, integrated: 5 });
  const stored = factory.store.list<FactoryTask>("tasks");
  for (const planned of typed) {
    const task = stored.find(value => value.title === planned.title)!;
    assert.ok(task, "A typed task must survive planning");
    assert.equal(task.kind, planned.kind);
    assert.deepEqual(task.acceptanceCriteria, planned.acceptanceCriteria);
    assert.deepEqual(task.expectedOutputs, planned.expectedOutputs);
    assert.equal(task.status, "completed");
    assert.deepEqual(factory.store.get<TaskDetail>("factory-task-details", task.id)!.checks, planned.checks);
    const execution = factory.executions.find(value => value.task.id === task.id)!;
    assert.equal(execution.task.kind, planned.kind);
    assert.deepEqual(execution.task.acceptanceCriteria, planned.acceptanceCriteria);
    assert.deepEqual(execution.task.expectedOutputs, planned.expectedOutputs);
    assert.match(execution.prompt, guidance[planned.kind!], `${planned.kind} work needs appropriate execution guidance`);
    for (const criterion of planned.acceptanceCriteria!) assert.ok(execution.prompt.includes(criterion), "Workers need the literal acceptance contract");
    for (const output of planned.expectedOutputs!) assert.ok(execution.prompt.includes(output), "Workers need the expected evidence/output contract");
    assert.ok(execution.prompt.includes(planned.checks[0]!));
    const contract = factory.store.get<AttemptDetail>("factory-attempt-details", execution.attempt.id)!.contract;
    assert.deepEqual(contract?.acceptanceCriteria, planned.acceptanceCriteria);
    assert.deepEqual(contract?.expectedOutputs, planned.expectedOutputs);
    assert.deepEqual(contract?.checks, planned.checks);
    factory.store.set("tasks", { ...task, description: "Revised work", acceptanceCriteria: ["New revision criterion"] });
    assert.deepEqual(factory.store.get<AttemptDetail>("factory-attempt-details", execution.attempt.id)!.contract, contract, "A later task revision must not rewrite an attempt's delivery contract");
  }
  const oldTask = stored.find(value => value.title === legacy.title)!;
  const oldExecution = factory.executions.find(value => value.task.id === oldTask.id)!;
  assert.equal(oldTask.kind, undefined, "Old plans must not silently become unit tasks");
  assert.equal(oldExecution.task.kind, undefined);
  assert.equal(oldTask.acceptanceCriteria, undefined);
  assert.equal(oldTask.expectedOutputs, undefined);
  assert.equal(oldTask.status, "completed");
  assert.ok(oldExecution.prompt.includes(legacy.description));
  assert.ok(oldExecution.prompt.includes(legacy.checks[0]!));
});

test("unsupported task kinds cannot publish tasks or dispatch workers", async () => {
  for (const kind of ["documentation", "Feature", ["feature"], null, true, 1]) {
    const factory = harness([{
      key: "invalid", title: "Invalid task", description: "Must not execute", kind, dependsOn: [], checks: [],
    }]);
    await planAndDispatch(factory);
    assert.equal(factory.store.list<FactoryTask>("tasks").length, 0, `Rejected kind ${JSON.stringify(kind)} must not become a task`);
    assert.equal(factory.executions.length, 0);
    assert.deepEqual(factory.counts(), { prepared: 0, integrated: 0 });
  }
});

test("malformed acceptance and output contracts cannot be dropped before dispatch", async () => {
  for (const contract of [
    { acceptanceCriteria: [""] }, { acceptanceCriteria: "a condition" }, { acceptanceCriteria: [true] },
    { expectedOutputs: ["   "] }, { expectedOutputs: "an artifact" }, { expectedOutputs: [null] },
  ]) {
    const factory = harness([{
      key: "invalid", title: "Invalid contract", description: "Must not execute", kind: "feature", dependsOn: [], checks: [], ...contract,
    }]);
    await planAndDispatch(factory);
    assert.equal(factory.store.list<FactoryTask>("tasks").length, 0, "Malformed contracts must be corrected before work is authorized");
    assert.equal(factory.executions.length, 0);
    assert.deepEqual(factory.counts(), { prepared: 0, integrated: 0 });
  }
});
