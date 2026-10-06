import { DurableObject } from 'cloudflare:workers';
import { createHash, randomBytes, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { generateCloudflareIceServers, type CloudflareTurnConfig } from '../../signaling/src/ice.ts';
import {
  authPayload, canonical, envelopePayload, identity,
  type Auth, type DeviceMetadata, type Envelope, type IceServer,
} from '../../signaling/src/protocol.ts';

export interface Env {
  SIGNALING: DurableObjectNamespace<SignalingHub>;
  STUN_URLS?: string;
  ENOUGH_SIGNALING_ALLOW_RELAY?: string;
  ENOUGH_SIGNALING_ALLOWED_ORIGINS?: string;
  ENOUGH_SIGNALING_DEVICE_IDS?: string;
  ENOUGH_SIGNALING_MAX_CONNECTIONS?: string;
  ENOUGH_SIGNALING_MAX_ROOM_CONNECTIONS?: string;
  ENOUGH_SIGNALING_MAX_IP_CONNECTIONS?: string;
  ENOUGH_SIGNALING_DAILY_MESSAGES?: string;
  ENOUGH_SIGNALING_DAILY_RELAY_BYTES?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
}
interface Config {
  stunUrls: string[];
  relay: boolean;
  origins: string[];
  deviceIds: string[];
  connections: number;
  roomConnections: number;
  ipConnections: number;
  dailyMessages: number;
  dailyRelayBytes: number;
  cloudflareTurn?: CloudflareTurnConfig;
}
interface Attachment {
  id: string;
  room: string;
  ip: string;
  nonce: string;
  authBy: number;
  metadata?: Pick<DeviceMetadata, 'deviceId' | 'publicKey'>;
  deliveryAcknowledgments: boolean;
  windowAt: number;
  messages: number;
  bytes: number;
  iceIssuedAt?: number;
}
const deviceIdPattern = /^[a-f0-9]{32}$/;
const roomPattern = /^[a-zA-Z0-9_-]{1,96}$/;
const maxFrameBytes = 512 * 1024;
const maxPendingBytes = 4 * 1024 * 1024;
const maxPendingFrames = 128;
const maxSkewMs = 5 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const list = (value?: string): string[] => value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('Invalid signaling limit.');
  return parsed;
}
function config(env: Env): Config {
  const stunUrls = list(env.STUN_URLS ?? 'stun:stun.cloudflare.com:3478');
  const deviceIds = list(env.ENOUGH_SIGNALING_DEVICE_IDS);
  if (stunUrls.some(url => !/^stuns?:[^\s]+$/.test(url)) || deviceIds.some(id => !deviceIdPattern.test(id))) throw new Error('Invalid signaling configuration.');
  const cloudflareTurn = env.CLOUDFLARE_TURN_KEY_ID || env.CLOUDFLARE_TURN_API_TOKEN ? {
    keyId: env.CLOUDFLARE_TURN_KEY_ID ?? '', apiToken: env.CLOUDFLARE_TURN_API_TOKEN ?? '',
    ttlSeconds: integer(env.TURN_TTL_SECONDS, 3600, 60, 172800),
  } : undefined;
  if (cloudflareTurn && (!cloudflareTurn.keyId || !cloudflareTurn.apiToken || !deviceIds.length))
    throw new Error('Managed TURN requires server-only credentials and an admitted device ID list.');
  return {
    stunUrls, deviceIds, cloudflareTurn, origins: list(env.ENOUGH_SIGNALING_ALLOWED_ORIGINS),
    relay: env.ENOUGH_SIGNALING_ALLOW_RELAY !== 'false',
    connections: integer(env.ENOUGH_SIGNALING_MAX_CONNECTIONS, 128, 1, 1024),
    roomConnections: integer(env.ENOUGH_SIGNALING_MAX_ROOM_CONNECTIONS, 32, 1, 1024),
    ipConnections: integer(env.ENOUGH_SIGNALING_MAX_IP_CONNECTIONS, 8, 1, 128),
    dailyMessages: integer(env.ENOUGH_SIGNALING_DAILY_MESSAGES, 10000, 1, 10000000),
    dailyRelayBytes: integer(env.ENOUGH_SIGNALING_DAILY_RELAY_BYTES, 1024 ** 3, 0, 1024 ** 4),
  };
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', service: 'enoughfactory-signaling', protocol: 1, transport: 'cloudflare-hibernation' });
    }
    if (url.pathname !== '/ws') return json({ error: 'not_found' }, 404);
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    const room = url.searchParams.get('room') ?? 'default';
    if (!roomPattern.test(room) || [...url.searchParams.keys()].some(key => key !== 'room')) return json({ error: 'invalid_room' }, 400);
    // A single hub provides deployment-wide caps. Room names partition presence/routing,
    // rather than allowing arbitrary room creation to bypass those caps.
    return env.SIGNALING.getByName('hub-v1').fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** Hibernating introduction + opaque relay. SQLite contains only resource/replay counters. */
