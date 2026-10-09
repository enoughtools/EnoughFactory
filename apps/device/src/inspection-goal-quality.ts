import type { FactoryTask, Goal, TaskQualityRequirements } from '@enoughfactory/contracts';
import { goalQualityRequirements, type AttemptDetail } from '@enoughfactory/factory';
import type { Store } from './store.ts';

/** Keep every live requirement, using the policy that actually authorized its author. */
export function inspectionGoalQuality(store: Pick<Store, 'get' | 'list'>, goalId: string): TaskQualityRequirements | undefined {
  const requirements = store.list<FactoryTask>('tasks').filter(task => task.goalId === goalId && task.status !== 'canceled').flatMap(task => {
    const detail = task.currentAttemptId ? store.get<AttemptDetail>('factory-attempt-details', task.currentAttemptId) : undefined;
    const quality = detail?.contract ? detail.contract.quality : task.quality;
    return quality ? [quality] : [];
  });
  return goalQualityRequirements(store.get<Goal>('goals', goalId) ?? {}, requirements);
}
