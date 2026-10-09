import type { Artifact } from '@enoughfactory/contracts';

export interface NativeProfileSummary { id: string; platform: 'macos' | 'ios-simulator'; scheme?: string; receipt?: Artifact }
export type NativeProfileAuditStatus = 'queued' | 'preparing' | 'running' | 'waiting' | 'unknown' | 'rejected' | 'configured' | 'canceled';
export interface NativeProfileAuditSummary { id: string; profileId: string; status: NativeProfileAuditStatus; reason?: string; nextAction?: string; verdict?: Artifact }
export interface NativeProfileAuditResponse { available: boolean; audits: NativeProfileAuditSummary[]; omitted?: number }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const auditStatuses = new Set<NativeProfileAuditStatus>(['queued', 'preparing', 'running', 'waiting', 'unknown', 'rejected', 'configured', 'canceled']);
const boundedText = (value: unknown, limit: number): string | undefined => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit) || undefined : undefined;
function auditArtifact(value: unknown): Artifact | undefined {
  const artifact = record(value);
  return artifact && typeof artifact.id === 'string' && artifact.id.length > 0 && artifact.id.length <= 128
    && typeof artifact.name === 'string' && artifact.name.length > 0 && artifact.name.length <= 256 && artifact.mime === 'application/json'
    && typeof artifact.deviceId === 'string' && artifact.deviceId.length > 0 && artifact.deviceId.length <= 128
    && typeof artifact.createdAt === 'string' && Number.isFinite(Date.parse(artifact.createdAt))
    && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256)
    && typeof artifact.size === 'number' && Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= 1024 * 1024
    ? { id: artifact.id, name: artifact.name, mime: artifact.mime, deviceId: artifact.deviceId, createdAt: artifact.createdAt, sha256: artifact.sha256, size: artifact.size } : undefined;
}

/** The API lists creation order, not update times. Keep the newest review for each profile. */
export function nativeProfileAuditSummaries(value: unknown): NativeProfileAuditResponse {
  if (!Array.isArray(value)) return { available: false, audits: [] };
  const latest = new Map<string, NativeProfileAuditSummary>();
  for (const item of value) {
    const audit = record(item);
    if (typeof audit?.id !== 'string' || !audit.id || audit.id.length > 128
      || typeof audit.profileId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(audit.profileId)
      || typeof audit.status !== 'string' || !auditStatuses.has(audit.status as NativeProfileAuditStatus)) return { available: false, audits: [] };
    const reason = boundedText(audit.reason, 800), nextAction = boundedText(audit.nextAction, 600), verdict = auditArtifact(audit.verdict);
    latest.delete(audit.profileId);
    latest.set(audit.profileId, { id: audit.id, profileId: audit.profileId, status: audit.status as NativeProfileAuditStatus, ...(reason ? { reason } : {}), ...(nextAction ? { nextAction } : {}), ...(verdict ? { verdict } : {}) });
  }
  const newest = [...latest.values()].reverse();
  const attention = (audit: NativeProfileAuditSummary) => audit.status !== 'configured' && audit.status !== 'canceled';
  const ordered = [...newest.filter(attention), ...newest.filter(audit => !attention(audit))];
  return { available: true, audits: ordered.slice(0, 16), ...(ordered.length > 16 ? { omitted: ordered.length - 16 } : {}) };
}

/** A configured profile is not evidence that its current source or UI has passed. */
export function nativeProfileSummaries(value: unknown): NativeProfileSummary[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  return value.flatMap(value => {
    const profile = record(value), build = record(profile?.build);
    if (typeof profile?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id) || !build) return [];
    const platform = build.tool === 'swift' ? 'macos' : build.tool === 'xcodebuild' && (build.platform === 'macos' || build.platform === 'ios-simulator') ? build.platform : undefined;
    if (!platform) return [];
    const artifact = record(profile.receipt);
    const receipt = artifact && typeof artifact.id === 'string' && typeof artifact.name === 'string' && artifact.mime === 'application/json'
      && typeof artifact.deviceId === 'string' && typeof artifact.createdAt === 'string'
      && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256) && artifact.sha256 === profile.fixtureEvidenceSha256
      && typeof artifact.size === 'number' && Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= 1024 * 1024
      ? { id: artifact.id, name: artifact.name, mime: artifact.mime, deviceId: artifact.deviceId, createdAt: artifact.createdAt, sha256: artifact.sha256, size: artifact.size } as Artifact : undefined;
    return [{ id: profile.id, platform, ...(typeof build.scheme === 'string' ? { scheme: build.scheme } : {}), ...(receipt ? { receipt } : {}) }];
  });
}