export class SignalingHub extends DurableObject<Env> {
  private readonly limits: Config;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = config(env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS counters (
      scope TEXT PRIMARY KEY, bucket INTEGER NOT NULL, messages INTEGER NOT NULL, bytes INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sequences (
      connection TEXT NOT NULL, replay_key TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (connection, replay_key)
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, receiver TEXT NOT NULL, bytes INTEGER NOT NULL, issued_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS deliveries_receiver ON deliveries(receiver)');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
      connection TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (connection, device_id)
    )`);
    // Literal heartbeat frames are answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.setHibernatableWebSocketEventTimeout(15000);
  }
  private attachment(socket: WebSocket): Attachment | undefined {
    return socket.deserializeAttachment() as Attachment | undefined;
  }
  private sockets(room?: string): WebSocket[] {
    return this.ctx.getWebSockets(room ? `room:${room}` : undefined).filter(socket => socket.readyState === WebSocket.OPEN);
  }
  private find(room: string, deviceId: string): WebSocket | undefined {
    return this.sockets(room).find(socket => this.attachment(socket)?.metadata?.deviceId === deviceId);
  }
  private count(scope: string, bucket: number, messages: number, bytes = 0): { messages: number; bytes: number } {
    return this.ctx.storage.sql.exec<{ messages: number; bytes: number }>(`INSERT INTO counters VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET bucket = excluded.bucket,
      messages = CASE WHEN counters.bucket = excluded.bucket THEN counters.messages + excluded.messages ELSE excluded.messages END,
      bytes = CASE WHEN counters.bucket = excluded.bucket THEN counters.bytes + excluded.bytes ELSE excluded.bytes END
      RETURNING messages, bytes`, scope, bucket, messages, bytes).one();
  }
  private cleanupConnection(id: string): void {
    this.ctx.storage.sql.exec('DELETE FROM sequences WHERE connection = ?', id);
    this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE receiver = ?', id);
    this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE connection = ?', id);
  }
  private close(socket: WebSocket, code: number, reason: string): void {
    const state = this.attachment(socket);
    if (state) this.cleanupConnection(state.id);
    try { socket.close(code, reason); } catch { /* The runtime may already have closed the socket. */ }
  }
  private send(socket: WebSocket, value: unknown, track = false): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const state = this.attachment(socket);
    if (!state) return false;
    let wire = JSON.stringify(value);
    if (track) {
      const pending = this.ctx.storage.sql.exec<{ frames: number; bytes: number; oldest: number | null }>(
        'SELECT COUNT(*) AS frames, COALESCE(SUM(bytes), 0) AS bytes, MIN(issued_at) AS oldest FROM deliveries WHERE receiver = ?', state.id).one();
      const id = crypto.randomUUID();
      wire = JSON.stringify({ ...value as Record<string, unknown>, deliveryId: id });
      const size = encoder.encode(wire).byteLength;
      if (pending.frames >= maxPendingFrames || pending.bytes + size > maxPendingBytes || (pending.oldest !== null && pending.oldest < Date.now() - 30000)) {
        this.close(socket, 1013, 'Slow receiver');
        return false;
      }
      // Only the receipt ID and size are retained; never persist the forwarded body.
      this.ctx.storage.sql.exec('INSERT INTO deliveries VALUES (?, ?, ?, ?)', id, state.id, size, Date.now());
    }
    try { socket.send(wire); return true; } catch { this.close(socket, 1013, 'Receiver unavailable'); return false; }
  }
  private error(socket: WebSocket, code: string, message: string, envelope?: Partial<Envelope>): void {
    this.send(socket, { v: 1, type: 'error', code, message, ...(envelope ? { to: envelope.to, session: envelope.session } : {}) });
  }
  private presence(room: string): void {
    const sockets = this.sockets(room).filter(socket => this.attachment(socket)?.metadata);
    for (const socket of sockets) {
      const state = this.attachment(socket)!;
      const known = new Set(this.ctx.storage.sql.exec<{ device_id: string }>('SELECT device_id FROM subscriptions WHERE connection = ?', state.id).toArray().map(row => row.device_id));
      known.add(state.metadata!.deviceId);
      const devices = sockets.map(peer => this.attachment(peer)!.metadata!).filter(metadata => known.has(metadata.deviceId))
        .map(({ deviceId, publicKey }) => ({ deviceId, publicKey, online: true, lastSeen: Date.now() }));
      // No global device roster or human names/platforms. Only requested contact
      // identities are introduced; the paired protocol remains the authorization.
      this.send(socket, { v: 1, type: 'presence', devices }, true);
    }
  }
  private subscribe(state: Attachment, devices: unknown): void {
    if (!Array.isArray(devices) || devices.length > 128 || devices.some(id => typeof id !== 'string' || !deviceIdPattern.test(id))) throw new Error('Invalid discovery contacts.');
    this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE connection = ?', state.id);
    for (const id of new Set(devices as string[])) this.ctx.storage.sql.exec('INSERT INTO subscriptions VALUES (?, ?)', state.id, id);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/ws' || request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'not_found' }, 404);
    const origin = request.headers.get('Origin');
    if (origin && this.limits.origins.length && !this.limits.origins.includes(origin)) return json({ error: 'origin_not_admitted' }, 403);
    const room = url.searchParams.get('room') ?? 'default';
    if (!roomPattern.test(room)) return json({ error: 'invalid_room' }, 400);
    const now = Date.now();
    // CF supplies this header at its edge. Store a digest solely for admission counters.
    const ip = createHash('sha256').update(request.headers.get('CF-Connecting-IP') ?? 'local-development').digest('hex');
    const sockets = this.sockets();
    // Expired anonymous sockets cannot reserve capacity indefinitely; an alarm also
    // enforces this deadline when no later connection/message arrives.
    for (const socket of sockets) {
      const state = this.attachment(socket);
      if (state && !state.metadata && state.authBy <= now) this.close(socket, 4000, 'Authentication timeout');
    }
    const active = this.sockets();
    if (active.length >= this.limits.connections || active.filter(socket => this.attachment(socket)?.room === room).length >= this.limits.roomConnections ||
      active.filter(socket => this.attachment(socket)?.ip === ip).length >= this.limits.ipConnections) return json({ error: 'connection_capacity' }, 429);
    // Bound both reconnect churn and the number of IP counter rows. Idle counters
    // are removed at admission, rather than by a repeating timer/alarm.
    this.ctx.storage.sql.exec('DELETE FROM counters WHERE scope LIKE ? AND bucket < ?', 'ip:%', Math.floor(now / 60000) - 1);
    const ipRows = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM counters WHERE scope LIKE ?', 'ip:%').one().count;
    if (ipRows >= 1024) return json({ error: 'admission_capacity' }, 429);
    if (this.count(`ip:${ip}`, Math.floor(now / 60000), 1).messages > 30 || this.count('connections', Math.floor(now / dayMs), 1).messages > 500) return json({ error: 'connection_rate_limit' }, 429);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const state: Attachment = {
      id: crypto.randomUUID(), room, ip, nonce: Buffer.from(randomBytes(32)).toString('base64url'), authBy: now + 10000,
      deliveryAcknowledgments: false, windowAt: now, messages: 0, bytes: 0,
    };
    this.ctx.acceptWebSocket(server, [`room:${room}`]);
    server.serializeAttachment(state);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || state.authBy < alarm) await this.ctx.storage.setAlarm(state.authBy);
    this.send(server, { v: 1, type: 'challenge', nonce: state.nonce });
    return new Response(null, { status: 101, webSocket: client });
  }
  private async ice(socket: WebSocket, state: Attachment): Promise<IceServer[]> {
    state.iceIssuedAt = Date.now();
    socket.serializeAttachment(state);
    const servers: IceServer[] = this.limits.stunUrls.length ? [{ urls: this.limits.stunUrls }] : [];
    if (this.limits.cloudflareTurn) {
      try { servers.push(...await generateCloudflareIceServers(this.limits.cloudflareTurn, state.metadata!.deviceId)); }
      catch { this.error(socket, 'ice_unavailable', 'Temporary TURN credentials are unavailable; direct WebRTC and encrypted WSS remain available.'); }
    }
    return servers;
  }
  private async authenticate(socket: WebSocket, state: Attachment, value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') throw new Error('Expected authentication.');
    const auth = value as Auth & { deliveryAcknowledgments?: boolean; discoverPeers?: unknown };
    if (Date.now() > state.authBy || auth.v !== 1 || auth.type !== 'auth' || typeof auth.deviceId !== 'string' || !deviceIdPattern.test(auth.deviceId) || auth.nonce !== state.nonce ||
      typeof auth.publicKey !== 'string' || auth.publicKey.length > 1024 || typeof auth.signature !== 'string' || auth.signature.length > 128 ||
      typeof auth.name !== 'string' || !auth.name.trim() || auth.name.length > 128 ||
      typeof auth.platform !== 'string' || auth.platform.length > 32 || typeof auth.arch !== 'string' || auth.arch.length > 32) throw new Error('Invalid authentication fields.');
    const identified = identity(auth.publicKey);
    if (identified.deviceId !== auth.deviceId || !verify(null, Buffer.from(canonical(authPayload(auth))), identified.key, Buffer.from(auth.signature, 'base64'))) throw new Error('Invalid identity signature.');
    if (this.limits.deviceIds.length && !this.limits.deviceIds.includes(auth.deviceId)) throw new Error('This device is not admitted to the signaling service.');
    this.subscribe(state, auth.discoverPeers ?? []);
    const previous = this.find(state.room, auth.deviceId);
    if (previous && previous !== socket) this.close(previous, 4001, 'Identity reconnected');
    state.metadata = { deviceId: auth.deviceId, publicKey: auth.publicKey };
    state.nonce = '';
    state.deliveryAcknowledgments = auth.deliveryAcknowledgments === true;
    socket.serializeAttachment(state);
    const iceServers = await this.ice(socket, state);
    socket.serializeAttachment(state);
    this.send(socket, { v: 1, type: 'auth-ok', deviceId: auth.deviceId, iceServers,
      // Legacy clients can negotiate direct WebRTC. Hosted relay requires the
      // delivery extension so a slow receiver cannot accumulate an unbounded queue.
      relay: this.limits.relay && state.deliveryAcknowledgments,
      deliveryAcknowledgments: state.deliveryAcknowledgments,
      relayLimits: { bytesPerSecond: 512 * 1024, messagesPerSecond: 20 } });
    this.presence(state.room);
  }
  private async route(socket: WebSocket, state: Attachment, value: unknown): Promise<void> {
    if (this.find(state.room, state.metadata!.deviceId) !== socket) throw new Error('This connection has been superseded.');
    if (!value || typeof value !== 'object') throw new Error('Expected protocol object.');
    const control = value as { v?: number; type?: string; id?: unknown; devices?: unknown };
    if (control.v === 1 && control.type === 'delivery-ack') {
      if (!state.deliveryAcknowledgments || typeof control.id !== 'string' || control.id.length > 128) throw new Error('Invalid delivery acknowledgment.');
      this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE id = ? AND receiver = ?', control.id, state.id);
      return;
    }
    if (control.v === 1 && control.type === 'discover') {
      this.subscribe(state, control.devices);
      this.presence(state.room);
      return;
    }
    if (control.v === 1 && control.type === 'ice-request') {
      if (state.iceIssuedAt && Date.now() - state.iceIssuedAt < 30000) { this.error(socket, 'ice_rate_limit', 'ICE credentials were just issued.'); return; }
      const iceServers = await this.ice(socket, state);
      socket.serializeAttachment(state);
      this.send(socket, { v: 1, type: 'ice', iceServers });
      return;
    }
    const envelope = value as Envelope;
    if (envelope.v !== 1 || !['signal', 'relay'].includes(envelope.type) || envelope.from !== state.metadata!.deviceId ||
      typeof envelope.to !== 'string' || !deviceIdPattern.test(envelope.to) || envelope.to === envelope.from ||
      typeof envelope.session !== 'string' || !envelope.session || envelope.session.length > 128 ||
      !Number.isSafeInteger(envelope.seq) || envelope.seq < 0 || !Number.isSafeInteger(envelope.at) || Math.abs(Date.now() - envelope.at) > maxSkewMs ||
      typeof envelope.signature !== 'string' || envelope.signature.length > 128 || envelope.payload === undefined) throw new Error('Invalid envelope fields.');
    if (!verify(null, Buffer.from(canonical(envelopePayload(envelope))), identity(state.metadata!.publicKey).key, Buffer.from(envelope.signature, 'base64'))) throw new Error('Invalid envelope signature.');
    this.ctx.storage.sql.exec('DELETE FROM sequences WHERE connection = ? AND at < ?', state.id, Date.now() - maxSkewMs);
    const replayKey = `${envelope.type}:${envelope.to}:${envelope.session}`;
    const previous = this.ctx.storage.sql.exec<{ seq: number }>('SELECT seq FROM sequences WHERE connection = ? AND replay_key = ?', state.id, replayKey).toArray()[0];
    if (previous && envelope.seq <= previous.seq) { this.error(socket, 'replay', 'Envelope sequence was already consumed.', envelope); return; }
    if (!previous && this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM sequences WHERE connection = ?', state.id).one().count >= 128) throw new Error('Too many concurrent signaling sessions.');
    this.ctx.storage.sql.exec('INSERT INTO sequences VALUES (?, ?, ?, ?) ON CONFLICT(connection, replay_key) DO UPDATE SET seq = excluded.seq, at = excluded.at', state.id, replayKey, envelope.seq, envelope.at);
    if (envelope.type === 'relay' && (!this.limits.relay || !state.deliveryAcknowledgments)) { this.error(socket, 'relay_disabled', 'WSS relay is disabled for this connection.', envelope); return; }
    const target = this.find(state.room, envelope.to);
    if (!target) { this.error(socket, 'peer_offline', 'Target device is unavailable in this room.', envelope); return; }
    if (envelope.type === 'relay') {
      if (!this.attachment(target)?.deliveryAcknowledgments) { this.error(socket, 'relay_disabled', 'The target requires an updated client for hosted relay.', envelope); return; }
      // UUID receipts have a fixed wire length. Include that extension in the
      // application egress cap; TLS/IP framing remains provider-level overhead.
      const bytes = encoder.encode(JSON.stringify({ ...envelopePayload(envelope), signature: envelope.signature,
        deliveryId: '00000000-0000-0000-0000-000000000000' })).byteLength;
      if (this.count('relay', Math.floor(Date.now() / dayMs), 0, bytes).bytes > this.limits.dailyRelayBytes) { this.error(socket, 'relay_quota', 'The hosted relay reached its daily capacity; direct WebRTC is still available.', envelope); return; }
    }
    if (!this.send(target, { ...envelopePayload(envelope), signature: envelope.signature }, true)) this.error(socket, 'peer_offline', 'Target device is unavailable.', envelope);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') { this.close(socket, 1003, 'JSON text frames required'); return; }
    const size = encoder.encode(message).byteLength;
    if (size > maxFrameBytes) { this.close(socket, 1009, 'Frame limit'); return; }
    const state = this.attachment(socket);
    if (!state) { this.close(socket, 1008, 'Connection state unavailable'); return; }
    const now = Date.now();
    if (now - state.windowAt >= 1000) { state.windowAt = now; state.messages = 0; state.bytes = 0; }
    if (++state.messages > 100 || (state.bytes += size) > 1024 * 1024) { this.close(socket, 1008, 'Rate limit'); return; }
    socket.serializeAttachment(state);
    if (this.count('messages', Math.floor(now / dayMs), 1).messages > this.limits.dailyMessages) {
      this.error(socket, 'service_quota', 'Hosted networking reached its daily capacity. Try later or use self-hosted signaling.');
      this.close(socket, 1013, 'Daily capacity');
      return;
    }
    try {
      const value: unknown = JSON.parse(message);
      if (state.metadata) await this.route(socket, state, value); else await this.authenticate(socket, state, value);
    } catch (cause) {
      this.error(socket, state.metadata ? 'invalid_message' : 'authentication_failed', cause instanceof Error ? cause.message : 'Invalid request.');
      if (!state.metadata) this.close(socket, 4003, 'Authentication failed');
    }
  }
  webSocketClose(socket: WebSocket): void {
    const state = this.attachment(socket);
    if (!state) return;
    this.cleanupConnection(state.id);
    this.presence(state.room);
  }
  webSocketError(socket: WebSocket): void { this.close(socket, 1011, 'Transport error'); }
  async alarm(): Promise<void> {
    let next: number | undefined;
    for (const socket of this.sockets()) {
      const state = this.attachment(socket);
      if (!state || state.metadata) continue;
      if (state.authBy <= Date.now()) this.close(socket, 4000, 'Authentication timeout');
      else next = Math.min(next ?? state.authBy, state.authBy);
    }
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
    // No periodic alarm survives successful authentication.
  }
}
