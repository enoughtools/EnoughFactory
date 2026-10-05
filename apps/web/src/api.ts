import { useCallback, useEffect, useRef, useState } from 'react';
import type { FactoryState } from '@enoughfactory/contracts';
import { browserPeerClient, PeerSocket, peerChanges, type ClientSocket } from './browserPeers';

export interface Connection { url: string; token: string; mode?: 'http' | 'peer'; deviceId?: string }
export interface DesktopBridge {
  getConnection(): Promise<Connection>;
  pickDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  openPreview?(options: { sessionId: string; url: string; bounds?: { x: number; y: number; width: number; height: number } }): Promise<void>;
  setPreviewBounds?(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  closePreview?(): Promise<void>;
  previewNavigation?(action: 'back' | 'forward' | 'reload'): Promise<void>;
  onPreviewStatus?(callback: (status: { sessionId?: string; status: 'ready' | 'failed'; url: string; error?: string }) => void): () => void;
  platform?: string;
}
declare global { interface Window { enoughFactory?: DesktopBridge } }

const CONNECTION_KEY = 'enoughfactory.connection';
export function initialConnection(): Connection {
  try {
    const saved = JSON.parse(localStorage.getItem(CONNECTION_KEY) ?? 'null') as Connection | null;
    if (saved?.url || (saved?.mode === 'peer' && saved.deviceId)) return saved;
  } catch { /* A damaged local preference should not prevent onboarding. */ }
  return { url: location.protocol === 'file:' ? 'http://127.0.0.1:4317' : '', token: '' };
}
export function storeConnection(connection: Connection) { try { localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection)); } catch { /* A browser may disable preferences; the active connection can still work. */ } }

export class DeviceClient {
  constructor(readonly connection: Connection) {}
  url(path: string) { return `${this.connection.url.replace(/\/$/, '')}${path}`; }
  async request<T>(path: string, options: RequestInit = {}, lane: 'control' | 'bulk' = 'control'): Promise<T> {
    if (this.connection.mode === 'peer') {
      if (!this.connection.deviceId) throw new Error('Choose a paired device.');
      const peers = await browserPeerClient();
      const response = await peers.request(this.connection.deviceId, { method: options.method ?? 'GET', path, ...(options.body ? { body: JSON.parse(String(options.body)) } : {}) }, 30_000, lane);
      if (response.status < 200 || response.status >= 300) throw new Error((response.body as { error?: string })?.error || `The device returned ${response.status}.`);
      if (path === '/api/state') {
        const state = response.body as FactoryState;
        const owner = peers.devices().find(device => device.id === this.connection.deviceId);
        return { ...state, device: { ...state.device, local: false, transport: owner?.transport }, devices: state.devices.filter(device => device.platform !== 'browser').map(device => ({ ...device, local: false, ...(device.id === owner?.id ? { online: owner.online, transport: owner.transport, lastSeen: owner.lastSeen } : {}) })) } as T;
      }
      return response.body as T;
    }
    const response = await fetch(this.url(path), {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(this.connection.token ? { Authorization: `Bearer ${this.connection.token}` } : {}), ...options.headers },
    });
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try { message = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* Plain engine errors are useful too. */ }
      throw new Error(message || `The device returned ${response.status}.`);
    }
    if (response.status === 204) return undefined as T;
    return (response.headers.get('content-type')?.includes('json') ? response.json() : response.text()) as Promise<T>;
  }
  get<T>(path: string) { return this.request<T>(path); }
  getBulk<T>(path: string) { return this.request<T>(path, {}, 'bulk'); }
  post<T>(path: string, body: unknown = {}) { return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
  patch<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
  put<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }
  delete<T>(path: string) { return this.request<T>(path, { method: 'DELETE' }); }
  socket(path: string): ClientSocket {
    if (this.connection.mode === 'peer' && this.connection.deviceId) return new PeerSocket(this.connection.deviceId, path);
    const url = new URL(this.url(path), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.connection.token) url.searchParams.set('token', this.connection.token);
    return new WebSocket(url) as unknown as ClientSocket;
  }
}

export function useFactory() {
  const [connection, setConnectionState] = useState(initialConnection);
  const [state, setState] = useState<FactoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestGeneration = useRef(0);
  const client = useRef(new DeviceClient(connection));
  const refresh = useCallback(async () => {
    const generation = requestGeneration.current;
    try {
      const next = await client.current.get<FactoryState>('/api/state');
      if (generation !== requestGeneration.current) return;
      setState(next); setError(null);
    } catch (cause) {
      if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : 'The device is unavailable.');
    } finally { if (generation === requestGeneration.current) setLoading(false); }
  }, []);
  const setConnection = useCallback((next: Connection) => {
    storeConnection(next); requestGeneration.current++;
    client.current = new DeviceClient(next); setConnectionState(next); setLoading(true); setState(null);
  }, []);
  useEffect(() => { void window.enoughFactory?.getConnection().then(setConnection).catch(cause => setError(String(cause))); }, [setConnection]);
  useEffect(() => {
    const abort = new AbortController();
    void refresh();
    const fallback = setInterval(() => void refresh(), 15_000);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const peerUpdated = (event: Event) => {
      if (event.type === 'devices') {
        const devices = (event as CustomEvent<import('@enoughfactory/contracts').Device[]>).detail;
        const owner = devices.find(device => device.id === connection.deviceId);
        if (owner) setState(current => current ? { ...current, devices: current.devices.map(device => device.id === owner.id ? { ...device, online: owner.online, transport: owner.transport, lastSeen: owner.lastSeen } : device) } : current);
      }
      clearTimeout(debounce); debounce = setTimeout(() => void refresh(), 100);
    };
    async function subscribe() {
      try {
        const response = await fetch(client.current.url('/api/events'), { signal: abort.signal, headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {} });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        while (!abort.signal.aborted) {
          const result = await reader.read();
          if (result.done) break;
          clearTimeout(debounce); debounce = setTimeout(() => void refresh(), 100);
        }
      } catch { /* Polling retains a live catalog if the event stream reconnects. */ }
    }
    if (connection.mode === 'peer') { peerChanges.addEventListener('change', peerUpdated); peerChanges.addEventListener('devices', peerUpdated); }
    else void subscribe();
    return () => { abort.abort(); clearInterval(fallback); clearTimeout(debounce); peerChanges.removeEventListener('change', peerUpdated); peerChanges.removeEventListener('devices', peerUpdated); };
  }, [connection, refresh]);
  return { state, error, loading, client: client.current, refresh, connection, setConnection };
}
