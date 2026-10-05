# Portal + self-hosting checkpoint

Checkpoint written 2026-08-08, superseding the earlier development-image
checkpoint (that work is summarised below and remains in the worktree). The
worktree also contains the earlier beta-readiness implementation; do not
discard or overwrite those changes, and preserve the user's pre-existing
`README.md` edits.

## The portal (this pass)

Goal: envmux self-hosts envmux, with a portal visible over HTTP showing how
tasks are managed. CONCEPT §16 already specified the UI — Vite, React,
TypeScript, served by the daemon — while SOLUTION_DESIGN §1 held it outside
the Rust scope. It had never been built. It now exists.

- `ui/` — Vite + React + TypeScript portal. Views: overview (mirror state,
  service health, disk alert, reaping-soonest), workspaces (searchable and
  sortable by branch, dirtiness, tasks, capture age, time-to-death, config
  drift, routes), workspace detail (task graph, terminals, files, snapshot
  history, lease controls), volumes, events, config with drift state.
- Wire types are **generated**, never hand-written:
  `cargo run -p envmux-api-types --example dump-schemas -- ui/schemas` then
  `npm --prefix ui run codegen` (schemars → JSON Schema → TypeScript), exactly
  the pipeline SOLUTION_DESIGN §14 describes. CI regenerates and diffs them so
  a DTO change that never reached the portal fails the build.
- `GET /v1/workspaces/{id}/tasks` — new endpoint returning the workspace's
  **declared** task graph (command, `after`, `requires`, check, restart policy,
  exports) joined with live engine status. It is parsed from the workspace's
  frozen `config_toml`, so it reports what that workspace is actually running
  rather than what the repository declares today.
- `--http-bind` on the daemon serves the UI plus `/v1` over plain HTTP. Off
  unless passed; refuses a non-loopback bind without `--http-allow-public`;
  warns on every boot that it is unauthenticated. Assets resolve at runtime
  (`$ENVMUX_UI_DIR` → `ui` beside the executable → in-repo `ui/dist`), so the
  daemon still builds from a clean clone where `ui/dist` does not exist.
- Terminals attach over the existing WebSocket contract, read-only by default
  so watching an agent cannot silently extend its lease.

## Verification completed

- 89 workspace tests pass; `cargo fmt --all --check` clean; strict Clippy
  (`--workspace --all-targets -D warnings`) clean; `shellcheck -s sh` on
  `images/dev-common.sh` clean.
- Portal verified live: index, SPA deep links, fingerprinted assets with
  immutable caching, `no-cache` on the shell, and the `/v1` API all served on
  one plain-HTTP listener. Rendered against a real namespace in a browser.
- **A path-traversal bug was found and fixed during that verification.**
  `/..%2fCargo.toml` is a single path segment that percent-decodes to
  `../Cargo.toml`; `PathBuf::push` honours the embedded separator, so it
  escaped the UI root and served arbitrary files off disk. The original check
  only rejected a component that *equalled* `..`. Decoded components are now
  rejected if they contain any separator, with a regression test naming the
  case. Re-verified against the running daemon: seven traversal vectors all
  403, legitimate serving unaffected.

## Self-hosting: what is proven

On the Trixie image, on the fixture repository, the following ran end to end
and was verified directly:

| Stage | Result |
|---|---|
| Privileged DinD inside the workspace | `docker info` passes, server 26.1.5 |
| Portal UI built **inside** the container | `npm ci` + `vite build`, exit 0 |
| code-server | ready |
| Nested envmux daemon | compiled in-container, **started, reached `ready`** |
| Nested portal over HTTP | serves `index.html`, the fingerprinted JS asset, and `/v1` |
| Second-level namespace registration | `envmux up` registered `envmux-fixture` with `repo_remote=/work` |
| Second-level *workspace* | **blocked** — see below |

So envmux runs envmux, and the inner envmux serves its own portal over plain
HTTP with the task graph live. The one step not reached is the inner daemon
creating a workspace of its own.

### The remaining blocker: images cannot reach the nested daemon

```
pull access denied for envmux-rust-node, repository does not exist
```

