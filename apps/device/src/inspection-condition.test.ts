import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateObservedCondition, type ObservedCondition } from './inspection-condition.js';

test('exact observed values reject prefixes, suffixes, case changes and whitespace changes', () => {
  const condition = { labelIncludes: 'Subject', valueEquals: 'Hello' };
  assert.equal(evaluateObservedCondition([{ label: 'Subject field', value: 'Hello' }], condition), true);
  for (const value of ['Hello world', 'Say Hello', 'hello', ' Hello', 'Hello ', 'Hello\n']) {
    assert.equal(evaluateObservedCondition([{ label: 'Subject field', value }], condition), false, JSON.stringify(value));
  }
});

test('exact empty values require an actual observed string', () => {
  const condition = { labelIncludes: 'Subject', valueEquals: '' };
  assert.equal(evaluateObservedCondition([{ label: 'Subject', value: '' }], condition), true);
  assert.equal(evaluateObservedCondition([{ label: 'Subject' }], condition), false);
  assert.equal(evaluateObservedCondition([{ label: 'Subject', value: undefined }], condition), false);
  assert.equal(evaluateObservedCondition([{ label: 'Subject', value: ' ' }], condition), false);
});

test('exact and substring filters must hold on the same matching element', () => {
  const elements = [{ label: 'Subject', value: 'Hello' }, { label: 'Subject', value: 'World' }];
  assert.equal(evaluateObservedCondition(elements, { labelIncludes: 'Subject', valueEquals: 'Hello', valueIncludes: 'ell' }), true);
  assert.equal(evaluateObservedCondition(elements, { labelIncludes: 'Subject', valueEquals: 'Hello', valueIncludes: 'World' }), false);
  assert.equal(evaluateObservedCondition([{ label: 'Subject', value: 'World' }, { label: 'Other', value: 'Hello' }], { labelIncludes: 'Subject', valueEquals: 'Hello' }), false);
});

test('substring conditions preserve matching and missing-value behavior', () => {
  assert.equal(evaluateObservedCondition([{ label: 'Message body', value: 'A draft written today' }], { labelIncludes: 'body', valueIncludes: 'draft' }), true);
  assert.equal(evaluateObservedCondition([{ label: 'Message body', value: 'A draft written today' }], { labelIncludes: 'body', valueIncludes: 'Draft' }), false);
  assert.equal(evaluateObservedCondition([{ label: 'Message body' }], { labelIncludes: 'body', valueIncludes: '' }), true);
  assert.equal(evaluateObservedCondition([{ label: 'Message body' }], { labelIncludes: 'body', valueIncludes: 'draft' }), false);
  assert.equal(evaluateObservedCondition([{ label: 'Message body' }], { labelIncludes: 'body' }), true);
  assert.equal(evaluateObservedCondition([], { labelIncludes: 'body' }), false);
});

test('identifier fallback is used only when the label is empty or missing', () => {
  const condition = { labelIncludes: 'compose.subject', valueEquals: 'Hello' };
  assert.equal(evaluateObservedCondition([{ identifier: 'compose.subject', value: 'Hello' }], condition), true);
  assert.equal(evaluateObservedCondition([{ label: '', identifier: 'compose.subject', value: 'Hello' }], condition), true);
  assert.equal(evaluateObservedCondition([{ label: 'Subject', identifier: 'compose.subject', value: 'Hello' }], condition), false);
  assert.equal(evaluateObservedCondition([{ value: 'Hello' }], condition), false);
});

test('absence ignores value filters and depends only on matching labels', () => {
  const condition = { labelIncludes: 'Composer', absent: true, valueIncludes: 'draft', valueEquals: 'other' };
  assert.equal(evaluateObservedCondition([{ label: 'Inbox' }], condition), true);
  assert.equal(evaluateObservedCondition([], condition), true);
  assert.equal(evaluateObservedCondition([{ label: 'Composer', value: 'neither filter matches' }], condition), false);
  assert.equal(evaluateObservedCondition([{ identifier: 'Composer' }], condition), false);
  assert.equal(evaluateObservedCondition([{ label: 'Composer', value: 'draft' }], { labelIncludes: 'Composer', absent: false, valueIncludes: 'draft' }), true);
});

test('conditions require a concrete string label without changing the matched text', () => {
  for (const labelIncludes of ['', ' \t\n', undefined, null, 42]) {
    assert.throws(() => evaluateObservedCondition([], { labelIncludes } as ObservedCondition), /concrete observed label/);
  }
  assert.equal(evaluateObservedCondition([{ label: 'Subject' }], { labelIncludes: ' Subject ' }), false);
  assert.equal(evaluateObservedCondition([{ label: ' Subject ' }], { labelIncludes: ' Subject ' }), true);
});

test('optional value filters must be strings, including for absence conditions', () => {
  for (const key of ['valueIncludes', 'valueEquals']) {
    for (const value of [null, false, 42, {}]) {
      assert.throws(() => evaluateObservedCondition([], { labelIncludes: 'Subject', absent: true, [key]: value } as ObservedCondition), /values must be text/);
    }
  }
  assert.equal(evaluateObservedCondition([{ label: 'Subject' }], { labelIncludes: 'Subject', valueIncludes: undefined, valueEquals: undefined }), true);
});
