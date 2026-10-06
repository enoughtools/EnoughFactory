import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { WebSocket } from 'ws';
import { encrypt } from '../../../packages/peers/src/identity.ts';
import { PeerManager } from '../../../packages/peers/src/index.ts';
import { authPayload, canonical, envelopePayload, identity, type Auth, type Envelope } from '../../signaling/src/protocol.ts';

type Wire = Record<string, any>;
function device() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { ...keys, publicKey, deviceId: identity(publicKey).deviceId };
}
function inbox(socket: WebSocket) {
  const messages: Wire[] = [];
  const waiters: Array<{ matches: (value: Wire) => boolean; resolve: (value: Wire) => void }> = [];
  let acknowledge = true;
  socket.on('message', data => {
    const wire = data.toString();
    const value: Wire = wire === 'pong' ? { type: 'pong' } : JSON.parse(wire);
    if (acknowledge && typeof value.deliveryId === 'string') socket.send(JSON.stringify({ v: 1, type: 'delivery-ack', id: value.deliveryId }));
    const index = waiters.findIndex(waiter => waiter.matches(value));
    if (index < 0) messages.push(value); else waiters.splice(index, 1)[0]!.resolve(value);
  });
  return {
    acknowledge(value: boolean) { acknowledge = value; },
    messages,
    async next(type: string, match: (value: Wire) => boolean = () => true): Promise<Wire> {
      const matches = (value: Wire) => value.type === type && match(value);
      const index = messages.findIndex(matches);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve: (value: Wire) => { clearTimeout(timeout); resolve(value); } };
        const timeout = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out awaiting ${type}`)); }, 3000);
        waiters.push(waiter);
      });
    },
  };
}
async function connect(url: string, keys = device(), contacts: string[] = [], updated = true) {
  const socket = new WebSocket(url);
  socket.on('error', () => { /* Test assertions and bounded waits report transport failures. */ });
  const messages = inbox(socket);
  messages.acknowledge(updated);
  const challenge = await messages.next('challenge');
  const auth: Auth = { v: 1, type: 'auth', deviceId: keys.deviceId, publicKey: keys.publicKey, name: 'Private human name', platform: 'linux', arch: 'arm64', nonce: challenge.nonce, signature: '' };
  auth.signature = sign(null, Buffer.from(canonical(authPayload(auth))), keys.privateKey).toString('base64');
  socket.send(JSON.stringify({ ...auth, ...(updated ? { deliveryAcknowledgments: true, discoverPeers: contacts } : {}) }));
  const ready = await messages.next('auth-ok');
  return { socket, messages, keys, auth, ready };
}
function envelope(from: ReturnType<typeof device>, to: string, seq: number, type: 'signal' | 'relay' = 'signal', payload: any = { kind: 'offer', sdp: 'opaque-sdp' }): Envelope {
  const value: Envelope = { v: 1, type, from: from.deviceId, to, session: 'protocol-check', seq, at: Date.now(), payload, signature: '' };
  value.signature = sign(null, Buffer.from(canonical(envelopePayload(value))), from.privateKey).toString('base64');
  return value;
}
function signedOnly(value: Wire): Wire { const { deliveryId: _id, ...original } = value; return original; }
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 10000;
  while (!check()) { if (Date.now() > end) throw new Error('Peer connection condition timed out'); await delay(25); }
}
async function refused(url: string, headers?: Record<string, string>): Promise<number> {
  const socket = new WebSocket(url, { headers });
  socket.on('error', () => {});
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
    socket.once('open', () => { socket.terminate(); reject(new Error('Expected handshake rejection.')); });
  });
}

test('actual hibernating SQLite runtime retains signed rooms/replay, hides roster, bounds delivery and enforces caps', { timeout: 30000 }, async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({ name: 'network-check', modules: true, script: bundled.outputFiles[0]!.text,
    compatibilityDate: '2026-10-05', compatibilityFlags: ['nodejs_compat'], port: 0,
    durableObjects: { SIGNALING: { className: 'SignalingHub', useSQLite: true } },
    bindings: { ENOUGH_SIGNALING_ALLOWED_ORIGINS: 'https://factory.example', ENOUGH_SIGNALING_DAILY_RELAY_BYTES: String(1024 ** 3) },
    log: new Log(LogLevel.ERROR) }), unsafeInspectDurableObjects: true });
  const sockets: WebSocket[] = [];
  try {
    const origin = (await runtime.ready).origin;
    const url = origin.replace('http:', 'ws:') + '/ws';
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal((await fetch(origin + '/ice')).status, 404);
    assert.equal((await fetch(origin + '/ws')).status, 426);
    assert.equal(await refused(url, { Origin: 'https://unlisted.example' }), 403);
    assert.equal(await refused(url + '?room=invalid%20room'), 400);
    const aliceKey = device(), bobKey = device();
    const alice = await connect(url, aliceKey, [bobKey.deviceId]); sockets.push(alice.socket);
    const bob = await connect(url, bobKey, [aliceKey.deviceId]); sockets.push(bob.socket);
    const outsider = await connect(url); sockets.push(outsider.socket);
    const otherRoom = await connect(url + '?room=private-fixture'); sockets.push(otherRoom.socket);
    const legacy = await connect(url, device(), [], false); sockets.push(legacy.socket);
    assert.equal(alice.ready.deliveryAcknowledgments, true);
    assert.equal(alice.ready.relay, true);
    assert.equal(legacy.ready.relay, false);
    assert.deepEqual(alice.ready.iceServers, [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
    const introduced = await alice.messages.next('presence', value => value.devices.some((entry: Wire) => entry.deviceId === bob.keys.deviceId));
    assert.equal(introduced.devices.length, 2);
    assert.ok(introduced.devices.every((entry: Wire) => Object.keys(entry).sort().join(',') === 'deviceId,lastSeen,online,publicKey'));
    assert.equal((await outsider.messages.next('presence')).devices.length, 1);
    assert.equal((await otherRoom.messages.next('presence')).devices.length, 1);
    assert.equal((await legacy.messages.next('presence')).devices.length, 1);
    alice.socket.send('ping'); assert.equal((await alice.messages.next('pong')).type, 'pong');
    const offer = envelope(alice.keys, bob.keys.deviceId, 0);
    alice.socket.send(JSON.stringify(offer));
    assert.deepEqual(signedOnly(await bob.messages.next('signal')), offer);

    // Evict the actual object while keeping its accepted WebSockets hibernating.
    // Subsequent routing must reconstruct attachments and retain SQLite replay guards.
    await runtime.unsafeEvictDurableObject('network-check', 'SignalingHub', { name: 'hub-v1', webSockets: 'hibernate' });
    alice.socket.send('ping'); await alice.messages.next('pong');
    alice.socket.send(JSON.stringify(offer)); assert.equal((await alice.messages.next('error')).code, 'replay');
    const tampered = { ...envelope(alice.keys, bob.keys.deviceId, 1), payload: { changed: true } };
    alice.socket.send(JSON.stringify(tampered)); assert.equal((await alice.messages.next('error')).code, 'invalid_message');
    alice.socket.send(JSON.stringify(envelope(alice.keys, otherRoom.keys.deviceId, 2)));
    assert.equal((await alice.messages.next('error')).code, 'peer_offline');
    const privateText = 'private-chat-must-never-be-in-signaling-storage';
    const relay = envelope(alice.keys, bob.keys.deviceId, 3, 'relay', { box: encrypt(randomBytes(32), { text: privateText }, 'protocol-check') });
    alice.socket.send(JSON.stringify(relay));
    assert.deepEqual(signedOnly(await bob.messages.next('relay')), relay);
    const storage = await runtime.unsafeGetDurableObjectStorage('network-check', 'SignalingHub', { name: 'hub-v1' });
    for (const table of ['counters', 'sequences', 'deliveries', 'subscriptions']) {
      assert.ok(!JSON.stringify(await storage.exec(`SELECT * FROM ${table}`)).includes(privateText));
      assert.ok(!JSON.stringify(await storage.exec(`SELECT * FROM ${table}`)).includes('Private human name'));
    }
    // A deterministic counter boundary avoids sending a gigabyte just to prove a quota.
    await storage.exec('UPDATE counters SET bytes = ? WHERE scope = ?', 1024 ** 3, 'relay');
    alice.socket.send(JSON.stringify(envelope(alice.keys, bob.keys.deviceId, 4, 'relay')));
    assert.equal((await alice.messages.next('error')).code, 'relay_quota');
    alice.socket.send(JSON.stringify(envelope(alice.keys, bob.keys.deviceId, 5)));
    assert.equal((await bob.messages.next('signal')).seq, 5);
    await storage.exec('UPDATE counters SET bytes = 0 WHERE scope = ?', 'relay');
    alice.socket.send(JSON.stringify({ v: 1, type: 'ice-request' }));
    assert.equal((await alice.messages.next('error')).code, 'ice_rate_limit');

    const bad = new WebSocket(url); sockets.push(bad); bad.on('error', () => {});
    const badMessages = inbox(bad); await badMessages.next('challenge');
    bad.send(JSON.stringify(alice.auth)); assert.equal((await badMessages.next('error')).code, 'authentication_failed');
    // A receiver that stops acknowledging is closed at the pending-frame bound.
    await delay(50);
    bob.messages.acknowledge(false);
    const closed = new Promise<{ code: number; reason: string }>(resolve => bob.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    for (let seq = 10; seq < 80; seq++) alice.socket.send(JSON.stringify(envelope(alice.keys, bob.keys.deviceId, seq, 'relay')));
    await delay(1100);
    for (let seq = 80; seq < 140; seq++) alice.socket.send(JSON.stringify(envelope(alice.keys, bob.keys.deviceId, seq, 'relay')));
    assert.deepEqual(await closed, { code: 1013, reason: 'Slow receiver' });
    assert.equal((await alice.messages.next('error')).code, 'peer_offline');
    alice.socket.send(JSON.stringify({ v: 1, type: 'discover', devices: [outsider.keys.deviceId] }));
    const refreshed = await alice.messages.next('presence', value => value.devices.some((entry: Wire) => entry.deviceId === outsider.keys.deviceId));
    assert.ok(!refreshed.devices.some((entry: Wire) => entry.deviceId === bob.keys.deviceId));
    // All local fixture connections share one edge address, exercising the real
    // per-IP admission guard without creating a fleet or trusting client identity.
    for (let count = 0; count < 4; count++) {
      const anonymous = new WebSocket(url); sockets.push(anonymous); anonymous.on('error', () => {});
      await inbox(anonymous).next('challenge');
    }
    assert.equal(await refused(url), 429);
    await delay(50);
    await storage.exec('UPDATE counters SET messages = ? WHERE scope = ?', 10000, 'messages');
    alice.socket.send(JSON.stringify(envelope(alice.keys, outsider.keys.deviceId, 150)));
    assert.equal((await alice.messages.next('error', value => value.code === 'service_quota')).code, 'service_quota');
    for (const socket of sockets) socket.terminate();
    await delay(50);
    await storage.exec('UPDATE counters SET messages = 0 WHERE scope = ?', 'messages');
    // One actual app-protocol path, forced onto encrypted WSS: no native RTC,
    // provider turn or container. This catches pacing/backpressure integration.
    const directory = await mkdtemp(join(tmpdir(), 'enough-hosted-peers-'));
    const observed: string[] = [];
    let receivedArtifact = '';
    const options = { signalingUrl: url + '?room=app-protocol', transport: 'relay' as const,
      onError: (error: Error) => observed.push(error.message) };
    const a = await PeerManager.create({ ...options, dataDir: join(directory, 'a') });
    const b = await PeerManager.create({ ...options, dataDir: join(directory, 'b'),
      onRequest: async (_peer, request) => ({ v: 1, id: request.id, status: 200, body: { path: request.path, body: request.body } }),
      onArtifact: (_peer, _manifest, path) => { receivedArtifact = path; } });
    try {
      await a.start(); await b.start(); await b.pair(a.createInvitation().code);
      await until(() => a.devices().some(device => device.id === b.localDevice.id && device.online));
      assert.equal(a.connectionInfo(b.localDevice.id)?.transport, 'relay');
      assert.deepEqual((await a.request(b.localDevice.id, { method: 'POST', path: '/api/echo', body: { enough: true } })).body,
        { path: '/api/echo', body: { enough: true } });
      const artifact = randomBytes(1024 * 1024), path = join(directory, 'source.bundle'); await writeFile(path, artifact);
      await a.uploadArtifact(b.localDevice.id, path, { id: 'hosted-proof-bundle', name: 'source.bundle', size: artifact.length,
        sha256: createHash('sha256').update(artifact).digest('hex') });
      assert.deepEqual(await readFile(receivedArtifact), artifact);
      await b.stop(); await until(() => !a.devices().find(device => device.id === b.localDevice.id)?.online);
      await b.start(); await until(() => a.devices().some(device => device.id === b.localDevice.id && device.online));
      assert.equal((await a.request(b.localDevice.id, { method: 'GET', path: '/api/reconnected' })).status, 200);
      assert.deepEqual(observed, []);
    } finally { await a.stop(); await b.stop(); await rm(directory, { recursive: true, force: true }); }
  } finally {
    for (const socket of sockets) socket.terminate();
    await runtime.dispose();
  }
});
