import type { Device } from '@enoughfactory/contracts';
import type { BrowserPeerClient, BrowserPeerStream } from '@enoughfactory/peers/browser';

export const peerChanges = new EventTarget();
let peerClient: Promise<BrowserPeerClient> | undefined;
export function browserPeerClient() {
  return peerClient ??= import('@enoughfactory/peers/browser').then(async module => {
    const client = await module.BrowserPeerClient.create({
      name: 'EnoughFactory browser',
      onEvent: (deviceId, event) => peerChanges.dispatchEvent(new CustomEvent('change', { detail: { deviceId, event } })),
      onDevices: devices => peerChanges.dispatchEvent(new CustomEvent('devices', { detail: devices })),
      onError: error => peerChanges.dispatchEvent(new CustomEvent('error', { detail: error.message })),
    });
    await client.start(); return client;
  }).catch(error => { peerClient = undefined; throw error; });
}
export async function pairedBrowserDevices(): Promise<Device[]> { return (await browserPeerClient()).devices().filter(device => !device.local); }

export interface ClientSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Keeps terminal input/output identical over local sockets and authenticated peer streams. */
export class PeerSocket implements ClientSocket {
  readyState = WebSocket.CONNECTING as number;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  private stream?: BrowserPeerStream;
  constructor(deviceId: string, path: string) {
    const parsed = new URL(path, 'https://factory.invalid');
    void browserPeerClient().then(client => client.openStream(deviceId, { kind: 'terminal', path: parsed.pathname, body: { terminalId: parsed.searchParams.get('terminalId') } })).then(stream => {
      if (this.readyState === WebSocket.CLOSED) { stream.close(); return; }
      this.stream = stream;
      const decoder = new TextDecoder();
      let pending = '';
      stream.on('data', bytes => {
        pending += decoder.decode(bytes, { stream: true });
        if (pending.length > 2 * 1024 * 1024) { stream.close('Terminal frame is too large.'); this.onerror?.(); return; }
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) { const packet = pending.slice(0, end); pending = pending.slice(end + 1); if (packet) this.onmessage?.({ data: packet }); }
      });
      stream.on('end', () => { this.readyState = WebSocket.CLOSED; this.onclose?.(); });
      this.readyState = WebSocket.OPEN;
      void stream.send(JSON.stringify({ type: 'attach' }) + '\n').then(() => { if (this.readyState === WebSocket.OPEN) this.onopen?.(); }).catch(() => this.onerror?.());
    }).catch(() => { this.readyState = WebSocket.CLOSED; this.onerror?.(); this.onclose?.(); });
  }
  send(data: string) { void this.stream?.send(data + '\n').catch(() => { this.onerror?.(); }); }
  close() { this.readyState = WebSocket.CLOSED; this.stream?.close(); }
}
