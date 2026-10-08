import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Artifact } from '@enoughfactory/contracts';
import type { DeviceClient } from './api';
import { readArtifactBlob } from './artifacts';

test('inspection artifact reads use their owner and verify all chunks before display', async () => {
  const bytes = Buffer.alloc(60000, 42);
  const artifact: Artifact = { id: 'screenshot', name: 'Native screenshot', mime: 'image/png', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), deviceId: 'paired-mac', createdAt: '2026-10-08T00:00:00.000Z' };
  const offsets: number[] = [], progress: number[] = [];
  const client = { async getBulk(route: string) {
    const url = new URL(route, 'http://enoughfactory.local');
    assert.equal(url.searchParams.get('deviceId'), 'paired-mac');
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return { offset, total: bytes.length, data: bytes.subarray(offset, offset + 49152).toString('base64') };
  } } as DeviceClient;
  const blob = await readArtifactBlob(client, artifact, artifact.deviceId, received => progress.push(received));
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  assert.deepEqual(offsets, [0, 49152]); assert.deepEqual(progress, [49152, 60000]);
  const corrupt = { getBulk: async () => ({ offset: 0, total: bytes.length, data: Buffer.alloc(49152).toString('base64') }) } as unknown as DeviceClient;
  await assert.rejects(readArtifactBlob(corrupt, { ...artifact, size: 49152 }, artifact.deviceId), /transfer changed/);
  await assert.rejects(readArtifactBlob({ getBulk: async () => ({ offset: 0, total: 60000, data: ' ' }) } as unknown as DeviceClient, artifact, artifact.deviceId), /chunk did not match/);
  const invalidHash = { getBulk: async () => ({ offset: 0, total: 1, data: 'AA==' }) } as unknown as DeviceClient;
  await assert.rejects(readArtifactBlob(invalidHash, { ...artifact, size: 1 }, artifact.deviceId), /fingerprint/);
});
