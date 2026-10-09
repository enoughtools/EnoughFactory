import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { BrowserLease, BrowserObservation } from '@enoughfactory/browser-inspection';
import type { InspectionAuthority } from '@enoughfactory/contracts';
import { parseBrowserObservation } from './inspection-browser-observation.ts';
import { beginBrowserFormObservation, browserFormValueFunction, browserPageIdentityFunction, completeBrowserFormObservation, type BrowserFormBinding } from './inspection-browser-values.ts';

const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 12, taskId: 'task', attemptId: 'attempt', authorityGeneration: 3, policyRevision: 12 };
const binding: BrowserFormBinding = { backendSessionId: 'owned-browser', sourceSha256: 'a'.repeat(64), authority };
const href = 'http://127.0.0.1:4318/mail', timeOrigin = 1_777_000_000_000;
const supported = ['browser_tabs', 'browser_evaluate'];
const snapshot = (yaml = '- textbox "Body" [ref=e8]: first middle last\n- button "Close draft" [ref=e9]') => `- Page URL: ${href}\n### Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\`\n`;
const result = (value: unknown) => ({ content: [{ type: 'text', text: `### Result\n${JSON.stringify(value)}\n### Ran Playwright code\nA fixed service function was evaluated.\n` }] });
function lease(): BrowserLease {
  return { id: binding.backendSessionId, sessionId: 'author-session', goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId,
    authorityGeneration: authority.authorityGeneration, source: { snapshotSha256: binding.sourceSha256 }, version: 1, name: 'Owned browser', authorContainerId: 'container',
    image: { image: 'fixture', baseImage: 'fixture', platform: 'linux/amd64', recipeSha256: 'b'.repeat(64), nodeVersion: 'fixture', playwrightVersion: 'fixture', mcpVersion: 'fixture',
      browserRevision: 'fixture', chromiumVersion: 'fixture', executablePath: '/fixture/chromium', nodePath: '/fixture/node', mcpCliPath: '/fixture/mcp', playwrightPackagePath: '/fixture/playwright' },
    port: 3000, endpoint: 'http://127.0.0.1:3000', state: 'ready', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    lastUsedAt: '2026-10-09T00:00:00.000Z', idleDeadline: '2026-10-09T00:20:00.000Z', artifacts: [] };
}
type Call = { tool: string; args: Record<string, unknown> };
function fixture(values: Record<string, unknown> = { e8: 'first\nmiddle\nlast' }, change?: (request: Call, observation: BrowserObservation, index: number) => BrowserObservation) {
  const calls: Call[] = [];
  const call = async (tool: string, args: Record<string, unknown>): Promise<BrowserObservation> => {
    const request = { tool, args }; calls.push(request);
    const response = tool === 'browser_tabs' ? { content: [{ type: 'text', text: `### Result\n- 0: (current) [EnoughMail](${href})\n- 1: [Other](http://127.0.0.1:4318/other)\n` }] }
      : args.function === browserPageIdentityFunction ? result({ version: 1, href, timeOrigin })
      : result({ version: 1, href, timeOrigin, connected: true, tag: 'textarea', value: values[String(args.target)] });
    const observation: BrowserObservation = { lease: lease(), result: response, artifacts: [], event: { tool, operationId: `read-${calls.length}`, content: response.content, artifactIds: [] } };
    return change ? change(request, observation, calls.length - 1) : observation;
  };
  return { calls, call };
}

