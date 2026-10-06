# Hosted networking live verification

The deployed [EnoughFactory network service](https://enoughfactory-network.russellbloxwich.workers.dev/health) passed one complete live journey on October 5, 2026 in America/Mexico_City (October 6 UTC). The [sanitized receipt](hosted-network-2026-10-05.json) records actual observed source hashes, public peer IDs, timestamps and results. The deployment version supplied by the deploying parent was `4c214543-6b5f-469f-abf7-0fcedfeec119`; the health endpoint independently reported the expected protocol and Cloudflare hibernation transport.

Two production `PeerManager` instances on one Mac used separate disposable identities and a unique room. This verifies the application transport through the deployed service; it does not claim two physical devices or a WebRTC connection. The check forced the encrypted WSS fallback, with no RTC runtime, containers, model turns or issued TURN credentials.

The journey paired both identities, exchanged an authenticated encrypted RPC, transferred 1 MiB of random artifact content with matching whole-file SHA-256 hashes, observed the owner offline, recreated the owner from its saved identity/catalog, and exchanged another authenticated RPC after reconnecting. All 94 observed relay envelopes contained encrypted boxes; the private RPC marker was absent from inspected signaling wire. The service returned negotiated pacing of 512 KiB/s and 20 relay messages/s. The completed check reported no service errors. Both peers stopped and their disposable identity/artifact homes were removed.

Two preceding failed attempts remain available:

- [First attempt](hosted-network-2026-10-05-first-attempt.json): forced-relay negotiation expired after 50 ms, shorter than a WAN handshake. It repeatedly started new sessions and hit the concurrent-session bound. The clients now allow the existing 5-second negotiation deadline, still activating relay immediately when the authenticated hello arrives. Stale timeouts and duplicate retries were also corrected.
- [Second attempt](hosted-network-2026-10-05-second-attempt.json): the fixture asserted the second endpoint's transport after waiting for only the first endpoint. Both endpoints authenticate independently; the corrected fixture waits for both. This attempt recorded no service errors or artifact transfer.

A subsequent read-only review found a separate existing race in legacy/direct RPC heartbeat rejection callbacks: an old callback could disconnect a replacement connection for the same peer. Both clients now check the captured link identity, and native `online()` rejects superseded links as the browser already did. These final guards were typechecked, with their separate hashes recorded under `postVerificationChanges`; they were added after the successful live journey and are not claimed as live-tested. Hosted WSS connections skip those RPC heartbeat calls.

The check consumes shared service capacity. The hosted service's all-room daily limits remain 10,000 JSON messages and 1 GiB of encrypted WSS egress; limits reject excess use and reset at UTC midnight. This was a bounded functional check, not a load or throughput benchmark. It changed no app settings, defaults or deployed Worker configuration.

To invoke the focused fixture against a reviewed deployment:

```sh
ENOUGHFACTORY_HOSTED_NETWORK_URL=https://enoughfactory-network.russellbloxwich.workers.dev \
ENOUGHFACTORY_HOSTED_NETWORK_VERSION=<deployment-version> \
node --import tsx scripts/hosted-network-smoke.ts
```

`ENOUGHFACTORY_HOSTED_NETWORK_RECEIPT` can select a new receipt path so historical results are preserved.
