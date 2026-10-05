# envmux — Technical Specification v1

**Status:** draft for implementation · **Date:** 2026-08-08 · **Companion:** envmux Conceptual
Design (Final). This document specifies *how*; the design document remains authoritative on *what*
and *why*. Where the two disagree, the design document wins and this one has a bug.

---

## 1. Scope

Specifies the Rust implementation of the daemon, CLI, and orchestrator proxy; the SQLite schema; the
tmux integration; the git subsystem; the service library; the secrets helper protocol; the mTLS
material; the API surface consumed by the CLI, the Tauri desktop app, and the optional web UI; and
the testing and packaging approach. The React frontend and the Tauri shell are out of scope beyond
their contract with the API.

Targets: Linux (x86_64, aarch64), macOS (aarch64, x86_64), Windows (x86_64). Container engine:
Docker Engine ≥ 25 via the local socket / named pipe. v1 does not target Podman, though nothing in
the Docker API usage below is knowingly Docker-exclusive.

---

## 2. Toolchain and workspace conventions

| Item | Decision |
|---|---|
| Edition | Rust 2024 |
| MSRV | Latest stable minus 2 at release cut; pinned in `rust-toolchain.toml` and CI-enforced |
| Workspace | Single Cargo workspace, `crates/*` layout, `resolver = "3"` |
| Lints | `[workspace.lints]`: `rust.unsafe_code = "forbid"` (except `envmux-secrets` platform FFI, crate-level allow with justification), clippy `pedantic` warn / `all` deny baseline, curated allows in workspace lints table — never inline `#[allow]` without a comment |
| Formatting | rustfmt, default profile, checked in CI |
| Dependency hygiene | `cargo-deny` (licenses: permissive only; advisories; duplicate-version budget), `cargo-audit` in CI |
| Test runner | `cargo nextest`; doctests via `cargo test --doc` |
| Feature policy | Additive only; no mutually exclusive features; `default` = full daemon |
| Unsafe | Forbidden outside the secrets platform shims |
| Panics | Never across a component boundary; `unwrap`/`expect` denied by clippy in non-test code, allowed in tests and build scripts |

**Dependency versions are workspace-level** (`[workspace.dependencies]`) so every crate agrees.

### Core ecosystem choices

| Concern | Crate | Notes |
|---|---|---|
| Async runtime | `tokio` (full) | Multi-threaded runtime in the daemon; current-thread in the CLI |
| Cancellation/supervision | `tokio-util` (`CancellationToken`), `tokio::task::JoinSet` | See §5 |
| Docker API | `bollard` | Typed client over local socket / npipe; streams for exec, stats, events |
| HTTP/API | `axum` + `tower` + `hyper` (`hyper-util`) | Same router mounted on local IPC and optional mTLS TCP |
| TLS | `rustls` + `tokio-rustls`; certs via `rcgen` | No OpenSSL anywhere; `rustls` client-cert verification for mTLS |
| SQLite | `sqlx` (sqlite, runtime-tokio, macros) | WAL mode; compile-time-checked queries; `sqlx::migrate!` |
| Config | `serde` + `toml` for parsing; `toml_edit` for generation (skill output, `create local config`) preserving comments |
| Git | System `git` CLI as the execution engine (§8); `gix` for read-only host-side inspection where convenient |
| Time | `jiff` | Civil + timestamp types; death dates stored as RFC 3339 UTC |
| Hashing | `blake3` | Config hash, base-drift hash |
| IDs / names | `uuid` v7 internal ids; `petname` for workspace name generation |
| Graphs | `petgraph` | Task dependency resolution, cycle detection |
| CLI | `clap` v4 derive; `clap_complete` for shell completions |
| Errors | `thiserror` in every library crate; `anyhow` only in binaries; `miette` for config diagnostics (§19) |
| Tracing | `tracing` + `tracing-subscriber` (env-filter, json); optional OTLP export behind `telemetry` feature |
| Secrets store | `keyring` as the built-in provider; helper subprocess protocol (§12) |
| WebSocket | `axum::extract::ws` |
| Archives | `tar` + `flate2` via `spawn_blocking` for file transfer and docker cp streams |
| Postgres admin | `sqlx` (postgres) inside the service impl |
| Redis admin | `redis` crate (ACL commands) |
| MinIO admin | `mc` exec'd inside the service container via Docker exec (§11) |

---

## 3. Crate map