test('exact browser form evidence replaces flattened snapshot text with the complete observed DOM string', async t => {
  for (const value of ['first\nmiddle\nlast', '', 'first\r\nmiddle\r\nlast', '  first\n\n middle\nlast \t']) await t.test(JSON.stringify(value), async () => {
    const f = fixture({ e8: value }), text = snapshot(), parsed = parseBrowserObservation(text), before = structuredClone(parsed);
    assert.equal(parsed.elements[0]!.value, 'first middle last');
    const frame = await beginBrowserFormObservation(binding, supported, f.call);
    const observed = await completeBrowserFormObservation(frame, parsed, text, f.call);
    assert.equal(observed.elements[0]!.value, value); assert.equal(observed.raw.complete, true);
    assert.equal(observed.observationCurrent, true);
    assert.equal(observed.raw.snapshotSha256, createHash('sha256').update(text).digest('hex'));
    assert.deepEqual(observed.elements[1], parsed.elements[1]); assert.deepEqual(parsed, before, 'Recording exact evidence cannot mutate the original snapshot projection');
    const request = f.calls.find(call => call.args.function === browserFormValueFunction)!;
    assert.deepEqual(request.args, { target: 'e8', element: 'Body', function: browserFormValueFunction });
    assert.equal(f.calls.length, 5, 'The owned current tab and document are checked before and after the field read');
  });
});

test('browser form evidence rejects another lease, source or author authority at the exact field read', async t => {
  const changes: Array<[string, Partial<BrowserLease>]> = [['browser', { id: 'other-browser' }], ['source', { source: { snapshotSha256: 'c'.repeat(64) } }],
    ['goal', { goalId: 'other-goal' }], ['task', { taskId: 'other-task' }], ['attempt', { attemptId: 'other-attempt' }], ['generation', { authorityGeneration: 4 }]];
  for (const [name, patch] of changes) await t.test(name, async () => {
    const f = fixture(undefined, (request, observation) => request.args.function === browserFormValueFunction ? { ...observation, lease: { ...observation.lease, ...patch } } : observation);
    const text = snapshot(), frame = await beginBrowserFormObservation(binding, supported, f.call);
    const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
    assert.equal(observed.raw.complete, false); assert.equal(observed.elements[0]!.value, undefined);
    assert.equal(observed.observationCurrent, false);
    assert.match(observed.raw.reason!, /another browser\/source authority/);
  });
});

test('browser form evidence fails closed on changed document, current tab or disconnected field', async t => {
  for (const change of ['snapshot-url', 'field-url', 'field-time-origin', 'disconnected', 'after-url', 'after-time-origin', 'after-tab', 'ambiguous-tabs'] as const) await t.test(change, async () => {
    const f = fixture(undefined, (request, observation, index) => {
      if (request.args.function === browserFormValueFunction && ['field-url', 'field-time-origin', 'disconnected'].includes(change)) return { ...observation, result: result({ version: 1, href: change === 'field-url' ? href + '?other' : href,
        timeOrigin: change === 'field-time-origin' ? timeOrigin + 1 : timeOrigin, connected: change !== 'disconnected', tag: 'textarea', value: 'first\nmiddle\nlast' }) };
      if (index === 4 && ['after-url', 'after-time-origin'].includes(change)) return { ...observation, result: result({ version: 1, href: change === 'after-url' ? href + '?other' : href, timeOrigin: change === 'after-time-origin' ? timeOrigin + 1 : timeOrigin }) };
      if (index === 3 && change === 'after-tab') return { ...observation, result: { content: [{ type: 'text', text: `### Result\n- 1: (current) [EnoughMail](${href})\n` }] } };
      if (index === 0 && change === 'ambiguous-tabs') return { ...observation, result: { content: [{ type: 'text', text: `### Result\n- 0: (current) [Mail](${href})\n- 1: (current) [Other](${href})\n` }] } };
      return observation;
    });
    const text = change === 'snapshot-url' ? snapshot().replace(`- Page URL: ${href}`, `- Page URL: ${href}?other`) : snapshot();
    const frame = await beginBrowserFormObservation(binding, supported, f.call);
    const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
    assert.equal(observed.raw.complete, false); assert.equal(observed.elements[0]!.value, undefined); assert.ok(observed.raw.reason);
    if (change !== 'ambiguous-tabs') assert.equal(observed.observationCurrent, false, 'An actual document/field/tab mismatch invalidates structural evidence as well as exact values');
    if (change.startsWith('after-')) assert.equal(f.calls.length, 5, 'The field read must succeed before this test exercises the final page fence');
  });
});

