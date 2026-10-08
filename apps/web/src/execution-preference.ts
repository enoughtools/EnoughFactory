import type { Device, ExecutionTargetPreference, RuntimeKind, TaskExecutionRequirements } from '@enoughfactory/contracts';
import { selectExecutionTarget } from '@enoughfactory/factory/scheduler';

/** Omitted settings are the existing container contract, not a request for automatic host placement. */
export function executionPreference(execution?: TaskExecutionRequirements): ExecutionTargetPreference {
  return execution?.target ?? 'container';
}

export function withExecutionPreference(execution: TaskExecutionRequirements | undefined, target: ExecutionTargetPreference): TaskExecutionRequirements {
  return { ...execution, target };
}

export function readyMacTarget(device: Device | undefined, execution: TaskExecutionRequirements | undefined, runtime: RuntimeKind, provider: 'git' | 'artifactfs') {
  if (!device?.executionTargets) return undefined;
  return selectExecutionTarget({ execution: withExecutionPreference(execution, 'host-macos') }, device, provider, runtime);
}

export function executionPreferenceLabel(execution?: TaskExecutionRequirements): string {
  const target = executionPreference(execution);
  return target === 'auto' ? 'Automatic' : target === 'host-macos' ? 'Mac' : 'Container';
}
