import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskOverview } from '@enoughfactory/contracts';
import { filterTaskWork, readHideCompletedPreference, saveHideCompletedPreference } from './task-work-filter';

test('completed filtering composes with search and task type while preserving canceled work and source records', () => {
  const overview: TaskOverview[] = [
    { task: { id: 'accepted', goalId: 'goal', title: 'Mail domain', description: '', kind: 'feature', status: 'completed', dependsOn: [], createdAt: '', updatedAt: '' }, state: 'accepted' },
    { task: { id: 'canceled', goalId: 'goal', title: 'Mail old plan', description: '', kind: 'feature', status: 'canceled', dependsOn: [], createdAt: '', updatedAt: '' }, state: 'canceled' },
    { task: { id: 'working', goalId: 'goal', title: 'Mail interface', description: '', kind: 'unit', status: 'running', dependsOn: ['accepted'], createdAt: '', updatedAt: '' }, state: 'executing' },
  ];
  const before = structuredClone(overview);
  assert.deepEqual(filterTaskWork(overview, { hideCompleted: true, kind: 'all', query: '' }).map(item => item.task.id), ['canceled', 'working']);
  assert.deepEqual(filterTaskWork(overview, { hideCompleted: false, kind: 'feature', query: 'MAIL' }).map(item => item.task.id), ['accepted', 'canceled']);
  assert.deepEqual(filterTaskWork(overview, { hideCompleted: true, kind: 'feature', query: 'domain' }), []);
  assert.deepEqual(overview, before, 'Filtering must not change task status, prerequisites, totals or records used for inspection.');
});

test('hide completed defaults on and remembers an explicit choice without requiring storage access', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    assert.equal(readHideCompletedPreference(), true);
    saveHideCompletedPreference(false);
    assert.equal(readHideCompletedPreference(), false);
    saveHideCompletedPreference(true);
    assert.equal(readHideCompletedPreference(), true);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Unavailable'); } });
    assert.equal(readHideCompletedPreference(), true);
    assert.doesNotThrow(() => saveHideCompletedPreference(false));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
