import type { Device, RpcRequest, RpcResponse, StreamEvent } from '@enoughfactory/contracts';
import { canonical, signedPart, type ArtifactManifest, type Frame, type IceServer, type Lane, type SignedEnvelope, type StreamOptions } from './protocol.js';

export type { ArtifactManifest, IceServer, StreamOptions } from './protocol.js';

export interface BrowserIdentity { id: string; publicKey: string; privateKey: string }
interface PairedDevice extends Device { publicKey: string }
export interface BrowserPeerState { identity: BrowserIdentity; devices: PairedDevice[]; signalingUrl?: string }
/** Supply an isolated store for a profile, or use the persistent IndexedDB browser identity. */
export interface BrowserIdentityStore {
  load(): Promise<BrowserPeerState | undefined>;
  save(state: BrowserPeerState): Promise<void>;
}
export interface BrowserPeerOptions {
  name?: string; signalingUrl?: string; iceServers?: IceServer[]; identityStore?: BrowserIdentityStore;
  transport?: 'auto' | 'webrtc' | 'relay'; relayFallback?: boolean; relayOnlyIce?: boolean;
  onEvent?: (deviceId: string, event: StreamEvent) => void;
  onDevice?: (device: Device) => void;
  onDevices?: (devices: Device[]) => void;
  onError?: (error: Error) => void;
}
interface Invitation { v: 1; deviceId: string; name: string; publicKey: string; signalingUrl: string; secret: string; expiresAt: string }
interface Ciphertext { nonce: string; data: string; tag: string }
type Timer = ReturnType<typeof setTimeout>;
interface PendingRpc { peerId: string; timer: Timer; resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
interface QueueItem { wire: string; size: number; resolve: () => void; reject: (error: Error) => void }
interface Link {
  id: string; session: string; initiator: boolean; ephemeral: CryptoKeyPair; relayKey?: CryptoKey;
  pc?: RTCPeerConnection; channels: Map<Lane, RTCDataChannel>; creating?: Promise<RTCPeerConnection>;
  connecting?: Timer; transport?: 'webrtc' | 'relay'; described: boolean;
  candidates: RTCIceCandidateInit[]; seq: number; queue: Record<Lane, QueueItem[]>;
  queueBytes: Record<Lane, number>; draining: boolean;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = () => new Date().toISOString();
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const lanes: Lane[] = ['control', 'events', 'bulk'];
const errorValue = (error: unknown) => error instanceof Error ? error : new Error(String(error));
function base64(bytes: Uint8Array): string {
  let value = ''; for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), char => char.charCodeAt(0));
}
function pem(type: 'PUBLIC KEY' | 'PRIVATE KEY', value: ArrayBuffer): string {
  return `-----BEGIN ${type}-----\n${base64(new Uint8Array(value)).match(/.{1,64}/g)!.join('\n')}\n-----END ${type}-----\n`;
}
function pemBytes(value: string): Uint8Array<ArrayBuffer> {
  return unbase64(value.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
}
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
async function digest(value: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}
function hex(value: Uint8Array): string { return [...value].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function identityId(publicKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('spki', pemBytes(publicKey), 'Ed25519', true, ['verify']);
  return hex(await digest(new Uint8Array(await crypto.subtle.exportKey('spki', key)))).slice(0, 32);
}
async function verifyValue(publicKey: string, value: unknown, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('spki', pemBytes(publicKey), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, unbase64(signature), encoder.encode(canonical(value)));
  } catch { return false; }
}
async function secretKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await digest(encoder.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(key: CryptoKey, value: unknown, aad: string): Promise<Ciphertext> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(aad), tagLength: 128 }, key, encoder.encode(JSON.stringify(value))));
  return { nonce: base64(nonce), data: base64(sealed.subarray(0, -16)), tag: base64(sealed.subarray(-16)) };
}
async function decrypt<T>(key: CryptoKey, value: Ciphertext, aad: string): Promise<T> {
  if (!value || typeof value.nonce !== 'string' || typeof value.data !== 'string' || typeof value.tag !== 'string') throw new Error('Invalid encrypted peer frame');
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(value.nonce), additionalData: encoder.encode(aad), tagLength: 128 }, key, concat(unbase64(value.data), unbase64(value.tag)));
  return JSON.parse(decoder.decode(clear)) as T;
}
function validateSignalingUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))))
    throw new Error('Signaling must use WSS, or WS on localhost for development');
}
function defaultStore(): BrowserIdentityStore {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Persistent browser storage is unavailable; supply an identity store')); return; }
    const request = indexedDB.open('enoughfactory-peers', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('identity');
    request.onerror = () => reject(request.error ?? new Error('Cannot open browser identity storage'));
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(new Error('Browser identity storage upgrade is blocked by another tab'));
  });
  return {
    async load() {
      const db = await open();
      return new Promise<BrowserPeerState | undefined>((resolve, reject) => {
        const transaction = db.transaction('identity', 'readonly'); const request = transaction.objectStore('identity').get('current');
        request.onsuccess = () => resolve(request.result as BrowserPeerState | undefined); request.onerror = () => reject(request.error);
      });
    },
    async save(state) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('identity', 'readwrite'); transaction.objectStore('identity').put(state, 'current');
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error('Browser identity storage write aborted'));
      });
    },
  };
}