```
crates/
  envmux-core       # domain types, ids, lifecycle state machine, label schema, errors
  envmux-config     # .envmux.toml model, validation, hashing, provenance, toml_edit generation
  envmux-docker     # thin bollard wrapper: labels, filtered queries, exec streams, usage APIs
  envmux-git        # mirror, clone-with-alternates, capture, observation, shadow maintenance
  envmux-tmux       # tmux control-mode client over an exec stream
  envmux-services   # ServiceKind enum + per-service slice provisioning implementations
  envmux-secrets    # helper chain, keyring provider, file fallback, helper protocol client
  envmux-ca         # local CA, server/client cert issue + rotation (rcgen/rustls glue)
  envmux-api-types  # request/response DTOs shared by daemon, CLI, and (via codegen) the UI
  envmux-daemon     # library: components, scheduler, reconciler, API server
  envmux-cli        # THE binary: clap surface over local IPC, plus `envmux daemon`
  envmux-proxy      # binary: the orchestrator image — host/path-routing reverse proxy
```

Rules: `envmux-core` depends on nothing internal. Binaries depend on libraries, never the reverse.
`envmux-api-types` is the single source of truth for the wire; the TypeScript client for the UI is
generated from it (`schemars` → JSON Schema → codegen in the UI build).

---

## 4. Domain model (`envmux-core`)

**Newtypes everywhere.** `NamespaceName`, `WorkspaceName`, `ServiceName`, `TaskName`, `VolumeName`,
`ConfigHash`, `SliceKey` — all `String` newtypes with validated constructors (charset, length,
Docker-name safety) and `serde`/`sqlx` derives. Raw strings do not cross crate boundaries.

**Workspace lifecycle** is an explicit state machine, persisted as a column, transitions enforced in
code rather than by convention:

```rust
pub enum WorkspaceState {
    Provisioning,   // slices being created, clone in progress, task graph starting
    Ready,          // task graph satisfied
    Degraded,       // a supervised task is failing its restart policy
    Reaping,        // final capture → deprovision → destroy, in progress
    Reaped,         // terminal; row retained for shadow-history linkage
    Lost,           // recorded but container vanished outside envmux
}
```

Transitions are a `fn try_transition(from, to) -> Result<(), InvalidTransition>` table, unit-tested
exhaustively. `Reaping` is entered exactly once and is not exited except to `Reaped`; a daemon crash
mid-reap resumes at the recorded sub-step (§18).

**Label schema** (applied to every container, volume, network envmux creates):

```
dev.envmux.namespace   = <namespace>
dev.envmux.workspace   = <workspace|-- absent on namespace-scoped objects>
dev.envmux.role        = base | workspace | service | orchestrator
dev.envmux.class       = source | cache | tools | sync | shadow | mirror | service-data
dev.envmux.created-at  = <rfc3339>
dev.envmux.config-hash = <blake3-hex>
dev.envmux.schema      = 1
```

Label keys are constants in `envmux-core`; nothing formats a label string ad hoc.

---

## 5. Async architecture (daemon)

**Pattern: component-per-task, message-in / event-out ("actor-lite").** No actor framework. Each
component from the design's §15 table is a struct with:

- an `mpsc::Sender<Command>` handle (commands are `enum`s carrying a `oneshot` reply channel where a
  response is needed),
- a `run(self, cancel: CancellationToken)` future spawned into a root `JoinSet`,
- read access to shared state only through the database or a `watch` channel — no `Arc<Mutex<World>>`.

**Supervision.** The daemon `main` builds every component, spawns them into one `JoinSet`, and
selects on: JoinSet completion (a component exiting is a bug → log, tear down, exit non-zero),
SIGTERM/ctrl-c (→ cancel token, bounded drain with `tokio::time::timeout`), and a `watch` for
config-file-level reload of daemon defaults. Components observe cancellation at every await point
that matters; long Docker streams are raced against the token.

**Scheduling.** No cron crate. Each periodic worker (capture, observe, mirror sync, shadow
maintenance, disk monitor, reaper) owns a `tokio::time::interval` with
`MissedTickBehavior::Delay` plus ±10% jitter, reading its interval from resolved config via a
`watch` channel so tuning applies without restart. This is deliberate: the design's reaper semantics
("nothing is computed from elapsed time at sweep") only require *a* periodic sweep; wall-clock
correctness lives in the stamped death dates, not the scheduler.

**Blocking work** (tar packing, keyring FFI, occasional `git` invocations on the host) goes through
`spawn_blocking`. Docker exec streams are async end-to-end via bollard.

---

## 6. Persistence (`sqlx` / SQLite)

One database file per daemon: `$ENVMUX_STATE_DIR/envmux.db`, WAL mode, `synchronous=NORMAL`,
foreign keys on, busy timeout 5 s. Migrations embedded with `sqlx::migrate!` and applied on boot
before any component starts. All queries are compile-time checked (`query!`/`query_as!`); prepared
offline data committed (`sqlx prepare`) so builds don't need a live database.

Schema (v1, abbreviated — full DDL lives in `migrations/`):

