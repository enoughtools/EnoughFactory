import type { Artifact } from '@enoughfactory/contracts';

export interface NativeProfileSummary { id: string; platform: 'macos' | 'ios-simulator'; scheme?: string; receipt?: Artifact }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

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
