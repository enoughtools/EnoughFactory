import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { goalAgentCount } from './factory-agent-capacity.ts';
import { Store } from './store.ts';

const goalId = 'mail-goal';

/** Capacity comes from durable ownership claims, including the gap before a chat exists. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ef-goal-agent-capacity-'));
  let store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    reopen() { store.close(); store = new Store(directory); },
    count(exclude: string[] = [], includeWorkers = true) { return goalAgentCount(store, goalId, exclude, includeWorkers); },
    chat(id: string, status: string) { store.set('chats', { id, status }); },
    worker(id: string, status: string, chatId?: string, selectedGoal = goalId) {
      store.set('factory-workers', { id, goal: { id: selectedGoal }, attempt: { id }, status, ...(chatId ? { chatId } : {}) });
    },
    attempt(id: string, status: string, options: { current?: boolean; goalId?: string; chatId?: string } = {}) {
      const taskId = `task-${id}`;
      store.set('tasks', { id: taskId, goalId: options.goalId ?? goalId, currentAttemptId: options.current === false ? `successor-${id}` : id });
      store.set('attempts', { id, taskId, status, ...(options.chatId ? { chatId: options.chatId } : {}) });
    },
    input(id: string, status: string, selectedGoal = goalId) {
      store.set('factory-controller-inputs', { id, goalId: selectedGoal, role: 'evaluator', status });
    },
    controller(id: string, status: string, chatId?: string, selectedGoal = goalId) {
      store.set('factory-controller-runs', { id, goalId: selectedGoal, role: 'evaluator', status, ...(chatId ? { chatId } : {}) });
    },
    verifier(id: string, status: string, chatId?: string, selectedGoal = goalId) {
      store.set('inspection-verifier-runs', { id, authority: { goalId: selectedGoal }, status, ...(chatId ? { chatId } : {}) });
    },
    audit(id: string, status: string, fields: { chatId?: string; providerUnresolved?: boolean; retirementStatus?: string; goalId?: string } = {}) {
      const { goalId: selectedGoal, ...rest } = fields;
      store.set('inspection-profile-audits', { id, authority: { goalId: selectedGoal ?? goalId }, status, ...rest });
    },
  };
}

test('a one-agent goal reserves controller preparation before its provider chat exists', async t => {
  const f = await fixture(t);
  f.input('controller-A', 'preparing');
  assert.equal(f.count(), 1, 'An audit cannot enter the only slot during controller input preparation');
  f.input('controller-A', 'prepared');
  assert.equal(f.count(), 1);
  f.controller('controller-A', 'starting');
  assert.equal(f.count(), 1, 'The input journal and its starting run are the same actor');
  f.controller('controller-A', 'running', 'controller-chat');
  f.chat('controller-chat', 'running');
  assert.equal(f.count(), 1);
  f.chat('controller-chat', 'waiting');
  assert.equal(f.count(), 1, 'A provider awaiting input still owns its process slot');
  f.chat('controller-chat', 'idle');
  assert.equal(f.count(), 0, 'A completed turn releases the slot even if controller evidence review continues');
  f.controller('controller-A', 'waiting', 'controller-chat');
  assert.equal(f.count(), 0, 'The old prepared input journal does not resurrect a waiting controller');
  f.controller('controller-A', 'completed', 'controller-chat');
  assert.equal(f.count(), 0);
});

test('pre-chat verifier claims block the only audit slot and waiting verification releases it', async t => {
  const f = await fixture(t);
  f.verifier('verifier-A', 'queued');
  assert.equal(f.count(), 0);
  f.verifier('verifier-A', 'preparing');
  assert.equal(f.count(), 1, 'Preparation is a durable admission claim before chat creation');
  f.verifier('verifier-A', 'running');
  assert.equal(f.count(), 1);
  f.verifier('verifier-A', 'unknown');
  assert.equal(f.count(), 1, 'Uncertain verifier dispatch is not permission to overbook');
  f.verifier('verifier-A', 'waiting');
  assert.equal(f.count(), 0);
  for (const status of ['succeeded', 'failed', 'canceled']) {
    f.verifier('verifier-A', status);
    assert.equal(f.count(), 0, `Terminal verifier status ${status} releases its slot`);
  }
});

test('an admitted audit blocks controller and verifier admission until its provider ends', async t => {
  const f = await fixture(t);
  f.audit('audit-A', 'queued');
  assert.equal(f.count(), 0);
  f.audit('audit-A', 'preparing');
  assert.equal(f.count(), 1, 'A controller or verifier sees the pre-chat audit claim');
  assert.equal(f.count(['audit:audit-A']), 0, 'Only the admitted audit may discount its own claim');
  f.audit('audit-A', 'running', { chatId: 'audit-chat' });
  f.chat('audit-chat', 'idle');
  assert.equal(f.count(), 1, 'The audit journal remains authoritative while dispatch is in flight');
  f.audit('audit-A', 'unknown', { chatId: 'audit-chat', providerUnresolved: true });
  assert.equal(f.count(), 1);
  f.audit('audit-A', 'waiting');
  assert.equal(f.count(), 0);
  for (const status of ['configured', 'rejected', 'canceled']) {
    f.audit('audit-A', status);
    assert.equal(f.count(), 0);
  }
});

test('unknown audit claims distinguish unresolved providers from cleanup-only uncertainty', async t => {
  const f = await fixture(t);
  f.audit('audit-A', 'unknown');
  assert.equal(f.count(), 0, 'A failed pre-dispatch setup has no provider slot to preserve');
  f.audit('audit-A', 'unknown', { providerUnresolved: true });
  assert.equal(f.count(), 1, 'Lost chat identity does not erase a recorded unresolved dispatch');
  f.audit('audit-A', 'unknown', { chatId: 'retained-chat' });
  f.chat('retained-chat', 'idle');
  assert.equal(f.count(), 1, 'Idle UI status alone does not prove an unknown provider terminated');
  f.audit('audit-A', 'unknown', { chatId: 'retained-chat', retirementStatus: 'configured', providerUnresolved: false });
  assert.equal(f.count(), 0, 'Source-retention cleanup does not keep occupying a provider slot');
  f.audit('audit-A', 'unknown', { chatId: 'retained-chat', retirementStatus: 'configured', providerUnresolved: true });
  assert.equal(f.count(), 1, 'Cleanup metadata cannot overrule an explicit unresolved provider');
});

test('workers and their current orphan attempts each reserve one slot across preparation and uncertainty', async t => {
  const f = await fixture(t);
  for (const status of ['preparing', 'prepared', 'running', 'unknown']) {
    f.worker('author-A', status);
    f.attempt('author-A', 'running');
    assert.equal(f.count(), 1, `Worker ${status} and its attempt represent one actor`);
  }
  for (const status of ['succeeded', 'failed', 'canceled']) {
    f.worker('author-A', status);
    assert.equal(f.count(), 0, 'A journaled terminal worker is not resurrected by an older attempt record');
  }
  f.store.delete('factory-workers', 'author-A');
  for (const status of ['created', 'running', 'unknown']) {
    f.attempt('author-A', status);
    assert.equal(f.count(), 1, `Current orphan attempt ${status} still reserves the slot`);
  }
  f.attempt('author-A', 'unknown', { current: false });
  assert.equal(f.count(), 0, 'A superseded attempt cannot reserve its successor\'s slot');
  for (const status of ['succeeded', 'failed', 'retired']) {
    f.attempt('author-A', status);
    assert.equal(f.count(), 0);
  }
});

test('one provider chat is counted once across journals while exact actor exclusion preserves other owners', async t => {
  const f = await fixture(t);
  f.chat('shared-chat', 'running');
  f.worker('author-A', 'running', 'shared-chat');
  f.attempt('author-A', 'running', { chatId: 'shared-chat' });
  f.controller('controller-A', 'running', 'shared-chat');
  f.verifier('verifier-A', 'running', 'shared-chat');
  f.audit('audit-A', 'running', { chatId: 'shared-chat' });
  assert.equal(f.count(), 1, 'Duplicated durable markers do not imply four provider processes');
  assert.equal(f.count(['audit:audit-A']), 1, 'Excluding one actor cannot hide another actor sharing its chat');
  assert.equal(f.count(['worker:author-A', 'controller:controller-A', 'verifier:verifier-A', 'audit:audit-A']), 0);
  assert.equal(f.count([], false), 1, 'Ignoring worker ownership still counts the other lanes');
});

test('retained worker chat aliases deduplicate transitive provider ownership without hiding a separate provider', async t => {
  const f = await fixture(t);
  f.worker('author-A', 'unknown', 'worker-chat');
  f.attempt('author-A', 'unknown', { chatId: 'attempt-chat' });
  f.verifier('verifier-A', 'unknown', 'attempt-chat');
  f.audit('audit-A', 'unknown', { chatId: 'worker-chat' });
  f.controller('controller-A', 'starting', 'separate-chat');
  assert.equal(f.count(), 2, 'Two aliases of one provider plus an independent controller occupy two slots');
  assert.equal(f.count(['worker:author-A']), 3, 'Removing the connecting actor leaves three independently claimed providers');
  assert.equal(f.count(['controller:controller-A']), 1);
});

test('distinct actors reserve distinct slots and actor exclusions are scoped to their lane', async t => {
  const f = await fixture(t);
  f.worker('same-id', 'preparing');
  f.input('same-id', 'prepared');
  f.verifier('same-id', 'preparing');
  f.audit('same-id', 'preparing');
  assert.equal(f.count(), 4);
  assert.equal(f.count(['audit:same-id']), 3);
  assert.equal(f.count(['same-id']), 4, 'Raw IDs do not accidentally exclude every lane');
  assert.equal(f.count([], false), 3);
  assert.equal(f.count(['controller:same-id', 'verifier:same-id', 'audit:same-id'], false), 0);
});

test('worker suppression removes orphan attempt ownership without removing inspection or controller claims', async t => {
  const f = await fixture(t);
  f.worker('worker-A', 'unknown');
  f.attempt('orphan-A', 'unknown');
  f.controller('controller-A', 'starting');
  f.verifier('verifier-A', 'preparing');
  f.audit('audit-A', 'preparing');
  assert.equal(f.count(), 5);
  assert.equal(f.count([], false), 3);
  assert.equal(f.count(['controller:controller-A'], false), 2);
});

test('foreign goals and detached attempts cannot consume this goal\'s capacity', async t => {
  const f = await fixture(t);
  f.worker('foreign-worker', 'running', undefined, 'another-goal');
  f.attempt('foreign-attempt', 'created', { goalId: 'another-goal' });
  f.input('foreign-input', 'preparing', 'another-goal');
  f.controller('foreign-controller', 'starting', undefined, 'another-goal');
  f.verifier('foreign-verifier', 'preparing', undefined, 'another-goal');
  f.audit('foreign-audit', 'unknown', { providerUnresolved: true, goalId: 'another-goal' });
  f.store.set('attempts', { id: 'detached', taskId: 'missing-task', status: 'unknown' });
  assert.equal(f.count(), 0);
  f.audit('local-audit', 'preparing');
  assert.equal(f.count(), 1);
});

test('service restart preserves uncertain ownership until durable terminal transitions free it', async t => {
  const f = await fixture(t);
  f.worker('author-A', 'unknown', 'author-chat');
  f.chat('author-chat', 'idle');
  f.controller('controller-A', 'unknown', 'controller-chat');
  f.chat('controller-chat', 'idle');
  f.verifier('verifier-A', 'unknown');
  f.audit('audit-A', 'unknown', { providerUnresolved: true });
  assert.equal(f.count(), 4);
  f.reopen();
  assert.equal(f.count(), 4, 'A new service process must observe the same unresolved reservations');
  f.worker('author-A', 'succeeded', 'author-chat');
  f.controller('controller-A', 'completed', 'controller-chat');
  f.verifier('verifier-A', 'waiting');
  f.audit('audit-A', 'configured');
  assert.equal(f.count(), 0);
});

test('controller dispatch uncertainty reserves capacity even before its chat is durably recorded', async t => {
  const f = await fixture(t);
  f.controller('controller-A', 'unknown');
  assert.equal(f.count(), 1);
  f.controller('controller-A', 'completed');
  assert.equal(f.count(), 0);
  f.store.set('factory-controller-runs', { id: 'controller-A', goalId, status: 'completed', providerUnresolved: true });
  assert.equal(f.count(), 1, 'A terminal UI label cannot erase explicit unresolved dispatch ownership');
});
