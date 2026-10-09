import assert from 'node:assert/strict';
import test from 'node:test';
import type { FactoryTask, Goal } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import { inspectionGoalQuality } from './inspection-goal-quality.ts';

test('application final review remains mandatory before a plan and with omitted live task quality', () => {
  const goal = { id: 'goal', acceptance: { kind: 'application', platforms: ['macos', 'ios-simulator'], referenceIds: ['primary', 'enoughui'] } } as Goal;
  const tasks = [{ id: 'task', goalId: goal.id, status: 'completed', currentAttemptId: 'attempt', quality: undefined }] as FactoryTask[];
  const frozen = { contract: { quality: { platforms: ['macos'], workflows: [{ id: 'compose-close', platform: 'macos' }], referenceIds: ['retained-reference'] } } } as AttemptDetail;
  const store = {
    get<T>(table: string, id: string): T | undefined { return (table === 'goals' && id === goal.id ? goal : table === 'factory-attempt-details' ? frozen : undefined) as T | undefined; },
    list<T>(table: string): T[] { return (table === 'tasks' ? tasks : []) as T[]; },
  };
  const quality = inspectionGoalQuality(store, goal.id)!;
  assert.deepEqual(quality.platforms, ['ios-simulator', 'macos']);
  assert.deepEqual(quality.referenceIds, ['enoughui', 'primary', 'retained-reference']);
  assert.deepEqual(quality.workflows, [{ id: 'compose-close', platform: 'macos' }]);
  tasks.splice(0);
  assert.deepEqual(inspectionGoalQuality(store, goal.id), { platforms: ['ios-simulator', 'macos'], workflows: [], referenceIds: ['enoughui', 'primary'] }, 'No planner-selected task can turn off the application review gate');
  delete goal.acceptance;
  assert.equal(inspectionGoalQuality(store, goal.id), undefined, 'Existing goals without any quality policy retain their prior behavior');
});

test('editing live task quality cannot strengthen or weaken its already frozen author contract', () => {
  const task = { id: 'task', goalId: 'legacy', status: 'completed', currentAttemptId: 'attempt', quality: { platforms: ['web'], workflows: [{ id: 'new-workflow', platform: 'web' }], referenceIds: ['new-reference'] } } as FactoryTask;
  const detail = { contract: { title: 'Original author without UI policy' } } as AttemptDetail;
  const store = { get<T>(): T | undefined { return detail as T; }, list<T>(): T[] { return [task] as T[]; } };
  assert.equal(inspectionGoalQuality(store, 'legacy'), undefined);
});