test('missing, malformed and excessive DOM results discard the old snapshot scalar rather than claim exact evidence', async t => {
  for (const change of ['missing-result', 'malformed-json', 'duplicate-result', 'nonobject-result', 'tool-error', 'missing-value', 'unsupported-tag', 'overbound-value', 'overbound-result', 'shared-bound'] as const) await t.test(change, async () => {
    const tooLarge = 'x'.repeat(65_537), tooLargeResult = 'x'.repeat(300_000);
    const f = fixture({ e8: 'x'.repeat(32_769), e10: 'y'.repeat(32_769) }, (request, observation) => {
      if (request.args.function !== browserFormValueFunction) return observation;
      if (change === 'missing-result') return { ...observation, result: { content: [{ type: 'text', text: 'No confirmed DOM value' }] } };
      if (change === 'malformed-json') return { ...observation, result: { content: [{ type: 'text', text: '### Result\n{' }] } };
      if (change === 'duplicate-result') return { ...observation, result: { content: [{ type: 'text', text: '### Result\n{}\n### Result\n{}' }] } };
      if (change === 'nonobject-result') return { ...observation, result: result(['first', 'middle', 'last']) };
      if (change === 'tool-error') return { ...observation, result: { ...observation.result, isError: true } };
      if (change === 'missing-value') return { ...observation, result: result({ version: 1, href, timeOrigin, connected: true, tag: 'textarea' }) };
      if (change === 'unsupported-tag') return { ...observation, result: result({ version: 1, href, timeOrigin, connected: true, tag: 'div', value: 'old snapshot scalar' }) };
      if (change === 'overbound-value' || change === 'overbound-result') return { ...observation, result: result({ version: 1, href, timeOrigin, connected: true, tag: 'textarea', value: change === 'overbound-value' ? tooLarge : tooLargeResult }) };
      return observation;
    });
    const text = snapshot('- textbox "Body" [ref=e8]: old snapshot scalar\n- textbox "Subject" [ref=e10]: another old scalar');
    const frame = await beginBrowserFormObservation(binding, supported, f.call);
    const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
    assert.equal(observed.raw.complete, false); assert.ok(observed.raw.reason);
    assert.equal(observed.observationCurrent, true, 'Unavailable field values do not invalidate structural evidence when the owned before/after document remains confirmed');
    assert.ok(observed.elements.every(element => element.value === undefined), 'A partially successful exact read cannot leave old snapshot values or partially published form evidence');
    if (change === 'overbound-result') {
      const omitted = observed.raw.reads.find(read => read.stage === 'field:e8')!;
      assert.equal(omitted.result, undefined); assert.match(omitted.omittedSha256!, /^[a-f0-9]{64}$/); assert.ok(omitted.omittedBytes! > 256 * 1024);
    }
  });
});

test('unavailable exact browser tools or missing original references never preserve snapshot values', async t => {
  for (const tools of [[], ['browser_tabs'], ['browser_evaluate']]) await t.test(JSON.stringify(tools), async () => {
    const f = fixture(), text = snapshot(), frame = await beginBrowserFormObservation(binding, tools, f.call);
    const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
    assert.equal(f.calls.length, 0); assert.equal(observed.raw.complete, false); assert.equal(observed.elements[0]!.value, undefined);
  });
  const f = fixture(), text = snapshot('- textbox "Body": old snapshot scalar');
  const frame = await beginBrowserFormObservation(binding, supported, f.call);
  const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
  assert.equal(observed.raw.complete, false); assert.equal(observed.elements[0]!.value, undefined);
  assert.equal(observed.observationCurrent, true);
  assert.equal(f.calls.filter(call => call.args.function === browserFormValueFunction).length, 0);
});