```sql
namespaces(name PK, repo_remote, created_at, mirror_last_fetch, mirror_fetch_mode)
workspaces(id PK, namespace FK, name UNIQUE(namespace,name), state, branch_requested,
           config_hash, config_toml,          -- full resolved TOML frozen at launch
           created_at, death_date, lease_extended_at, reap_step, container_id)
observations(workspace_id FK, observed_at, branch, head, dirty_files, ahead, behind,
             tasks_json, last_attach_at, PRIMARY KEY(workspace_id))   -- latest-only; history is not kept
captures(id PK, workspace_id FK, captured_at, shadow_ref, commit_oid, torn, flagged_state)
slices(id PK, workspace_id FK, service, slice_key, state,             -- provisioned|deprovisioned|failed
       created_at, deprovisioned_at, last_error)
certificates(serial PK, kind, subject, not_after, revoked)
events(id PK, at, level, namespace, workspace, component, message)    -- ring-buffered audit trail
```

**Intent vs reality vs condition**, per the design: `workspaces` + `slices` are intent, Docker
labels are reality (never mirrored into SQLite beyond `container_id` as a hint), `observations` is
condition — latest-only by design; the CLI shows age from `observed_at`.

`config_toml` freezing the resolved file at launch is what makes "no upgrade, hash mismatch is
information" implementable: the daemon can always print exactly what a workspace was built from.

---

## 7. Docker integration (`envmux-docker`)

A thin, typed layer over `bollard`. Responsibilities and constraints:

- **Every create call goes through one builder** that injects the label set of §4; it is impossible
  to construct an unlabelled object from this crate.
- **Every list call is a filtered query** on `dev.envmux.*` labels. The daemon never lists the
  world.
- **Exec streams**: `exec_create`/`exec_start` wrapped into an `ExecStream` implementing
  `AsyncRead + AsyncWrite`, used by the tmux client, in-container git, service `mc` calls, and file
  transfer.
- **File transfer** uses the archive endpoints (`upload_to_container`, `download_from_container`),
  tar packed/unpacked in `spawn_blocking`, with path traversal defense (reject entries escaping the
  target prefix) on extraction.
- **Image builds shell out to `docker build`** (`envmux-docker::build`), rather than using the API's
  `/build` endpoint. That endpoint takes a context tar the client must assemble, which means
  reimplementing `.dockerignore` (a client-side convention the daemon never sees), holding the whole
  context in memory, and streaming it in one request. Delegating deleted a bespoke ignore matcher
  and context packer along with the failure class they caused: an unfiltered context in this
  repository was ~15 GB of `target/`, merely slow on Linux and fatal over a Windows named pipe.
  The CLI is invoked with `--progress=plain`, its output streamed to the log as it arrives and the
  last 40 lines retained for the error message; the argv construction is a pure function so the
  contract with the CLI is unit-tested without a daemon. The CLI is required only when a namespace
  actually builds, checked at that point rather than at daemon start.
- **Usage/accounting**: `system_df` polled by the disk monitor, cached with a minimum refresh
  interval (default 60 s) because the design flags it as slow; attribution joins Docker's volume
  list against the `class` label.
- **Events**: the daemon subscribes to Docker events filtered by label and uses die/destroy events
  to mark `Lost` early, but reconciliation (§18) remains the source of truth — events are a hint,
  not a ledger.
- **Reconnection**: bollard client wrapped with retry (exponential backoff, capped) for the socket
  dropping under daemon restarts of Docker itself; in-flight exec streams are not resumed, they
  fail their owning operation.

---

## 8. Git subsystem (`envmux-git`)

**Policy: the system `git` binary is the execution engine for anything that mutates or must match
git's exact semantics.** Alternates, `--no-optional-locks`, separate-index tricks, and gc behavior
are places where reimplementations diverge in the corners; envmux's correctness story leans on
"inspectable with ordinary tools", and the ordinary tool is git. `gix` is permitted for read-only
host-side inspection (walking shadow refs for the history views) where it is faster and safer than
parsing porcelain. Two hard rules:

1. **In-workspace git always runs inside the container** (via exec), using the image's git — never
   the host's — so version skew between host and image cannot corrupt a checkout.
2. **Mirror and shadow git runs on the host** against the mounted volumes, using a pinned minimum
   git version checked at daemon start.

### 8.1 Mirror

- `git clone --mirror <remote>` into the mirror volume at namespace creation.
- Fetch: `git fetch --prune` on the configured interval, or on demand (workspace create when the
  requested ref is unknown; explicit CLI trigger). Serialized per namespace with a tokio `Mutex`.
