import assert from "node:assert/strict";
import test from "node:test";
import { validateGoalAcceptance } from "./protocol.js";
import { applicationPlanTasks, assertApplicationWorkflowCoverage, goalQualityRequirements } from "./application-acceptance.js";

test("only explicit bounded application acceptance selects the goal gate", () => {
  assert.equal(validateGoalAcceptance(undefined), undefined);
  assert.equal(goalQualityRequirements({}, []), undefined, "Legacy/API goals acquire no inferred quality gate");
  for (const acceptance of [null, { kind: "other", platforms: ["web"], referenceIds: [] }, { kind: "application", platforms: [], referenceIds: [] }, { kind: "application", platforms: ["windows"], referenceIds: [] }, { kind: "application", platforms: ["web", "web"], referenceIds: [] }, { kind: "application", platforms: ["web"], referenceIds: ["primary", "primary"] }, { kind: "application", platforms: ["web"], referenceIds: [], workflows: [] }]) {
    assert.throws(() => validateGoalAcceptance(acceptance));
  }
  const acceptance = validateGoalAcceptance({ kind: "application", platforms: ["macos", "ios-simulator"], referenceIds: [" primary "] })!;
  assert.deepEqual(acceptance.referenceIds, ["primary"]);
  assert.deepEqual(goalQualityRequirements({ acceptance }, []), { platforms: ["ios-simulator", "macos"], workflows: [], referenceIds: ["primary"] }, "The planner can read the mandatory template before selecting workflows");
  assert.throws(() => assertApplicationWorkflowCoverage({ acceptance }, []), /macos, ios-simulator/);
});

test("a localized backend replan preserves complete frozen UI coverage and cannot weaken references", () => {
  const acceptance = { kind: "application" as const, platforms: ["web" as const, "macos" as const], referenceIds: ["design"] };
  const retained = [{ platforms: ["macos" as const], workflows: [{ id: "draft-offline-reopen", platform: "macos" as const }], referenceIds: ["old-reference"] }];
  const backend = { key: "storage", title: "Store drafts", description: "Persist drafts", dependsOn: [], checks: [] };
  const ui = { key: "web", title: "Compose mail", description: "Compose and save drafts", dependsOn: [], checks: [], quality: { platforms: ["web" as const], workflows: [{ id: "compose-save-reopen", platform: "web" as const }], referenceIds: ["component-library"] } };
  assert.throws(() => applicationPlanTasks({ acceptance }, [backend], retained), /web/);
  const tasks = applicationPlanTasks({ acceptance }, [backend, ui], retained);
  assert.equal(tasks[0]!.quality, undefined);
  assert.deepEqual(tasks[1]!.quality!.referenceIds, ["design", "component-library"]);
  assert.deepEqual(ui.quality.referenceIds, ["component-library"], "Normalizing never mutates the provider response");
  assert.deepEqual(goalQualityRequirements({ acceptance }, [...retained, tasks[1]!.quality!])!.referenceIds, ["component-library", "design", "old-reference"]);
});
