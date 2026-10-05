# envmux v2 — daemonless plan

**Branch:** `feat/v2` · **Status:** planning · **Supersedes** the daemon architecture described in `SOLUTION_DESIGN.md`.

## The one-paragraph version

v1 went too deep: a resident daemon with SQLite, three HTTP transports, five background
workers, a CA, a reverse proxy, a desktop app, and a portal — all so state could outlive
the terminal. v2 inverts that. `envmux` is a single small binary you run **in a
directory**. The session *is* the process: all state lives in memory, containers are
created when envmux starts and killed when it exits, and the only durable things are the
`.envmux.toml` you can read and the `.envmux/git` shadow remote that survives sessions.
If envmux isn't running, nothing of envmux is running.

## Revision (2026-08-10): the ephemeral namespace daemon

Implementation begins with one pragmatic amendment to the pure in-process model below:
a **per-folder, ephemeral daemon** instead of no daemon at all. `envmux` in a directory
forks a daemon scoped to that folder's namespace (state under the project's own
`.envmux/state`, so every project gets its own socket/pipe), **disowns it**, and attaches
the TUI as a client. The daemon is not resident infrastructure: when its last client
detaches it starts a grace timer, and when the timer fires it reaps every workspace,
stops the namespace's containers, and exits. Close your terminal → grace elapses →
containers die → daemon dies. Nothing of envmux outlives the session by more than the
grace period.

What this buys over strictly in-process: sessions can detach/reattach and survive a TUI
restart, `envmux manage` can join from a second terminal, and the battle-tested v1
provisioning/IPC code is reused instead of rewritten. What it keeps from the v2 thesis:
no global daemon, no shared state dir, no reconciliation across restarts — the daemon's
death *is* the cleanup. The in-container `envmux-agent` dead-man switch remains on the
roadmap as the backstop for a SIGKILLed daemon.

The UX contract:

- `envmux` — onboard the directory if there's no toml, else fork-and-disown the
  namespace daemon (if not already running), ensure a workspace, drop into a
  Claude-Code-style session TUI with a slash-command input.
- `/manage` in the TUI (or `envmux manage` directly) — swap to the management
  dashboard for this folder's namespace: workspaces, containers, captures, events.
- Closing every envmux instance — daemon grace timer starts; on expiry the daemon
  kills related containers and itself.
- TUI-only: the Vite portal and Tauri desktop app are deleted, not deprecated.

Statements below describing the daemon as fully deleted are superseded to this extent:
the daemon survives **reduced and ephemeral** (IPC transport + SQLite relocated into
`.envmux/state`, TLS/portal transports and background pollers removed). Pure in-memory
state remains the end-state target once the session engine stabilises.

**Status (2026-08-10) — landed on this branch:** the demolition, the ephemeral
per-folder daemon with grace death, the session TUI with `/manage`, config schema 2
(minimal-valid file, `[routing]` port/domain/delimiter), the **in-session router**
(plain HTTP; loopback reverse proxy inside the daemon, `{ns}_{ws}_{route}.{domain}`,
platform-default domain, WebSocket passthrough), **`envmux prune`**, the **shadow
remote in `.envmux/git`**, and the **`envmux-agent` credential shim** (static musl
binary over the exec stream, host `git credential fill`, remote-host allowlist).
Still open from this plan: router TLS via the local CA + `envmux trust`, host tool
detection/mounting at onboarding, and the agent-as-PID-1 dead-man switch (the daemon's
grace death covers cleanup today).

## Principles

1. **100% in-session, config-driven.** The `.envmux.toml` plus the live process is the
   entire system. No database, no state dir, no reconciliation, no rehydration.
2. **Deeply ephemeral containers.** Containers are created with `AutoRemove`, owned by
   the session that made them, and killed when it ends — cleanly on exit, and by the
   in-container agent's dead-man switch if the host dies uncleanly.
3. **The repo is the state dir.** Anything that must survive a session lives in the
   project's own `.envmux/` folder (gitignored), not in a platform data dir.
4. **Small binary, small surface.** One binary, a handful of subcommands, a config file
   with single-digit sections. Every dependency has to pay rent.

## What v2 deletes from v1

