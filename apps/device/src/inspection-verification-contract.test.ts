import assert from 'node:assert/strict';
import test from 'node:test';
import type { InspectionVerificationAcceptance } from '@enoughfactory/contracts';
import { verificationContractChunk, verificationContractContent, verificationContractFullyRead, type VerificationContractRead } from './inspection-verification-contract.ts';

const contract: InspectionVerificationAcceptance = { version: 1, task: { title: 'Restore the original reply', description: 'Read every original criterion.', acceptanceCriteria: ['Exact multiline body 😀\n'.repeat(2400)], dependsOn: [], checks: [], planRevision: 3 } };
test('bounded contract reads reconstruct every original character and bind completion to the original owner and digest', () => {
  const original = verificationContractContent(contract), reads: VerificationContractRead[] = [];
  let offset = 0, restored = '';
  while (offset < original.totalCharacters) {
    const chunk = verificationContractChunk(contract, offset, 16000);
    assert.ok(chunk.content.length <= 16000); assert.equal(chunk.contractSha256, original.contractSha256);
    reads.push({ runId: 'original-run', chatId: 'original-chat', contractSha256: chunk.contractSha256, offset, end: chunk.nextOffset });
    restored += chunk.content; offset = chunk.nextOffset;
  }
  assert.equal(restored, original.content); assert.deepEqual(JSON.parse(restored), contract);
  assert.equal(verificationContractFullyRead(contract, 'original-run', 'original-chat', reads), true);
  assert.equal(verificationContractFullyRead(contract, 'original-run', 'original-chat', reads.slice(1)), false);
  assert.equal(verificationContractFullyRead(contract, 'another-run', 'original-chat', reads), false);
  assert.equal(verificationContractFullyRead(contract, 'original-run', 'another-chat', reads), false);
  assert.equal(verificationContractFullyRead({ ...contract, task: { ...contract.task, description: 'Changed original criterion' } }, 'original-run', 'original-chat', reads), false);
});
test('contract range reads reject malformed offsets and excessive responses; duplicate reads cannot cover a gap', () => {
  for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000]) assert.throws(() => verificationContractChunk(contract, offset, 16000), /original contract range/);
  for (const count of [0, -1, 0.5, 16001, Number.NaN]) assert.throws(() => verificationContractChunk(contract, 0, count), /original contract range/);
  const original = verificationContractContent(contract), read = { runId: 'original-run', chatId: 'original-chat', contractSha256: original.contractSha256, offset: 0, end: 16000 };
  assert.equal(verificationContractFullyRead(contract, read.runId, read.chatId, [read, read, { ...read, offset: 16001, end: original.totalCharacters }]), false);
});
