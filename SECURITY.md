# Security

EnoughFactory deliberately runs development agents with full permissions inside isolated containers. It is designed for devices and projects you own or control. Container access, Enough approval decisions and factory autonomy are separate settings.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** flow for private vulnerability reports. Include the affected version, OS/architecture, reproduction steps, expected boundary and actual impact. Do not include live credentials or private source unless essential to reproduce the issue. Avoid posting exploitable details in a public issue while a private report is being investigated.

Only the latest published release is the initial maintenance target. Until a release exists, report against the current default branch and include its commit. We will acknowledge reports as maintainer availability permits and coordinate fixes and disclosure with the reporter; no fixed response time is promised.

## Boundaries and data

- The device service binds its factory API to loopback and requires a private bearer token. The token is access to that service, not a read-only credential.
- Pairing enrolls another device for access. Invitations are short-lived and single-use; send them only to devices you control. Revoke an unwanted peer from Devices.
- Device identities authenticate negotiation; relay traffic is encrypted between enrolled endpoints. The signaling service is not a transcript or goal store.
- Agent containers do not receive the host Docker socket through EnoughFactory's agent adapter. Project mounts, credentials and services remain deliberate environment configuration.
- Previews run on separate origins and Electron partitions without the factory preload or Node access. Keep public preview gateways separate from the factory API.
- Approve all intentionally authorizes supported runtime actions without a human wait. Rules and Manual govern the typed requests an adapter exposes; an accepted shell command can have effects without additional callbacks.
- Losing a worker connection does not prove its process stopped. The coordinator records unknown status and reconciles its journal or retires its authority before replacement work is accepted.

The default state directory, `~/.enoughfactory`, contains service access tokens, identity keys, chats and coordination records. Treat it as private. Provider credentials remain sensitive even when scoped to containers. Redact tokens, invitation codes, credentials, repository content and conversations before sharing diagnostics.

Self-host operators should use TLS, restrict signaling admission to their device IDs where appropriate, and keep the shared TURN secret on the signaling/TURN services. See [self-hosting](docs/self-hosting.md) for the actual configuration. EnoughFactory does not guarantee that a third-party runtime emits a decision request for every filesystem, process or network effect.