- **gc policy** (the alternates containment from the design): `gc.auto=0`;
  maintenance runs `git repack -a -d -k` (`-k`: keep existing packs) on the shadow-maintenance
  schedule; object *pruning* on the mirror runs only when the daemon can prove no live workspace
  clone lists the mirror in its alternates — i.e. only when zero non-`Reaped` workspaces exist in
  the namespace. Otherwise pruning is deferred and the disk monitor carries the cost visibly.

### 8.2 Workspace clone

- Volume created, then in-container:
  `git clone --reference-if-able /mirror --dissociate=false file:///mirror <workdir>` — expressed
  concretely as `git clone -s file:///mirror` with the mirror volume mounted read-only at `/mirror`,
  followed by remapping `origin` to the real remote URL (so `git push` from inside the workspace
  goes upstream, per the design's "finished work leaves deliberately").
- Full-clone opt-out: same flow without `-s`, no mirror mount.

### 8.3 Capture (torn detection, separate index)

Runs on the host? No — **inside the container**, because only there are file paths and permissions
guaranteed to match the checkout. Sequence per capture, all via one exec with a small embedded
shell script (checked into the daemon, versioned, no ad-hoc string building):

```
1. pre  = find <workdir> -newer-aware listing → (path, size, mtime_ns) sorted, hashed (blake3)
2. GIT_INDEX_FILE=$TMP/capture-index git add -A            (respects .gitignore as-is)
3. tree = git write-tree                                    (against the capture index)
4. post = same listing as (1), hashed
5. if pre != post: retry once from (1); if still moving → torn=true
6. commit = git commit-tree $tree -m "envmux capture <ts>" [-p <prev shadow tip>]
7. git push --force-with-lease file:///shadow refs/…       → shadow volume mounted rw at /shadow
```

Ref layout in the shadow repo: `refs/envmux/ws/<workspace>/head` (the line of snapshots) and a
per-capture annotated tag `refs/envmux/snap/<workspace>/<rfc3339>` carrying `torn` and
`flagged_state` (rebase/merge/conflict markers detected via `.git/rebase-merge` etc.) in the tag
message as TOML. Branch grouping is derived at read time from the recorded branch in `captures`, not
by duplicating refs.

The workspace's own `HEAD`, index, and branch are untouched throughout — the capture index is a
temp file, and nothing runs `git status` without `--no-optional-locks`.

### 8.4 Observation

One exec per workspace per tick, one script, `git --no-optional-locks` on every invocation:
`rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`, `status --porcelain=v2 -z` (bounded: the script
counts lines and truncates at a configured cap rather than shipping a monorepo's status wholesale),
`rev-list --left-right --count @{upstream}...HEAD` (tolerating no-upstream). Depth `cheap` mode
replaces the status call with `diff --quiet` + `diff --cached --quiet` for a dirty/clean bit.
fsmonitor is used if `core.fsmonitor` is already configured in the image; envmux does not configure
it. Results parse into `Observation` and upsert `observations`.

### 8.5 Shadow maintenance

On its schedule, per namespace, serialized against capture by a per-namespace `Mutex` (the "lock"
from the design is this, plus a marker file for crash detection): delete `refs/envmux/*` past
retention per policy, then `git reflog expire --expire=now --all` scoped to the shadow repo, then
`git gc --prune=<horizon>`. `gc.auto=0` set at shadow-repo init.

---

## 9. tmux integration (`envmux-tmux`)

**Control mode over exec.** The daemon holds one long-lived exec stream per workspace running
`tmux -CC -u attach -t envmux` (creating the session on first use: `new-session -d -s envmux`). A
small parser turns the control-mode protocol (`%begin/%end/%error` framed replies, `%output`,
`%window-add`, `%exit`, …) into typed events; commands are written as lines and matched to replies
by the begin/end framing. This gives the task engine:

- window create: `new-window -d -n <task> -t envmux '<wrapped command>'`
- liveness + exit status: windows run the command under `sh -c '<cmd>; ec=$?; tmux wait-for -S …'`
  — concretely, each task command is wrapped so its exit code is written to
  `$ENVMUX_RUN_DIR/<task>.exit` and the window stays via `remain-on-exit on` (set per-window), so
  scrollback survives for debugging and the engine reads a real exit code from the file rather than
  inferring from `pane_dead_status` across tmux versions.
- restart: kill window, re-create (policy-driven).
- attach brokering: client attach does **not** share the control stream; the session broker opens a
  fresh exec running plain `tmux attach -t envmux \; select-window -t <task>` (read-only mode:
  `attach -r`) and splices it to the CLI's TTY or a WebSocket. Multi-client is native tmux.

**Version tolerance:** control mode features used are restricted to the ≥ 3.2 baseline; the base
container verification step runs `tmux -V` and refuses images below it with a clear message (per the
design: fail at verification, not first attach).

**Daemon restart:** the control stream dies with the daemon; on boot, reattaching `-CC` to the
existing session recovers window list and the `.exit` files recover completed statuses. Task-graph
state is thereby reconstructed from observable substrate, not from memory.

---

## 10. Task engine

- Config's `[tasks.*]` compiles into a `petgraph::DiGraph`; cycle detection at config validation,
  not at run time (a cyclic graph is a rejected config).
- Node readiness = internal deps satisfied (dep task's completion check passed, or exited 0 for
  expected-exit tasks) **and** external deps satisfied (service health per Docker healthcheck;
  declared slice `state = provisioned` per the provisioner).
- Checks: `exec` (command in the workspace, exit 0), `http` (orchestrator-side GET against the
  workspace port), `port` (TCP connect from the daemon via the orchestrator network). Timeout and
  interval per check, config-set with defaults.
- Restart policy for long-running tasks: `never | on-failure{max, backoff} | always{backoff}`;
  breaching `max` transitions the workspace to `Degraded` (visible in observation, does not stop
  siblings).
- Workspace `Ready` = every root-to-leaf path satisfied. Recorded with a timestamp; the CLI's
  create command can `--wait` on it over the API.

---

## 11. Service library (`envmux-services`)

**No trait objects; an enum.** v1 supports a closed set, and enum dispatch keeps the provisioner
simple, `Send`-clean, and exhaustively matched:

```rust
pub enum ServiceKind { Postgres(Postgres), Minio(Minio), Redis(Redis) }

impl ServiceKind {
    pub async fn provision(&self, ws: &WorkspaceRef) -> Result<SliceCredentials, ServiceError>;
    pub async fn deprovision(&self, slice: &SliceKey) -> Result<(), ServiceError>;
    pub async fn audit(&self) -> Result<Vec<SliceKey>, ServiceError>;   // slices that exist server-side
    pub async fn health(&self) -> Result<Health, ServiceError>;
}
```

(Native `async fn` in traits would also work here; the enum is chosen because v1's set is closed and
`dyn` adds nothing but ceremony. If a plugin story ever lands, the enum grows a `Custom` arm speaking
a subprocess protocol — out of scope for v1.)

Slice keys derive from the workspace name (design: key on name, not branch), sanitized per backend:

| Service | Slice | Mechanism |
|---|---|---|
| Postgres | database `ws_<name>` + role `ws_<name>` with password minted by the daemon, `GRANT ALL ON DATABASE` to that role only | admin connection via `sqlx` using the service's admin secret from the helper chain |
| Redis | ACL user `ws_<name>` restricted to key pattern `ws_<name>:*` (+ minted password) | `redis` crate, `ACL SETUSER` |
| MinIO | bucket `ws-<name>` + service account scoped by policy to that bucket | `mc admin user svcacct` executed *inside the service container* via Docker exec — avoids depending on unstable admin-API crates; `mc` ships in the service image envmux pins |

`SliceCredentials` are written into the workspace via the secrets mount (§12) before the task graph
starts; task env interpolation exposes their *paths*, never their values. `audit()` diffs
server-side slices against `slices` rows with a live workspace and reports orphans; it never deletes
on its own.

Deprovision failures set `slices.state = failed` with `last_error` and surface in CLI/UI; the
reaper proceeds (the workspace still dies — design: failures recorded against the service, not lost
with the workspace) and the orphan audit will keep reporting until resolved.

---

## 12. Secrets (`envmux-secrets`)

**Helper protocol** (modeled on git credential helpers): a helper is an executable
`envmux-secret-<name>`; the daemon invokes it with `get|store|erase` on argv, writes
`key=value\n` pairs on stdin (`name=<secret name>`, `namespace=<ns>`), reads the same format on
stdout; nonzero exit or empty output = not found, chain continues. Chain order is configured
daemon-level; default: `keyring` (built-in, via the `keyring` crate → Keychain / Credential Manager
/ Secret Service) → `file` (0600 TOML under the state dir, with a logged warning that it is the
fallback).

The same chain stores: mTLS client keys, service admin credentials, user-declared secrets, and
daemon-minted slice credentials (minted with `rand::rngs::OsRng`-derived 32-byte tokens, base64url).

**Delivery**: secrets land in a per-workspace tmpfs-backed directory bind... — no. Per the design,
no bind mounts: secrets are written into the container at create time via the archive upload
endpoint to `/run/envmux/secrets/<name>` (mode 0400, owned by the container user), and rewritten on
rotation. They are absent from `docker inspect` env output by construction.

---

## 13. Certificates (`envmux-ca`)

- First run: `rcgen` generates a CA (ECDSA P-256, 10-year), a server cert (SANs: `localhost`,
  `127.0.0.1`, `::1`, the daemon's structured-URL wildcard, e.g. `*.envmux.localhost`; 90-day,
  auto-rotated at two-thirds life), and a `cli` client cert (1-year).
- CA private key → helper chain; certs (public halves) on disk in the state dir.
- `envmux cert issue <name>` / `revoke <serial>` / `reissue-server`; revocation is a serial denylist
  checked in the daemon's client-cert verifier (a custom `rustls::server::danger::ClientCertVerifier`
  wrapping WebPKI verification against the local CA + the denylist) — no CRL machinery.
- Clock-skew tolerance: verifier allows 5 minutes of skew on `notBefore`.
- Lost-CA recovery is explicitly `envmux cert init --force`: new CA, all clients reissued, one
  command, documented — the design names this as a known support burden; the answer is a short path,
  not cleverness.

---

## 14. API surface

One `axum::Router`, mounted twice:

1. **Local IPC, always on, no TLS**: Unix domain socket (`$ENVMUX_STATE_DIR/daemon.sock`, 0600) on
   Unix; `tokio::net::windows::named_pipe` (`\\.\pipe\envmux`) on Windows, served through
   `hyper-util`'s connection loop with a small accept adapter. Filesystem/pipe ACLs are the auth.
2. **TCP + mTLS, optional**: bound per config (default loopback), `tokio-rustls` acceptor with the
   §13 verifier; the authenticated client-cert CN is attached as an extension for audit logging.
3. **Plain HTTP, optional — the portal**: `--http-bind`, off unless passed. Serves the built UI
   (§21) plus the same router, so the browser client needs no second origin. It carries **no
   authentication**: the design rules out browser mTLS (concept §5), and inventing session tokens
   would be a second security model to maintain. The guard rails are that it is off by default, that
   a non-loopback bind additionally requires `--http-allow-public`, and that it says so at `warn` on
   every boot. Static assets resolve at runtime (`$ENVMUX_UI_DIR` → a `ui` dir beside the executable
   → the in-repo `ui/dist`) rather than being embedded, so the daemon builds from a clean clone
   where the UI has never been built; an unbuilt UI serves build instructions, not a 404.

`GET /v1/workspaces/{id}/tasks` reads the workspace's **frozen** `config_toml`, not the file on
disk. A workspace is a product of the config it was created from and is never upgraded in place, so
the graph the portal draws is what that workspace is actually running — with `config_current`
carrying the hash comparison as information, per the design's rule that mismatch is not a prompt to
migrate.

Routes (v1, all JSON, DTOs from `envmux-api-types`):

```
GET  /v1/namespaces                         GET  /v1/namespaces/{ns}
POST /v1/namespaces/{ns}/mirror/fetch
GET  /v1/namespaces/{ns}/workspaces         POST /v1/namespaces/{ns}/workspaces
GET  /v1/workspaces/{id}                    DELETE /v1/workspaces/{id}        (reap now)
POST /v1/workspaces/{id}/lease              (set/extend death date)
POST /v1/workspaces/{id}/pin                (lease = none; explicit unpin required)
GET  /v1/workspaces/{id}/observation
GET  /v1/workspaces/{id}/tasks              (declared graph + live status)
GET  /v1/workspaces/{id}/files?path=…       PUT /v1/workspaces/{id}/files?path=…   (tar streams)
GET  /v1/workspaces/{id}/captures           POST /v1/workspaces/{id}/captures      (capture now)
POST /v1/namespaces/{ns}/workspaces:from-capture
GET  /v1/services/{ns}                      GET  /v1/services/{ns}/{svc}/slices
GET  /v1/config/{ns}                        (active file, hash, drift state)
GET  /v1/disk                               GET  /v1/events?since=…
WS   /v1/workspaces/{id}/attach?task=…&mode=rw|ro
WS   /v1/events/stream
```

**Terminal WS protocol**: binary frames = raw PTY bytes; text frames = control JSON
(`{"resize":{cols,rows}}`, `{"mode":"ro"}`); server → client text frames carry task/window events.
One WS per terminal; "multiplexed" in the design means many terminals over the daemon, not many
panes over one socket — keeping the framing trivial.

**Attach side effect**: any successful `attach` (WS or CLI/UDS) with `mode=rw` calls the lease rule
(now + 24 h if later). Read-only attach does **not** extend — watching an agent shouldn't keep its
world alive; this is the one refinement to "any shell connection", and it is deliberate: `ro` is for
observers.

---

## 15. CLI (`envmux-cli`)

`clap` v4 derive; verbs mirror the design's §16 list:

```
envmux up|status|down                       # daemon + namespace bootstrap from cwd context
envmux create [--repo … --branch …] [--name …] [--wait]
envmux ls [--branch …] [--dirty] [--json|--porcelain]
envmux attach <ws> [--task …] [--ro]
envmux run <ws> -- <cmd…>
envmux lease <ws> --extend 24h | --until <ts> | --pin | --unpin
envmux cp <ws>:<path> <local> | <local> <ws>:<path>
envmux snapshots <ws|--branch …> [--from <snap> create]
envmux capture <ws>
envmux mirror fetch
envmux config show [--hash] ; envmux config create-local
envmux services ; envmux slices [--orphans]
envmux reap [--dry-run] ; envmux disk ; envmux cert …
envmux completions <shell>
```

Output contract: human tables to a TTY (`comfy-table`), `--porcelain` = stable tab-separated
columns (the greppable promise; column set is versioned and additions are append-only), `--json` =
one object per line. Attach puts the terminal in raw mode (`crossterm`) and splices to the UDS/WS
stream; `--ro` maps to tmux read-only attach. Exit codes: 0 ok, 1 error, 2 usage, 3 not-found,
4 daemon-unreachable — stable and documented.

---

## 16. Orchestrator proxy (`envmux-proxy`)

A ~7 MB static binary on `FROM scratch`; the one non-namespace image envmux ships. The image
compiles the proxy itself in a multi-stage musl build rather than copying a binary out of the host's
`target/`, so it builds on any host OS — the copy form was unbuildable on Windows and macOS, where
that path holds a native binary that cannot run in a container.

- **Routing**: host-based primary — `p<port>.<workspace>.<namespace>.envmux.localhost` — with
  path-based fallback `/ns/<namespace>/ws/<workspace>/p/<port>/…` for clients that can't wildcard.
  The path form strips its prefix and injects `X-Forwarded-*`; the doc'd failure mode (apps that
  assume root mounting) is stated in `--help` and docs, matching the design's decision to pick a
  primary and document the other.
