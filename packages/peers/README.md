# EnoughFactory peers

The independent device service owns these connections. Electron windows connect locally;
closing a window does not destroy device networking or running agents.

```ts
const peers = await PeerManager.create({
  dataDir,
  name: 'Studio Mac',
  signalingUrl: 'wss://signal.example.net/ws',
  onRequest: async (peerId, request) => router.dispatch(request, { authenticatedPeer: peerId }),
  onDevices: devices => publishDeviceState(devices),
  onStreamOpen: async (peerId, options, stream) => attachOwnedTerminalOrPreview(peerId, options, stream),
});
await peers.start();
```

`createInvitation()` produces a ten-minute, single-use code and `enoughfactory://pair`
link. Paste the code on the other device with `pair(code)`. The code includes the
inviting device's pinned identity key and a secret proof. Pairing requests and replies
are encrypted under that secret, so the signaling operator cannot redeem it merely by
observing the exchange. A device invitation grants access to that device service:
share it only with a device that you own and control. Revoke access with `forget(id)`.

Device keys and the paired catalog are mode-0600 files in `dataDir/peers`; the containing
directory is mode 0700. Ed25519 signatures authenticate signaling, and X25519 exchanges
provide per-connection keys for AES-GCM relay payloads. Signed SDP binds the enrolled
identity to the DTLS certificate fingerprint; native RTC verifies the fingerprint
again when the data channel opens. The server only sees presence, negotiation and
opaque relay ciphertext; it stores no conversations or goal state.

The normal route is native `node-datachannel` WebRTC. `iceServers` accepts browser-style
STUN/TURN entries. Temporary TURN credentials are delivered by the self-hosted signaling
service. `relayFallback` is enabled unless explicitly disabled: after direct negotiation
fails, encrypted WSS carries the same protocol. `transport: 'relay'` selects that route
explicitly; `relayOnlyIce: true` exercises TURN-only native RTC when configured. No
public relay or mandatory cloud account is required. See `services/signaling/README.md`.

`request(deviceId, { method, path, body })` returns the existing typed RPC response.
Request identities remain stable within a call and duplicate frames are deduplicated,
but the transport never retries a timed-out mutation. Its result can be unknown; durable
worker journals and authority generations must reconcile it before a new attempt.
Messages up to 16 MiB are fragmented into bounded frames. Terminal/events use
`openStream`, `PeerStream.send`, and cursor metadata. `uploadArtifact` uses resumable
24 KiB file chunks, offset checks and a whole-file SHA-256 before accepting the manifest.
No transcript replication is performed.

Control, event and bulk queues have separate bounds and priority, with native buffered
amount/WebSocket buffered amount backpressure. They still share network congestion.
A stalled preview reader is closed after its bounded buffer rather than consuming
unbounded memory. Stream reconnection is explicit: callers reopen with their last cursor
and the owning service replays its durable event journal.

For remote previews, open a `preview-tcp` stream on the session owner with a host/port
in the stream body, then use `streamToDuplex(stream)` in the viewing service gateway.
The owner's callback must dial through that session's envmux SOCKS proxy, never the
host's arbitrary TCP network. HTTP and WebSocket upgrades share the resulting bytes;
the preview gateway handles navigation origins/cookies and avoids exposing factory
authentication to preview content.

The browser entry exports `BrowserPeerClient`. It uses browser RTCPeerConnection and
WebCrypto with the identical enrolled wire protocol and a local persistent browser
identity. Standalone browser previews still require an explicitly configured HTTP
gateway; RTC data channels are not navigable URLs.

Run `pnpm --filter @enoughfactory/peers test` for the focused two-service exercise:
real direct WebRTC, encrypted WSS relay, concurrent terminal/artifact access and
stop/restart reconnect. This does not prove every NAT configuration; a deployed TURN
configuration should additionally be checked using `relayOnlyIce: true` on the target
network.

The native TURN path was also exercised against coturn 4.7.0 with relay-only ICE and
an asserted `localType: 'relay'` selected candidate. A repeatable local exercise is:

```sh
docker run -d --rm --name enough-turn-check \
  -p 127.0.0.1:3479:3478/udp -p 127.0.0.1:3479:3478/tcp \
  coturn/coturn:4.7.0 -n --no-tls --no-dtls --no-cli \
  --realm=enoughfactory-verification --user=enough:local-verification \
  --listening-ip=0.0.0.0 --min-port=49760 --max-port=49780
ENOUGH_TEST_TURN_URL=turn:127.0.0.1:3479 pnpm --filter @enoughfactory/peers test
docker stop enough-turn-check
```

This fixture intentionally lets both peers use the same container's relay address.
A deployed TURN service needs its real external address, relay port range and temporary
credential configuration from the signaling deployment guide. `connectionInfo(peerId)`
returns the actual transport, selected candidate types and RTC round-trip time.
