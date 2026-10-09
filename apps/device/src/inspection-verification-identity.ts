import { createHash } from 'node:crypto';
import type { InspectionVerificationAcceptance, InspectionVerificationRun, TaskQualityRequirements } from '@enoughfactory/contracts';

/** Stable service identity shared by verifier ownership and quality provenance. */
export function canonicalVerificationValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalVerificationValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalVerificationValue(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string { return createHash('sha256').update(canonicalVerificationValue(value)).digest('hex'); }
export function inspectionQualityPolicySha256(quality: TaskQualityRequirements): string { return digest(quality); }
export function inspectionAcceptanceContractSha256(contract: InspectionVerificationAcceptance): string { return digest(contract); }
export function inspectionVerificationKey(input: Pick<InspectionVerificationRun, 'authority' | 'source' | 'quality' | 'purpose' | 'goalRevision' | 'acceptanceContract'>): string {
  return `verify-${digest({ version: 1, authority: input.authority, ...(input.purpose === 'goal-final' ? { purpose: input.purpose, goalRevision: input.goalRevision } : {}), ...(input.acceptanceContract ? { acceptanceContract: input.acceptanceContract } : {}), source: { sha256: input.source.sha256, roots: (input.source.roots ?? []).map(({ id, sha256 }) => ({ id, sha256 })).sort((a, b) => a.id.localeCompare(b.id)) }, quality: input.quality })}`;
}