- Implementation: `hyper` + `tower` service, upstream = `<workspace-dns>:<port>` on the namespace
  bridge; WebSocket upgrade pass-through; streaming bodies, no buffering. The upstream request
  target is **origin-form** (`/path?query`) with the authority in the `Host` header — hyper emits
  the URI verbatim, and absolute-form is reserved by RFC 7230 §5.3.2 for requests *to* a proxy, so
  an origin server may read `http://ws:8000/x` as a literal path. It does: every proxied request
  returned 404 until this was fixed.
- **Known gap — the host form does not validate against the server certificate.** The structured
  host `p<port>.<workspace>.<namespace>.envmux.localhost` is three labels deep, while the SAN is
  `*.envmux.localhost`, and RFC 6125 wildcards match exactly one label. Conforming clients reject
  it (`ERR_TLS_CERT_ALTNAME_INVALID`); the path form, which uses the single-label
  `envmux.localhost`, works. Resolving this needs a decision rather than a patch: flatten the
  structured host to one label (`p8000--ws--ns.envmux.localhost`) so one static wildcard covers it,
  reissue the server certificate with explicit per-workspace SANs as routes change, or demote the
  host form to secondary in the docs.
- TLS: terminates the daemon-issued server cert; client-cert verification with the same denylist
  (the daemon pushes cert material and route table over a private control endpoint on the bridge —
  plain HTTP, unreachable off-bridge by construction).