| Removed | Why it existed | Why it goes |
|---|---|---|
| `envmux-daemon` (5.8k LOC): SQLite + migrations, axum API (IPC/mTLS/portal HTTP), 5 background workers, boot reconciliation, rehydration | State had to outlive the CLI process | State no longer outlives the CLI process |
| `envmux-cli/src/client.rs`, IPC token, named-pipe/UDS endpoint resolution, `spawn_daemon`, exit code 4 | CLI ↔ daemon transport | No daemon to reach |
| `certs.rs` mTLS transport, client cert issue/revoke, denylist | Securing a network-reachable daemon API | Nothing listens on a network for control; `envmux-ca` survives, repurposed as the local dev CA for routing TLS (see Routing) |
| `envmux-proxy` binary + orchestrator container + control-plane pushes | Long-lived ingress fed by a resident daemon | Routing survives as a concept but moves **in-process** into the session (see Routing); the separate proxy image and its push API go |
| `desktop/` (Tauri) + `ui/` (portal SPA) + `envmux-api-types` | Daemon clients by construction | No API to be a client of |
| Leases, death dates, pin/unpin, the reaper | Garbage collection for a resident supervisor | Lifetime = session lifetime; `envmux prune` sweeps strays |
| `WorkspaceState` machine + persisted `ReapStep` crash-resume | Crash-resume of multi-step teardown | Teardown is `docker kill` of auto-remove containers |
| Events ring buffer + `/v1/events` stream | UI needed history across connections | `tracing` + the live TUI is enough |
| Observations table + observer/capture/mirror-sync/disk workers | Polling on behalf of absent users | On-demand, in-session |
| `envmux-services` + `envmux-secrets` slice minting | Multi-workspace shared Postgres/Redis/MinIO with scoped creds | Out of scope for v2.0; a session that needs a database declares a sidecar container (future `[services]`, much simpler) or uses compose |
| `envmux-tmux` control-mode client | Daemon-owned multiplexed sessions | The user's terminal owns the session; attach is a plain interactive exec |

**Kept, largely as-is:** `envmux-core` (`ids.rs`, `labels.rs` — bumped to `schema=2`),
`envmux-docker` (bollard wrapper, exec streams, archive I/O, CLI build shell-out),
`envmux-git` (`host.rs`, the shadow/capture scripts, and the hard-won `safe.directory`
`--system`-scope logic from `namespace.rs:22-36`), `envmux-config` (rewritten schema, same
parse/validate/miette machinery), the Ratatui TUI chrome/theme/modals (re-pointed from IPC
polling to in-process state).

## Architecture

### The session

```
envmux (host, foreground)
 ├─ parses .envmux.toml (or onboards)
 ├─ ensures .envmux/git shadow remote exists
 ├─ creates container: AutoRemove, labels schema=2,
 │    entrypoint = envmux-agent (PID 1)
 ├─ attaches a control channel to the agent (docker attach, multiplexed)
 │    ├─ heartbeats            → liveness both ways
 │    └─ git-credential RPC    → host git credential manager
 ├─ runs setup command, then hands the user an interactive shell (docker exec -it)
 └─ on exit / Ctrl-C / SIGTERM: kill session containers (best-effort; the
      agent's dead-man switch is the backstop)
```

There is exactly one source of truth for "what does envmux own" that outlives the
process: **Docker labels**. `dev.envmux.schema=2`, `dev.envmux.project=<hash of repo
path>`, `dev.envmux.session=<uuid7>`, `dev.envmux.role`, `dev.envmux.created-at`. v1
already proved labels can reconstruct everything (`reconcile.rs` did exactly this);
in v2 they exist only so `envmux prune` and a second `envmux` invocation can see strays.

### The in-container agent (`envmux-agent`)

A separate, tiny, statically linked (musl) crate. It is the container's **entrypoint
(PID 1)** and replaces v1's `sleep infinity`:

- **Init duties:** reap zombies, forward signals.
- **Dead-man switch:** the host's control channel (the container's stdin/stdout via the
  Docker attach API) is the attachment. When it drops and is not re-established within a
  grace period (`session.grace`, default 30s — long enough to survive a host envmux
  restart/upgrade), the agent exits. `AutoRemove` then deletes the container. A crashed
  host, a closed laptop, a killed terminal — all converge to "container removes itself."
- **Git credential shim (server side):** listens on a unix socket *inside* the container
  (e.g. `/run/envmux/agent.sock`). A one-line helper is installed as the container-wide
  credential helper (`git config --system credential.helper "/usr/local/bin/envmux-agent credential"`).
  Credential requests are forwarded over the control channel to the host.

