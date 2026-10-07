# EnoughFactory envmux adapter

This service-only TypeScript package wraps the pinned envmux engine. It owns a child process and its private readiness descriptor, and uses the engine's existing authenticated state, task, stream and shell APIs. React never receives the engine bearer or SOCKS credential.

The source pin and local changes are recorded in [upstream provenance](../../vendor/envmux/ENOUGHFACTORY-PROVENANCE.md). The engine owns container state, Git bundle transport, task latching and teardown. EnoughFactory's managed runtime owns the daemon and its private socket.

Build a self-contained engine on a development machine with the .NET 10 SDK:

```sh
node scripts/envmux-build.mjs osx-arm64 linux-x64 linux-arm64
```

Output is `artifacts/envmux/<runtime-id>/envmux`. The shipped engine includes its .NET runtime. `ENOUGHFACTORY_ENVMUX_BINARY` selects an installed engine. Development also supports `ENOUGHFACTORY_DOTNET` and `ENOUGHFACTORY_ENVMUX_DLL`, or the standard local SDK at `~/.local/share/enoughfactory/dotnet`.

Construct `EnvmuxEngine({ dockerRuntime: manager.endpoint, containerHostAddress: manager.bridgeHostAddress() })` using `ManagedRuntimeManager` from `@enoughfactory/runtime`. The descriptor supplies `{host, cliPath, configDirectory}` for EnoughFactory's own engine. Call the manager's `ensureReady()` before a container operation. The adapter never resolves the user's Docker context or default socket. Missing runtime configuration fails closed; CLI calls explicitly select the managed socket and private configuration directory.

`EnvmuxEngine.detect`, `validate`, `discover`, `start` and `attach` supply lifecycle operations. A session exposes state/events, task controls/output, live repository status/diff and service-side shell URL/headers. Save `session.ready` and `session.pid` in private service storage to reconnect after a daemon restart. Reattachment verifies the saved engine provenance and expected session. A record from a different or legacy engine remains unknown; it is not adopted into the managed daemon.

The adapter checks the engine's `--factory-capabilities` contract before starting or discovering containers. This prevents an older binary from ignoring managed endpoint requirements and falling back to an ambient engine. Child environments remove Docker contexts and TLS settings, select the explicit owned Unix socket, and can carry a manager-provided host bridge IP for Mac guest-to-service communication.

`start({ goldenImage: 'sha256:<64 lowercase hex digits>', ... })` selects one immutable image already prepared on the owned engine. This requires `managedGoldenImage: true` from the capability probe and an exact `goldenImage` startup receipt. The adapter clears inherited image overrides on every command and supplies `ENVMUX_MANAGED_GOLDEN_IMAGE` only to that launch. Missing images fail without pulling or rebuilding. The engine includes the immutable base ID in the resolved plan's project image fingerprint without changing the project's configuration; feature caches and adopted sessions also carry the exact base ID. Self-spawned agents do not inherit this per-launch override.

Each terminal has a stable application ID passed as `terminal` to `/api/shell`. Reusing the ID reconnects the same tmux terminal; different IDs create independent terminals. For browser clients the device service proxies the WebSocket and adds `shellHeaders`; never expose those headers in a renderer.

Git workspaces use the upstream default. ArtifactFS integration accepts only a trusted manager mount under `/var/lib/enoughfactory/workspaces/<attempt>/repo` with the matching `enoughfactory-afs-<attempt>` state volume. The provider must seed the exact source input on `envmux/<session-name>` before startup. Invalid or unready mounts fail rather than being overwritten by an ordinary clone.

Run one real source-retention journey after a runtime change:

```sh
pnpm exec tsx scripts/envmux-smoke.ts
```

This provisions EnoughFactory's owned runtime, then uses a temporary fixture, authenticated events, source inspection, reattachment and Git recovery. It never invokes the user's Docker CLI or daemon. It leaves the stopped fixture container and recovered host branch available for inspection.
