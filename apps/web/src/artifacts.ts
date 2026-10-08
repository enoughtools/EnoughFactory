import type { Artifact } from '@enoughfactory/contracts';
import type { DeviceClient } from './api';

/** Read authenticated chunks and verify the complete artifact before display or download. */
export async function readArtifactBlob(client: DeviceClient, artifact: Artifact, ownerDeviceId: string, onProgress: (received: number) => void = () => {}) {
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error('This artifact has an invalid manifest.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (offset < artifact.size) {
    const chunk = await client.getBulk<{ offset: number; data: string; total: number }>(`/api/artifacts/${encodeURIComponent(artifact.id)}/chunk?offset=${offset}&size=49152&deviceId=${encodeURIComponent(ownerDeviceId)}`);
    if (chunk.offset !== offset || chunk.total !== artifact.size || typeof chunk.data !== 'string' || !chunk.data || chunk.data.length > 65536) throw new Error('The artifact transfer changed unexpectedly. Retry the download.');
    const bytes = Uint8Array.from(atob(chunk.data), value => value.charCodeAt(0));
    if (!bytes.length || bytes.length > 49152 || offset + bytes.length > artifact.size) throw new Error('The artifact chunk did not match its manifest.');
    chunks.push(bytes); offset += bytes.length; onProgress(offset);
  }
  const blob = new Blob(chunks, { type: artifact.mime || 'application/octet-stream' });
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== artifact.sha256.toLowerCase()) throw new Error('The downloaded artifact did not match its recorded fingerprint.');
  return blob;
}

export async function downloadArtifact(client: DeviceClient, artifact: Artifact, coordinatorId: string, onProgress: (received: number) => void) {
  const blob = await readArtifactBlob(client, artifact, coordinatorId, onProgress);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = artifact.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