Riding the Docker attach API for the control channel is deliberate: it works identically
on Windows, macOS, and Linux hosts, requires no bind-mounted sockets (Windows named pipes
can't be mounted into Linux containers), and gives attachment-liveness for free — the
credential transport and the dead-man switch are the same stream.

**Getting the agent into the container:** the host binary embeds the
`linux/amd64` and `linux/arm64` musl agent binaries via `include_bytes!` and
`docker cp`s the right one in at container create (arch from the image inspect). The
agent must stay tiny (~1–2 MB stripped: no tokio — a small poll loop or `smol`; no
bollard; no TLS) so embedding two copies doesn't blow up the host binary. Fallback
escape hatch: `ENVMUX_AGENT_PATH` to supply your own.

### Git: host credentials + shadow remote

**Credential shim.** Inside the container, `git push`/`fetch` to the real origin hits
the credential helper → agent → control channel → host envmux, which answers by invoking
`git credential fill` on the host — i.e. whatever the user's real credential manager is
(GCM on Windows, osxkeychain, libsecret). Guardrails:

- Host answers only for hosts that appear in the repo's configured remotes (allowlist
  computed at session start; anything else prompts in the TUI).
- Only `get` is forwarded by default; `store`/`erase` are dropped (the host manager
  already has the credential).
- Every fill is surfaced in the session log/TUI.

### Routing

v1's routing idea was right; only its delivery vehicle (a resident proxy container fed by
daemon pushes) was wrong. In v2 the reverse proxy is a task **inside the session
process**: it starts with the session, routes only that session's ports, and dies with it.

- **Implicit namespace.** Each `envmux` instance *is* a namespace — derived from the
  directory name by default, nominated explicitly via `[routing] name` when you want a
  stable identity. Combined with the current git branch it forms the route identity.
- **Named ports.** `[ports]` maps a name to a container port; bare numbers are allowed
  and route by number. Hostname pattern:
  `{namespace}{delim}{branch}{delim}{port-or-name}.{domain}` — e.g. with
  `vite = 5173`, `envmux_main_vite.localhost` and `envmux_main_5173.localhost` both
  reach the dev server.
- **Resolution.** DNS is config with a compiled-in, platform-conditional default the
  user can override in `[routing] domain`. Default: **`strigops.xyz` on Windows** (a
  hard-coded const for now; public wildcard DNS resolving to loopback, lvh.me-style,
  because `*.localhost` resolution is unreliable on Windows even in browsers) and
  **`localhost` elsewhere** (browsers resolve `*.localhost` to loopback with zero
  setup on macOS/most Linuxes). Where the default doesn't fit — offline work, strict
  resolvers, corporate DNS — the user points `domain` at their own setup (hosts
  entries, dnsmasq wildcard, `curl --resolve`); envmux documents the options rather
  than owning the workaround. Built-in hosts-file management could come later if the
  friction proves real.