/** Browser duplex stream. Data events contain bytes, preserving UTF-8 across chunk boundaries. */
export class BrowserPeerStream extends EventTarget {
  private ended = false;
  constructor(readonly id: string, private transmit: (frame: Frame, lane: Lane) => Promise<void>, private remove: () => void) { super(); }
  on(type: 'data', listener: (bytes: Uint8Array, metadata: { binary: boolean; cursor?: number }) => void): () => void;
  on(type: 'end', listener: (error?: string) => void): () => void;
  on(type: 'data' | 'end', listener: (...args: any[]) => void): () => void {
    const handler = (event: Event) => { const detail = (event as CustomEvent).detail; if (type === 'data') listener(detail.data, { binary: detail.binary, cursor: detail.cursor }); else listener(detail); };
    this.addEventListener(type, handler); return () => this.removeEventListener(type, handler);
  }
  async send(data: string | Uint8Array, cursor?: number): Promise<void> {
    if (this.ended) throw new Error('Peer stream is closed');
    const binary = typeof data !== 'string'; const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    for (let offset = 0; offset < bytes.length; offset += 24 * 1024)
      await this.transmit({ v: 1, type: 'stream-data', id: this.id, data: base64(bytes.subarray(offset, offset + 24 * 1024)), binary, cursor }, 'events');
  }
  close(error?: string): void {
    if (this.ended) return; this.remoteClose(error);
    void this.transmit({ v: 1, type: 'stream-close', id: this.id, error }, 'control').catch(() => {});
  }
  receive(data: string, binary: boolean, cursor?: number): void {
    if (!this.ended) this.dispatchEvent(new CustomEvent('data', { detail: { data: unbase64(data), binary, cursor } }));
  }
  remoteClose(error?: string): void {
    if (this.ended) return; this.ended = true; this.remove(); this.dispatchEvent(new CustomEvent('end', { detail: error }));
  }
}

