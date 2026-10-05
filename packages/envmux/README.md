# EnoughFactory envmux adapter

This service-only TypeScript package wraps the pinned envmux engine. It owns a child process and its private readiness descriptor, and uses the engine's existing authenticated state, task, stream and shell APIs. React never receives the engine bearer or SOCKS credential.

The source pin and local changes are recorded in [upstream provenance](../../vendor/envmux/ENOUGHFACTORY-PROVENANCE.md). The engine owns Docker state, Git bundle transport, task latching and teardown; this package is not another implementation of those functions.

Build a self-contained engine on a development machine with the .NET 10 SDK:

```sh
node scripts/envmux-build.mjs osx-arm64 linux-x64 linux-arm64
```

Output is `artifacts/envmux/<runtime-id>/envmux`. The shipped engine includes its .NET runtime. `ENOUGHFACTORY_ENVMUX_BINARY` selects an installed engine. Development also supports `ENOUGHFACTORY_DOTNET` and `ENOUGHFACTORY_ENVMUX_DLL`, or the standard local SDK at `~/.local/share/enoughfactory/dotnet`.

`EnvmuxEngine.detect`, `validate`, `discover`, `start` and `attach` supply lifecycle operations. A session exposes state/events, task controls/output, live repository status/diff and service-side shell URL/headers. Save `session.ready` and `session.pid` in private service storage to reconnect after a daemon restart. Reattachment verifies the saved endpoint still owns the expected session. It does not infer that an unreachable container has stopped.

Each terminal has a stable application ID passed as `terminal` to `/api/shell`. Reusing the ID reconnects the same tmux terminal; different IDs create independent terminals. For browser clients the device service proxies the WebSocket and adds `shellHeaders`; never expose those headers in a renderer.

Git workspaces use the upstream default. ArtifactFS integration accepts only a trusted manager mount under `/var/lib/enoughfactory/workspaces/<attempt>/repo` with the matching `enoughfactory-afs-<attempt>` state volume. The provider must seed the exact source input on `envmux/<session-name>` before startup. Invalid or unready mounts fail rather than being overwritten by an ordinary clone.

Run one real source-retention journey after a runtime change:

```sh
pnpm exec tsx scripts/envmux-smoke.ts
```

This uses a temporary fixture, the real Docker engine, authenticated events, source inspection, reattachment and Git recovery. It leaves the stopped fixture container and recovered host branch available for inspection.
