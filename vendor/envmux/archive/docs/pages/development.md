# Development

Working on envmux itself.

## Layout

```
crates/          the Rust workspace
  envmux-core       domain newtypes, lifecycle state machine, label schema,
                    state-dir and IPC-endpoint resolution
  envmux-config     .envmux.toml model, validation, hashing, drift, the
                    authoring prompt
  envmux-docker     typed bollard layer, plus `docker build` orchestration
  envmux-git        mirror, clone-with-alternates, capture, observation
  envmux-tmux       tmux control-mode client over Docker exec
  envmux-services   Postgres/MinIO/Redis slice provisioning
  envmux-secrets    helper chain: keyring, file fallback, external helpers
  envmux-api-types  wire DTOs — the single source of truth for the wire
  envmux-daemon     the daemon, as a library
  envmux-cli        THE binary: the CLI, the TUI, and `envmux daemon`
images/          development container images
scripts/         install, smoke
docs/            you are here
```

One deliberate separation: **`envmux-daemon` is a library**, and `envmux-cli`
is the only binary. One executable means a CLI can never meet a daemon from a
different build, and nothing has to keep two files together.

`envmux-api-types` stays a separate crate for the same reason it always was:
the wire shapes are the contract between the two halves, and a DTO change
should be visible as a change to exactly one crate. Nothing is generated from
it any more — the portal that consumed TypeScript is gone.

## Build and test

```console
$ cargo build --workspace
$ cargo test --workspace
$ cargo clippy --workspace --all-targets -- -D warnings
$ cargo fmt --all --check
```

## The documentation site

The site is built with [Vocs](https://vocs.dev) from `docs/pages` — the same
Markdown GitHub renders, so there is no second copy to drift.

```console
$ npm install
$ npm run docs:dev        # http://localhost:5173
$ npm run docs:build      # into docs/dist
```

Vocs validates internal links at build time. A failure here is usually a link
pointing outside `docs/pages`; link to GitHub for those.

> **Vocs 1.4.1 does not build on Windows.** It mangles absolute paths when
> resolving its own theme (`Z:\envmux\node_modules\…` loses its backslashes to
> escape interpretation). `npm run docs:dev` is likewise affected. Build it in
> WSL, in a container, or let CI do it — the `Docs` workflow builds every pull
> request, so a broken page is caught regardless.
>
> ```console
> $ docker run --rm -v "$PWD:/src:ro" -w /build node:24-trixie bash -c \
>     'cp -r /src/package.json /src/vocs.config.ts /src/docs /build/ && \
>      npm install && npx vocs build'
> ```

## Conventions

- `thiserror` in libraries, `anyhow` only in binaries, `miette` for config
  diagnostics — the config file is the primary human touchpoint and earns the
  best errors.
- `unsafe` is forbidden outside the secrets platform shims.
- `unwrap`/`expect` are denied by Clippy outside tests.
- Curated lint allows live in the workspace lints table, never as inline
  `#[allow]` without a comment.
- Comments explain *why*. The code already says what.

## Testing

| Layer | Approach |
|---|---|
| Domain, config | Unit tests; `insta` snapshots for resolved config and `--porcelain` |
| SQL | `sqlx` compile-time checks, migrations against a temp database |
| Git subsystem | Against real `git` in temp directories — torn-capture detection, alternates safety, `--no-optional-locks` non-disturbance |
| tmux client | Protocol parser against recorded control-mode transcripts |
| Docker paths | `#[ignore]`-by-default integration, run in a CI job with a daemon |
| API | axum router in-process via `tower::ServiceExt::oneshot` |
| TUI | Rendered into an in-memory backend, down to 20×8 and 10×5 |
| End to end | `scripts/smoke.sh` against a live Docker daemon |

Write the test that would have caught the bug. Several tests in this repository
exist because they caught a flaw in the first version of their own fix — the
path-traversal check, the CLI error message, the IPC endpoint digest.

## Running the daemon during development

```console
$ envmux daemon --state-dir .envmux/state                # foreground, logs on stderr
$ RUST_LOG=debug envmux daemon --state-dir .envmux/state # more of them
$ ENVMUX_STATE_DIR=/tmp/envmux-dev envmux daemon         # a scratch world
```

Use a scratch `ENVMUX_STATE_DIR` when experimenting. It keeps mirrors, shadow
history, and the database out of your real one — and the CLI must use the same
value, or it reads a different IPC credential and gets a 401.

Remember the daemon is a dead-man switch: with no client for `--grace-secs`
(default 60) it closes its containers and exits. Pass a large `--grace-secs`
when you want a foreground daemon to sit still between manual CLI pokes.

## Before you push

CI runs formatting, Clippy with warnings denied, docs with warnings denied,
tests on three platforms, the MSRV build, a current-stable check, cargo-deny,
RustSec audit, the development images with their substrate assertions, and a
Docker-backed integration job.

Run at least the first four locally. They are fast, and they are the ones that
fail most.
