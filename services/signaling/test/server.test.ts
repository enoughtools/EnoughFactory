import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { authPayload, canonical, envelopePayload, identity, type Auth, type Envelope } from '../src/protocol.ts';
import { configFromEnvironment, createSignalingService, iceServers } from '../src/server.ts';

type Wire = Record<string, unknown>;
function inbox(socket: WebSocket) {
  const messages: Wire[] = [];
  const waiters: Array<{ matches: (value: Wire) => boolean; resolve: (value: Wire) => void }> = [];
  socket.on('message', data => {
    const value = JSON.parse(data.toString()) as Wire;
    const waiterIndex = waiters.findIndex(waiter => waiter.matches(value));
    if (waiterIndex < 0) messages.push(value);
    else waiters.splice(waiterIndex, 1)[0]!.resolve(value);
  });
  return {
    async next(type: string, match: (value: Wire) => boolean = () => true): Promise<Wire> {
      const matches = (value: Wire) => value.type === type && match(value);
      const index = messages.findIndex(matches);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve: (value: Wire) => { clearTimeout(timeout); resolve(value); } };
        const timeout = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out awaiting ${type}`)); }, 2000);
        waiters.push(waiter);
      });
    },
    messages,
  };
}
function device() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { ...keys, publicKey, deviceId: identity(publicKey).deviceId };
}
async function connect(url: string, keys = device()) {
  const socket = new WebSocket(url);
  const messages = inbox(socket);
  const challenge = await messages.next('challenge');
  const auth: Auth = { v: 1, type: 'auth', deviceId: keys.deviceId, publicKey: keys.publicKey, name: 'Test device', platform: 'linux', arch: 'x64', nonce: challenge.nonce as string, signature: '' };
  auth.signature = sign(null, Buffer.from(canonical(authPayload(auth))), keys.privateKey).toString('base64');
  socket.send(JSON.stringify(auth));
  await messages.next('auth-ok');
  return { socket, messages, keys, auth };
}
function envelope(from: ReturnType<typeof device>, to: string, seq: number, type: 'signal' | 'relay' = 'signal'): Envelope {
  const value: Envelope = { v: 1, type, from: from.deviceId, to, session: 'pairing-session', seq, at: Date.now(), payload: { encrypted: 'opaque-negotiation-data' }, signature: '' };
  value.signature = sign(null, Buffer.from(canonical(envelopePayload(value))), from.privateKey).toString('base64');
  return value;
}

test('signed identity routing rejects forgery and replay, forwards opaque relay, and reports offline peers', { timeout: 10000 }, async () => {
  const service = createSignalingService(configFromEnvironment({ PORT: '0', ENOUGH_SIGNALING_HOST: '127.0.0.1', STUN_URLS: '' }));
  const { port } = await service.listen();
  const url = `ws://127.0.0.1:${port}/ws`;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ice`)).status, 404);
    const alice = await connect(url);
    const bob = await connect(url);
    await alice.messages.next('presence', value => (value.devices as Wire[]).length === 2);
    const offer = envelope(alice.keys, bob.keys.deviceId, 0);
    alice.socket.send(JSON.stringify(offer));
    assert.deepEqual(await bob.messages.next('signal'), offer);
    alice.socket.send(JSON.stringify(offer));
    assert.equal((await alice.messages.next('error')).code, 'replay');
    const forged = { ...envelope(alice.keys, bob.keys.deviceId, 1), payload: { encrypted: 'tampered' } };
    alice.socket.send(JSON.stringify(forged));
    assert.equal((await alice.messages.next('error')).code, 'invalid_message');
    const relay = envelope(alice.keys, bob.keys.deviceId, 2, 'relay');
    alice.socket.send(JSON.stringify(relay));
    assert.deepEqual(await bob.messages.next('relay'), relay);
    alice.socket.send(JSON.stringify({ v: 1, type: 'ice-request' }));
    assert.deepEqual((await alice.messages.next('ice')).iceServers, []);
    const attacker = new WebSocket(url);
    const attackerMessages = inbox(attacker);
    await attackerMessages.next('challenge');
    attacker.send(JSON.stringify(alice.auth));
    assert.equal((await attackerMessages.next('error')).code, 'authentication_failed');
    bob.socket.close();
    await alice.messages.next('presence', value => (value.devices as Wire[]).length === 1);
    alice.socket.send(JSON.stringify(envelope(alice.keys, bob.keys.deviceId, 3)));
    assert.equal((await alice.messages.next('error')).code, 'peer_offline');
    assert.equal(bob.messages.messages.filter(value => value.type === 'signal').length, 0);
  } finally { await service.close(); }
});

test('TURN needs an admission list and returns expiring identity-scoped credentials only after authentication', { timeout: 10000 }, async () => {
  assert.throws(() => configFromEnvironment({ TURN_URLS: 'turn:relay.example:3478', TURN_SECRET: 'test-secret' }), /DEVICE_IDS/);
  const allowed = device();
  const config = configFromEnvironment({ PORT: '0', ENOUGH_SIGNALING_HOST: '127.0.0.1', STUN_URLS: '', TURN_URLS: 'turn:relay.example:3478', TURN_SECRET: 'test-secret', ENOUGH_SIGNALING_DEVICE_IDS: allowed.deviceId });
  const credential = iceServers(config, allowed.deviceId, 100000)[0]!;
  assert.equal(credential.username, `3700:${allowed.deviceId}`);
  assert.equal(credential.credential, createHmac('sha1', 'test-secret').update(credential.username!).digest('base64'));
  const service = createSignalingService(config);
  const { port } = await service.listen();
  try {
    const admitted = await connect(`ws://127.0.0.1:${port}/ws`, allowed);
    admitted.socket.send(JSON.stringify({ v: 1, type: 'ice-request' }));
    const ice = await admitted.messages.next('ice');
    assert.match((ice.iceServers as Wire[])[0]!.username as string, new RegExp(`:${allowed.deviceId}$`));
    const outsider = device();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = inbox(socket);
    const challenge = await messages.next('challenge');
    const auth: Auth = { ...admitted.auth, deviceId: outsider.deviceId, publicKey: outsider.publicKey, nonce: challenge.nonce as string, signature: '' };
    auth.signature = sign(null, Buffer.from(canonical(authPayload(auth))), outsider.privateKey).toString('base64');
    socket.send(JSON.stringify(auth));
    assert.equal((await messages.next('error')).code, 'authentication_failed');
  } finally { await service.close(); }
});
