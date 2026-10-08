import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ArtifactStore } from '@enoughfactory/workspaces';
import { decodeBrowserImage, retainBrowserResult } from '../src/evidence.ts';
import type { BrowserLease, BrowserToolContent, BrowserToolResult } from '../src/types.ts';

const png: BrowserToolContent = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWLsAAAAASUVORK5CYII=' };
const lease = { id: 'browser-evidence', sessionId: 'session-evidence', authorityGeneration: 1, image: { recipeSha256: 'a'.repeat(64), image: `sha256:${'b'.repeat(64)}` }, source: { snapshotSha256: 'c'.repeat(64) }, artifacts: [] } as unknown as BrowserLease;
function storage() {
  const writes: Array<{ bytes: Buffer; metadata: unknown }> = [];
  const artifacts: Pick<ArtifactStore, 'put'> = { async put(data, metadata) {
    const bytes = Buffer.from(data); writes.push({ bytes, metadata });
    return { ...metadata, id: `image-${writes.length}`, deviceId: 'evidence-test', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, createdAt: new Date().toISOString() };
  } };
  return { artifacts, writes };
}

test('a malformed later image rejects the whole observation before any artifact write', async () => {
  const sink = storage();
  await assert.rejects(retainBrowserResult({ content: [png, { ...png, data: 'invalid' }] }, lease, 'operation', 'browser_take_screenshot', sink.artifacts), /invalid/);
  assert.equal(sink.writes.length, 0);
});

test('a malformed later content block cannot leave an earlier screenshot behind', async () => {
  const sink = storage();
  const malformed = { content: [png, null] } as unknown as BrowserToolResult;
  await assert.rejects(retainBrowserResult(malformed, lease, 'operation', 'browser_take_screenshot', sink.artifacts), /invalid content/);
  assert.equal(sink.writes.length, 0);
});

test('the whole-observation image limit is checked before publishing any manifest', async () => {
  const sink = storage();
  const bytes = Buffer.alloc(7 * 1024 ** 2); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const large = { ...png, data: bytes.toString('base64') };
  assert.equal(decodeBrowserImage(large).length, bytes.length, 'An individually allowed image must decode without a regular expression stack overflow.');
  await assert.rejects(retainBrowserResult({ content: [large, large, large, large] }, lease, 'operation', 'browser_take_screenshot', sink.artifacts), /observation exceeds/);
  assert.equal(sink.writes.length, 0);
});

test('a later image crossing the session byte quota prevents every new write', async () => {
  const sink = storage(), imageBytes = decodeBrowserImage(png).length;
  const full = { ...lease, artifacts: [{ size: 128 * 1024 ** 2 - imageBytes }] } as BrowserLease;
  await assert.rejects(retainBrowserResult({ content: [png, png] }, full, 'operation', 'browser_take_screenshot', sink.artifacts), /retained image storage limit/);
  assert.equal(sink.writes.length, 0);
});

test('authority loss during validation prevents all artifact writes', async () => {
  const sink = storage(); let guards = 0;
  await assert.rejects(retainBrowserResult({ content: [png, png] }, lease, 'operation', 'browser_take_screenshot', sink.artifacts, () => { if (++guards === 2) throw new Error('Authority retired'); }), /Authority retired/);
  assert.equal(sink.writes.length, 0);
});

test('valid image content is preserved for the provider and retained as compact immutable references', async () => {
  const sink = storage(), input = { content: [png, { type: 'text', text: 'Observed composer' }] };
  const retained = await retainBrowserResult(input, lease, 'operation', 'browser_take_screenshot', sink.artifacts);
  assert.equal(sink.writes.length, 1); assert.deepEqual(sink.writes[0]!.bytes, decodeBrowserImage(png));
  assert.equal(input.content[0]!.data, png.data); assert.ok(!JSON.stringify(retained.event).includes(png.data!));
  assert.equal(retained.event.content[0]!.type, 'resource_link'); assert.equal(retained.event.content[0]!.artifactId, retained.artifacts[0]!.id);
  assert.deepEqual(retained.event.content[1], { type: 'text', text: 'Observed composer' });
});

test('base64 padding and alphabet remain validated without grouped repetition', () => {
  for (const data of ['AAAAA', 'AA=A', 'A===', '!!!!', 'AA\nA']) assert.throws(() => decodeBrowserImage({ ...png, data }), /invalid/);
});