- Route table = the declared `[routes]` set; undeclared ports 404. Hot-reloaded on workspace
  create/reap.

---

## 17. Provisioner, capture, observation, disk — worker wiring

All follow §5's worker shape; specifics worth pinning:

- **Provisioner** runs inline in workspace creation (not periodic): mint creds → per-service
  `provision()` with per-service timeout → write `slices` rows → deliver secrets → hand off to task
  engine. Any failure rolls back created slices (best-effort, recorded) and fails creation cleanly.
- **Observer** ticks per namespace, fans out per workspace with `JoinSet` bounded by a concurrency
  limit (default 4) so a dozen monorepo workspaces don't stampede; skips non-`Ready`/`Degraded`
  states.
- **Capture worker** same fan-out shape, plus the per-namespace mutex shared with shadow
  maintenance.
- **Disk monitor** caches `system_df` (min 60 s), attributes by label class, compares against the
  configured percentage threshold, and emits an `events` row + a `watch`-published alert the CLI
  (`envmux disk`) and UI both read.

---

## 18. Reaper and reconciliation

**Reaper sweep**: `SELECT … WHERE state IN ('Ready','Degraded','Provisioning') AND death_date <
now`. Per victim, a persisted step column (`reap_step`) drives an idempotent sequence:

```
1. mark Reaping, reap_step=capture   → final capture (torn rules apply; failure logged, continue)
2. reap_step=deprovision             → per-service deprovision (failures recorded, continue)
3. reap_step=destroy                 → stop container, remove container + per-workspace volumes
4. mark Reaped                       → shadow refs retained per horizon
```