test('password and hidden fields are excluded while ordinary observed values remain exact', async () => {
  const f = fixture({ e8: 'complete\noriginal\nbody' }, (request, observation) => request.args.target === 'e11' ? { ...observation, result: result({ version: 1, href, timeOrigin, connected: true, tag: 'input', type: 'password', excluded: true }) } : observation);
  const text = snapshot('- textbox "Body" [ref=e8]: flattened body\n- textbox "Password" [ref=e11]: old secret');
  const frame = await beginBrowserFormObservation(binding, supported, f.call);
  const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
  assert.equal(observed.elements[0]!.value, 'complete\noriginal\nbody'); assert.equal(observed.elements[1]!.value, undefined);
  assert.equal(observed.raw.complete, false); assert.match(observed.raw.reason!, /Secure fields are excluded/);
  assert.equal(observed.observationCurrent, true);
  const ownerDocument = { URL: href, defaultView: { performance: { timeOrigin } } };
  class Input {
    tagName = 'INPUT'; isConnected = true; ownerDocument = ownerDocument;
    constructor(readonly type: string) {}
    get value(): never { throw new Error('A secure field value must never be accessed'); }
  }
  class TextArea {} class Select {}
  const read = runInNewContext(`(${browserFormValueFunction})`, { HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: Select }) as (element: Input) => { excluded?: boolean; value?: string };
  for (const type of ['password', 'hidden']) { const result = read(new Input(type)); assert.equal(result.excluded, true); assert.equal(result.value, undefined); }
});

test('DOM evaluation uses a fixed service-owned function without author expected text or executable field data', async () => {
  const expected = 'Distinctive author requirement\nwith exact last line';
  const f = fixture({ e8: expected }), text = snapshot(), frame = await beginBrowserFormObservation(binding, supported, f.call);
  const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
  assert.equal(observed.elements[0]!.value, expected);
  for (const request of f.calls) {
    assert.equal(Object.values(request.args).some(value => typeof value === 'string' && value.includes(expected)), false);
    if (request.tool === 'browser_evaluate') assert.ok([browserPageIdentityFunction, browserFormValueFunction].includes(String(request.args.function)));
  }
});

test('page and foreign-lease fences apply to snapshots with no editable fields', async t => {
  for (const change of ['after-url', 'after-tab', 'before-lease', 'after-lease'] as const) await t.test(change, async () => {
    const f = fixture(undefined, (request, observation, index) => {
      if (change === 'before-lease' && index === 0 || change === 'after-lease' && index === 2) return { ...observation, lease: { ...observation.lease, id: 'other-browser' } };
      if (change === 'after-tab' && index === 2) return { ...observation, result: { content: [{ type: 'text', text: `### Result\n- 1: (current) [Mail](${href})\n` }] } };
      if (change === 'after-url' && index === 3) return { ...observation, result: result({ version: 1, href: href + '?other', timeOrigin }) };
      return observation;
    });
    const text = snapshot('- heading "Inbox" [ref=e1]'), frame = await beginBrowserFormObservation(binding, supported, f.call);
    const observed = await completeBrowserFormObservation(frame, parseBrowserObservation(text), text, f.call);
    assert.equal(observed.observationCurrent, false);
    assert.equal(f.calls.filter(request => request.args.function === browserFormValueFunction).length, 0);
    if (change !== 'before-lease') assert.equal(observed.raw.complete, false);
  });
});

test('an excessive editable inventory removes all snapshot values without unbounded DOM reads', async () => {
  const text = snapshot(Array.from({ length: 65 }, (_, index) => `- textbox "Field ${index}" [ref=e${index}]: old scalar`).join('\n'));
  const parsed = parseBrowserObservation(text), f = fixture(), frame = await beginBrowserFormObservation(binding, supported, f.call);
  assert.equal(parsed.formFields.length, 65);
  const observed = await completeBrowserFormObservation(frame, parsed, text, f.call);
  assert.equal(observed.raw.complete, false); assert.equal(observed.observationCurrent, true);
  assert.ok(observed.elements.every(element => element.value === undefined));
  assert.equal(f.calls.filter(request => request.args.function === browserFormValueFunction).length, 0);
  assert.equal(f.calls.length, 4, 'Only the bounded before/after page fence is read');
});
