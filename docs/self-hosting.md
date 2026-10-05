# Self-host EnoughFactory

The device service owns execution and local history. The signaling service exchanges presence and authenticated negotiation, issues optional temporary TURN credentials, and can forward encrypted relay frames. It stores no conversations or goals. A local-only factory needs no signaling service.

## Signaling with Docker and TLS

On a server you control:

```sh
git clone https://github.com/enoughtools/EnoughFactory.git
cd EnoughFactory/services/signaling
cp .env.example .env
```

Edit `.env`: set `SIGNALING_DOMAIN` to your hostname and optionally restrict `ENOUGH_SIGNALING_DEVICE_IDS` to your device identity IDs. Point DNS at the server and allow inbound TCP 80/443, then:

```sh
docker compose --profile tls up --build -d
docker compose logs --tail=50 signaling
curl --fail https://YOUR_SIGNALING_DOMAIN/health
```

Devices use `wss://YOUR_SIGNALING_DOMAIN/ws` in Settings. Caddy provisions HTTPS certificates and forwards WebSocket upgrades. The raw port is bound to host loopback by default. With an existing TLS proxy, run `docker compose up --build -d signaling` and proxy `/ws` and `/health` to `127.0.0.1:8788`.

The default STUN service is `stun:stun.cloudflare.com:3478`; override `STUN_URLS` with your own service or an empty value. Set `ENOUGH_SIGNALING_ALLOW_RELAY=false` to disable the encrypted WSS fallback. A browser Origin allowlist is separate from device admission and pairing. Without a server device allowlist, any valid identity can use bounded signaling/relay; use that configuration on a trusted network.

The complete variables, wire protocol, rate limits and operation notes are in the [signaling README](../services/signaling/README.md). The `.env` file is Compose input; direct Node execution must explicitly load it with `--env-file`.

## Optional TURN

For networks requiring a relay, enable the included coturn profile on a Linux server with a stable public address. Configure these values in `.env` using real hostnames, addresses and identity IDs:

```dotenv
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_REALM=turn.example.com
TURN_EXTERNAL_IP=YOUR_PUBLIC_IP
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
ENOUGH_SIGNALING_DEVICE_IDS=YOUR_FIRST_DEVICE_ID,YOUR_SECOND_DEVICE_ID
```

Generate `TURN_SECRET` with `openssl rand -hex 32` and save it privately in `.env`. Signaling and coturn use that same secret; device clients receive short-lived credentials. Signaling refuses TURN configuration without a device admission allowlist.

Allow TCP/UDP 3478 and UDP 49160–49200 in both host and network firewalls, then:

```sh
docker compose --profile tls --profile turn up --build -d
```

The supplied profile provides `turn:` over UDP/TCP, with host networking on Linux. It does not provide `turns:`. TLS TURN requires a coturn certificate/key and TCP 5349; Caddy's HTTP proxy cannot terminate the TURN protocol. Consult the [complete TURN instructions](../services/signaling/README.md#optional-turn-relay) before enabling it. A signaling health response does not prove a TURN allocation or a particular NAT path works.

## Pairing and availability

Set the signaling endpoint on the inviting device, generate an invitation in Devices and redeem it on another owned device. Invitations expire after ten minutes and are single-use. Pairing pins long-lived identities; encrypted invitations and signed negotiation bind access to the enrolled peer. Forget a peer to revoke its enrollment.

Restarting signaling clears live presence and sockets; services reconnect and renegotiate. Environments and local chats stay on their owner. Closing a desktop window leaves its service connected. An offline coordinator stops dispatching new work; it does not prove that previously dispatched workers stopped. Keep one coordinator authority per goal and do not synchronize live SQLite databases.

## Browser preview gateway

RTC data channels do not provide navigable browser URLs. The viewing device service can expose a separate preview listener behind a TLS proxy. Configure the service environment before starting it:

```dotenv
ENOUGHFACTORY_PREVIEW_ORIGIN_TEMPLATE=https://{id}.preview.example.org
ENOUGHFACTORY_PREVIEW_PORT=43126
ENOUGHFACTORY_PREVIEW_HOST=127.0.0.1
```

Provision wildcard DNS and a wildcard TLS certificate for `*.preview.example.org`. Your reverse proxy must preserve `Host` and forward HTTP **and WebSocket upgrades** for those preview hosts to `127.0.0.1:43126`. Wildcard certificate provisioning normally needs your DNS provider's DNS challenge integration; the included signaling Caddy profile does not configure this preview domain for you. Use `ENOUGHFACTORY_PREVIEW_HOST` only when the proxy must connect over another interface.

That listener serves scoped preview grants, not factory APIs. Each preview gets its own origin and HttpOnly preview cookie; hosted cookies are Secure and SameSite=None. Never place the factory bearer token or another service's routes on the preview domain.

Development servers should respect `X-Forwarded-Host` and `X-Forwarded-Proto`, or be configured with their public preview origin. The gateway rewrites same-target redirects and cookie scope. It does not rewrite hardcoded localhost JavaScript, service worker bodies or links to another container port. Browser framing policies remain intact; open an external preview tab when framing is blocked. Use the Electron session browser when a project requires unrestricted container-localhost semantics.

See [preview implementation notes](../packages/previews/README.md) for the actual request route and lifecycle.

## ArtifactFS workspaces

Ordinary Git is the default workspace provider. The optional ArtifactFS manager runs inside the Linux Docker engine, including a Mac's Linux VM. The trusted manager holds FUSE/mount capability; agent containers consume the attempt's private mount and state volume without receiving the host Docker socket or mount capability.

Build the pinned image from source:

```sh
bash runtime/workspaces/build.sh
```

This fetches the committed RepoReach/ArtifactFS source, applies the documented private mount patch and builds `enoughfactory/artifactfs:6a62f2f34aeb`. Image provenance and Apache-2.0 notices are recorded in [runtime/workspaces/NOTICE.md](../runtime/workspaces/NOTICE.md); dependency licenses are retained in the image.

Use `workspaceProvider: "artifactfs"` in the goal creation API to select this provider explicitly. Selection and fallback are recorded with the workspace. If the provider is unavailable, the compatible Git fallback remains visible; integrations using the workspace manager can request strict provider behavior instead.

ArtifactFS is source/workspace storage. SQLite coordination, device-local chats and immutable evidence manifests remain separate. Do not use a mounted repository as a transactional scheduler database.

## Checks and configured actions

Candidate checks run inside isolated Docker containers with full access. The default image is `node:22-bookworm`; `ENOUGHFACTORY_CHECK_IMAGE` selects a project-compatible image. Put required project commands in the goal objective or context so the planner retains them with its task checks. No commands produces `not-configured`, rather than a successful verification claim.

The goal's autonomy and approval policy are independent. Autonomous with Approve all can drive configured repository and release actions without a compulsory human checkpoint. Credentials and integrations must actually be configured in the environment where those actions run. Provider-native approval coverage remains adapter-specific.

## Updating and recovery

Update the source or desktop package, retain the device state directory and reinstall the optional user service from the updated application resources. Keep signing status and native architecture explicit. Back up state only while the service is shut down; back up project repositories separately.

To update signaling, rebuild it with the same enabled Compose profiles. Rotate `TURN_SECRET` in both signaling and coturn together. Preserve Caddy certificate volumes. `docker compose --profile tls --profile turn down` stops the services without deleting those volumes.
