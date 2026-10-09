import type { Goal, TaskQualityRequirements } from "@enoughfactory/contracts";
import type { PlannedTask } from "./types.js";
import { FactoryDecisionError } from "./errors.js";
import { validateTaskQuality } from "./protocol.js";

/** The template remains inspectable before the planner has named its workflows. */
export function goalQualityRequirements(goal: Pick<Goal, "acceptance">, requirements: TaskQualityRequirements[]): TaskQualityRequirements | undefined {
  if (!goal.acceptance && !requirements.length) return;
  return {
    platforms: [...new Set([...(goal.acceptance?.platforms ?? []), ...requirements.flatMap(item => item.platforms)])].sort(),
    workflows: [...new Map(requirements.flatMap(item => item.workflows).map(item => [`${item.platform}:${item.id}`, { id: item.id, platform: item.platform }])).values()]
      .sort((left, right) => `${left.platform}:${left.id}`.localeCompare(`${right.platform}:${right.id}`)),
    referenceIds: [...new Set([...(goal.acceptance?.referenceIds ?? []), ...requirements.flatMap(item => item.referenceIds)])].sort(),
  };
}

/** Empty policies cannot turn a requested application into build-only acceptance. */
export function assertApplicationWorkflowCoverage(goal: Pick<Goal, "acceptance">, requirements: TaskQualityRequirements[]): void {
  if (!goal.acceptance) return;
  const missing = goal.acceptance.platforms.filter(platform => !requirements.some(quality => quality.platforms.includes(platform) && quality.workflows.some(workflow => workflow.platform === platform)));
  if (missing.length) throw new FactoryDecisionError(`Application acceptance needs representative workflow quality policies for ${missing.join(", ")}. Declare observable user journeys on UI implementation or final delivery tasks; backend and architecture tasks can remain independent.`);
}

/** Inherit required references before author authority freezes the task contract. */
export function applicationPlanTasks(goal: Pick<Goal, "acceptance">, tasks: PlannedTask[], retained: TaskQualityRequirements[]): PlannedTask[] {
  if (!goal.acceptance) return tasks;
  const normalized = tasks.map(task => {
    if (!task.quality) return task;
    const quality = validateTaskQuality({ ...task.quality, referenceIds: [...new Set([...goal.acceptance!.referenceIds, ...task.quality.referenceIds])] })!;
    const missing = quality.platforms.filter(platform => !quality.workflows.some(workflow => workflow.platform === platform));
    if (missing.length) throw new FactoryDecisionError(`Task ${task.key} needs representative user workflows for its quality platforms: ${missing.join(", ")}.`);
    return { ...task, quality };
  });
  assertApplicationWorkflowCoverage(goal, [...retained, ...normalized.flatMap(task => task.quality ? [task.quality] : [])]);
  return normalized;
}
