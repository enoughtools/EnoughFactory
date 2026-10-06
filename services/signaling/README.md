# EnoughFactory signaling

This self-hostable service introduces devices to each other. It provides signed WebRTC negotiation, live presence, temporary TURN credentials and an optional WebSocket forwarding path. Device services own enrollment, execution, chats and goal records. Signaling does not store or replicate those records.

A separate [Cloudflare Worker backend](../signaling-cloudflare/README.md) implements the same signed frames with SQLite/WebSocket Hibernation, private contact discovery and bounded hosted delivery. It is eligible for Workers Free and keeps this Node/coturn deployment available. Hosted discovery/relay require the newer client extensions described there.

The server exposes `GET /health` and WebSocket `/ws`. A connection must answer an Ed25519 challenge before joining presence or forwarding messages. Receiving devices validate signed messages against their enrolled peer identities before granting access. Forwarded payloads remain opaque to the signaling protocol; key possession at the server does not grant permission to use another device.

## Wire protocol

Every JSON message has `v: 1`. The server sends `{type: "challenge", nonce}` immediately after connection. The device answers with `{type: "auth", deviceId, publicKey, name, platform, arch, nonce, signature}`. `publicKey` is Ed25519 SPKI PEM, and `deviceId` is the first 32 lowercase hexadecimal characters of SHA-256 over its SPKI DER representation. Signatures are Ed25519 over UTF-8 JSON with object keys sorted recursively, encoded as standard base64. Sign exactly the listed authentication fields plus `v`, omitting `signature`. Optional hosted capabilities `deliveryAcknowledgments` and `discoverPeers` remain outside that signed payload, so legacy Node verification stays compatible. The nonce is single-use and specific to the connection.

Successful authentication yields `{type: "auth-ok", deviceId, iceServers, relay}`. All authenticated connections receive `{type: "presence", devices}` updates; entries contain public identity metadata plus `online: true` and `lastSeen`. Missing devices are offline. Presence conveys reachability, never peer enrollment.

Forwarded envelopes are `{type: "signal" | "relay", from, to, session, seq, at, payload, signature}`. Sign exactly these fields plus `v`, omitting `signature`, using the same canonical JSON. `at` is Unix time in milliseconds within five minutes of server time; `seq` is a nonnegative safe integer increasing within each type/target/session. A valid frame consumes its sequence even if the target is unavailable. Sign a fresh sequence when retrying. The server checks sender identity and signature, rejects consumed sequences, then forwards the envelope unchanged. Device endpoints must additionally validate enrollment, their own freshness/replay state and negotiation fingerprints. Encrypt pairing material and relay traffic end to end; the server does not create that encryption.

An authenticated `{type: "ice-request"}` returns `{type: "ice", iceServers}` with renewed temporary credentials. There is no public HTTP credential endpoint. Errors use `{type: "error", code, message, to?, session?}`. Common codes are `authentication_failed`, `invalid_message`, `replay`, `peer_offline` and `relay_disabled`. JSON text frames are limited to 512 KiB, queued output to 4 MiB per receiver, and input to 200 messages/4 MiB per second. Use bounded chunks and backpressure for bulk transfer.