A crash resumes at the recorded step, which is why each step is idempotent (capture-again is
harmless; deprovision tolerates already-gone; destroy tolerates 404s).

**Boot reconciliation** (before the API opens): list by label → join against SQLite →
adopt matches; labelled-but-unrecorded → flag orphan (event, never auto-delete); recorded-but-gone
→ `Lost`; mark all observations stale (`observed_at` untouched; staleness is derived, so this is a
no-op by construction — noted here because it is deliberately *not* a flag).

---

## 19. Errors, diagnostics, logging

- Library crates: `thiserror` enums, no `anyhow` in signatures; error types carry the failing
  object's newtype ids so context survives without string prefixing.
- Binaries: `anyhow::Result` in `main`, `context()` at IO edges.
- **Config errors are `miette` diagnostics**: span-carrying, pointing into the TOML source with the
  offending key underlined — the config file is the primary human touchpoint and earns the best
  errors in the product.
- `tracing`: every component instruments spans keyed by namespace/workspace; `RUST_LOG`-style
  env-filter; JSON output when not a TTY; daemon writes a rotating file log in the state dir
  (`tracing-appender`). The `events` table is *not* the log — it is the small, queryable audit
  ledger the UI reads.

---

## 20. Testing strategy

| Layer | Approach |
|---|---|
| Domain / config | Unit + `proptest` (name validation, lifecycle transition table, TOML round-trips); `insta` snapshots for resolved-config output and `--porcelain` formats |
| SQL | `sqlx` compile-time checks + migration tests against a temp db |
| Git subsystem | Integration tests against real `git` in temp dirs: capture torn-flag (writer thread mutating during capture), alternates + kept-pack gc safety, `--no-optional-locks` non-disturbance (assert index mtime unchanged) |
| tmux client | Integration against real tmux in CI (Linux); protocol parser unit-tested from recorded control-mode transcripts |
| Docker paths | `testcontainers`-style integration behind `#[ignore]`-by-default, run in a CI job with a Docker daemon: full create→ready→attach→reap loop, service slice provision/deprovision/audit for all three backends, reconciliation after killing the daemon mid-reap |
| API | axum `Router` exercised in-process (`tower::ServiceExt::oneshot`); mTLS handshake tests with rcgen-minted good/expired/revoked/skewed certs |
| End-to-end | One smoke workflow in CI: sample monorepo fixture, generated `.envmux.toml`, two concurrent workspaces on one branch, capture, reap, revive from snapshot |

