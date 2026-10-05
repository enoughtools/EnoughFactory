import type { Artifact } from '@enoughfactory/contracts';
import type { DeviceClient } from './api';

export async function downloadArtifact(client: DeviceClient, artifact: Artifact, coordinatorId: string, onProgress: (received: number) => void) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (offset < artifact.size) {
    const chunk = await client.getBulk<{ offset: number; data: string; total: number }>(`/api/artifacts/${encodeURIComponent(artifact.id)}/chunk?offset=${offset}&size=49152&deviceId=${encodeURIComponent(coordinatorId)}`);
    if (chunk.offset !== offset || chunk.total !== artifact.size || !chunk.data) throw new Error('The artifact transfer changed unexpectedly. Retry the download.');
    const bytes = Uint8Array.from(atob(chunk.data), value => value.charCodeAt(0));
    if (bytes.length > 49152 || offset + bytes.length > artifact.size) throw new Error('The artifact chunk did not match its manifest.');
    chunks.push(bytes); offset += bytes.length; onProgress(offset);
  }
  const blob = new Blob(chunks, { type: artifact.mime || 'application/octet-stream' });
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== artifact.sha256.toLowerCase()) throw new Error('The downloaded artifact did not match its recorded fingerprint.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = artifact.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