Temporary ICE servers include optional `expiresAt` in Unix milliseconds. Clients also recognize the older coturn expiry prefix. To use the optional Cloudflare credential adapter instead of coturn, leave `TURN_URLS` empty and provide both managed key/token variables plus device admission. No keys are created automatically. The [managed TURN setup, expiry and separate billing boundary](../signaling-cloudflare/README.md#optional-managed-turn) apply to this Node adapter too.

## Local development

From this directory, using Node 22:

```sh
npm install --include=dev
npm run build
node dist/index.js
```

The endpoint is `ws://127.0.0.1:8788/ws`. The `.env` file is a Docker Compose input; the Node process does not automatically load it. To use it directly after copying and editing the example:

```sh
node --env-file=.env dist/index.js
```

Check the service without initiating a peer connection:

```sh
curl --fail http://127.0.0.1:8788/health
```

## Container deployment

```sh
cp .env.example .env
docker compose up --build -d signaling
docker compose logs --tail=50 signaling
```

The Docker image is built from this directory, installs its own dependencies and runs the bundled `dist/index.js` as the unprivileged Node user. The default published port is bound to host loopback. `PORT` selects the published port; the Compose service listens internally on 8788. Standalone Node or Docker invocation uses `PORT` as the actual listening port.

For a standalone image:

```sh
docker build -t enoughfactory-signaling .
docker run --name enoughfactory-signaling --init --restart unless-stopped --env-file .env -p 127.0.0.1:8788:8788 enoughfactory-signaling
```

If you change `PORT` for this standalone command, change both sides of its port mapping to match.

## HTTPS and WSS

Set `SIGNALING_DOMAIN` in `.env` to an owned hostname, point its DNS at the server and permit inbound TCP 80/443. Then enable the included reverse proxy:

```sh
docker compose --profile tls up --build -d
```

Devices use `wss://YOUR_SIGNALING_DOMAIN/ws`. Caddy provisions and renews HTTPS certificates, preserving them in the `caddy_data` volume, and handles the WebSocket upgrade. UDP 443 is optional HTTP/3 transport. Existing TLS reverse proxies can route `/ws` and `/health` to `127.0.0.1:8788` instead. [Caddy reverse proxy](https://caddyserver.com/docs/command-line#caddy-reverse-proxy).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENOUGH_SIGNALING_HOST` | `0.0.0.0` | Listening address outside the Compose wrapper |
| `PORT` | `8788` | Listening port, or published port in Compose |
| `STUN_URLS` | `stun:stun.cloudflare.com:3478` | Comma-separated STUN URLs; an empty value disables STUN |
| `TURN_URLS` | empty | Comma-separated `turn:`/`turns:` URLs advertised to devices |
| `TURN_SECRET` | empty | Shared coturn REST secret, held only by signaling and coturn |
| `TURN_TTL_SECONDS` | `3600` | Lifetime of temporary client TURN credentials |
| `CLOUDFLARE_TURN_KEY_ID` | empty | Optional managed TURN key ID instead of coturn URLs |
| `CLOUDFLARE_TURN_API_TOKEN` | empty | Server-only managed TURN credential API token; requires device admission |
| `ENOUGH_SIGNALING_ALLOW_RELAY` | `true` | Allow opaque WebSocket relay forwarding |
| `ENOUGH_SIGNALING_ALLOWED_ORIGINS` | empty | Optional comma-separated browser Origin allowlist |
| `ENOUGH_SIGNALING_DEVICE_IDS` | empty | Identity IDs permitted to authenticate; required when TURN is configured |

An Origin allowlist governs browser connections; it is not device enrollment or a network access policy. Restrict server admission with `ENOUGH_SIGNALING_DEVICE_IDS`, using the identity IDs shown by your local device services. This server allowlist is separate from peer pairing: each device still checks its enrolled peers. Without a server allowlist, any valid device identity can use bounded signaling and optional WSS forwarding, so keep that configuration on a trusted/private network. Do not send the shared TURN secret to device clients: the server supplies time-limited usernames and passwords instead.

## Optional TURN relay

The Compose `turn` profile runs coturn with host networking on Linux. Provision it on a Linux host with a stable public address; local Docker Desktop is not the intended public relay host. Set these `.env` values:

```dotenv
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_REALM=turn.example.com
TURN_EXTERNAL_IP=203.0.113.10
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
ENOUGH_SIGNALING_DEVICE_IDS=YOUR_FIRST_DEVICE_ID,YOUR_SECOND_DEVICE_ID
```

Generate a secret with `openssl rand -hex 32` and put its result in `TURN_SECRET`. The same value is passed to signaling and coturn. Populate the device identity allowlist before enabling TURN; signaling refuses TURN configuration without one. Set `TURN_EXTERNAL_IP` to the actual public address, not the documentation address above. For a host behind NAT, use `PUBLIC_IP/PRIVATE_IP` and forward matching ports without changing port numbers.

Permit inbound TCP/UDP 3478 and UDP `TURN_MIN_PORT`–`TURN_MAX_PORT` in the host firewall and any cloud/network firewall. Keep the relay range large enough for the expected concurrent connections. Then start both profiles:

```sh
docker compose --profile tls --profile turn up --build -d
docker compose logs --tail=50 coturn
```

The included coturn profile supplies `turn:` over UDP/TCP, with REST authentication; it does not serve `turns:`. WebRTC traffic remains encrypted between peers. To offer TLS TURN, configure coturn with its own certificate/key, remove `--no-tls`, expose TCP 5349 and advertise `turns:turn.example.com:5349?transport=tcp`. Caddy's HTTP reverse proxy does not terminate the TURN protocol. [Coturn image and networking](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md), [coturn configuration](https://github.com/coturn/coturn/blob/master/docker/coturn/turnserver.conf).

## Operation and recovery

Restarting signaling disconnects its live sockets and clears presence. Device services reconnect and renegotiate; sessions, local chats and coordinator records remain on their owning devices. A healthy `/health` response proves the signaling process is serving requests, not that a particular peer or TURN allocation is reachable.

Stop with `docker compose --profile tls --profile turn down`. The certificate volumes survive unless explicitly removed. Rotate `TURN_SECRET` in both services together; clients need fresh temporary credentials after rotation. Preserve TLS certificates while updating and use `docker compose up --build -d` with the same enabled profiles to replace the service.
