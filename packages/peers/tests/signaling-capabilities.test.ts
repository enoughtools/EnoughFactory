import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { PeerManager } from '../src/index.ts';
import { BrowserPeerClient, type BrowserPeerState } from '../src/browser.ts';
import { encrypt, loadIdentity, secretKey, signValue, verifyValue } from '../src/identity.ts';
import { authPayload, type Auth } from '../../../services/signaling/src/protocol.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

for (const clientKind of ['native-service', 'browser'] as const) {
  test(`${clientKind} keeps the legacy signed auth shape and acknowledges consumed delivery after durable pairing`, { timeout: 8000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'enough-signaling-codec-'));
    const fixture = await loadIdentity(join(root, 'fixture'));
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const signalingUrl = `ws://127.0.0.1:${address.port}`;
    const secret = randomBytes(32).toString('base64url');
    const invitation = Buffer.from(JSON.stringify({ v: 1, deviceId: fixture.id, name: 'Codec fixture', publicKey: fixture.publicKey,
      signalingUrl, secret, expiresAt: new Date(Date.now() + 60_000).toISOString() })).toString('base64url');
    const authenticated = deferred<void>();
    const acknowledged = deferred<void>();
    const discovered = deferred<void>();
    const errors: string[] = [];
    let state: BrowserPeerState | undefined;
    let browserPairPersisted = false;
    const originalWebSocket = globalThis.WebSocket;
    if (clientKind === 'browser') globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
    const client = clientKind === 'native-service'
      ? await PeerManager.create({ dataDir: join(root, 'client'), signalingUrl, transport: 'relay', onError: error => errors.push(error.message) })
      : await BrowserPeerClient.create({ signalingUrl, transport: 'relay', onError: error => errors.push(error.message), identityStore: {
        async load() { return state; },
        async save(value) {
          // A delivery ACK must wait for the real browser identity-store save.
          if (value.devices.length) await delay(25);
          state = structuredClone(value); browserPairPersisted = value.devices.some(device => device.id === fixture.id);
        },
      } });
    server.on('connection', socket => {
      let remoteId = '';
      socket.send(JSON.stringify({ v: 1, type: 'challenge', nonce: 'codec-fixture-nonce' }));
      socket.on('message', data => { void (async () => {
        const wire = data.toString();
        if (wire === 'ping') { socket.send('pong'); return; }
        const message = JSON.parse(wire);
        if (message.type === 'auth') {
          assert.equal(message.nonce, 'codec-fixture-nonce');
          assert.equal(verifyValue(message.publicKey, authPayload(message as Auth), message.signature), true,
            'Unsigned capabilities must not alter the legacy signed authentication payload.');
          assert.equal(message.deliveryAcknowledgments, true);
          assert.deepEqual(message.discoverPeers, []);
          remoteId = message.deviceId;
          socket.send(JSON.stringify({ v: 1, type: 'auth-ok', deviceId: remoteId, iceServers: [], relay: true, deliveryAcknowledgments: true }));
          socket.send('pong');
          authenticated.resolve();
        } else if (message.type === 'signal' && message.payload?.kind === 'pair-request') {
          const payload = { kind: 'pair-accepted', requestId: message.payload.requestId,
            box: encrypt(secretKey(secret), { device: { id: fixture.id, publicKey: fixture.publicKey, name: 'Codec fixture', platform: 'linux', arch: 'x64', online: true } }, message.payload.requestId) };
          const envelope = { v: 1, type: 'signal', from: fixture.id, to: remoteId, session: message.session, seq: 1, at: Date.now(), payload };
          socket.send(JSON.stringify({ ...envelope, signature: signValue(fixture.privateKey, envelope), deliveryId: 'fixture-pair-accepted' }));
        } else if (message.type === 'discover') {
          assert.deepEqual(message.devices, [fixture.id]);
          discovered.resolve();
        } else if (message.type === 'delivery-ack') {
          assert.equal(message.id, 'fixture-pair-accepted');
          if (clientKind === 'browser') assert.equal(browserPairPersisted, true, 'The browser ACK overtook its awaited identity-store save.');
          else {
            const saved = JSON.parse(await readFile(join(root, 'client/peers/devices.json'), 'utf8')) as Array<{ id: string }>;
            assert.ok(saved.some(device => device.id === fixture.id), 'The native ACK overtook durable peer enrollment.');
          }
          acknowledged.resolve();
        }
      })().catch(error => { authenticated.reject(error); acknowledged.reject(error); discovered.reject(error); }); });
    });
    try {
      await client.start();
      await authenticated.promise;
      const paired = await client.pair(invitation);
      assert.equal(paired.id, fixture.id);
      await Promise.all([acknowledged.promise, discovered.promise]);
      assert.deepEqual(errors, [], 'Literal pong or capability negotiation produced a protocol error.');
    } finally {
      await client.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      globalThis.WebSocket = originalWebSocket;
      await rm(root, { recursive: true, force: true });
    }
  });
}
