# Beta release contract

This document records the supported beta surface and the release gates derived
from [CONCEPT.md](CONCEPT.md) and [SOLUTION_DESIGN.md](SOLUTION_DESIGN.md). A tagged build is releasable only
when every required gate below passes for that commit.

## Supported in beta

- Local Docker Engine or Docker Desktop on Linux, macOS, and Windows.
- The CLI and daemon over a user-local Unix socket or Windows named pipe.
- Namespace registration, concurrent workspace creation, capture, snapshot
  revival, leases, reconciliation, and resumable reap.
- Redis, PostgreSQL, and MinIO service provisioning through the built-in
  service library.
- Named volumes, including `copy-on-start` seeding from a namespace volume.
- Optional namespace ingress through the envmux proxy, protected with mTLS on
  ingress and a per-namespace bearer credential on its loopback control port.
- The optional portal: the web UI and `/v1` API over plain HTTP, off unless
  `--http-bind` is passed, loopback-only unless `--http-allow-public` is also
  passed, and unauthenticated when enabled.

Remote operation, Tauri packaging, Podman/rootless Docker, submodules, Git LFS,
sparse checkout, and custom service plugins are not part of the beta support
promise.

The portal ships as a local, opt-in surface only. Serving it to anything beyond
loopback, or to a browser on another machine, is outside the support promise:
it has no authentication of its own, and the concept design's position that
browser mTLS is unusable has not changed. A developer who exposes it is
expected to front it with their own session layer.

The configuration schema accepts the egress policy vocabulary from the design,
but beta implements only `unrestricted`. `proxy-only` and `allowlist` are
rejected during validation so a requested restriction can never silently run
open.

## Required CI gates

- Formatting, documentation with warnings denied, and Clippy with warnings
  denied.
- Portal UI build, plus a regenerate-and-diff of the wire types so the
  generated TypeScript client cannot drift from `envmux-api-types`.
- Per-platform installer bundles, built natively on each runner.
- Workspace tests on Linux, macOS, and Windows.
- The pinned MSRV build, dependency policy (`cargo-deny`), and RustSec audit.
- Cross-target proxy compilation.
- Linux Docker integration covering creation of two workspaces, Redis
  provisioning, task execution, copy-on-start, capture, snapshot revival,
  graceful daemon restart and namespace rehydration, and reap.

## Release procedure

1. Build and publish `images/proxy.Dockerfile`, `images/default.Dockerfile`,
   `images/dotnet-node.Dockerfile`, and `images/rust-node.Dockerfile` for the
   advertised container architectures.
2. Record the immutable proxy manifest reference
   (`ghcr.io/.../proxy@sha256:...`). Build release binaries with that value in
   `ENVMUX_PROXY_IMAGE_DEFAULT`. `ENVMUX_PROXY_IMAGE` remains a runtime override
   for development and private registries.
3. Push the tag. `.github/workflows/release.yml` builds each platform's
   installer natively — Tauri cannot cross-compile a bundle — and attaches
   them, plus CLI-only archives carrying the portal assets, to a **draft**
   GitHub Release.
4. Sign the artifacts and exercise each installer on its native OS. Windows
   SmartScreen and macOS Gatekeeper both warn on unsigned builds; the README
   says so plainly, which is a stopgap rather than a position.
5. Run the required workflow on the release commit, attach its successful run
   to the release notes, and publish the draft.

There is deliberately **no auto-updater**. A self-updating binary commits you
to an update endpoint, signing keys, and a rollback story; until those exist,
an updater that half-works is worse than none. Upgrading means downloading a
newer installer.

The repository is beta-candidate quality when these gates pass. It is not a
publishable beta artifact until the images exist in the target registry and the
daemon binaries have been built against the recorded proxy digest.

## Intentional design deviations

- The CLI starts a detached, self-supervising daemon rather than remaining as
  its parent for the daemon's lifetime. `envmux down` provides graceful local
  shutdown; production residency remains the responsibility of an OS service.
- Docker Desktop cannot reach bridge-only container addresses from the host.
  Service administration and proxy control therefore use loopback-published
  ports. Service ports use generated credentials; proxy control additionally
  requires a per-namespace bearer credential.
- Restricted egress is fail-closed but deferred, as described above.
- The beta release surface is CLI-only. The design explicitly leaves the
  frontend and Tauri shell outside the Rust implementation scope.
