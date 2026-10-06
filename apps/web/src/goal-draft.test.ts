import assert from 'node:assert/strict';
import test from 'node:test';
import { clearGoalDraft, goalObjective, parseGoalProposal, readGoalDraft, saveGoalDraft, type GoalDraft } from './goal-draft.ts';

test('invalid agent proposals preserve the draft; applied specifications and criteria survive storage and goal creation', () => {
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const key = 'enoughfactory.goal-draft.device.project';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => { storage.set(name, value); },
    removeItem: (name: string) => { storage.delete(name); },
  } });
  try {
    const original: GoalDraft = { title: 'Existing work', objective: 'Keep the existing objective', specification: 'Existing contract', criteria: 'Existing criterion', sessionId: 'session-1', chatId: 'chat-1' };
    let draft = { ...original };
    for (const invalid of [
      'A conversational proposal without structured JSON.', '{broken json}',
      JSON.stringify({ title: 'Only a title', criteria: ['Check it'] }),
      JSON.stringify({ objective: '   ', specification: '\n' }),
      JSON.stringify({ objective: 'New goal', criteria: 'A string is not a criteria array' }),
      JSON.stringify({ objective: 'New goal', criteria: ['Valid', 42] }),
      JSON.stringify({ objective: 'New goal', specification: { text: 'Wrong shape' } }),
      JSON.stringify({ action: 'retry', reason: 'Unrelated factory decision' }),
      JSON.stringify({ objective: 'New goal', approvalMode: 'approve-all' }),
      '```json\n{"objective":"Earlier proposal"}\n```\n```json\n{broken}\n```',
    ]) {
      const proposal = parseGoalProposal(invalid);
      if (proposal) draft = { ...draft, ...proposal };
      assert.equal(proposal, null);
      assert.deepEqual(draft, original, 'Malformed or unrelated agent output must not replace the editable contract');
    }

    const specification = '# Behavior\n\nPreserve offline work and reconnect it.\n\n## Constraints\n- Keep full container access.\n- Do not replicate chats.\n\n```ts\nconst retries = 0;\n```';
    const proposal = { title: 'Reconnect work', objective: 'Recover an interrupted device task', specification, criteria: ['Work keeps its identity', 'Captured source remains inspectable'] };
    const parsed = parseGoalProposal(`Here is the proposed contract.\n\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``);
    assert.ok(parsed);
    assert.deepEqual(parseGoalProposal(JSON.stringify(proposal)), parsed);
    draft = { ...draft, ...parsed };
    assert.equal(saveGoalDraft(key, draft), true);
    assert.deepEqual(readGoalDraft(key), draft);
    const stored = readGoalDraft(key);
    const payload = { title: stored.title, objective: goalObjective(stored), criteria: stored.criteria.split('\n').map(value => value.trim()).filter(Boolean) };
    assert.equal(payload.objective, `${proposal.objective}\n\n## Specification\n${specification}`);
    assert.deepEqual(payload.criteria, proposal.criteria);
    assert.equal(stored.sessionId, original.sessionId);
    assert.equal(stored.chatId, original.chatId);

    storage.set(key, JSON.stringify({ ...draft, credentials: 'not a draft field', title: 42 }));
    assert.deepEqual(readGoalDraft(key), { ...draft, title: '' });
    storage.set(key, '{bad saved data}');
    assert.deepEqual(readGoalDraft(key), { title: '', objective: '', specification: '', criteria: '' });
    saveGoalDraft(key, draft);
    const newer = { ...draft, specification: 'New unsent edits' };
    saveGoalDraft(key, newer);
    clearGoalDraft(key, draft);
    assert.deepEqual(readGoalDraft(key), newer, 'An earlier successful submission must not clear newer edits');
    clearGoalDraft(key, newer);
    assert.equal(storage.has(key), false);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Storage unavailable'); } });
    assert.equal(saveGoalDraft(key, draft), false);
    assert.deepEqual(readGoalDraft(key), { title: '', objective: '', specification: '', criteria: '' });
    assert.doesNotThrow(() => clearGoalDraft(key));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
