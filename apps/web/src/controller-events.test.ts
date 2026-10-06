import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatEvent } from '@enoughfactory/contracts';
import { controllerTimeline } from './controller-events';
import { parseGoalProposal } from './goal-draft';

const event = (id: string, value: Partial<ChatEvent>): ChatEvent => ({ id, chatId: 'controller', seq: 0, at: '2026-10-06T00:00:00Z', kind: 'message', ...value });

test('factory activity retains prompt and tools while coalescing live chunks and replacing final content', () => {
  const events = [
    event('instructions', { role: 'system', text: 'Factory instructions' }),
    event('prompt', { role: 'user', text: 'Plan the project' }),
    event('delta1', { role: 'assistant', text: 'Inspecting ', data: { delta: true, itemId: 'message' } }),
    event('tool', { kind: 'tool', text: 'rg --files', data: { method: 'item/started' } }),
    event('delta2', { role: 'assistant', text: 'the source', data: { delta: true, itemId: 'message' } }),
    event('output1', { kind: 'tool', text: 'app.ts\n', data: { outputDelta: true, itemId: 'command' } }),
    event('output2', { kind: 'tool', text: 'api.ts\n', data: { outputDelta: true, itemId: 'command' } }),
  ];
  const live = controllerTimeline(events);
  assert.equal(live.length, 5);
  assert.equal(live[2].text, 'Inspecting the source');
  assert.equal(live[3].id, 'tool');
  assert.equal(live[4].text, 'app.ts\napi.ts\n');
  const final = controllerTimeline([...events, event('final', { role: 'assistant', text: 'Complete plan', data: { final: true, itemId: 'message' } })]);
  assert.equal(final[2].id, 'delta1');
  assert.equal(final[2].text, 'Complete plan');
  assert.equal(final[2].data?.final, true);
  assert.equal(events[2].text, 'Inspecting ');
});

test('normal and drafting conversations retain one growing response and the authoritative usable draft', () => {
  const draft = JSON.stringify({ title: 'Project goal', objective: 'Build the workspace', specification: '## Scope\nProject workspace', criteria: ['Projects can be opened'] });
  const chunks = [event('prompt', { role: 'user', text: 'Help me write a goal' }), event('part1', { role: 'assistant', text: draft.slice(0, 35), data: { delta: true, itemId: 'draft' } }), event('part2', { role: 'assistant', text: draft.slice(35), data: { delta: true, itemId: 'draft' } })];
  const live = controllerTimeline(chunks, 'codex');
  assert.equal(live.length, 2);
  assert.equal(live[1].text, draft);
  assert.equal(live[1].data?.delta, true);
  const final = controllerTimeline([...chunks, event('draft-final', { role: 'assistant', text: draft, data: { final: true, itemId: 'draft' } })], 'codex');
  assert.equal(final.length, 2);
  assert.equal(final[1].id, 'part1');
  assert.notEqual(final[1].data?.delta, true);
  assert.equal(parseGoalProposal(final[1].text!)?.title, 'Project goal');
});

test('reused item identities stay separate across user turns and late chunks cannot replace final text', () => {
  const events = [event('prompt1', { role: 'user', text: 'First turn' }), event('first-chunk', { role: 'assistant', text: 'One ', data: { delta: true, itemId: 'reused' } }), event('first-final', { role: 'assistant', text: 'One complete', data: { final: true, itemId: 'reused' } }), event('late-chunk', { role: 'assistant', text: 'duplicate', data: { delta: true, itemId: 'reused' } }), event('prompt2', { role: 'user', text: 'Second turn' }), event('second-chunk', { role: 'assistant', text: 'Two ', data: { delta: true, itemId: 'reused' } }), event('second-final', { role: 'assistant', text: 'Two complete', data: { final: true, itemId: 'reused' } })];
  const timeline = controllerTimeline(events, 'codex');
  assert.equal(timeline.length, 4);
  assert.deepEqual(timeline.filter(item => item.role === 'assistant').map(item => [item.id, item.text]), [['first-chunk', 'One complete'], ['second-chunk', 'Two complete']]);
});

test('Antigravity CLI aggregate final replaces step partials while tool lifecycle retains one row', () => {
  const events = [event('prompt', { role: 'user', text: 'Inspect the project' }), event('step1', { role: 'assistant', text: 'First step ', data: { delta: true, itemId: 'step-0' } }), event('tool-start', { kind: 'tool', text: 'rg --files', data: { method: 'item/started', item: { id: 'command' } } }), event('step2', { role: 'assistant', text: 'second step', data: { delta: true, itemId: 'step-1' } }), event('tool-complete', { kind: 'tool', text: 'rg --files', data: { method: 'item/completed', item: { id: 'command', exitCode: 0 } } }), event('aggregate', { role: 'assistant', text: 'Authoritative response', data: { final: true, itemId: 'response' } })];
  const timeline = controllerTimeline(events, 'antigravity');
  assert.equal(timeline.length, 3);
  assert.equal(timeline[1].text, 'Authoritative response');
  assert.equal(timeline[2].id, 'tool-start');
  assert.equal(timeline[2].data?.method, 'item/completed');
});
