# EnoughFactory hosted networking

This separate OSS Worker introduces authenticated device identities and forwards end-to-end encrypted WSS envelopes when direct WebRTC is unavailable. It uses the [existing signed protocol](../signaling/README.md#wire-protocol), a SQLite Durable Object and WebSocket Hibernation. Device services retain chats, workspaces and factory authority. Signaling never stores forwarded bodies, conversations or goals.

`GET /health` checks the Worker; `/ws` uses the shared default room. A URL such as `wss://YOUR_WORKER.workers.dev/ws?room=YOUR_RANDOM_ROOM` isolates contact discovery and routing. Room names contain 1–96 letters, digits, `_` or `-`. Use a random room identifier when self-hosting a private fleet; the invitation carries this exact URL. A room is a routing boundary, not device enrollment: paired Ed25519 identities and invitation secrets remain the access authority.

Presence contains only requested contact IDs, public keys and online timestamps, plus the requesting identity. It never publishes a global roster, device names, platform or architecture. The server validates each signed sender and forwards only the signed envelope fields. Pairing material and relay bodies are encrypted by the endpoints; signaling cannot grant access to another device.

## Local check and deployment

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @enoughfactory/signaling-cloudflare typecheck
pnpm --filter @enoughfactory/signaling-cloudflare test
pnpm --filter @enoughfactory/signaling-cloudflare build
pnpm --filter @enoughfactory/signaling-cloudflare dev
```

`build` is an upload dry run. The runtime check uses local workerd/SQLite and real signed WebSockets, including eviction into hibernation, reconnect-safe replay state, room isolation, encrypted forwarding and receiver limits. Daily quota boundaries use deterministic counter fixtures rather than a gigabyte of test traffic. It starts no containers, inference or external TURN API calls.

The same bounded check pairs two actual `PeerManager` instances through this Worker, forces encrypted WSS, exchanges an RPC and a SHA-256-verified 1 MiB artifact, then reconnects an enrolled identity. Native RTC is not started. This verifies client pacing and delivery integration rather than only manually constructed signaling frames.

After reviewing the account and service limits, deploy with an existing authenticated account:

```sh
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID pnpm --filter @enoughfactory/signaling-cloudflare exec wrangler deploy
```

The configuration creates one **SQLite** namespace (`new_sqlite_classes`), a Worker and its workers.dev HTTPS endpoint. No custom DNS/domain, paid plan, scheduled jobs, provider key or TURN billing is required for basic signaling/WSS. Deployment needs account permission to publish Workers and create the Durable Object namespace. An account API token or Wrangler login must stay outside source. Verify `/health` and a paired connection before setting any app default endpoint. Marketing deployment configuration is independent.

## Free-plan eligibility and limits

As checked on October 5, 2026, Cloudflare supports SQLite Durable Objects on **Workers Free**. Its account allowances include 100,000 DO requests/day, 13,000 GB-s/day, 5 million SQL rows read/day, 100,000 rows written/day and 5 GB storage. Free operations fail when a relevant allowance is exhausted and reset at 00:00 UTC. The migration in this package selects the eligible backend. [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [backend eligibility and limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

Workers Free also limits incoming Worker requests to 100,000/day. A paid plan is an optional account choice with a $5/month minimum and usage charges; it is **not** a prerequisite here. Workers have no additional egress/throughput charge under the documented pricing. Realtime TURN is billed separately. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Idle sockets use `acceptWebSocket`, attachment recovery and automatic literal `ping`/`pong`. There are no repeating object timers; the one-shot authentication deadline alarm disappears after authentication. Clients use signaling heartbeat/presence for idle WSS paths instead of sending periodic encrypted RPCs through the object. [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

The application additionally enforces these deployment-wide defaults:

| Limit | Default |
| --- | --- |
| Concurrent sockets | 128 total, 32 per room, 8 per edge IP |
| Admission churn | 30 upgrades/minute/IP, 500 upgrades/day total |
| Authentication deadline | 10 seconds |
| Input | 512 KiB/frame, 100 JSON frames and 1 MiB/second/socket |
| Daily JSON messages | 10,000 including delivery ACKs, across all rooms |
| Daily encrypted WSS egress | 1 GiB across all rooms, including receipt fields |
| Outstanding delivery | 128 frames or 4 MiB per receiving socket |
| Stalled delivery | Receiver closed when next delivery finds a receipt older than 30 seconds |
| Replay records | 128 active type/target/session sequences/socket, five-minute freshness |
| Discovery subscriptions | 128 known contact IDs/socket |

`auth-ok.relayLimits` advertises a conservative shared client send pace of 512 KiB/second and 20 relay envelopes/second. Updated clients pace their encrypted WSS queues before sending, retaining room for acknowledgments and control. The service input limit remains an admission guard, not a reason to reject ordinary fast artifact transfers.

The configurable limits are in `wrangler.jsonc`; concurrent/IP/room, daily JSON and daily relay limits have corresponding `ENOUGH_SIGNALING_*` variables. Global counters cover all rooms so choosing another room cannot bypass the budget. Counters, contact subscriptions, replay sequences and receipt IDs/sizes are the only SQLite rows. Receipt/replay/subscription rows are deleted on connection close; stale IP admission counters are pruned on admission. Forwarded payloads are not logged or written to SQLite.

These are capacity controls, not an unlimited service or a promise that every traffic pattern fits the account's free allowance. Presence fanout, replay guards and ACKs consume SQL operations; Cloudflare can reject work before the application cap. Self-generated identity keys prove key possession, not entitlement to funded traffic. Public users share the daily capacity; a device allowlist is available for private deployments. A paid account needs its own billing review before raising limits. The WSS cap does not meter TURN bandwidth or TLS/IP overhead.

`relay_quota` leaves direct WebRTC negotiation available. `service_quota` closes the affected signaling connection until capacity resets; clients receive a concrete capacity code and message. Admission returns HTTP 429. Stalled receivers close with 1013. Local execution and durable factory work remain on their owning device through signaling outages.

## Client boundary

Hosted discovery/reconnection and WSS relay require clients with the new negotiated `deliveryAcknowledgments` and `discoverPeers` extensions. The authentication signature remains over the original fields; these optional fields are outside that signed payload. Clients refresh contact subscriptions after pairing/forget. The server attaches an unsigned `deliveryId` to each forwarded envelope/presence; after processing it, the receiver sends `{v:1,type:"delivery-ack",id}`. The encrypted/signed payload is unchanged.

Legacy clients can authenticate and exchange directed signed introduction frames; they receive `relay:false`, no global discovery roster and bounded unacknowledged delivery. They do not gain automatic hosted reconnection of already paired contacts. Update them before choosing this hosted service. The independent Node/coturn server remains compatible with existing clients and self-hosted deployments.

## Optional managed TURN

Public Cloudflare STUN is the default; it discovers direct candidates and is documented as free. STUN and signaling do not supply TURN relay bandwidth. The WSS fallback above requires no Realtime credentials. [Cloudflare TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/).

Managed TURN remains disabled until an operator deliberately supplies `CLOUDFLARE_TURN_KEY_ID`, secret `CLOUDFLARE_TURN_API_TOKEN`, and `ENOUGH_SIGNALING_DEVICE_IDS`. Use Wrangler secrets for the API token. No provider keys are created by this application. Only authenticated allowlisted identities receive generated temporary credentials; the server token never reaches clients. `TURN_TTL_SECONDS` defaults to 3600 (supported range 60–172800). Responses include explicit per-server `expiresAt` in Unix milliseconds, including opaque Cloudflare usernames. Issuance is bounded and rate limited; provider failure retains STUN/WSS with a clear error. [Credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

TURN has a separate 1,000 GB free tier, then $0.05/GB of edge-to-client traffic including TURN overhead, shared with Realtime SFU billing. Neither the Worker free plan nor the WSS daily limit caps this external bill. Do not enable it merely to deploy basic networking. [TURN pricing and accounting](https://developers.cloudflare.com/realtime/turn/faq/).

Native and browser clients refresh credentials before expiry. Confirmed local TURN paths reconnect when credentials change; established direct paths stay live. Active streams can need reconnection during this renewal. Static/self-hosted ICE configuration remains available, and the Node service also supports coturn's temporary REST credentials.
