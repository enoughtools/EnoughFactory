# Contributing to EnoughFactory

Read the [build plan](docs/build-plan.md) and [implementation instructions](AGENTS.md) before changing product behavior. EnoughFactory is one shared interface over a device-owned runtime. Keep the envmux adapter narrow and preserve the distinction between container permissions, approval policy and goal autonomy.

## Development

Install Node 22.14+, pnpm 10.34.5, Git, the .NET 10 SDK, Python 3.10+ and build tools (`make`, `gperf`, `tar`, `file`, binutils and standard shell utilities; Xcode Command Line Tools on Mac). Runtime preparation downloads its pinned Go/Zig toolchains and builds the native engine components. Satisfy the target's host prerequisites; an existing Docker daemon is not a product dependency. Clone the repository, then:

```sh
pnpm install --frozen-lockfile
pnpm --filter @enoughfactory/envmux build:engine
node scripts/prepare-container-runtime.mjs
pnpm dev
```

Open the desktop during development in another terminal:

```sh
pnpm --filter @enoughfactory/desktop dev
```

Use a disposable repository for changes to session teardown, integration or agent execution. Development uses the private runtime and real provider accounts when connected. Use a separate `ENOUGHFACTORY_HOME` if you need independent application state. Every engine call must receive the managed endpoint and private client configuration; a missing runtime must never fall back to the user's Docker socket or context.

## Verification

Run `pnpm typecheck` and `pnpm build` for changes affecting the shared application. Add or run focused checks for behavior that can lose work, accept stale authority, misroute approval decisions or confuse unknown execution with failure. The relevant package README documents its test commands and optional Docker journeys.

A representative user journey is usually better evidence than another test mirroring a function's implementation. Styling changes need a visual check. Runtime or packaging changes need a real session or packaged-service check on the affected platform. Record what you ran and what it proves; do not label unconfigured checks as passed. Once appropriate checks pass, continue toward the intended outcome.

## Pull requests

Explain the concrete problem, resulting behavior and meaningful validation. Keep changes scoped enough to review, including coherent documentation and interface states. Preserve runtime request identity, policy revisions, attempt generations and device ownership when touching their boundaries.

If you change an upstream pin, update its provenance, required notices and matching source companions. The [engine source and relink kit](runtime/container/relink-kit/README.md) records native build inputs; the [Ubuntu source kit](runtime/container/os-source-kit/README.md) resolves the guest's exact package versions. Rebuild those companions before publishing changed binaries or guest images. Changes to `vendor/envmux` should be minimal and listed in `vendor/envmux/ENOUGHFACTORY-PROVENANCE.md`. Preserve native/font licenses in distributions. See [third-party notices](THIRD_PARTY_NOTICES.md).

Bug reports should include the EnoughFactory version, OS/architecture, affected runtime, reproduction steps and a redacted error. Do not upload connection tokens, pairing invitations, provider credentials, private repository contents or unredacted conversations. Report security issues through [SECURITY.md](SECURITY.md).

Contributions are provided under this repository's MIT license unless the changed upstream file carries another license. Participation follows the [code of conduct](CODE_OF_CONDUCT.md).
