import { createHash } from 'node:crypto';
import type { ArtifactManifest, ArtifactStore } from '@enoughfactory/workspaces';
import type { BrowserLease, BrowserToolContent, BrowserToolResult } from './types.ts';
import { BrowserInspectionError } from './types.ts';

const imageLimit = 8 * 1024 ** 2, totalLimit = 24 * 1024 ** 2;
export function decodeBrowserImage(content: BrowserToolContent): Buffer {
  if (typeof content.data !== 'string' || content.data.length > Math.ceil(imageLimit / 3) * 4 + 4 || content.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content.data)) throw new BrowserInspectionError('Browser image content is invalid or exceeds its storage limit.', 'INVALID_IMAGE');
  const bytes = Buffer.from(content.data, 'base64');
  if (bytes.length > imageLimit) throw new BrowserInspectionError('Browser image exceeds its storage limit.', 'INVALID_IMAGE');
  const valid = content.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : content.mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : content.mimeType === 'image/webp' ? bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' : false;
  if (!valid) throw new BrowserInspectionError('Browser image format does not match its declared media type.', 'INVALID_IMAGE');
  return bytes;
}

export async function retainBrowserResult(result: BrowserToolResult, lease: BrowserLease, operationId: string, tool: string, artifacts: Pick<ArtifactStore, 'put'>, assertCurrent: () => void = () => {}) {
  if (!Array.isArray(result.content) || result.content.length > 64) throw new BrowserInspectionError('Browser response contains invalid or excessive content.', 'INVALID_CONTENT');
  for (const content of result.content) {
    if (!content || typeof content !== 'object' || Array.isArray(content) || typeof content.type !== 'string') throw new BrowserInspectionError('Browser response contains invalid content.', 'INVALID_CONTENT');
  }
  const retained: ArtifactManifest[] = [], compact: BrowserToolContent[] = [];
  const prepared: Array<{ index: number; content: BrowserToolContent; bytes?: Buffer }> = [];
  let total = 0;
  const previousBytes = lease.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  if (lease.artifacts.length + result.content.filter(content => content.type === 'image').length > 256) throw new BrowserInspectionError('This browser session reached its retained screenshot limit. Retire it explicitly before starting another session.', 'EVIDENCE_QUOTA');
  // Validate the entire observation before publishing any image manifest. A later
  // malformed image or quota breach must not leave an earlier image unaccounted.
  for (const [index, content] of result.content.entries()) {
    assertCurrent();
    if (content.type === 'image') {
      const bytes = decodeBrowserImage(content); total += bytes.length;
      if (total > totalLimit) throw new BrowserInspectionError('Browser observation exceeds its image storage limit.', 'INVALID_IMAGE');
      if (previousBytes + total > 128 * 1024 ** 2) throw new BrowserInspectionError('This browser session reached its retained image storage limit.', 'EVIDENCE_QUOTA');
      prepared.push({ index, content, bytes });
    } else prepared.push({ index, content });
  }
  assertCurrent();
  for (const { index, content, bytes } of prepared) {
    assertCurrent();
    if (bytes) {
      const extension = content.mimeType === 'image/png' ? 'png' : content.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
      const manifest = await artifacts.put(bytes, { name: `browser-${lease.id}-${operationId}-${index}.${extension}`, mime: content.mimeType!, goalId: lease.goalId, taskId: lease.taskId, attemptId: lease.attemptId,
        metadata: { kind: 'browser-inspection', browserSessionId: lease.id, sessionId: lease.sessionId, operationId, tool, source: lease.source, authorityGeneration: lease.authorityGeneration, browserRecipeSha256: lease.image.recipeSha256, browserImage: lease.image.image, observedAt: new Date().toISOString() } });
      assertCurrent(); retained.push(manifest);
      compact.push({ type: 'resource_link', name: manifest.name, mimeType: manifest.mime, uri: `enoughfactory-artifact:${manifest.id}`, artifactId: manifest.id, sha256: manifest.sha256, size: manifest.size });
    } else if (content.type === 'text' && typeof content.text === 'string') compact.push({ type: 'text', text: content.text.slice(0, 64 * 1024) });
    else compact.push({ type: content.type, omitted: true });
  }
  // Preserve structural success/errors without copying arbitrary hidden image payloads to SQLite.
  return { artifacts: retained, event: { tool, operationId, content: compact, isError: result.isError, artifactIds: retained.map(manifest => manifest.id) } };
}

export function browserIdentitySha256(identity: unknown): string { return createHash('sha256').update(JSON.stringify(identity)).digest('hex'); }