The nested Docker daemon starts with an empty image store, and
`envmux-rust-node:trixie` is a local-only tag with no registry behind it. This
is the same unpublished-images gap BETA_RELEASE already records, surfacing one
level down. Two ways forward, both real work rather than a tweak:

1. **Publish the images.** Once the tag resolves from a registry, the nested
   daemon pulls it like any other and the second level completes with no code
   change. This is the intended path and is already on the release checklist.
2. **Seed the nested daemon.** `docker save | docker load` into the DinD. Not
   attempted here deliberately: the demo config runs dockerd with
   `--storage-driver=vfs`, which duplicates every layer, so loading a 6.3 GB
   image risks tens of GB of host disk. If this path is wanted, move the nested
   daemon to `overlay2` first.

## Earlier in this pass: how far it got before the image fixes

Proven on a fixture repository (per the previous checkpoint's suggestion),
built from the working tree and committed, so nothing was written to the real
repository's history:

- Privileged DinD came up inside the workspace (`docker` task ready).
- The portal UI **built inside the container** (`npm ci` + `vite build`,
  exited 0).
- code-server came up (`editor` task ready).
- The nested envmux daemon compiled in-container in 37s and started.

It then died on envmux's own substrate check:

```
Error: host git check
Caused by: host git 2.39.5 is older than required 2.40
```

**The development images could not run envmux.** They were based on
`node:24-bookworm`, and Debian Bookworm ships git 2.39.5 while envmux refuses
to start below 2.40. `bookworm-backports` does **not** carry git, so pinning
is not available; the fix is the base image. All three Dockerfiles now use
`node:24-trixie` (git 2.47.3), and the .NET feed moved from Debian 12 to 13.

Moving to Trixie then exposed a second packaging bug: `docker.io` on Trixie
only **Recommends** `docker-cli`, so with `--no-install-recommends` the images
got `dockerd` and no `docker` command. The symptom is confusing — the daemon
starts and initialises perfectly, and every client call reports
`docker: not found`, so the DinD task hangs on its own health check.
`docker-cli` is now installed explicitly.

Both bugs share a root cause worth noting: the images advertised tools that
were never checked. `dev-common.sh` now asserts the git version *and* that
every advertised command (`aws`, `claude`, `code-server`, `codex`, `docker`,
`dockerd`, `fd`, `git`, `jq`, `node`, `npm`, `rg`, `tmux`) resolves, at build
time, so a packaging change fails the build rather than a user's workspace.

## Next steps

1. Finish the Trixie rebuild of all three images and re-run the runtime checks
   for every advertised tool. The .NET variant is the one to watch: its
   Microsoft feed reference moved to Debian 13 and has not yet been built.
2. Re-run the fixture self-host flow on the Trixie image and confirm the
   nested daemon reaches `Ready`, then confirm `self-workspace` creates a
   second-level workspace.
3. **Full self-hosting of the real repository needs the work committed and
   pushed.** envmux clones workspaces from a mirror of the project remote, so
   a workspace only ever sees committed, pushed content — `ui/`, `.envmux.toml`
   and `images/` are currently untracked and are therefore absent from the
   clone. The fixture exists precisely to prove the flow without writing to
   the repository's history; the real thing needs a commit and a push.
4. The second-level workspace additionally needs an image the *nested* Docker
   daemon can obtain. A local-only tag is invisible inside DinD, so either
   publish the image or let the nested daemon build it from the Dockerfile
   (long, but it is the honest path).
5. Record final image sizes after the Trixie rebuild and decide whether to keep
   all agent CLIs in every image or split an optional agent-tools layer.
6. Consider pinning npm agent package versions or capturing resolved
   versions/provenance in release automation; they use `latest` deliberately.
7. Add multi-architecture image publishing and immutable digest injection to
   the release workflow; no registry publication has been performed.

## The orchestrator now builds and routes, including on Windows

Previously the proxy image could not be built on a Windows or macOS host at
all: `images/proxy.Dockerfile` did `COPY target/debug/envmux-proxy`, and on
those hosts that path holds a native binary that cannot run in a Linux
container. The published `ghcr.io` reference does not exist either, so every
namespace logged `orchestrator unavailable: ... denied` and declared `[routes]`
pointed at nothing.

The Dockerfile is now a multi-stage musl build that compiles the proxy itself.
It needs no host toolchain and no cross-compiler, and produces the same
artifact everywhere:

```console
$ docker build -t envmux-proxy:local -f images/proxy.Dockerfile .
```

Result: a 7.08 MB static binary on `FROM scratch`, built on Windows in 76 s.

### Verified on Windows, end to end

| Step | Result |
|---|---|
| Image build on a Windows host | 7.08 MB, `scratch`, binary runs |
| Orchestrator container | starts, ingress + control published on loopback |
| Cert and route-table push | succeeds — no `orchestrator unavailable` event |
| mTLS ingress from the host | client cert accepted |
| Routed request, path form | **HTTP 200**, real file content from the workspace |

`docker port envmux-<ns>-orchestrator 8443/tcp` gives the host-side ingress;
both ingress and control are loopback-published because Docker Desktop cannot
reach bridge addresses from the host.

### Bug fixed while proving it: absolute-form upstream requests

The proxy built the upstream URI as `http://<workspace>:<port><path>` and handed
it to hyper, which emits the request target verbatim. RFC 7230 §5.3.2 reserves
that absolute-form for requests *to* a proxy; an origin server may treat it as a
literal path, and static servers do. The workspace logged:

```
"GET http://w1:8000/src/main.rs HTTP/1.1" 404 -
```

while the identical path fetched directly inside the container returned 200. So
**every** proxied request 404'd — host form and path form alike. The upstream
target is now origin-form with the authority in the `Host` header, with a
regression test asserting the constructed URI carries no scheme or authority.

### Open decision: the host form cannot validate against the server cert

The structured host `p<port>.<workspace>.<namespace>.envmux.localhost` is three
labels deep. The server certificate's SAN is `*.envmux.localhost`, and RFC 6125
wildcards match exactly one label, so conforming clients reject it:

```
ERR_TLS_CERT_ALTNAME_INVALID: Host: p8000.w1.wintest.envmux.localhost
  is not in the cert's altnames: DNS:localhost, IP:127.0.0.1, IP:::1,
  DNS:*.envmux.localhost, DNS:envmux.localhost
```

The path form works today because it uses the single-label `envmux.localhost`.
This is a design decision rather than a patch, so it has not been changed:

1. **Flatten the host to one label** — `p8000--w1--wintest.envmux.localhost` —
   so the existing static wildcard covers it. Cleanest; changes the documented
   URL scheme in CONCEPT §4 and SOLUTION_DESIGN §16.
2. **Reissue the server certificate with explicit per-workspace SANs** as the
   route table changes. Keeps the URL scheme; adds cert churn on every
   workspace create/reap, and the daemon already pushes certs to the proxy so
   the machinery exists.
3. **Demote the host form** to secondary and document the path form as primary.

Until then, the path form is the working one:
`/ns/<namespace>/ws/<workspace>/p/<port>/…`.

## Bug found: re-registration does not refresh a namespace's image

`namespace::register` short-circuits when the namespace is already registered:
it replaces `NamespaceCtx.resolved` but leaves `NamespaceCtx.image` at whatever
was resolved the *first* time. Changing `[image]` in the active config and
re-registering therefore has no effect until the daemon restarts, and new
workspaces are silently created from the stale image — which is how it was
found here (a workspace kept coming up on the old image, with the old git,
after the config had been changed).

The same short-circuit skips `orchestrator::ensure`, so a replaced proxy image
is not picked up either — seen directly while testing the new image, where the
orchestrator had to be recreated by restarting the daemon.

This is distinct from "workspaces are never upgraded in place", which is about
*existing* workspaces. A *new* workspace should follow the refreshed config.
The fix is to recompute the image and re-run the orchestrator check on the
re-registration path, not to document the restart.

## Image builds now delegate to the `docker` CLI

envmux orchestrates volumes, networks, and containers. It no longer *implements*
image building: a declared `[image] dockerfile` is handed to `docker build`.

This started as a Windows bug. Builds failed with
`error writing a body to connection: The parameter is incorrect (os error 87)`,
which this file previously recorded as a bollard/named-pipe limitation. That was
wrong twice over. The transport was fine — probes moved 512 MiB over the pipe
and sustained a 217 s build. The real cause was that **`.dockerignore` was never
implemented**: it is a client-side convention the daemon never sees, so packing
the context with `append_dir_all(".")` shipped the entire directory — ~15 GB of
`target/` here, in one in-memory buffer, in one request.

The first fix reimplemented moby's ignore matcher and a context packer. That
worked, and it was the wrong shape: it is a pile of bespoke code duplicating
what `docker build` already does correctly on every platform. Delegating to the
CLI deleted all of it — the matcher, the packer, the in-memory context, the size
ceiling that existed to guard it, and the dedicated-connection workaround that
existed to guard *that*.

What remains is `envmux-docker::build`: argv construction (a pure function, unit
tested, so the CLI contract is checked without a daemon), a streamed
`--progress=plain` invocation whose output goes to the log as it arrives, and
the last 40 lines retained for the error message.

Verified on Windows: `envmux up` against a Dockerfile-based config returns
HTTP 200 and produces the tagged image, with the CLI invocation visible in the
daemon log.

Consequences worth knowing:

- **The Docker CLI is now a dependency for building** — not merely the engine
  socket. It is checked when a build is actually needed, not at daemon start, so
  a namespace that pulls by reference never requires it. The error names the
  alternative (`[image] reference`).
- Anything beyond a local build — multi-architecture, registries, build secrets
  — belongs in compose or CI, with the published result referenced by digest.
- `archive.rs` remains, and is unrelated to builds: it is the container
  file-transfer layer behind `/v1/workspaces/{id}/files` (`envmux cp`, the
  portal's file browser) and behind secrets delivery, which writes secrets into
  containers as files rather than environment variables so they never appear in
  `docker inspect`.

## Workspace resource limits are opt-in

`[workspace] cpus` / `memory` are optional and now absent from every shipped
config. Absent means **no limit**: the workspace gets whatever the host will
give it. A number committed to `.envmux.toml` applies to every machine that
clones the repository, which is almost never what the author meant.

While removing them, a related bug surfaced: `memory` was parsed at container
creation by an ad-hoc function that returned `Option`, and `None` meant *no
limit*. So `"12gb"`, `"1.5g"`, and `"512k"` all silently removed the cap instead
of applying it. It is now a typed `ByteSize` parsed when the config loads, so an
unparseable value is a diagnostic pointing at the key rather than a limit that
quietly is not there. 8 tests cover the spellings people actually write.

## Separate bug seen once: 32 GiB allocation abort on an existing state dir

A daemon started against a state dir left behind by a killed daemon aborted with
`memory allocation of 34359738368 bytes failed`, after the git check and before
the API opened. A fresh state dir started cleanly. The database was only 90 KB,
so this is not simply "a big file"; a corrupt WAL from the killed process is the
leading suspect. Not root-caused — worth reproducing, because "the daemon cannot
restart after being killed" is a bad failure for a CLI-supervised process, and
worse for the Tauri sidecar.

## Carried over from the previous checkpoint

- Three Debian development images (`default`, `dotnet-node`, `rust-node`) with
  shared installation logic in `images/dev-common.sh`: code-server 4.130.0,
  Python, jq, AWS CLI v2, Docker, Git/Git LFS, tmux, ripgrep, fd, shellcheck,
  Codex CLI, Codex Security, Claude Code, and OpenCode.
- Explicit dangerous Docker options in `[workspace]`
  (`dangerously_mount_docker_socket`, `dangerously_enable_dind`), defaulting to
  false, with validation rejecting both at once.
- Validated examples under `examples/`, a repository `.envmux.toml` self-host
  demo, and CI jobs building all three images.
- Before the Trixie change, Docker Desktop reported ~5.33 GB for the general
  image and ~6.6 GB for the language variants; the largest components are the
  global agent packages (~1.4 GB), code-server (~645 MB), and AWS CLI (~270 MB).
