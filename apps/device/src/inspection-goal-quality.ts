import type { FactoryTask, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import type { Store } from './store.ts';

/** Keep every live requirement, using the policy that actually authorized its author. */
export function inspectionGoalQuality(store: Pick<Store, 'get' | 'list'>, goalId: string): TaskQualityRequirements | undefined {
  const requirements = store.list<FactoryTask>('tasks').filter(task => task.goalId === goalId && task.status !== 'canceled').flatMap(task => {
    const detail = task.currentAttemptId ? store.get<AttemptDetail>('factory-attempt-details', task.currentAttemptId) : undefined;
    const quality = detail?.contract ? detail.contract.quality : task.quality;
    return quality ? [quality] : [];
  });
  if (!requirements.length) return;
  return {
    platforms: [...new Set(requirements.flatMap(item => item.platforms))].sort(),
    workflows: [...new Map(requirements.flatMap(item => item.workflows).map(item => [`${item.platform}:${item.id}`, { id: item.id, platform: item.platform }])).values()]
      .sort((left, right) => `${left.platform}:${left.id}`.localeCompare(`${right.platform}:${right.id}`)),
    referenceIds: [...new Set(requirements.flatMap(item => item.referenceIds))].sort(),
  };
}