/** Native browser RTC transport using the same enrolled identity and envelopes as device services. */
export class BrowserPeerClient extends EventTarget {
  readonly identity: BrowserIdentity;
  readonly localDevice: Device;
  private readonly privateKey: CryptoKey;
  private catalog = new Map<string, PairedDevice>();
  private links = new Map<string, Link>();
  private pendingPairs = new Map<string, { invitation: Invitation; timer: Timer; resolve: (device: Device) => void; reject: (error: Error) => void }>();
  private requests = new Map<string, PendingRpc>();
  private streams = new Map<string, { peerId: string; stream: BrowserPeerStream }>();
  private streamReady = new Map<string, { peerId: string; timer: Timer; resolve: () => void; reject: (error: Error) => void }>();
  private receiveSequences = new Map<string, number>();
  private initiating = new Map<string, Promise<void>>();
  private fragments = new Map<string, { peerId: string; next: number; total: number; size: number; parts: Uint8Array[]; timer: Timer }>();
  private socket?: WebSocket;
  private signalReady = false;
  private stopped = true;
  private reconnect?: Timer;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectDelay = 500;
  private sequence = 0;
  private iceServers: IceServer[];
  private relayAllowed = true;
  private signalReceive: Promise<void> = Promise.resolve();
  private signalSend: Promise<void> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();
  private constructor(private options: BrowserPeerOptions, private store: BrowserIdentityStore, state: BrowserPeerState, privateKey: CryptoKey) {
    super(); this.identity = state.identity; this.privateKey = privateKey; this.iceServers = options.iceServers ?? [];
    this.localDevice = { id: state.identity.id, name: options.name ?? 'EnoughFactory browser', platform: 'browser', arch: 'web', online: true, local: true, lastSeen: now(), publicKey: state.identity.publicKey, transport: 'local' };
    for (const device of state.devices) this.catalog.set(device.id, { ...device, online: false, local: false, transport: undefined });
  }
  static async create(options: BrowserPeerOptions = {}): Promise<BrowserPeerClient> {
    if (!globalThis.crypto?.subtle) throw new Error('Browser pairing requires HTTPS or localhost and Web Crypto');
    const store = options.identityStore ?? defaultStore(); let state = await store.load();
    if (!state) {
      let keys: CryptoKeyPair;
      try { keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair; }
      catch { throw new Error('This browser does not support Ed25519 device identities; use a current browser or the desktop app'); }
      const publicKey = pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', keys.publicKey));
      state = { identity: { id: await identityId(publicKey), publicKey, privateKey: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', keys.privateKey)) }, devices: [], signalingUrl: options.signalingUrl };
      await store.save(state);
    }
    if (await identityId(state.identity.publicKey) !== state.identity.id) throw new Error('Stored browser identity is invalid');
    const privateKey = await crypto.subtle.importKey('pkcs8', pemBytes(state.identity.privateKey), 'Ed25519', false, ['sign']);
    const proof = base64(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, encoder.encode(canonical('identity-test')))));
    if (!await verifyValue(state.identity.publicKey, 'identity-test', proof)) throw new Error('Stored browser identity keys do not match');
    for (const peer of state.devices) if (peer.id === state.identity.id || await identityId(peer.publicKey) !== peer.id) throw new Error('Stored paired device identity is invalid');
    return new BrowserPeerClient({ ...options, signalingUrl: options.signalingUrl ?? state.signalingUrl }, store, state, privateKey);
  }
  devices(): Device[] { return [this.localDevice, ...this.catalog.values()].map(device => ({ ...device })); }
  async start(): Promise<void> {
    if (!this.stopped) return; this.stopped = false; this.connectSignaling();
    this.heartbeat = setInterval(() => {
      for (const link of this.links.values()) if (link.transport)
        void this.request(link.id, { method: 'GET', path: '/__peers/ping' }, 5000).catch(() => this.disconnect(link.id, 'Connection heartbeat missed'));
    }, 15000);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.signalReady = false;
    if (this.reconnect) clearTimeout(this.reconnect); if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(); this.socket = undefined;
    for (const id of [...this.links.keys()]) this.disconnect(id, 'Browser client stopped');
    for (const pending of this.pendingPairs.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser client stopped')); } this.pendingPairs.clear();
    await this.saveChain;
  }
  async configure(settings: Pick<BrowserPeerOptions, 'signalingUrl' | 'iceServers' | 'relayFallback' | 'transport' | 'relayOnlyIce'>): Promise<void> {
    if (settings.signalingUrl) validateSignalingUrl(settings.signalingUrl);
    const running = !this.stopped; if (running) await this.stop();
    this.options = { ...this.options, ...settings }; this.iceServers = settings.iceServers ?? this.iceServers;
    await this.persist(); if (running) await this.start();
  }
  async pair(codeOrUrl: string): Promise<Device> {
    let code = codeOrUrl.trim(); if (code.includes('://')) code = new URL(code).searchParams.get('code') ?? '';
    if (!code || code.length > 16384) throw new Error('Pairing invitation is invalid');
    const invitation = JSON.parse(decoder.decode(unbase64(code))) as Invitation;
    if (invitation.v !== 1 || typeof invitation.secret !== 'string' || !invitation.secret || invitation.deviceId !== await identityId(invitation.publicKey) ||
      !Number.isFinite(Date.parse(invitation.expiresAt)) || Date.parse(invitation.expiresAt) < Date.now()) throw new Error('Pairing invitation is invalid or expired');
    if (invitation.deviceId === this.identity.id) throw new Error('This invitation belongs to this browser');
    validateSignalingUrl(invitation.signalingUrl);
    if (this.options.signalingUrl !== invitation.signalingUrl) await this.configure({ signalingUrl: invitation.signalingUrl });
    await this.waitSignaling(); const requestId = crypto.randomUUID();
    const box = await encrypt(await secretKey(invitation.secret), { device: this.localDevice }, requestId);
    const secretId = hex(await digest(encoder.encode(invitation.secret)));
    return new Promise<Device>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingPairs.delete(requestId); reject(new Error('Pairing timed out. The inviting device must be online.')); }, 20000);
      this.pendingPairs.set(requestId, { invitation, timer, resolve, reject });
      void this.signal(invitation.deviceId, 'pair:' + requestId, { kind: 'pair-request', requestId, secretId, publicKey: this.identity.publicKey, box }).catch(error => {
        clearTimeout(timer); this.pendingPairs.delete(requestId); reject(errorValue(error));
      });
    });
  }
  async forget(deviceId: string): Promise<void> {
    this.catalog.delete(deviceId); this.disconnect(deviceId, 'Device unpaired'); await this.persist(); this.notify();
  }
  private connectSignaling(): void {
    if (this.stopped || !this.options.signalingUrl) return;
    try {
      validateSignalingUrl(this.options.signalingUrl); const socket = new WebSocket(this.options.signalingUrl); this.socket = socket;
      socket.onmessage = event => {
        // Web Crypto is asynchronous. Serialize messages so authenticated sequence checks cannot race.
        this.signalReceive = this.signalReceive.catch(() => {}).then(async () => {
          if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 512 * 1024) return;
          await this.handleSignal(JSON.parse(event.data));
        }).catch(error => this.error(error));
      };
      socket.onerror = () => this.error(new Error('Signaling connection failed'));
      socket.onclose = () => {
        if (this.socket !== socket) return; this.signalReady = false; this.socket = undefined;
        this.dispatchEvent(new CustomEvent('signaling', { detail: false }));
        for (const link of [...this.links.values()]) if (link.transport === 'relay') this.disconnect(link.id, 'Signaling relay disconnected');
        if (!this.stopped) { this.reconnect = setTimeout(() => this.connectSignaling(), this.reconnectDelay); this.reconnectDelay = Math.min(15000, this.reconnectDelay * 2); }
      };
    } catch (error) { this.error(error); }
  }
  private async sign(value: unknown): Promise<string> {
    return base64(new Uint8Array(await crypto.subtle.sign('Ed25519', this.privateKey, encoder.encode(canonical(value)))));
  }
  private async handleSignal(message: any): Promise<void> {
    if (message.type === 'challenge') {
      const auth = { v: 1, type: 'auth', deviceId: this.identity.id, publicKey: this.identity.publicKey, name: this.localDevice.name, platform: 'browser', arch: 'web', nonce: message.nonce };
      const signature = await this.sign(auth); if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ ...auth, signature })); return;
    }
    if (message.type === 'auth-ok') {
      if (message.deviceId !== this.identity.id) return; this.signalReady = true; this.reconnectDelay = 500; this.relayAllowed = message.relay !== false;
      this.iceServers = [...this.options.iceServers ?? [], ...message.iceServers ?? []]; this.dispatchEvent(new CustomEvent('signaling', { detail: true })); return;
    }
    if (message.type === 'ice') { this.iceServers = [...this.options.iceServers ?? [], ...message.iceServers ?? []]; return; }
    if (message.type === 'presence') {
      const present = new Set<string>();
      for (const entry of message.devices ?? []) {
        const peer = this.catalog.get(entry.deviceId); if (!peer || peer.publicKey !== entry.publicKey || !entry.online) continue;
        present.add(peer.id); if (this.identity.id < peer.id && !this.links.has(peer.id)) void this.initiate(peer.id).catch(error => this.error(error));
      }
      for (const link of [...this.links.values()]) if (link.transport === 'relay' && !present.has(link.id)) this.disconnect(link.id, 'Peer offline'); return;
    }
    if (message.type === 'error') { this.error(new Error(message.error ?? message.message ?? 'Signaling error')); return; }
    if (message.type !== 'signal' && message.type !== 'relay') return;
    const envelope = message as SignedEnvelope;
    if (envelope.v !== 1 || envelope.to !== this.identity.id || typeof envelope.from !== 'string' || !Number.isSafeInteger(envelope.seq) ||
      envelope.seq < 0 || !Number.isSafeInteger(envelope.at) || Math.abs(Date.now() - envelope.at) > 120000 || typeof envelope.session !== 'string') return;
    const payload = envelope.payload as any; if (!payload || typeof payload !== 'object') return;
    const known = this.catalog.get(envelope.from);
    const publicKey = payload.kind === 'pair-accepted' ? this.pendingPairs.get(payload.requestId)?.invitation.publicKey : known?.publicKey;
    if (!publicKey || await identityId(publicKey) !== envelope.from || !await verifyValue(publicKey, signedPart(envelope), envelope.signature)) return;
    const key = envelope.from + ':' + envelope.type + ':' + envelope.session;
    if (envelope.seq <= (this.receiveSequences.get(key) ?? -1)) return; this.receiveSequences.set(key, envelope.seq);
    if (this.receiveSequences.size > 10000) this.receiveSequences.delete(this.receiveSequences.keys().next().value!);
    if (payload.kind === 'pair-accepted') { await this.finishPair(envelope, payload); return; }
    if (!known) return;
    if (envelope.type === 'relay') {
      const link = this.links.get(envelope.from); if (!link?.relayKey || link.session !== envelope.session || !this.relayAllowed || this.options.transport === 'webrtc' || this.options.relayFallback === false) return;
      const frame = await decrypt<Frame>(link.relayKey, payload.box, link.session + ':' + envelope.from + ':' + envelope.seq);
      if (!link.transport) this.online(link, 'relay'); await this.frame(link, frame); return;
    }
    await this.negotiate(envelope.from, envelope.session, payload);
  }
  private async finishPair(envelope: SignedEnvelope, payload: any): Promise<void> {
    const pending = this.pendingPairs.get(payload.requestId); if (!pending || envelope.session !== 'pair:' + payload.requestId) return;
    const decoded = await decrypt<{ device: PairedDevice }>(await secretKey(pending.invitation.secret), payload.box, payload.requestId);
    if (decoded.device.id !== envelope.from || decoded.device.publicKey !== pending.invitation.publicKey) return;
    const device = { ...decoded.device, online: false, local: false, transport: undefined }; const previous = this.catalog.get(device.id); this.catalog.set(device.id, device);
    try { await this.persist(); }
    catch (error) {
      if (previous) this.catalog.set(device.id, previous); else this.catalog.delete(device.id);
      clearTimeout(pending.timer); this.pendingPairs.delete(payload.requestId); pending.reject(errorValue(error)); return;
    }
    clearTimeout(pending.timer); this.pendingPairs.delete(payload.requestId); this.notify(); pending.resolve({ ...device });
    if (this.identity.id < device.id) void this.initiate(device.id).catch(error => this.error(error));
  }
  private signal(to: string, session: string, payload: unknown): Promise<void> {
    const operation = this.signalSend.catch(() => {}).then(async () => {
      if (!this.signalReady || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Signaling is unavailable');
      const envelope: Omit<SignedEnvelope, 'signature'> = { v: 1, type: 'signal', from: this.identity.id, to, session, seq: ++this.sequence, at: Date.now(), payload };
      const signature = await this.sign(envelope);
      if (!this.signalReady || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Signaling disconnected');
      this.socket.send(JSON.stringify({ ...envelope, signature }));
    }); this.signalSend = operation; return operation;
  }
  private async newLink(id: string, session: string, initiator: boolean): Promise<Link> {
    const ephemeral = await crypto.subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
    const link: Link = { id, session, initiator, ephemeral, channels: new Map(), described: false, candidates: [], seq: 0, queue: { control: [], events: [], bulk: [] }, queueBytes: { control: 0, events: 0, bulk: 0 }, draining: false };
    this.links.set(id, link); return link;
  }
  private async sendHello(link: Link): Promise<void> {
    await this.signal(link.id, link.session, { kind: 'hello', publicKey: pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', link.ephemeral.publicKey)) });
  }
  private async initiate(id: string): Promise<void> {
    const pending = this.initiating.get(id); if (pending) return pending;
    const operation = this.beginLink(id); this.initiating.set(id, operation);
    try { await operation; } finally { if (this.initiating.get(id) === operation) this.initiating.delete(id); }
  }
  private async beginLink(id: string): Promise<void> {
    if (!this.signalReady || !this.catalog.has(id) || this.stopped) return;
    const prior = this.links.get(id); if (prior?.transport || prior?.connecting) return;
    if (prior) this.disconnect(id, 'Negotiation restarted', false);
    const link = await this.newLink(id, crypto.randomUUID(), true);
    await this.sendHello(link);
    if (this.options.transport !== 'relay') void this.native(link, true).catch(error => this.error(error));
    link.connecting = setTimeout(() => {
      link.connecting = undefined; if (this.links.get(id) !== link || link.transport) return;
      if (this.options.transport !== 'webrtc' && this.options.relayFallback !== false && this.relayAllowed && link.relayKey)
        void this.signal(id, link.session, { kind: 'use-relay' }).then(() => this.online(link, 'relay')).catch(error => this.error(error));
      else this.disconnect(id, 'No direct or relay connection');
    }, this.options.transport === 'relay' ? 150 : 5000);
  }
  private async negotiate(id: string, session: string, payload: any): Promise<void> {
    let link = this.links.get(id);
    if (payload.kind === 'hello') {
      // Key generation is asynchronous in browsers; resolve the reserved outgoing negotiation first.
      const pending = this.initiating.get(id); if (pending) { await pending; link = this.links.get(id); }
      if (link && link.session !== session) {
        if (this.identity.id < id && link.initiator) return;
        this.disconnect(id, 'New peer negotiation', false); link = undefined;
      }
      if (!link) { link = await this.newLink(id, session, false); await this.sendHello(link); }
      const publicKey = await crypto.subtle.importKey('spki', pemBytes(payload.publicKey), 'X25519', false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, link.ephemeral.privateKey, 256));
      const key = await digest(concat(shared, encoder.encode(session), encoder.encode([id, this.identity.id].sort().join(':'))));
      link.relayKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
      if (this.options.transport === 'relay' && link.initiator && this.relayAllowed) { await this.signal(id, session, { kind: 'use-relay' }); this.online(link, 'relay'); } return;
    }
    if (!link || link.session !== session) return;
    if (payload.kind === 'use-relay') {
      if (this.options.transport !== 'webrtc' && this.options.relayFallback !== false && this.relayAllowed && link.relayKey) this.online(link, 'relay'); return;
    }
    if (payload.kind === 'description') {
      if (this.options.transport === 'relay') return;
      if (typeof payload.sdp !== 'string' || !/^a=fingerprint:sha-256\s+(?:[\dA-F]{2}:){31}[\dA-F]{2}\s*$/im.test(payload.sdp) || !['offer', 'answer'].includes(String(payload.type).toLowerCase())) throw new Error('Invalid authenticated peer description');
      const pc = await this.native(link, false);
      // The enrolled identity signs this entire SDP. Browser DTLS verifies its certificate fingerprint.
      await pc.setRemoteDescription({ sdp: payload.sdp, type: String(payload.type).toLowerCase() as 'offer' | 'answer' }); link.described = true;
      for (const candidate of link.candidates.splice(0)) await pc.addIceCandidate(candidate);
      if (String(payload.type).toLowerCase() === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); await this.sendDescription(link); } return;
    }
    if (payload.kind === 'candidate') {
      if (typeof payload.candidate !== 'string' || typeof payload.mid !== 'string') return;
      const candidate: RTCIceCandidateInit = { candidate: payload.candidate, sdpMid: payload.mid };
      if (link.pc && link.described) await link.pc.addIceCandidate(candidate); else if (link.candidates.length < 128) link.candidates.push(candidate);
    }
  }
  private native(link: Link, initiator: boolean): Promise<RTCPeerConnection> {
    if (link.creating) return link.creating;
    link.creating = (async () => {
      if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC is unavailable in this browser; enable the encrypted relay');
      const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: this.options.relayOnlyIce ? 'relay' : 'all' }); link.pc = pc;
      pc.onicecandidate = event => {
        if (event.candidate && this.links.get(link.id) === link)
          void this.signal(link.id, link.session, { kind: 'candidate', candidate: event.candidate.candidate, mid: event.candidate.sdpMid ?? '0' }).catch(error => this.error(error));
      };
      pc.ondatachannel = event => this.bind(link, event.channel);
      pc.onconnectionstatechange = () => {
        if (this.links.get(link.id) === link && ['failed', 'closed'].includes(pc.connectionState) && link.transport === 'webrtc') this.disconnect(link.id, 'WebRTC disconnected');
        if (pc.connectionState === 'disconnected' && link.transport === 'webrtc') {
          // Allow a transient network change to recover before declaring the peer unavailable.
          setTimeout(() => { if (this.links.get(link.id) === link && pc.connectionState === 'disconnected') this.disconnect(link.id, 'WebRTC disconnected'); }, 5000);
        }
      };
      if (initiator) {
        for (const lane of lanes) this.bind(link, pc.createDataChannel(lane, { ordered: true, protocol: 'enoughfactory.v1' }));
        await pc.setLocalDescription(await pc.createOffer()); await this.sendDescription(link);
      } return pc;
    })(); return link.creating;
  }
  private async sendDescription(link: Link): Promise<void> {
    const description = link.pc?.localDescription;
    if (description && this.links.get(link.id) === link) await this.signal(link.id, link.session, { kind: 'description', sdp: description.sdp, type: description.type });
  }
  private bind(link: Link, channel: RTCDataChannel): void {
    const lane = channel.label as Lane;
    if (!lanes.includes(lane) || channel.protocol !== 'enoughfactory.v1' || link.channels.has(lane)) { channel.close(); return; }
    link.channels.set(lane, channel); channel.bufferedAmountLowThreshold = 128 * 1024;
    channel.onopen = () => { if (this.links.get(link.id) === link && lane === 'control' && link.described) this.online(link, 'webrtc'); void this.drain(link); };
    channel.onbufferedamountlow = () => { void this.drain(link); };
    channel.onmessage = event => {
      if (this.links.get(link.id) !== link || !link.described || typeof event.data !== 'string' || encoder.encode(event.data).length > 65536) return;
      try { void this.frame(link, JSON.parse(event.data)).catch(error => this.error(error)); }
      catch (error) { this.error(error); }
    };
    channel.onerror = () => this.error(new Error('WebRTC data channel failed'));
    channel.onclose = () => { if (lane === 'control' && this.links.get(link.id) === link && link.transport === 'webrtc') this.disconnect(link.id, 'WebRTC control channel closed'); };
  }
  private online(link: Link, transport: 'webrtc' | 'relay'): void {
    if (this.links.get(link.id) !== link || !this.catalog.has(link.id)) return;
    if (link.connecting) clearTimeout(link.connecting); link.connecting = undefined; link.transport = transport;
    const peer = this.catalog.get(link.id)!; peer.online = true; peer.transport = transport; peer.lastSeen = now(); this.notify(); void this.persist().catch(error => this.error(error));
    this.dispatchEvent(new CustomEvent('online', { detail: { deviceId: link.id, transport } })); void this.drain(link);
  }
  private disconnect(id: string, reason: string, retry = true): void {
    const link = this.links.get(id); this.links.delete(id);
    if (link) {
      if (link.connecting) clearTimeout(link.connecting); link.pc?.close();
      for (const queue of Object.values(link.queue)) for (const item of queue) item.reject(new Error(reason));
    }
    const peer = this.catalog.get(id); if (peer) { peer.online = false; peer.transport = undefined; this.notify(); void this.persist().catch(error => this.error(error)); }
    for (const [requestId, pending] of this.requests) if (pending.peerId === id) { clearTimeout(pending.timer); pending.reject(new Error(reason)); this.requests.delete(requestId); }
    for (const [streamId, pending] of this.streamReady) if (pending.peerId === id) { clearTimeout(pending.timer); pending.reject(new Error(reason)); this.streamReady.delete(streamId); }
    for (const entry of [...this.streams.values()]) if (entry.peerId === id) entry.stream.remoteClose(reason);
    for (const [fragmentId, fragment] of this.fragments) if (fragment.peerId === id) { clearTimeout(fragment.timer); this.fragments.delete(fragmentId); }
    this.dispatchEvent(new CustomEvent('offline', { detail: { deviceId: id, reason } }));
    if (retry && !this.stopped && this.signalReady && this.identity.id < id && this.catalog.has(id))
      setTimeout(() => { void this.initiate(id).catch(error => this.error(error)); }, 1000);
  }
  private async waitSignaling(): Promise<void> {
    if (this.stopped) await this.start(); const until = Date.now() + 10000;
    while (!this.signalReady && !this.stopped && Date.now() < until) await pause(50);
    if (!this.signalReady) throw new Error('Signaling is unavailable');
  }
  private async waitLink(id: string): Promise<Link> {
    if (!this.catalog.has(id)) throw new Error('Device is not paired');
    if (this.stopped) await this.start();
    // Only the lower identity owns a fresh offer; pairing and presence wake that endpoint.
    if (!this.links.has(id) && this.signalReady && this.identity.id < id) await this.initiate(id);
    const until = Date.now() + 10000;
    while (Date.now() < until && !this.stopped) { const link = this.links.get(id); if (link?.transport) return link; await pause(25); }
    throw new Error('Device is offline or connection is unavailable');
  }
  private async send(id: string, frame: Frame, lane: Lane = 'control'): Promise<void> {
    const wire = JSON.stringify(frame); const bytes = encoder.encode(wire); const size = bytes.length;
    if (size > 16 * 1024 * 1024) throw new Error('Peer message exceeds 16MiB; use artifact transfer');
    if (size > 60 * 1024) {
      const fragmentId = crypto.randomUUID(); const total = Math.ceil(size / (32 * 1024));
      for (let part = 0; part < total; part++) await this.send(id, { v: 1, type: 'fragment', id: fragmentId, part, total, data: base64(bytes.subarray(part * 32 * 1024, (part + 1) * 32 * 1024)) }, lane);
      return;
    }
    const link = await this.waitLink(id);
    if (link.queueBytes[lane] + size > (lane === 'control' ? 2 : 8) * 1024 * 1024) throw new Error('Peer transport queue is full');
    return new Promise<void>((resolve, reject) => { link.queue[lane].push({ wire, size, resolve, reject }); link.queueBytes[lane] += size; void this.drain(link); });
  }
  private async drain(link: Link): Promise<void> {
    if (link.draining) return; link.draining = true;
    try {
      while (this.links.get(link.id) === link && link.transport) {
        let progress = false;
        for (const lane of lanes) {
          const item = link.queue[lane][0]; if (!item) continue;
          if (link.transport === 'webrtc') {
            const channel = link.channels.get(lane); if (channel?.readyState !== 'open' || channel.bufferedAmount > 256 * 1024) continue;
            channel.send(item.wire);
          } else {
            if (!link.relayKey || !this.signalReady || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 256 * 1024) continue;
            const seq = ++link.seq; const payload = { box: await encrypt(link.relayKey, JSON.parse(item.wire), link.session + ':' + this.identity.id + ':' + seq) };
            const envelope: Omit<SignedEnvelope, 'signature'> = { v: 1, type: 'relay', from: this.identity.id, to: link.id, session: link.session, seq, at: Date.now(), payload };
            const signature = await this.sign(envelope);
            if (this.links.get(link.id) !== link || !this.signalReady || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Relay disconnected');
            this.socket.send(JSON.stringify({ ...envelope, signature }));
          }
          link.queue[lane].shift(); link.queueBytes[lane] -= item.size; item.resolve(); progress = true;
        }
        if (!Object.values(link.queue).some(queue => queue.length)) break; await pause(progress ? 0 : 10);
      }
    } catch (error) { this.error(error); if (this.links.get(link.id) === link) this.disconnect(link.id, errorValue(error).message); }
    finally { link.draining = false; }
  }
  async request(deviceId: string, request: Omit<RpcRequest, 'v' | 'id'>, timeout = 30000, lane: Lane = 'control'): Promise<RpcResponse> {
    const id = crypto.randomUUID();
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Remote request timed out; execution outcome may be unknown')); }, timeout);
      this.requests.set(id, { peerId: deviceId, timer, resolve, reject });
      void this.send(deviceId, { v: 1, id, ...request }, lane).catch(error => { clearTimeout(timer); this.requests.delete(id); reject(errorValue(error)); });
    });
  }
  private async frame(link: Link, frame: Frame): Promise<void> {
    if (!frame || frame.v !== 1 || this.links.get(link.id) !== link) return;
    if ('type' in frame && frame.type === 'fragment') {
      if (typeof frame.id !== 'string' || frame.id.length > 128 || !Number.isSafeInteger(frame.total) || frame.total < 1 || frame.total > 512 ||
        !Number.isSafeInteger(frame.part) || frame.part < 0 || frame.part >= frame.total || typeof frame.data !== 'string' || frame.data.length > 45000) throw new Error('Invalid peer message fragment');
      const key = link.id + ':' + frame.id; let fragment = this.fragments.get(key);
      if (!fragment) {
        if (frame.part !== 0 || [...this.fragments.values()].filter(entry => entry.peerId === link.id).length >= 4) throw new Error('Peer fragment capacity or sequence exceeded');
        const timer = setTimeout(() => this.fragments.delete(key), 30000);
        fragment = { peerId: link.id, next: 0, total: frame.total, size: 0, parts: [], timer }; this.fragments.set(key, fragment);
      }
      const bytes = unbase64(frame.data);
      if (fragment.next !== frame.part || fragment.total !== frame.total || bytes.length > 32 * 1024 || (fragment.size + bytes.length) > 16 * 1024 * 1024) {
        clearTimeout(fragment.timer); this.fragments.delete(key); throw new Error('Invalid peer fragment ordering or size');
      }
      fragment.parts.push(bytes); fragment.size += bytes.length; fragment.next++;
      if (fragment.next === fragment.total) {
        clearTimeout(fragment.timer); this.fragments.delete(key);
        const assembled = JSON.parse(decoder.decode(concat(...fragment.parts))) as Frame;
        if ('type' in assembled && assembled.type === 'fragment') throw new Error('Nested peer fragmentation is invalid');
        await this.frame(link, assembled);
      } return;
    }
    const peer = this.catalog.get(link.id); if (peer) peer.lastSeen = now();
    if ('status' in frame && 'id' in frame) {
      const pending = this.requests.get(frame.id); if (pending?.peerId === link.id) { clearTimeout(pending.timer); this.requests.delete(frame.id); pending.resolve(frame); } return;
    }
    if ('method' in frame) {
      // A browser never grants access to host execution. It only answers the transport liveness route.
      const response: RpcResponse = { v: 1, id: frame.id, status: frame.path === '/__peers/ping' ? 200 : 404, body: frame.path === '/__peers/ping' ? { deviceId: this.identity.id, at: now() } : { error: 'Browser clients do not expose a device API' } };
      await this.send(link.id, response); return;
    }
    if (!('type' in frame)) return;
    if (frame.type === 'event') { this.options.onEvent?.(link.id, frame); this.dispatchEvent(new CustomEvent('event', { detail: { deviceId: link.id, event: frame } })); return; }
    if (frame.type === 'stream-open') { await this.send(link.id, { v: 1, type: 'stream-close', id: frame.id, error: 'Browser clients do not expose incoming streams' }); return; }
    const entry = this.streams.get(frame.id); if (!entry || entry.peerId !== link.id) return;
    if (frame.type === 'stream-ready') { const pending = this.streamReady.get(frame.id); if (pending?.peerId === link.id) { clearTimeout(pending.timer); this.streamReady.delete(frame.id); pending.resolve(); } return; }
    if (frame.type === 'stream-data') entry.stream.receive(frame.data, frame.binary, frame.cursor);
    if (frame.type === 'stream-close') {
      const pending = this.streamReady.get(frame.id); if (pending) { clearTimeout(pending.timer); this.streamReady.delete(frame.id); pending.reject(new Error(frame.error ?? 'Remote stream closed')); }
      entry.stream.remoteClose(frame.error);
    }
  }
  async openStream(deviceId: string, options: StreamOptions): Promise<BrowserPeerStream> {
    if (this.streams.size >= 128) throw new Error('Stream capacity reached');
    const id = crypto.randomUUID(); const stream = new BrowserPeerStream(id, (frame, lane) => this.send(deviceId, frame, lane), () => this.streams.delete(id)); this.streams.set(id, { peerId: deviceId, stream });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.streamReady.delete(id); stream.remoteClose('Stream open timed out'); reject(new Error('Stream open timed out')); }, 15000);
      this.streamReady.set(id, { peerId: deviceId, timer, resolve, reject });
      void this.send(deviceId, { v: 1, type: 'stream-open', id, options }).catch(error => { clearTimeout(timer); this.streamReady.delete(id); stream.remoteClose(errorValue(error).message); reject(errorValue(error)); });
    }); return stream;
  }
  async uploadArtifact(deviceId: string, blob: Blob, manifest: ArtifactManifest): Promise<void> {
    if (blob.size !== manifest.size) throw new Error('Artifact size does not match manifest');
    let response = await this.request(deviceId, { method: 'POST', path: '/__peers/transfers/start', body: manifest });
    if (response.status !== 200) throw new Error(JSON.stringify(response.body));
    let offset = Number((response.body as { offset?: number }).offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > blob.size) throw new Error('Invalid remote transfer offset');
    while (offset < blob.size) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid remote transfer offset');
      const bytes = new Uint8Array(await blob.slice(offset, offset + 24 * 1024).arrayBuffer());
      response = await this.request(deviceId, { method: 'POST', path: '/__peers/transfers/chunk', body: { id: manifest.id, offset, data: base64(bytes) } }, 30000, 'bulk');
      if (response.status !== 200) throw new Error(JSON.stringify(response.body));
      const next = Number((response.body as { offset?: number }).offset); if (next !== offset + bytes.length) throw new Error('Invalid remote transfer acknowledgement'); offset = next;
    }
    response = await this.request(deviceId, { method: 'POST', path: '/__peers/transfers/finish', body: { id: manifest.id } });
    if (response.status !== 200) throw new Error(JSON.stringify(response.body));
  }
  private notify(): void {
    const devices = this.devices(); this.options.onDevices?.(devices); for (const device of devices) this.options.onDevice?.(device);
    this.dispatchEvent(new CustomEvent('devices', { detail: devices }));
  }
  private persist(): Promise<void> {
    this.saveChain = this.saveChain.catch(() => {}).then(() => this.store.save({ identity: this.identity, devices: [...this.catalog.values()], signalingUrl: this.options.signalingUrl })); return this.saveChain;
  }
  private error(error: unknown): void { const value = errorValue(error); this.options.onError?.(value); this.dispatchEvent(new CustomEvent('diagnostic', { detail: value })); }
}
