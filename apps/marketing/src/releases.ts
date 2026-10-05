export interface ReleaseArtifact {
  platform: 'darwin' | 'linux';
  arch: 'arm64' | 'x64';
  format: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  signing: 'signed' | 'unsigned';
  verificationUrl?: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: 'EnoughFactory';
  version: string;
  status: 'preparing' | 'published';
  publishedAt: string | null;
  sourceUrl: string | null;
  sourceCommit?: string;
  releaseBaseUrl?: string;
  ubuntuSourceIndexSha256?: string;
  sources?: ReleaseSource[];
  artifacts: ReleaseArtifact[];
}

export interface ReleaseSource {
  kind: 'container-engine' | 'ubuntu';
  role: 'archive' | 'receipt' | 'part' | 'evidence' | 'lock' | 'index' | 'readme' | 'checksums';
  platform?: ReleaseArtifact['platform'];
  arch?: ReleaseArtifact['arch'];
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
}

function isPublicLink(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^\/downloads\/[a-zA-Z0-9._/-]+$/.test(value)) return !value.includes('..');
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object') throw new Error('The release catalog is unavailable.');
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== 1 || manifest.product !== 'EnoughFactory' || typeof manifest.version !== 'string' || !['preparing', 'published'].includes(manifest.status ?? '') || !Array.isArray(manifest.artifacts)) {
    throw new Error('The release catalog is unavailable.');
  }
  for (const artifact of manifest.artifacts) {
    if (!['darwin', 'linux'].includes(artifact.platform) || !['arm64', 'x64'].includes(artifact.arch) || !isPublicLink(artifact.url) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || !['signed', 'unsigned'].includes(artifact.signing)) {
      throw new Error('A release download could not be verified.');
    }
    if (artifact.verificationUrl !== undefined && !isPublicLink(artifact.verificationUrl)) throw new Error('The package verification record is unavailable.');
  }
  if (manifest.sourceUrl !== null && !isPublicLink(manifest.sourceUrl)) throw new Error('The source address is unavailable.');
  if (manifest.sources !== undefined) {
    if (!Array.isArray(manifest.sources)) throw new Error('Runtime source downloads are unavailable.');
    for (const source of manifest.sources) {
      if (!['container-engine', 'ubuntu'].includes(source.kind) || !['archive', 'receipt', 'part', 'evidence', 'lock', 'index', 'readme', 'checksums'].includes(source.role) || !isPublicLink(source.url) || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 || !/^[a-zA-Z0-9._-]+$/.test(source.filename) || (source.kind === 'container-engine' && (!['darwin', 'linux'].includes(source.platform ?? '') || !['arm64', 'x64'].includes(source.arch ?? '')))) throw new Error('A runtime source download could not be verified.');
    }
  }
  if (manifest.status === 'published' && (manifest.artifacts.length === 0 || !manifest.publishedAt || !manifest.sourceUrl || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') || manifest.artifacts.some(artifact => !artifact.verificationUrl) || !manifest.sources?.length || !isPublicLink(manifest.releaseBaseUrl) || !/^[a-f0-9]{64}$/.test(manifest.ubuntuSourceIndexSha256 ?? ''))) throw new Error('The release is not ready to download.');
  return manifest as ReleaseManifest;
}

export const platformLabel = (platform: ReleaseArtifact['platform'], arch: ReleaseArtifact['arch']) => platform === 'darwin' ? (arch === 'arm64' ? 'Mac · Apple Silicon' : 'Mac · Intel') : `Linux · ${arch === 'arm64' ? 'ARM64' : 'x64'}`;
export const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${Math.round(bytes / 1024 / 1024)} MB`;
