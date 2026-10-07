import { useCallback, useEffect, useRef, useState } from 'react';
import type { FactoryState } from '@enoughfactory/contracts';
import { browserPeerClient, PeerSocket, peerChanges, type ClientSocket } from './browserPeers';

export interface Connection { url: string; token: string; mode?: 'http' | 'peer'; deviceId?: string; version?: string; appVersion?: string }
export interface DesktopBridge {
  getConnection(): Promise<Connection>;
  restartDeviceService?(): Promise<Connection>;
  onConnectionChanged?(callback: (connection: Connection) => void): () => void;
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
const CONNECT_DEVICE_MESSAGE = 'Connect your device service or pair a device to open your workspace.';
const WEB_PAGE_MESSAGE = 'This address returned a web page. Use a device service URL or pair a device.';
function canConnect(connection: Connection): boolean {
  if (connection.mode === 'peer') return Boolean(connection.deviceId);
  // Only the development server proxies relative API requests to a device service.
  return Boolean(connection.url.trim()) || import.meta.env.DEV;
}
function deviceErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  if (/<\/?[a-z][^>]*>/i.test(value)) return WEB_PAGE_MESSAGE;
  return value.trim().slice(0, 600);
}
export function initialConnection(): Connection {
  try {
    const saved = JSON.parse(localStorage.getItem(CONNECTION_KEY) ?? 'null') as Connection | null;
    if (saved?.url || (saved?.mode === 'peer' && saved.deviceId)) return saved;
  } catch { /* A damaged local preference should not prevent onboarding. */ }
  return { url: location.protocol === 'file:' ? 'http://127.0.0.1:4317' : '', token: '' };
}
export function storeConnection(connection: Connection) { try { localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection)); } catch { /* A browser may disable preferences; the active connection can still work. */ } }

export class DeviceRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  constructor(readonly status: number, body: unknown) {
    const error = body && typeof body === 'object' && !Array.isArray(body) ? body as { error?: unknown; code?: unknown; details?: unknown } : undefined;
    super(deviceErrorMessage(error?.error ?? body, `The device returned ${status}.`));
    this.name = 'DeviceRequestError';
    this.code = typeof error?.code === 'string' ? error.code : undefined;
    this.details = error?.details;
  }
}

export class DeviceClient {
  constructor(readonly connection: Connection) {}
  url(path: string) { return `${this.connection.url.replace(/\/$/, '')}${path}`; }
  async request<T>(path: string, options: RequestInit = {}, lane: 'control' | 'bulk' = 'control'): Promise<T> {
    if (!canConnect(this.connection)) throw new Error(CONNECT_DEVICE_MESSAGE);
    if (this.connection.mode === 'peer') {
      if (!this.connection.deviceId) throw new Error('Choose a paired device.');
      const peers = await browserPeerClient();
      const response = await peers.request(this.connection.deviceId, { method: options.method ?? 'GET', path, ...(options.body ? { body: JSON.parse(String(options.body)) } : {}) }, 30_000, lane);
      if (response.status < 200 || response.status >= 300) throw new DeviceRequestError(response.status, response.body);
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
    if (response.headers.get('content-type')?.includes('text/html')) throw new Error(WEB_PAGE_MESSAGE);
    if (!response.ok) {
      const body = await response.text();
      let error: unknown = body;
      try { error = JSON.parse(body); } catch { /* Plain engine errors are useful too. */ }
      throw new DeviceRequestError(response.status, error);
    }
    if (response.status === 204) return undefined as T;
    if (response.headers.get('content-type')?.includes('json')) return response.json() as Promise<T>;
    const body = await response.text();
    if (/<\/?(?:html|head|body)\b/i.test(body)) throw new Error(WEB_PAGE_MESSAGE);
    return body as T;
  }
  get<T>(path: string) { return this.request<T>(path); }
  getBulk<T>(path: string) { return this.request<T>(path, {}, 'bulk'); }
  post<T>(path: string, body: unknown = {}) { return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
  patch<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
  put<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }
  delete<T>(path: string) { return this.request<T>(path, { method: 'DELETE' }); }
  socket(path: string): ClientSocket {
    if (!canConnect(this.connection)) throw new Error(CONNECT_DEVICE_MESSAGE);
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
  const [error, setError] = useState<string | null>(() => !window.enoughFactory && !canConnect(connection) ? CONNECT_DEVICE_MESSAGE : null);
  const [loading, setLoading] = useState(() => Boolean(window.enoughFactory) || canConnect(connection));
  const [bootstrapped, setBootstrapped] = useState(() => !window.enoughFactory);
  const bootstrappedRef = useRef(bootstrapped);
  const requestGeneration = useRef(0);
  const desktopServiceUrl = useRef<string | null>(null);
  const desktopReconnectNeeded = useRef(Boolean(window.enoughFactory));
  const client = useRef(new DeviceClient(connection));
  const refresh = useCallback(async () => {
    if (!bootstrappedRef.current) return;
    if (!canConnect(client.current.connection)) { setError(CONNECT_DEVICE_MESSAGE); setLoading(false); return; }
    const generation = requestGeneration.current;
    try {
      const next = await client.current.request<FactoryState>('/api/state', { signal: AbortSignal.timeout(8000) });
      if (generation !== requestGeneration.current) return;
      desktopReconnectNeeded.current = false; setState(next); setError(null);
    } catch (cause) {
      if (generation === requestGeneration.current) {
        desktopReconnectNeeded.current = Boolean(window.enoughFactory) && client.current.connection.mode !== 'peer' && client.current.connection.url === desktopServiceUrl.current;
        setError(cause instanceof Error ? cause.message : 'The device is unavailable.');
      }
    } finally { if (generation === requestGeneration.current) setLoading(false); }
  }, []);
  const setConnection = useCallback((next: Connection) => {
    bootstrappedRef.current = true; setBootstrapped(true);
    const current = client.current.connection;
    const sameService = current.url === next.url && current.token === next.token && current.mode === next.mode && current.deviceId === next.deviceId;
    storeConnection(next); requestGeneration.current++;
    client.current = new DeviceClient(next); setConnectionState(next); setLoading(true); setState(previous => sameService ? previous : null); setError(null);
  }, []);
  useEffect(() => {
    const bridge = window.enoughFactory;
    if (!bridge) return;
    let active = true, pending = false;
    const accept = (next: Connection) => {
      if (!active) return;
      const current = client.current.connection;
      if (bootstrappedRef.current && desktopServiceUrl.current && (current.mode === 'peer' || current.url !== desktopServiceUrl.current)) return;
      desktopServiceUrl.current = next.url;
      desktopReconnectNeeded.current = false;
      setConnection(next);
    };
    const reconnect = async () => {
      if (!active || pending) return;
      pending = true;
      try { accept(await bridge.getConnection()); }
      catch (cause) { if (active) { desktopReconnectNeeded.current = true; setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); } }
      finally { pending = false; }
    };
    const unsubscribe = bridge.onConnectionChanged?.(accept);
    void reconnect();
    const retry = setInterval(() => { if (desktopReconnectNeeded.current) void reconnect(); }, 3000);
    return () => { active = false; clearInterval(retry); unsubscribe?.(); };
  }, [setConnection]);
  useEffect(() => {
    if (!bootstrapped) return;
    if (!canConnect(connection)) { setError(CONNECT_DEVICE_MESSAGE); setLoading(false); return; }
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
  }, [bootstrapped, connection, refresh]);
  return { state, error, loading, client: client.current, refresh, connection, setConnection };
}
