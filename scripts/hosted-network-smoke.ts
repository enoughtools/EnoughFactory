import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PeerManager } from '../packages/peers/src/index.ts';

// One explicitly invoked live-network journey. Two local production transport
// instances use separate disposable identities; no RTC, containers or models.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.env.ENOUGHFACTORY_HOSTED_NETWORK_URL;
assert.ok(endpoint, 'Set ENOUGHFACTORY_HOSTED_NETWORK_URL to the reviewed HTTPS Worker endpoint.');
const origin = new URL(endpoint);
assert.equal(origin.protocol, 'https:', 'The live check requires HTTPS/WSS.');
assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash, 'Supply an origin without credentials or query parameters.');
const startedAt = new Date().toISOString();
const room = `proof_${randomUUID().replaceAll('-', '')}`;
const signalingUrl = `wss://${origin.host}/ws?room=${room}`;
const directory = await mkdtemp(path.join(tmpdir(), 'enough-hosted-live-'));
const receiptPath = path.resolve(process.env.ENOUGHFACTORY_HOSTED_NETWORK_RECEIPT ?? path.join(root, 'docs/verification/hosted-network-2026-10-05.json'));
const marker = 'private-proof-' + randomBytes(24).toString('hex');
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const errors: string[] = [];
const authentications: Array<{ peer: string; relay: boolean; deliveryAcknowledgments: boolean; relayLimits: unknown; iceUrls: string[]; temporaryCredentials: boolean }> = [];
const wire = { relayEnvelopes: 0, encryptedBoxes: 0, plaintextMarkerSeen: false, deliveryReceipts: 0 };
let receivedArtifact = '';
const steps: Array<{ at: string; step: string; detail?: unknown }> = [];
const record = (step: string, detail?: unknown): void => { steps.push({ at: new Date().toISOString(), step, ...(detail === undefined ? {} : { detail }) }); };
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(label: string, check: () => boolean): Promise<void> {
  const end = Date.now() + 20000;
  while (!check()) { if (Date.now() > end) throw new Error(`${label} timed out. ${errors.join('; ')}`); await delay(25); }
}
// Passive inspection of each fixture's actual incoming socket; no protocol
// replacement or handler mocking. Store counts/capabilities, never raw bodies.
function audit(peer: PeerManager, label: string): void {
  const socket = (peer as unknown as { socket?: { on(event: 'message', listener: (data: { toString(): string }) => void): void } }).socket;
  assert.ok(socket, 'Fixture signaling socket was not created.');
  socket.on('message', data => {
    const text = data.toString();
    if (text === 'pong') return;
    if (text.includes(marker)) wire.plaintextMarkerSeen = true;
    const message = JSON.parse(text);
    if (message.type === 'auth-ok') {
      const ice = Array.isArray(message.iceServers) ? message.iceServers : [];
      authentications.push({ peer: label, relay: message.relay === true,
        deliveryAcknowledgments: message.deliveryAcknowledgments === true, relayLimits: message.relayLimits,
        iceUrls: ice.flatMap((server: { urls: string | string[] }) => Array.isArray(server.urls) ? server.urls : [server.urls]),
        temporaryCredentials: ice.some((server: { username?: string; credential?: string }) => Boolean(server.username || server.credential)) });
    }
    if (typeof message.deliveryId === 'string') wire.deliveryReceipts++;
    if (message.type === 'relay') {
      wire.relayEnvelopes++;
      const box = message.payload?.box;
      if (typeof box?.nonce === 'string' && typeof box?.data === 'string' && typeof box?.tag === 'string') wire.encryptedBoxes++;
    }
  });
}
const common = { signalingUrl, transport: 'relay' as const, onError: (error: Error) => errors.push(error.message) };
const a = await PeerManager.create({ ...common, name: 'Hosted proof A', dataDir: path.join(directory, 'a') });
let b = await PeerManager.create({ ...common, name: 'Hosted proof B', dataDir: path.join(directory, 'b'),
  onRequest: async (peerId, request) => ({ v: 1, id: request.id, status: 200, body: { authenticatedPeer: peerId, path: request.path, input: request.body } }),
  onArtifact: (_peerId, _manifest, receivedPath) => { receivedArtifact = receivedPath; } });
