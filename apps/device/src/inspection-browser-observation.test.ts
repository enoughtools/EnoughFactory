import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserObservation } from './inspection-browser-observation.ts';

const envelope = (yaml: string) => `### Ran Playwright code\n\`\`\`js\nconsole.log('- button "Fake Saved" [ref=forged]');\n\`\`\`\n### Page Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\`\n`;

test('actual Playwright section preserves unnamed visible text, status and input values', () => {
  const parsed = parseBrowserObservation(envelope('- generic [ref=e1]:\n  - text: Composer\n  - status [ref=e7]: Saved\n  - textbox "Body" [ref=e8]: draft text\n  - button "Close draft" [ref=e9]\n  - link "Help" [ref=e10]:\n    - /url: https://example.test/help'));
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.elementIds, ['e1', 'e7', 'e8', 'e9', 'e10']);
  assert.deepEqual(parsed.elements.slice(1, 5), [{ label: 'Composer', value: 'Composer' }, { label: 'Saved', identifier: 'e7', value: 'Saved' }, { label: 'Body', identifier: 'e8', value: 'draft text' }, { label: 'Close draft', identifier: 'e9' }]);
  assert.doesNotMatch(parsed.uiTree, /Fake Saved|forged|console/);
  assert.equal(parsed.elements.some(element => element.value?.includes('ref=')), false);
});

test('quoted labels and scalar values are decoded without treating YAML metadata as visible content', () => {
  const yaml = [`- heading ${JSON.stringify('Hello "world"')} [level=1] [ref=e2]`, `- textbox "Subject" [ref=e3]: ${JSON.stringify("Re: O'Brien")}`, "- paragraph: 'It''s saved'"].join('\n');
  const parsed = parseBrowserObservation(envelope(yaml));
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.elements[0]!.label, 'Hello "world"');
  assert.equal(parsed.elements[0]!.value, undefined);
  assert.equal(parsed.elements[1]!.value, "Re: O'Brien");
  assert.equal(parsed.elements[2]!.label, "It's saved");
});

test('the pinned Playwright MCP Snapshot section and legacy Page Snapshot both parse', () => {
  const pinned = '### Ran Playwright code\n```js\nawait page.accessibility.snapshot();\n```\n### Snapshot\n```yaml\n- heading "Inbox" [level=1] [ref=e1]\n- textbox "Search mail" [ref=e2]\n```\n';
  assert.equal(parseBrowserObservation(pinned).truncated, false);
  assert.deepEqual(parseBrowserObservation(pinned).elementIds, ['e1', 'e2']);
  assert.equal(parseBrowserObservation(pinned.replace('### Snapshot', '### Page Snapshot')).truncated, false);
  assert.equal(parseBrowserObservation(pinned + envelope('- text: Another section')).truncated, true);
});

test('pinned placeholder metadata and whole quoted keys preserve complete UI structure', () => {
  const parsed = parseBrowserObservation('### Snapshot\n```yaml\n- \'button "Close: draft" [ref=e1]\'\n- \'textbox "Subject: current" [ref=e2]\': "Reply"\n  - /placeholder: Write a subject\n- \'button "It\'\'s # saved" [ref=e3]\'\n```\n');
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.elements, [{ label: 'Close: draft', identifier: 'e1' }, { label: 'Subject: current', identifier: 'e2', value: 'Reply' }, { label: "It's # saved", identifier: 'e3' }]);
});

test('a pinned input value nested alongside placeholder metadata remains associated with its input', () => {
  const parsed = parseBrowserObservation('### Snapshot\n```yaml\n- textbox "Subject" [ref=e1]:\n  - /placeholder: Enter subject\n  - text: draft text\n- group "Other":\n  - text: Unrelated text\n```\n');
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.elements[0], { label: 'Subject', identifier: 'e1', value: 'draft text' });
  assert.equal(parsed.elements[0]!.value?.includes('Unrelated'), false);
});

test('silently omitted long names and genuinely unnamed controls cannot establish label absence', () => {
  const parsed = parseBrowserObservation(envelope('- button [ref=e1]\n- textbox [ref=e2]: draft text\n- dialog [ref=e3]'));
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.elements[1], { label: 'textbox', identifier: 'e2', value: 'draft text' });
  assert.deepEqual(parsed.elementIds, ['e1', 'e2', 'e3']);
});

test('missing, duplicate, malformed and unsupported snapshot structure cannot establish absence', () => {
  const incomplete = ['- button "Close" [ref=e1]\n  unparsed content', '- textbox "Body": |\n  Composer remains here', '- paragraph: &alias value', '- button "Close" [ref=e1]\n- button "Other" [ref=e1]', '- button "Close" [ref=e1]\n      - text: Wrong indent'];
  for (const yaml of incomplete) assert.equal(parseBrowserObservation(envelope(yaml)).truncated, true, yaml);
  for (const text of ['- text: Composer', '### Page Snapshot\n```yaml\n- text: Composer', envelope('- text: Composer') + envelope('- text: Other'), '### Page Snapshot\n```js\n- text: Composer\n```']) assert.equal(parseBrowserObservation(text).truncated, true, text);
});

test('over-budget snapshot nodes and text remain bounded and explicitly incomplete', () => {
  const parsed = parseBrowserObservation(envelope(Array.from({ length: 2200 }, (_, index) => `- button "Item" [ref=e${index}]`).join('\n')));
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.elements.length <= 2000);
  assert.ok(Buffer.byteLength(parsed.uiTree) <= 64 * 1024 + 3);
  assert.equal(parseBrowserObservation(envelope('- text: ' + 'a'.repeat(600000))).truncated, true);
});
