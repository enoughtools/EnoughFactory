import type { TaskOverview } from '@enoughfactory/contracts';

const HIDE_COMPLETED_KEY = 'enoughfactory.tasks.hide-completed';

export function readHideCompletedPreference(): boolean {
  try { return localStorage.getItem(HIDE_COMPLETED_KEY) !== 'false'; }
  catch { return true; }
}

export function saveHideCompletedPreference(hide: boolean): void {
  try { localStorage.setItem(HIDE_COMPLETED_KEY, String(hide)); }
  catch { /* Task filters remain usable when local preferences are unavailable. */ }
}

export function filterTaskWork(tasks: TaskOverview[], filters: { hideCompleted: boolean; kind: string; query: string }): TaskOverview[] {
  const query = filters.query.toLowerCase();
  return tasks.filter(({ task }) => (!filters.hideCompleted || task.status !== 'completed') &&
    (filters.kind === 'all' || (filters.kind === 'generic' ? !task.kind : task.kind === filters.kind)) &&
    `${task.title} ${task.description}`.toLowerCase().includes(query));
}