const oldIdentity = b.localDevice.id;
let outcome: Record<string, unknown> = {};
let failure: unknown;
try {
  const healthResponse = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(10000), cache: 'no-store' });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.service, 'enoughfactory-signaling'); assert.equal(health.protocol, 1);
  assert.equal(health.transport, 'cloudflare-hibernation'); record('deployed-health', health);
  await a.start(); audit(a, 'a'); await b.start(); audit(b, 'b');
  await until('Signed authentication', () => authentications.length === 2);
  assert.ok(authentications.every(auth => auth.relay && auth.deliveryAcknowledgments && !auth.temporaryCredentials));
  assert.ok(authentications.every(auth => auth.iceUrls.every(url => /^stuns?:/.test(url))));
  assert.ok(authentications.every(auth => JSON.stringify(auth.relayLimits) === JSON.stringify({ bytesPerSecond: 524288, messagesPerSecond: 20 })));
  await b.pair(a.createInvitation().code);
  await until('Paired encrypted relay', () => a.connectionInfo(b.localDevice.id)?.transport === 'relay'
    && b.connectionInfo(a.localDevice.id)?.transport === 'relay');
  assert.equal(a.connectionInfo(b.localDevice.id)?.transport, 'relay');
  assert.equal(b.connectionInfo(a.localDevice.id)?.transport, 'relay');
  record('paired', { a: a.localDevice.id, b: b.localDevice.id, transport: 'relay' });
  const response = await a.request(b.localDevice.id, { method: 'POST', path: '/api/live-proof', body: { marker } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { authenticatedPeer: a.localDevice.id, path: '/api/live-proof', input: { marker } });
  record('authenticated-encrypted-rpc', { status: response.status, markerSha256: digest(marker) });
  const bytes = randomBytes(1024 * 1024), artifactPath = path.join(directory, 'proof.bundle');
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  const manifest = { id: 'live-proof-' + randomUUID(), name: 'proof.bundle', size: bytes.length, sha256: digest(bytes) };
  await a.uploadArtifact(b.localDevice.id, artifactPath, manifest);
  const received = await readFile(receivedArtifact);
  assert.equal(received.length, manifest.size); assert.equal(digest(received), manifest.sha256);
  record('artifact-sha256-verified', { id: manifest.id, bytes: manifest.size, sourceSha256: manifest.sha256, receivedSha256: digest(received) });
  // Recreate B from its durable identity/catalog rather than reusing its object.
  await b.stop(); await until('Owner offline presence', () => !a.devices().find(device => device.id === oldIdentity)?.online);
  record('owner-offline-observed');
  b = await PeerManager.create({ ...common, name: 'Hosted proof B', dataDir: path.join(directory, 'b'),
    onRequest: async (peerId, request) => ({ v: 1, id: request.id, status: 200, body: { authenticatedPeer: peerId, path: request.path } }) });
  assert.equal(b.localDevice.id, oldIdentity);
  await b.start(); audit(b, 'b-restarted');
  await until('Durable paired owner reconnect', () => a.connectionInfo(oldIdentity)?.transport === 'relay'
    && b.connectionInfo(a.localDevice.id)?.transport === 'relay');
  const reconnected = await a.request(oldIdentity, { method: 'GET', path: '/api/live-proof/reconnected' });
  assert.equal(reconnected.status, 200);
  assert.deepEqual(reconnected.body, { authenticatedPeer: a.localDevice.id, path: '/api/live-proof/reconnected' });
  assert.equal(a.connectionInfo(oldIdentity)?.transport, 'relay'); record('same-identity-reconnect', { deviceId: oldIdentity, status: reconnected.status });
  assert.ok(wire.relayEnvelopes > 0); assert.equal(wire.encryptedBoxes, wire.relayEnvelopes);
  assert.equal(wire.plaintextMarkerSeen, false); assert.ok(wire.deliveryReceipts > 0); assert.deepEqual(errors, []);
  outcome = { status: 'passed', health, peerIdentities: { a: a.localDevice.id, b: oldIdentity },
    artifact: { bytes: manifest.size, sourceSha256: manifest.sha256, receivedSha256: digest(received) },
    forcedTransport: 'encrypted-wss-relay', sameIdentityRecreatedAndReconnected: true, wire, authentications, errors };
} catch (error) {
  failure = error;
  outcome = { status: 'failed', failure: error instanceof Error ? error.message : String(error), wire, authentications, errors };
} finally {
  await a.stop(); await b.stop(); await rm(directory, { recursive: true, force: true });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sourceHashes = Object.fromEntries(await Promise.all([
    'packages/peers/src/index.ts', 'packages/peers/src/identity.ts', 'packages/peers/src/types.ts', 'services/signaling-cloudflare/src/worker.ts',
  ].map(async source => [source, digest(await readFile(path.join(root, source)))])));
  const receipt = { schema: 1, startedAt, completedAt: new Date().toISOString(), localDate: '2026-10-05', localTimezone: 'America/Mexico_City',
    endpoint: origin.origin, room, deploymentVersionReportedByParent: process.env.ENOUGHFACTORY_HOSTED_NETWORK_VERSION ?? null,
    source: { observedGitHead: head.status === 0 ? head.stdout.trim() : null, sourceHashes },
    topology: 'Two production PeerManager instances on one Mac, separate disposable identities, deployed Cloudflare Worker.',
    ...outcome, steps,
    scope: { nativeRtcStarted: false, containersStarted: false, modelTurns: 0,
      observedTurnCredentialsIssued: authentications.some(auth => auth.temporaryCredentials), appOrDefaultChanges: false },
    capacity: { pacedPerSocketBytesPerSecond: 524288, pacedRelayFramesPerSecond: 20,
      publicDailyJsonCap: 10000, publicDailyWssBytesCap: 1073741824, note: 'One bounded check consumes shared service capacity; no stress/throughput benchmark.' },
    cleanup: { peersStopped: true, disposableIdentityAndArtifactHomesRemoved: true, privateKeysOrInvitationSecretsInReceipt: false } };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: outcome.status, receiptPath }));
}
if (failure) throw failure;
