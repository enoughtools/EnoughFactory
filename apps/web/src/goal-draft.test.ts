import assert from 'node:assert/strict';
import test from 'node:test';
import { clearGoalDraft, goalAcceptance, goalAcceptanceError, goalObjective, parseGoalProposal, readGoalDraft, saveGoalDraft, type GoalDraft } from './goal-draft.ts';

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

test('application choices survive draft storage and assistant proposals without becoming agent-editable', () => {
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const key = 'enoughfactory.goal-draft.device.application';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => { storage.set(name, value); },
    removeItem: (name: string) => { storage.delete(name); },
  } });
  try {
    const draft: GoalDraft = { title: 'Mail', objective: 'Build the mail app', specification: '', criteria: 'Drafts can be reopened', workType: 'application', applicationPlatforms: ['web', 'macos'], designReferenceIds: ['primary', 'design-folder-id'] };
    assert.equal(saveGoalDraft(key, draft), true);
    assert.deepEqual(readGoalDraft(key), draft);
    const proposal = parseGoalProposal(JSON.stringify({ title: 'Mail drafts', objective: 'Build a mail app with recoverable drafts', criteria: ['Drafts persist after closing the window'] }));
    assert.ok(proposal);
    const revised = { ...readGoalDraft(key), ...proposal };
    const expected = { kind: 'application', platforms: ['web', 'macos'], referenceIds: ['primary', 'design-folder-id'] };
    assert.deepEqual(goalAcceptance(revised), expected);
    assert.equal(goalAcceptanceError(revised, ['primary', 'design-folder-id']), null);
    assert.equal(saveGoalDraft(key, revised), true);
    assert.deepEqual(goalAcceptance(readGoalDraft(key)), expected);

    for (const choices of [
      { workType: 'other' }, { applicationPlatforms: ['web'] }, { designReferenceIds: [] },
      { acceptance: { kind: 'application', platforms: ['web'], referenceIds: [] } },
    ]) {
      assert.equal(parseGoalProposal(JSON.stringify({ objective: 'A proposal cannot change acceptance', ...choices })), null);
    }

    const other: GoalDraft = { ...revised, workType: 'other' };
    assert.equal(saveGoalDraft(key, other), true);
    const restored = readGoalDraft(key);
    assert.deepEqual(restored, other);
    assert.equal(goalAcceptance(restored), undefined, 'Other work must omit application acceptance from its goal payload');
    assert.deepEqual(goalAcceptance({ ...restored, workType: 'application' }), expected, 'Switching work type retains the user’s application choices');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('legacy drafts use explicit application defaults and stale reference selections block creation', () => {
  const legacy: GoalDraft = { title: '', objective: 'Update the server', specification: '', criteria: '' };
  assert.deepEqual(goalAcceptance(legacy), { kind: 'application', platforms: ['web'], referenceIds: ['primary'] }, 'Defaults do not depend on the objective text');
  assert.equal(goalAcceptanceError(legacy, ['primary', 'arbitrary-sibling-folder']), null);
  assert.match(goalAcceptanceError({ ...legacy, applicationPlatforms: [] }, ['primary']) ?? '', /Choose at least one platform/);
  const missingReference = { ...legacy, designReferenceIds: ['primary', 'removed-folder-id'] };
  assert.match(goalAcceptanceError(missingReference, ['primary', 'replacement-folder-id']) ?? '', /Remove it below or reattach it/);
  assert.equal(goalAcceptanceError(missingReference, ['primary', 'removed-folder-id']), null, 'Stable folder identity remains valid independently of its display name');
  assert.equal(goalAcceptanceError({ ...missingReference, workType: 'other', applicationPlatforms: [] }, ['primary']), null);
  assert.deepEqual(goalAcceptance({ ...legacy, designReferenceIds: [] })?.referenceIds, [], 'An explicit empty reference selection stays empty');
});