CI: fmt, clippy (deny), nextest, deny/audit, docs (`RUSTDOCFLAGS="-D warnings"`), MSRV build,
cross-target check builds; the Docker-backed integration job is Linux-only, required.

---

## 21. Packaging and delivery

- **Daemon + CLI are one executable.** `envmux daemon` runs the daemon; `envmux up` spawns that
  same executable in the background and adopts it. Two binaries meant a CLI could meet a daemon of
  a different build, and meant every installer, bundle, and package had to keep two files together;
  one binary removes both problems and there is no separate service install step. The daemon
  subcommand is documented rather than hidden — starting your own daemon is a normal thing to do,
  and an OS service unit invokes exactly it.
- **Tauri**: bundles the daemon as a sidecar; talks UDS/named pipe locally, holds its client cert
  via the helper chain for any TCP use.
- **Orchestrator image**: built and published per release, referenced by digest in the daemon.
- **Default images**: published per release; the general, .NET 10 + Node.js, and Rust + Node.js
  variants include tmux ≥ 3.2, git, common cloud/agent tooling, and code-server (the hosted VS
  Code), routed at a conventional port declared in the generated `[routes]`.
- **Portal UI**: `ui/` — Vite + React + TypeScript, built with `npm --prefix ui run build` into
  `ui/dist`. Its wire types are generated from `envmux-api-types`
  (`cargo run -p envmux-api-types --example dump-schemas -- ui/schemas` → `npm --prefix ui run
  codegen`), and CI regenerates and diffs them so a DTO change that never reached the portal fails
  the build rather than drifting. Releases ship `ui/dist` as a `ui` directory beside the daemon
  executable. `base` is relative in the Vite config and routing is hash-based, so one build works
  both at an origin root and behind the orchestrator's path-prefixed fallback.
- Versioning: workspace-wide single version; API is `/v1` and additive-only until `/v2`; label
  `schema=1` guards future label migrations.

---

## 22. Deferred / open items

- Podman and rootless Docker validation (nothing known-blocking; untested is unsupported).
- `Custom` service arm / subprocess service protocol.
- Sparse checkout, submodules, LFS against the mirror + alternates model — each needs its own
  test matrix before the design's monorepo caveat can be narrowed.
- fsmonitor auto-configuration (currently: used only if the image configured it).
- OTLP telemetry default-off review before any release that enables it.
