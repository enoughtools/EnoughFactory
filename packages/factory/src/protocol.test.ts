import assert from "node:assert/strict";
import test from "node:test";
import { FactoryDecisionError } from "./errors.js";
import { readCheckCommands, readEvaluation, readPlan, readTasks, validateDependencies, validateRequiredCheckEnvironment, validateTaskExecution, validateTaskQuality } from "./protocol.js";

const task = { key: "implementation", title: "Implement feature", description: "Deliver the requested behavior", dependsOn: [], checks: [] };

test("execution contracts preserve omission and distinguish author requirements from delegated tools", () => {
  assert.equal(validateTaskExecution(undefined), undefined);
  assert.deepEqual(validateTaskExecution({}), {});
  const execution = { target: "auto", requiredCapabilities: ["mac-shell"], delegatedCapabilities: ["ios-simulator-inspection", "chromium-inspection"] };
  assert.deepEqual(validateTaskExecution(execution), execution);
  assert.deepEqual(readTasks([{ ...task, execution }])[0]!.execution, execution);
  assert.equal(Object.hasOwn(readTasks([task])[0]!, "execution"), false);
  for (const value of [null, [], "host-macos", { target: "darwin" }, { target: null }, { host: true }, { requiredCapabilities: "mac-shell" }, { requiredCapabilities: ["mac-shell", "mac-shell"] }, { delegatedCapabilities: ["fake-ui"] }]) {
    assert.throws(() => validateTaskExecution(value), FactoryDecisionError);
  }
});

test("quality acceptance is explicit, bounded and bound to declared platforms and workflow identities", () => {
  const quality = { platforms: ["web", "macos"], workflows: [{ id: "compose-close", platform: "macos" }], referenceIds: ["mail-web"] };
  assert.deepEqual(validateTaskQuality(quality), quality);
  assert.deepEqual(readTasks([{ ...task, quality }])[0]!.quality, quality);
  assert.equal(validateTaskQuality(undefined), undefined);
  assert.equal(Object.hasOwn(readTasks([task])[0]!, "quality"), false);
  for (const invalid of [null, {}, { ...quality, arbitrary: true }, { ...quality, platforms: [] }, { ...quality, platforms: ["macos", "macos"] }, { ...quality, platforms: ["linux"] }, { ...quality, workflows: [{ id: "compose", platform: "ios-simulator" }] }, { ...quality, workflows: [{ id: "compose", platform: "macos" }, { id: "compose", platform: "macos" }] }, { ...quality, referenceIds: ["mail-web", " mail-web "] }, { ...quality, referenceIds: ["bad\nreference"] }]) {
    assert.throws(() => validateTaskQuality(invalid), FactoryDecisionError);
  }
});

test("verification prerequisites accept only supported unique input names and preserve explicit clearing", () => {
  const keys = ["ENOUGH_EVIDENCE_ROOT", "ENOUGH_NATIVE_INDEX_SHA256", "ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR", "ENOUGH_ACCEPTANCE_INDEX_SHA256"];
  assert.equal(validateRequiredCheckEnvironment(undefined), undefined);
  assert.deepEqual(validateRequiredCheckEnvironment([]), []);
  assert.deepEqual(validateRequiredCheckEnvironment(keys), keys);
  assert.deepEqual(readTasks([{ ...task, requiredCheckEnvironment: keys }])[0]!.requiredCheckEnvironment, keys);
  assert.deepEqual(readTasks([{ ...task, requiredCheckEnvironment: [] }])[0]!.requiredCheckEnvironment, []);
  assert.equal(Object.hasOwn(readTasks([task])[0]!, "requiredCheckEnvironment"), false);
  for (const value of [null, "ENOUGH_EVIDENCE_ROOT", {}, [1], [""], [" ENOUGH_EVIDENCE_ROOT"], ["API_TOKEN"], ["invalid-key"], ["A".repeat(129)], [keys[0], keys[0]], [...keys, "EXTRA"]]) {
    assert.throws(() => validateRequiredCheckEnvironment(value), FactoryDecisionError);
    assert.throws(() => readTasks([{ ...task, requiredCheckEnvironment: value }]), FactoryDecisionError);
  }
});

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