- **Optional TLS.** A per-user local CA (the surviving `envmux-ca` crate, rcgen), stored
  once per machine. `envmux trust` installs it into the platform trust stores via
  built-in per-platform steps — Windows `CurrentUser\Root` via `certutil`, macOS
  `security add-trusted-cert`, Linux `update-ca-certificates` + NSS `certutil` for
  browsers (mkcert's playbook). Leaf certs for the session's hostnames are minted in
  memory at session start and never touch disk. TLS is opt-in (`tls = true`); plain
  HTTP is the default.
- **Port binding.** Each session's router binds one loopback port. `[routing] port`
  nominates it in the toml (so a project's URLs are stable across sessions); unset, the
  default (8443 with TLS, 8080 without) is tried first. If the port is already held by
  another session, the new session takes the next free port and prints/TUI-displays its
  URLs — hostnames carry identity, so nothing collides except the TCP bind itself.

The per-machine CA keypair is the one deliberate exception to "no state dir" — trust
must survive sessions to be worth installing. It lives in the platform keyring (or a
0600 file fallback), never in the repo.

**Shadow remote.** A bare repo at `.envmux/git`, bind-mounted RW into the container at
`/shadow`. The container clones the project into its workdir and pushes checkpoint refs
(`refs/envmux/…`, v1's capture script largely survives) to `/shadow`. Because it lives in
the project folder it is naturally **shared** across sessions and survives container
death — that's where "work I did in a container that died" is recovered from. The
`safe.directory --system` handling carries over verbatim.

### Onboarding (`envmux` in a directory with no `.envmux.toml`)

1. Confirm with the user (one prompt; `--yes` to skip).
2. **Detect host tools:** probe for installed agents/CLIs and their state dirs —
   `claude` (`~/.claude`, `~/.claude.json`), `codex`/`openai` (`~/.codex`), `opencode`
   (`~/.config/opencode`), `gemini` (`~/.gemini`), `gh` (`~/.config/gh`). Found tools are
   written into `[tools]` in the generated toml; their state dirs are bind-mounted into
   the container user's home so the tools arrive already logged in.
3. **Pick an image:** detect the stack (Cargo.toml/package.json/etc.) and propose a
   sensible default reference; the user can point at a Dockerfile instead.
4. `git init`-aware setup of `.envmux/git` (bare) — created lazily on first session if
   absent.
5. **`.gitignore`:** append `.envmux/` if not already present (create `.gitignore` if the
   repo has none).
6. Write `.envmux.toml`, then continue straight into the session.

### Config v2 (`.envmux.toml`)

Target: a file a human writes in under a minute. Everything defaulted; `deny_unknown_fields`
and miette diagnostics stay.

```toml
schema = 2

[image]
reference = "ghcr.io/example/dev:latest"   # or: dockerfile = "Dockerfile"

[tools]                # written by onboarding; values: "auto" | "off" | explicit path
claude = "auto"
gh = "auto"

[session]
grace = "30s"          # agent dead-man delay after losing the host
cpus = 4               # optional resource caps
memory = "8g"

[env]
RUST_LOG = "info"

[setup]
command = "npm ci"     # runs once, before the shell is handed over

[ports]                # named container ports, served by the in-session router
vite = 5173
api = 3000

[routing]              # all optional
name = "myproj"        # nominate this instance's namespace (default: directory name)
port = 8443            # nominate the router's listen port (default: 8443 tls / 8080 plain)
tls = true             # opt into the local-CA TLS (see `envmux trust`)
domain = "localhost"   # override the platform default (windows: strigops.xyz,
                       # elsewhere: localhost) when your resolver needs it — e.g.
                       # "dev.test" with your own dnsmasq/hosts setup
```

Gone from the schema: `mirror`, `services`, `tasks` graph, `volumes` classes, `capture`,
`observe`, `secrets`, `lease`. `[routes]`/`[routing]` survive, simplified: named ports
plus an instance name/port nomination, served in-process instead of by an orchestrator
container. The task DAG + checks engine is the
biggest capability cut — v2.0 ships `[setup]` only, and a lightweight `[tasks]` can
return later if it earns it.

### CLI surface

| Command | Behaviour |
|---|---|
| `envmux` | The whole product: onboard if no toml, then run a session in the cwd and attach. |
| `envmux prune` | Like `docker system prune`, scoped to `dev.envmux.schema=2` labels: remove stopped/orphaned envmux containers, session volumes, networks. `--all` includes running sessions (with confirm), `--shadow <retention>` prunes old checkpoint refs in `.envmux/git`. |
| `envmux ls` | List live envmux containers (from labels) across projects. |
| `envmux config` | `show` / `validate` / `init` (onboarding without starting a session). |
| `envmux shell` | Attach another terminal to the running session's container. |
| `envmux trust` | Create the per-user local CA if absent and install it into the platform trust stores (per-OS steps built in); `--uninstall` reverses it. |

Exit of the root `envmux` process = kill of that session's containers. `prune` is the
janitor for everything the dead-man switch and `AutoRemove` somehow missed (daemonless
Docker Desktop shutdowns, forced power-off).

## Workspace slimming

New crate layout (5 crates + agent, down from 12 + proxy + desktop + ui):

```
crates/envmux-core     ids, labels(schema=2)          (keep, trim paths.rs)
crates/envmux-config   schema v2                      (rewrite model/validate/generate)
crates/envmux-docker   bollard wrapper                (keep; drop usage cache)
crates/envmux-git      host runner, scripts, shadow   (keep; drop mirror or fold into shadow)
crates/envmux-ca       local dev CA + trust install   (keep, repurposed; loses mTLS verifier/denylist)
crates/envmux-cli      bin: session engine + router + TUI  (rewrite main; keep TUI chrome)
crates/envmux-agent    bin: musl PID-1 agent          (new, no-tokio, tiny)
```

Dependencies deleted along with the daemon: `sqlx`, `axum`, `tower`, `http-body-util`,
`tokio-tungstenite`, `redis`, `schemars`, `petgraph` (unless tasks return), `fs4`.
Kept for the in-session router: `hyper`/`hyper-util`, and `rustls`/`tokio-rustls`/
`rcgen` behind a TLS feature; `keyring` stays only to hold the CA key. Release profile
gets `lto = "fat"`, `codegen-units = 1`, `strip = true`, `panic = "abort"`; track binary
size in CI.

## Milestones

Each lands green on `feat/v2`; order chosen so the tree builds throughout.

1. **M1 — Demolition.** Remove `envmux-daemon`, `envmux-proxy`, `envmux-ca`,
   `envmux-api-types`, `envmux-services`, `envmux-secrets`, `envmux-tmux`, `desktop/`,
   `ui/`, and the CLI's client/daemon plumbing. Stub `envmux` to "not yet". Workspace
   builds, CI passes, dependency tree measured.
2. **M2 — Config v2.** New schema, validation, miette errors, `envmux config`
   show/validate/init. Golden-file tests for generation.
3. **M3 — Ephemeral namespace daemon + session UX** *(revised, see Revision above)*:
   relocate state to `.envmux/state` (per-folder daemon + pipe), grace-period death
   that reaps workspaces and namespace containers, `envmux` default flow
   (onboard-or-session, fork/disown, ensure workspace), session TUI with slash
   commands, `/manage` swap + `envmux manage`. This is the first end-to-end usable
   build.
4. **M4 — Agent.** `envmux-agent` crate (PID 1, zombie reaping, signal forwarding,
   dead-man switch), control-channel protocol over docker attach, embed + `docker cp`
   delivery. Replace the placeholder entrypoint.
5. **M5 — Git.** `.envmux/git` shadow remote, capture-on-exit + checkpoint refs,
   credential shim end-to-end (agent socket → channel → host `git credential fill`,
   with the remote-host allowlist).
6. **M6 — Onboarding.** Tool detection, image proposal, toml generation, `.gitignore`
   update, first-run flow.
7. **M7 — Routing.** In-session reverse proxy: named ports, `{ns}_{branch}_{name}`
   hostnames on `*.localhost`, nominated name/port from `[routing]`, port-conflict
   fallback. Then TLS: `envmux-ca` repurpose, in-memory leaf certs, `envmux trust`
   per-platform install.
8. **M8 — Prune + ls.** Label-driven sweep, shadow-ref retention, `--all`.
9. **M9 — TUI re-point + polish.** In-process snapshot instead of IPC polling; session
   log pane (credential fills, captures, routed URLs); docs rewrite; size budget
   enforced in CI.

## Open questions

1. **Workdir model: bind-mount the host directory, or clone from it?** Bind-mounting the
   project dir is the simplest mental model (edits are live on the host, like
   devcontainers) but gives up isolation between concurrent sessions and makes the shadow
   remote mostly a checkpoint log. Cloning into a container-local volume (v1's model)
   keeps sessions isolated and makes `.envmux/git` the real hand-off point, at the cost
   of a sync step. **Leaning: bind-mount for v2.0** — it matches "runs in a directory",
   and the shadow remote still earns its place as the checkpoint/recovery log; revisit
   isolation when multi-session demand is real.
2. **Grace-period default** — 30s assumed; long enough for `envmux` restarts, short
   enough that closed-laptop containers die promptly?
3. **Windows containers** — v2 assumes Linux containers on all hosts (agent is musl).
   Windows-container support explicitly out of scope?
4. **Multiple concurrent sessions per project** — allowed in v2.0 (names get a session
   suffix) or rejected with "session already running"?
5. **Hostname delimiter.** `_` matches the proposed `namespace_branch_vite` shape, but
   underscores are technically invalid in DNS hostnames — browsers accept them over
   HTTP, yet some TLS stacks refuse to validate certificates for underscore names.
   Keep v1's configurable delimiter with `-` as the TLS-safe default and `_` allowed?
6. **Branch in the hostname.** Live-bind-mounted workdir means branch can change
   mid-session — re-route on branch change, or freeze the branch label at session
   start?
