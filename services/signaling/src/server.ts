import { createHmac, randomBytes, verify, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { authPayload, canonical, envelopePayload, identity, type Auth, type DeviceMetadata, type Envelope, type IceServer } from './protocol.ts';
import { generateCloudflareIceServers, type CloudflareTurnConfig } from './ice.ts';

export interface SignalingConfig {
  host: string;
  port: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  turnTtlSeconds: number;
  allowRelay: boolean;
  allowedOrigins: string[];
  deviceIds: string[];
  maxConnections: number;
  cloudflareTurn?: CloudflareTurnConfig;
}
interface Peer {
  socket: WebSocket;
  nonce: string;
  authenticated: boolean;
  metadata?: DeviceMetadata;
  key?: KeyObject;
  alive: boolean;
  sequences: Map<string, { seq: number; at: number }>;
  windowAt: number;
  messages: number;
  bytes: number;
  authTimeout: ReturnType<typeof setTimeout>;
  issuedIce?: { servers: IceServer[]; refreshAt: number };
  issuingIce?: Promise<IceServer[]>;
}

const ids = /^[a-f0-9]{32}$/;
const maxMessageBytes = 512 * 1024;
const maxPendingBytes = 4 * 1024 * 1024;
const maxSkewMs = 5 * 60 * 1000;
function list(value: string | undefined): string[] { return value?.split(',').map(item => item.trim()).filter(Boolean) ?? []; }
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid configuration number: ${value}`);
  return parsed;
}
export function configFromEnvironment(env = process.env): SignalingConfig {
  const turnUrls = list(env.TURN_URLS);
  if (turnUrls.length && !env.TURN_SECRET) throw new Error('TURN_URLS requires a server-only TURN_SECRET.');
  const deviceIds = list(env.ENOUGH_SIGNALING_DEVICE_IDS);
  if (deviceIds.some(deviceId => !ids.test(deviceId))) throw new Error('ENOUGH_SIGNALING_DEVICE_IDS must contain 32-character device IDs.');
  if (turnUrls.length && !deviceIds.length) throw new Error('TURN_URLS requires ENOUGH_SIGNALING_DEVICE_IDS to restrict relay resource admission.');
  const cloudflareTurn = env.CLOUDFLARE_TURN_KEY_ID || env.CLOUDFLARE_TURN_API_TOKEN ? {
    keyId: env.CLOUDFLARE_TURN_KEY_ID ?? '', apiToken: env.CLOUDFLARE_TURN_API_TOKEN ?? '',
    ttlSeconds: integer(env.TURN_TTL_SECONDS, 3600, 60, 172800),
  } : undefined;
  if (cloudflareTurn && (!cloudflareTurn.keyId || !cloudflareTurn.apiToken || !deviceIds.length)) throw new Error('Cloudflare TURN requires server-only key/token and ENOUGH_SIGNALING_DEVICE_IDS.');
  if (cloudflareTurn && turnUrls.length) throw new Error('Choose coturn or Cloudflare TURN credentials, rather than combining providers.');
  const stunUrls = list(env.STUN_URLS ?? 'stun:stun.cloudflare.com:3478');
  if (stunUrls.some(url => !/^stuns?:[^\s]+$/.test(url)) || turnUrls.some(url => !/^turns?:[^\s]+$/.test(url))) throw new Error('Invalid STUN or TURN URL.');
  return {
    host: env.ENOUGH_SIGNALING_HOST ?? '0.0.0.0',
    port: integer(env.PORT, 8788, 0, 65535),
    stunUrls, turnUrls, turnSecret: env.TURN_SECRET, cloudflareTurn,
    turnTtlSeconds: cloudflareTurn?.ttlSeconds ?? integer(env.TURN_TTL_SECONDS, 3600, 60, 86400),
    allowRelay: env.ENOUGH_SIGNALING_ALLOW_RELAY !== 'false',
    allowedOrigins: list(env.ENOUGH_SIGNALING_ALLOWED_ORIGINS),
    deviceIds,
    maxConnections: integer(env.ENOUGH_SIGNALING_MAX_CONNECTIONS, 1024, 1, 100000),
  };
}

/** Temporary coturn REST credentials are issued only to challenge-authenticated sockets. */
export function iceServers(config: SignalingConfig, deviceId: string, now = Date.now()): IceServer[] {
  const servers: IceServer[] = config.stunUrls.length ? [{ urls: config.stunUrls }] : [];
  if (config.turnSecret && config.turnUrls.length) {
    const username = `${Math.floor(now / 1000) + config.turnTtlSeconds}:${deviceId}`;
    servers.push({ urls: config.turnUrls, username, credential: createHmac('sha1', config.turnSecret).update(username).digest('base64'), expiresAt: (Math.floor(now / 1000) + config.turnTtlSeconds) * 1000 });
  }
  return servers;
}

export interface SignalingService {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}
export function createSignalingService(config: SignalingConfig): SignalingService {
  const clients = new Set<Peer>();
  const devices = new Map<string, Peer>();
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: 'enoughfactory-signaling', protocol: 1 }));
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    }
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== '/ws' || clients.size >= config.maxConnections || (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, connection => websocket.emit('connection', connection, request));
  });
  function send(peer: Peer, value: unknown): boolean {
    if (peer.socket.readyState !== WebSocket.OPEN) return false;
    if (peer.socket.bufferedAmount > maxPendingBytes) { peer.socket.close(1013, 'Slow receiver'); return false; }
    peer.socket.send(JSON.stringify(value));
    return true;
  }
  function error(peer: Peer, code: string, message: string, envelope?: Partial<Envelope>) {
    send(peer, { v: 1, type: 'error', code, message, ...(envelope ? { to: envelope.to, session: envelope.session } : {}) });
  }
  function presence() {
    const value = { v: 1, type: 'presence', devices: [...devices.values()].map(peer => ({ ...peer.metadata!, online: true, lastSeen: Date.now() })) };
    for (const peer of devices.values()) send(peer, value);
  }
  async function issueIce(peer: Peer): Promise<IceServer[]> {
    if (!config.cloudflareTurn) return iceServers(config, peer.metadata!.deviceId);
    if (peer.issuedIce && peer.issuedIce.refreshAt > Date.now()) return peer.issuedIce.servers;
    if (peer.issuingIce) return peer.issuingIce;
    const issuance = (async () => {
      const servers = iceServers(config, peer.metadata!.deviceId);
      let refreshAt = Date.now() + 30000;
      try {
        const managed = await generateCloudflareIceServers(config.cloudflareTurn!, peer.metadata!.deviceId);
        servers.push(...managed);
        refreshAt = Math.min(...managed.filter(server => server.expiresAt).map(server => server.expiresAt!)) - 60000;
      } catch { error(peer, 'ice_unavailable', 'Temporary TURN credentials are unavailable; direct WebRTC and encrypted WSS remain available.'); }
      peer.issuedIce = { servers, refreshAt: Math.max(Date.now() + 30000, refreshAt) };
      return servers;
    })();
    peer.issuingIce = issuance;
    try { return await issuance; } finally { if (peer.issuingIce === issuance) peer.issuingIce = undefined; }
  }
  async function authenticate(peer: Peer, value: unknown) {
    if (!value || typeof value !== 'object') throw new Error('Expected authentication.');
    const auth = value as Auth;
    if (auth.v !== 1 || auth.type !== 'auth' || typeof auth.deviceId !== 'string' || !ids.test(auth.deviceId) || auth.nonce !== peer.nonce ||
      typeof auth.publicKey !== 'string' || auth.publicKey.length > 1024 || typeof auth.signature !== 'string' || auth.signature.length > 128 ||
      typeof auth.name !== 'string' || !auth.name.trim() || auth.name.length > 128 ||
      typeof auth.platform !== 'string' || auth.platform.length > 32 || typeof auth.arch !== 'string' || auth.arch.length > 32) throw new Error('Invalid authentication fields.');
    const identified = identity(auth.publicKey);
    if (identified.deviceId !== auth.deviceId || !verify(null, Buffer.from(canonical(authPayload(auth))), identified.key, Buffer.from(auth.signature, 'base64'))) throw new Error('Invalid identity signature.');
    if (config.deviceIds.length && !config.deviceIds.includes(auth.deviceId)) throw new Error('This device is not admitted to the signaling service.');
    peer.authenticated = true;
    peer.nonce = '';
    peer.key = identified.key;
    peer.metadata = { deviceId: auth.deviceId, publicKey: auth.publicKey, name: auth.name, platform: auth.platform, arch: auth.arch };
    clearTimeout(peer.authTimeout);
    const previous = devices.get(auth.deviceId);
    devices.set(auth.deviceId, peer);
    previous?.socket.close(4001, 'Identity reconnected');
    send(peer, { v: 1, type: 'auth-ok', deviceId: auth.deviceId, iceServers: await issueIce(peer), relay: config.allowRelay });
    presence();
  }
  async function route(peer: Peer, value: unknown) {
    if (devices.get(peer.metadata!.deviceId) !== peer) throw new Error('This connection has been superseded.');
    if (!value || typeof value !== 'object') throw new Error('Expected protocol object.');
    const envelope = value as Envelope;
    if (envelope.v === 1 && (envelope as unknown as { type: string }).type === 'ice-request') {
      send(peer, { v: 1, type: 'ice', iceServers: await issueIce(peer) });
      return;
    }
    if (envelope.v !== 1 || !['signal', 'relay'].includes(envelope.type) || envelope.from !== peer.metadata!.deviceId ||
      typeof envelope.to !== 'string' || !ids.test(envelope.to) || envelope.to === envelope.from ||
      typeof envelope.session !== 'string' || !envelope.session || envelope.session.length > 128 ||
      !Number.isSafeInteger(envelope.seq) || envelope.seq < 0 || !Number.isSafeInteger(envelope.at) || Math.abs(Date.now() - envelope.at) > maxSkewMs ||
      typeof envelope.signature !== 'string' || envelope.signature.length > 128 || envelope.payload === undefined) throw new Error('Invalid envelope fields.');
    if (!verify(null, Buffer.from(canonical(envelopePayload(envelope))), peer.key!, Buffer.from(envelope.signature, 'base64'))) throw new Error('Invalid envelope signature.');
    const replayKey = `${envelope.type}:${envelope.to}:${envelope.session}`;
    const previous = peer.sequences.get(replayKey);
    if (previous && envelope.seq <= previous.seq) { error(peer, 'replay', 'Envelope sequence was already consumed.', envelope); return; }
    if (peer.sequences.size >= 10000 && !previous) throw new Error('Too many concurrent signaling sessions.');
    peer.sequences.set(replayKey, { seq: envelope.seq, at: envelope.at });
    if (envelope.type === 'relay' && !config.allowRelay) { error(peer, 'relay_disabled', 'WSS relay is disabled.', envelope); return; }
    const target = devices.get(envelope.to);
    if (!target || !send(target, envelope)) error(peer, 'peer_offline', 'Target device is unavailable.', envelope);
  }
  websocket.on('connection', socket => {
    const peer: Peer = {
      socket, nonce: randomBytes(32).toString('base64url'), authenticated: false,
      alive: true, sequences: new Map(), windowAt: Date.now(), messages: 0, bytes: 0,
      authTimeout: setTimeout(() => socket.close(4000, 'Authentication timeout'), 10000),
    };
    clients.add(peer);
    send(peer, { v: 1, type: 'challenge', nonce: peer.nonce });
    socket.on('pong', () => { peer.alive = true; });
    socket.on('error', () => { /* Close events own cleanup; individual transport failures are not server failures. */ });
    socket.on('message', async (data: RawData, binary: boolean) => {
      if (binary) { socket.close(1003, 'JSON text frames required'); return; }
      const size = Buffer.byteLength(data.toString());
      const now = Date.now();
      if (now - peer.windowAt >= 1000) { peer.windowAt = now; peer.messages = 0; peer.bytes = 0; }
      if (++peer.messages > 200 || (peer.bytes += size) > 4 * 1024 * 1024) { socket.close(1008, 'Rate limit'); return; }
      if (data.toString() === 'ping') { if (peer.authenticated) socket.send('pong'); return; }
      try {
        const value: unknown = JSON.parse(data.toString());
        if (peer.authenticated) await route(peer, value); else await authenticate(peer, value);
      } catch (cause) {
        error(peer, peer.authenticated ? 'invalid_message' : 'authentication_failed', cause instanceof Error ? cause.message : 'Invalid request.');
        if (!peer.authenticated) socket.close(4003, 'Authentication failed');
      }
    });
    socket.on('close', () => {
      clients.delete(peer);
      clearTimeout(peer.authTimeout);
      if (peer.metadata && devices.get(peer.metadata.deviceId) === peer) {
        devices.delete(peer.metadata.deviceId);
        presence();
      }
    });
  });
  const heartbeat = setInterval(() => {
    const oldest = Date.now() - maxSkewMs;
    for (const peer of clients) {
      if (!peer.alive) { peer.socket.terminate(); continue; }
      peer.alive = false;
      peer.socket.ping();
      for (const [key, value] of peer.sequences) if (value.at < oldest) peer.sequences.delete(key);
    }
  }, 30000);
  heartbeat.unref();
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('No TCP listening address.')); return; }
        resolve({ host: config.host, port: address.port });
      });
    }),
    close: async () => {
      clearInterval(heartbeat);
      for (const peer of clients) { clearTimeout(peer.authTimeout); peer.socket.terminate(); }
      await new Promise<void>((resolve, reject) => websocket.close(error => error ? reject(error) : resolve()));
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
