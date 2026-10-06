import assert from "node:assert/strict";
import test from "node:test";
import { FactoryDecisionError } from "./errors.js";
import { readPlan, readTasks, validateDependencies } from "./protocol.js";

const task = { key: "implementation", title: "Implement feature", description: "Deliver the requested behavior", dependsOn: [], checks: [] };

test("planning preserves scheduling hints, normalizes path globs and keeps legacy hints absent", () => {
  assert.deepEqual(readTasks([task]), [task]);
  const planned = readTasks([{
    ...task, estimatedMinutes: 2.5, resources: { cpus: 1.5, memoryGiB: 0.5 },
    writePaths: [" ./src\\components\\**\\*.tsx ", "src//services/.", "src/services", ".github/**", "packages/{factory,contracts}/src/**"],
  }])[0]!;
  assert.equal(planned.estimatedMinutes, 2.5);
  assert.deepEqual(planned.resources, { cpus: 1.5, memoryGiB: 0.5 });
  assert.deepEqual(planned.writePaths, ["src/components/**/*.tsx", "src/services", ".github/**", "packages/{factory,contracts}/src/**"]);
  const limits = readTasks([{ ...task, estimatedMinutes: 10080, resources: { cpus: 512, memoryGiB: 4096 }, writePaths: [] }])[0]!;
  assert.equal(limits.estimatedMinutes, 10080);
  assert.deepEqual(limits.resources, { cpus: 512, memoryGiB: 4096 });
  assert.deepEqual(limits.writePaths, []);
  assert.deepEqual(readTasks([{ ...task, resources: {} }])[0]!.resources, {});
});

test("malformed duration and resource hints must be corrected before dispatch", () => {
  for (const estimatedMinutes of [0, -1, NaN, Infinity, -Infinity, 10081, "20", true, null, [], {}]) {
    assert.throws(() => readTasks([{ ...task, estimatedMinutes }]), FactoryDecisionError, `Duration ${String(estimatedMinutes)} must be rejected`);
  }
  for (const resources of [null, [], "small", 2, true, { memory: 2 }, { cpus: 1, memory: 2 }]) {
    assert.throws(() => readTasks([{ ...task, resources }]), FactoryDecisionError);
  }
  for (const [field, maximum] of [["cpus", 512], ["memoryGiB", 4096]] as const) {
    for (const value of [0, -1, NaN, Infinity, maximum + 1, "2", null, false, [], {}]) {
      assert.throws(() => readTasks([{ ...task, resources: { [field]: value } }]), FactoryDecisionError, `${field}: ${String(value)} must be rejected`);
    }
  }
  assert.throws(() => readPlan(JSON.stringify({ summary: "A plan", criteria: ["Complete"], tasks: [{ ...task, estimatedMinutes: null }] })), /estimatedMinutes/);
});

test("write scope rejects malformed entries, absolute paths and parent traversal while permitting globs", () => {
  for (const writePaths of ["src/**", null, [true], ["src", 2], [""], ["   "]]) {
    assert.throws(() => readTasks([{ ...task, writePaths }]), FactoryDecisionError);
  }
  for (const path of ["/src/**", "\\src", "\\\\host\\share", "C:\\src", "c:src", "../src", "src/../other", "src\\..\\other", "**/../*.ts", "..", ".", "./", "src\u0000file"]) {
    assert.throws(() => readTasks([{ ...task, writePaths: [path] }]), FactoryDecisionError, `${JSON.stringify(path)} must be rejected`);
  }
  assert.deepEqual(readTasks([{ ...task, writePaths: ["**/*", "src/[a-z]*.ts", "src/!(generated)/**"] }])[0]!.writePaths, ["**/*", "src/[a-z]*.ts", "src/!(generated)/**"]);
});

test("dependency validation accepts a DAG and completed predecessors but rejects missing keys and cycles", () => {
  const tasks = readTasks([
    { ...task, key: "contract" },
    { ...task, key: "web", dependsOn: ["contract"] },
    { ...task, key: "service", dependsOn: ["contract"] },
    { ...task, key: "integration", dependsOn: ["web", "service"] },
  ]);
  assert.doesNotThrow(() => validateDependencies(tasks));
  assert.doesNotThrow(() => validateDependencies(readTasks([{ ...task, dependsOn: ["previous"] }]), new Set(["previous"])));
  assert.throws(() => validateDependencies(readTasks([{ ...task, dependsOn: ["missing"] }])), /dependency missing does not exist/);
  assert.throws(() => validateDependencies(readTasks([{ ...task, dependsOn: [task.key] }])), /dependency cycle/);
  assert.throws(() => validateDependencies(readTasks([
    { ...task, key: "first", dependsOn: ["third"] },
    { ...task, key: "second", dependsOn: ["first"] },
    { ...task, key: "third", dependsOn: ["second"] },
  ])), /dependency cycle/);
});