test("prose checks require corrected shell commands in plans, tasks and evaluation additions", () => {
  const prose = "Run scripts/check-foundation.sh to validate foundation behavior.";
  const correction = (error: unknown): boolean => error instanceof FactoryDecisionError && /actual shell commands/.test(error.message) && error.message.includes("sh scripts/check-foundation.sh");
  assert.throws(() => readTasks([{ ...task, checks: [prose] }]), correction);
  assert.throws(() => readPlan(JSON.stringify({ summary: "Deliver work", criteria: ["Verified"], tasks: [task], checks: [prose] })), correction);
  assert.throws(() => readEvaluation(JSON.stringify({ complete: false, summary: "More work", criteria: [], additionalTasks: [{ ...task, checks: [prose] }] })), correction);
  for (const instruction of ["run scripts/check-foundation.sh to validate the result", "Please execute npm test and then verify the behavior", "Run the test suite", "Ensure that all checks pass"]) {
    assert.throws(() => readCheckCommands([instruction]), correction);
  }
});

test("check commands reject Markdown wrappers and NUL bytes", () => {
  for (const command of ["```sh\nsh scripts/check-foundation.sh\n```", "~~~bash\npnpm test\n~~~", "- sh scripts/check-foundation.sh", "1. pnpm test", "printf 'bad\u0000argument'"]) {
    assert.throws(() => readCheckCommands([command]), FactoryDecisionError);
  }
});

test("check commands retain arbitrary executables, scripts, compound shell logic and quoted explanatory content", () => {
  const commands = [
    "sh scripts/check-foundation.sh", "scripts/check-foundation.sh", "custom-verifier --strict", "Run --full",
    "run suite --message 'to validate the result'", "printf '%s\\n' 'Run scripts/check-foundation.sh to validate the result'",
    "CHECK_MODE=full ./verify && echo success", "if [ -f package.json ]; then pnpm test; else ./verify; fi",
    "sh -c 'echo \"Ensure that the result is present\"'", "printf '%s' '```'",
    "cat <<'MESSAGE'\nRun scripts/check-foundation.sh to validate the result\nMESSAGE",
  ];
  assert.deepEqual(readCheckCommands(commands), commands);
  assert.deepEqual(readTasks([{ ...task, checks: commands }])[0]!.checks, commands);
  assert.deepEqual(readPlan(JSON.stringify({ summary: "Deliver work", criteria: ["Verified"], tasks: [], checks: commands })).checks, commands);
});

const criterionBindings = [
  { criterionId: `criterion-${"1".repeat(64)}`, criterion: String.raw`The original literal \n requirement is satisfied.` },
  { criterionId: `criterion-${"2".repeat(64)}`, criterion: "The release artifact is available." },
] as const;
const evaluationText = (criteria: unknown[]) => JSON.stringify({ complete: true, summary: "Inspect the original requirements", criteria });
const satisfiedEvidence = { satisfied: true, evidence: ["artifact:current-proof"] };

test("criterion IDs resolve only against frozen bindings and preserve original literal requirement bytes", () => {
  const required = structuredClone(criterionBindings);
  const result = readEvaluation(evaluationText(required.map(({ criterionId }) => ({ criterionId, ...satisfiedEvidence }))), required);
  assert.deepEqual(result.criteria, required.map(binding => ({ ...binding, ...satisfiedEvidence })));
  assert.equal(result.criteria[0]!.criterion.includes("\\n"), true);
  assert.equal(result.criteria[0]!.criterion.includes("\n"), false);
  assert.deepEqual(required, criterionBindings, "resolving an ID cannot mutate the frozen requirement source");
  assert.deepEqual(readEvaluation(evaluationText([{ ...required[0], ...satisfiedEvidence }]), required).criteria[0], { ...required[0], ...satisfiedEvidence });
});

