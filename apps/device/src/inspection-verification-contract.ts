import type { InspectionVerificationAcceptance } from '@enoughfactory/contracts';
import { inspectionAcceptanceContractSha256 } from './inspection-verification-identity.ts';

export const INLINE_VERIFICATION_CONTRACT_CHARACTERS = 32_000;
export const VERIFICATION_CONTRACT_CHUNK_CHARACTERS = 16_000;
export interface VerificationContractRead { runId: string; chatId: string; contractSha256: string; offset: number; end: number }
export function verificationContractContent(contract: InspectionVerificationAcceptance) {
  const content = JSON.stringify(contract);
  return { content, totalCharacters: content.length, contractSha256: inspectionAcceptanceContractSha256(contract) };
}
export function verificationContractChunk(contract: InspectionVerificationAcceptance, offset: number, maxCharacters: number) {
  const original = verificationContractContent(contract);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > original.totalCharacters || !Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > VERIFICATION_CONTRACT_CHUNK_CHARACTERS) throw new Error('Read an original contract range using an integer offset and 1–16000 characters.');
  const content = original.content.slice(offset, offset + maxCharacters);
  return { contractSha256: original.contractSha256, totalCharacters: original.totalCharacters, offset, nextOffset: offset + content.length, content };
}
export function verificationContractFullyRead(contract: InspectionVerificationAcceptance, runId: string, chatId: string, reads: VerificationContractRead[]): boolean {
  const original = verificationContractContent(contract);
  if (original.totalCharacters <= INLINE_VERIFICATION_CONTRACT_CHARACTERS) return true;
  const selected = reads.filter(read => read.runId === runId && read.chatId === chatId && read.contractSha256 === original.contractSha256 && Number.isSafeInteger(read.offset) && Number.isSafeInteger(read.end) && read.offset >= 0 && read.end > read.offset && read.end <= original.totalCharacters).sort((left, right) => left.offset - right.offset);
  let end = 0;
  for (const read of selected) { if (read.offset > end) return false; end = Math.max(end, read.end); }
  return end === original.totalCharacters;
}