test("legacy criterion text remains exact without adding an ID", () => {
  const criterion = criterionBindings[0].criterion;
  const legacy = { criterion, ...satisfiedEvidence };
  assert.deepEqual(readEvaluation(evaluationText([legacy])).criteria, [legacy]);
  assert.deepEqual(readEvaluation(evaluationText([legacy]), criterionBindings).criteria, [legacy]);
  const realNewline = { criterion: criterion.replace("\\n", "\n"), ...satisfiedEvidence };
  assert.notEqual(realNewline.criterion, criterion);
  assert.deepEqual(readEvaluation(evaluationText([realNewline])).criteria, [realNewline], "legacy evidence is never normalized to a recorded requirement");
  assert.deepEqual(readEvaluation(evaluationText([realNewline]), criterionBindings).criteria, [realNewline], "a real newline cannot bind to the original literal backslash-n requirement");
});

test("explicit invalid or unbound criterion IDs cannot fall back to correctly echoed original text", () => {
  const original = criterionBindings[0].criterion;
  for (const criterionId of [null, false, 1, [], {}, "", " ", "criterion-1", `criterion-${"A".repeat(64)}`, `criterion-${"3".repeat(64)}`]) {
    assert.throws(() => readEvaluation(evaluationText([{ criterionId, criterion: original, ...satisfiedEvidence }]), criterionBindings), FactoryDecisionError, `Explicit ID ${JSON.stringify(criterionId)} cannot use its text as a fallback`);
  }
  const boundEntry = { ...criterionBindings[0], ...satisfiedEvidence };
  assert.throws(() => readEvaluation(evaluationText([boundEntry])), FactoryDecisionError, "an ID requires its supplied frozen bindings");
  assert.throws(() => readEvaluation(evaluationText([boundEntry]), []), FactoryDecisionError);
  assert.throws(() => readEvaluation(evaluationText([boundEntry]), [criterionBindings[1]]), FactoryDecisionError, "an earlier revision's ID cannot bind to a different snapshot");
  for (const criterion of [null, 1, original.replace("\\n", "\n"), `${original} extra`, criterionBindings[1].criterion]) {
    assert.throws(() => readEvaluation(evaluationText([{ ...boundEntry, criterion }]), criterionBindings), FactoryDecisionError, "provided text cannot conflict with its exact bound requirement");
  }
  assert.throws(() => readEvaluation(evaluationText([{ ...satisfiedEvidence }]), criterionBindings), FactoryDecisionError, "each assessment still requires a criterion identity");
});

test("duplicate and ambiguous criterion assessments cannot select one convenient satisfied result", () => {
  const first = { criterionId: criterionBindings[0].criterionId, ...satisfiedEvidence };
  const legacy = { criterion: criterionBindings[0].criterion, ...satisfiedEvidence };
  for (const entries of [[first, { ...first, satisfied: false, evidence: [] }], [legacy, first], [first, legacy], [legacy, legacy], [first, { ...criterionBindings[1], criterionId: criterionBindings[0].criterionId, ...satisfiedEvidence }]]) {
    assert.throws(() => readEvaluation(evaluationText(entries), criterionBindings), FactoryDecisionError);
  }
  assert.throws(() => readEvaluation(evaluationText([legacy]), [criterionBindings[0], { ...criterionBindings[1], criterion: criterionBindings[0].criterion }]), FactoryDecisionError, "legacy text cannot choose between identical requirements with distinct IDs");
});

test("valid criterion identity does not manufacture positive assessment or missing evidence", () => {
  const entries = [
    { criterionId: criterionBindings[0].criterionId, satisfied: false, evidence: ["artifact:failed-outcome"] },
    { criterionId: criterionBindings[1].criterionId, satisfied: true, evidence: [] },
  ];
  const result = readEvaluation(evaluationText(entries), criterionBindings);
  assert.deepEqual(result.criteria, entries.map((entry, index) => ({ ...entry, criterion: criterionBindings[index]!.criterion })));
  assert.deepEqual(readEvaluation(evaluationText([]), criterionBindings).criteria, [], "omitted assessments remain omitted for the coordinator's coverage gate");
  for (const entry of [{ criterionId: criterionBindings[0].criterionId, evidence: [] }, { criterionId: criterionBindings[0].criterionId, satisfied: "true", evidence: [] }, { criterionId: criterionBindings[0].criterionId, satisfied: true }]) {
    assert.throws(() => readEvaluation(evaluationText([entry]), criterionBindings), FactoryDecisionError);
  }
});
