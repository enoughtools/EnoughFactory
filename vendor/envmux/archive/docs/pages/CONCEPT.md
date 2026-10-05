# envmux — Conceptual Design (Final)

**Status:** final · **Date:** 2026-08-08 · **Scope:** concepts only; implementation is specified
separately in the accompanying technical specification.

---

## 1. Problem statement

Running several coding agents in parallel on one machine means running several copies of the same
development environment at once. Existing tooling assumes one stack per project (DDEV, Docker
Compose) or ephemeral throwaway services per test run (Testcontainers). Neither handles *N
concurrent instances of the same project*, each needing its own database, object store, dev server,
and shell sessions, without the developer hand-managing port ranges and container names.

envmux provides isolated, disposable environments on a private Docker network, declared in a
committed file and managed by a local daemon. Work in progress is periodically captured to a local
shadow git origin so that a disposable workspace can be reaped without silently destroying
uncommitted work.

---

## 2. Design principles

| Principle | Consequence |
|---|---|
| **Isolation by namespace, not by allocation** | Every workspace uses the same canonical ports internally. No port arithmetic, no collisions, no drift between workspaces. |
| **No magic** | No image snapshots, no promotion, no rollback, no in-place upgrade. State lives in named Docker volumes and in git, both inspectable with ordinary tools. |
| **One image** | A single Dockerfile or image reference serves the base container and every workspace. There is no separate workspace image to keep in sync. |
| **No source bind mounts** | Source lives in a volume, cloned from a local mirror. Sidesteps macOS and Windows filesystem performance entirely, and removes host path translation as a class of bug. |
| **Services are containers, tasks are shells** | A service is a shared Docker container. A task is a named tmux window inside a workspace. Two concepts, two mechanisms, no overlap. |
| **Provisioning is the daemon's job** | Per-workspace slices of shared services are created by the daemon, which injects only scoped credentials into the workspace. Admin credentials never enter a workspace unless explicitly supplied. |
| **The CLI is the product** | The API and the UI are optional layers over it. Nothing requires either to be running. |
| **Identify by observation, not by convention** | Workspace names are arbitrary. What makes a workspace findable is continuously observed state, not a naming scheme someone has to remember. |
| **Ephemeral by construction** | Every workspace is born with a death date. Life is extended by lease, never by inference. There is no upgrade path for a stale workspace — commit, push to the shadow or the remote, and re-create. |
| **Reasonable defaults, no hard rules** | Volume modes, capture cadence, lease lengths, and naming all ship with sane defaults and are configurable. |
| **Namespaces are hard boundaries** | Services never cross a namespace. Two projects on one machine cannot see each other's databases. |
| **Nothing envmux writes leaves the machine** | The shadow origin is local. Pushing upstream is always the developer's decision. |

---

## 3. Core concepts

**Namespace** — one project's world: its own network, mirror, services, volumes, shadow origin, and
workspaces. Identity comes from an explicit field in `.envmux.toml`, falls back to the repository
name, and can be overridden in `.envmux.local.toml`. One daemon on the machine manages all
namespaces.

**Image** — one reference, declared in `.envmux.toml`, as either an image the daemon pulls or a
Dockerfile it has built. It backs both the base container and every workspace container. Its only
hard requirement is that **tmux is installed**. envmux ships an opinionated default image that
additionally includes a hosted VS Code server, routed through the orchestrator, so any workspace
can be opened in a browser editor without SSH or per-workspace setup.

**envmux orchestrates builds; it does not implement them.** A declared Dockerfile is handed to
`docker build` — the ordinary CLI, on the developer's own machine. That keeps `.dockerignore`,
BuildKit, the layer cache, and every platform difference in the tool that already solves them,
instead of reimplementing a context packer and an ignore matcher against the engine's build
endpoint. Anything more demanding — multi-architecture, registries, build secrets — belongs in
compose or CI, with the published result named as a reference here.

**Mirror** — a bare git repository on a per-namespace volume, maintained by the daemon as a local
copy of the project remote. It is the sync point with upstream and the clone origin for every
workspace.

**Project base container** — one per namespace, always present, running the namespace image. Holds
a working checkout cloned from the mirror at the standard path, and is the target for light
verification.

**Workspace** — one isolated instance of the environment: a single container on the namespace
network, running the namespace image, with its own tmux server, its own routes, and its own death
date. Randomly named. Ephemeral.

**Service** — a shared Docker container, namespace-scoped: a database, an object store, a cache, a
queue. One instance, shared across every workspace in the namespace. Each service type is backed by
an implementation in the daemon's Rust service library, which knows how to provision, deprovision,
and health-check slices of it.

**Task** — a named tmux window inside a workspace container, running a declared command.

**Shadow origin** — a bare git repository on a local namespace volume, holding periodic snapshots of
each workspace's working tree. Local only; never pushed anywhere. Distinct from the mirror: the
mirror reflects upstream, the shadow origin reflects work in progress.

**Observation** — the periodically refreshed picture of what each workspace currently is: its
branch, its commit state, its activity. What makes an arbitrarily named workspace findable.

**Orchestrator** — the single ingress container for a namespace, proxying to workspace ports via
structured URLs, reached over mutual TLS. It runs a small, envmux-supplied proxy image — not the
namespace image — and, like services, is exempt from the tmux requirement: envmux never gives you a
shell in it, and it is managed entirely through the Docker API.

**Daemon** — the Rust worker process on the host. Owns reconciliation, mirror synchronisation,
certificate management, service and workspace lifecycle, slice provisioning, tmux brokering,
capture, observation, shadow maintenance, disk monitoring, file transfer, and reaping.

---

## 4. Namespacing and networking

Each namespace gets a user-defined bridge network. Containers resolve each other by DNS alias, so a
workspace reaches its database at a stable hostname on the standard port regardless of how many
sibling workspaces exist. Because each workspace is its own network namespace, processes inside it
bind whatever ports they like without coordination.

The **orchestrator** is the single ingress, routing to any port in any workspace by structured URL —
namespace, workspace, and target port encoded in the hostname or path. Nothing is published per
workspace. The hosted editor in the default image is just another routed port.

**Egress** from a workspace is a policy knob: unrestricted, proxy-only, or allowlist.

**Docker-in-Docker and host socket mounting** are supported but not recommended. Nothing prevents
either, and an existing `compose.yaml` can be driven that way. The rest of the design covers the
same ground without a privileged container or a hole through the isolation boundary.

---

## 5. Transport security

The orchestrator and the daemon's API are protected by mutual TLS, following the model Docker
already established for its own remote API.

On first run the daemon generates a local certificate authority, a server certificate for its
endpoints, and a client certificate for the CLI. Both ends verify the other against the CA: the
client confirms it is talking to this machine's daemon, and the daemon confirms the caller holds a
certificate it issued. Additional client certificates can be issued for the desktop app, for
scripts, or for a second machine.

**mTLS is designed for the CLI and the Tauri desktop app**, both of which hold client certificates
through the credential helper chain without friction. Browser access is a different matter: browser
client-certificate handling is poor enough that the web UI is **off by default**, and enabling it is
an explicit decision. A developer who turns it on accepts the certificate-installation workflow for
their browser, or fronts the daemon with their own session layer. envmux does not mint session
tokens or run its own auth — that would be a second security model to maintain, and the supported
consumers do not need it.

The default bind remains loopback. A developer who binds wider is exposing an mTLS-gated surface,
which is a defensible thing to do deliberately. Remote operation is still not officially supported,
but it is no longer structurally reckless.

Client certificates and keys are handled through the same helper chain as other secrets, so they
land in the platform credential store rather than loose on disk where practical.

---

## 6. The mirror and the project base container

**The mirror** is a bare repository on a namespace volume, and it is the daemon's answer to two
questions the sixth pass left open: how the local copy tracks the real remote, and what workspaces
actually clone from.

- **Synchronisation is the daemon's job.** The mirror fetches from the project remote either
  periodically, on a configured interval, or on demand — at workspace creation, or when the
  developer asks. Both modes and the interval are set in `.envmux.toml`. A workspace request for a
  branch the mirror has never seen triggers an on-demand fetch before the clone fails.
- **It is the clone origin.** Workspace clones come from the mirror over a read-only volume mount,
  not from a live checkout and not from the network. Creating the fifth workspace of the day does
  not re-fetch the monorepo, and no concurrent clone can trip over a checked-out branch or a
  mid-operation state, because a bare mirror has neither.
- **Object sharing by default.** Workspace clones use git alternates against the read-only mirror
  volume, so N workspaces on a monorepo share one object store rather than carrying N copies. The
  classic hazard — gc on the origin invalidating objects an alternate depends on — is manageable
  precisely because the daemon owns gc on the mirror: repacks keep existing packs reachable, and
  pruning is deferred while any workspace clone references the mirror. Full, self-contained clones
  remain available as a per-namespace opt-out for developers who prefer paying disk for
  independence.

**The base container** keeps its remaining jobs:

- **Standardise git position.** A working checkout, cloned from the mirror, lives at one known
  path, identically, everywhere.
- **Provide a verification target.** Light checks — the image is sane, tmux is present, the
  toolchain runs, the repo resolves, services are reachable — run here before any workspace inherits
  the same image. Because it is the same image, a base container that works is meaningful evidence
  that workspaces will.

It runs tmux like any other container envmux gives you a shell in, and is long-lived rather than
leased.

---

## 7. Workspaces

**One container per workspace.** Every task in a workspace is a tmux window inside that single
container. There is no per-task container and no sidecar.

**Naming.** Each workspace gets a generated name. Fully random by default; partially random derived
from the branch name, or from a name the developer requests, when that is more useful. The name is
the workspace's identity — not the branch.

**Many workspaces per branch.** A dozen agents can work `main` simultaneously. Nothing in the design
prevents it, nothing coordinates between them, and whether it is a good idea is the developer's
problem. Each has its own container, its own checkout, its own tmux server, and its own shadow
history.

**Creation.** The developer nominates a workspace from the CLI or the API. Source resolution is
either explicit — a git repository reference and branch to clone — or contextual: running envmux
inside a directory detects the repository, the branch, and the namespace from where you are
standing. v1 supports git monorepos only. The resolved configuration is applied **at launch, once**:
a workspace is a product of the `.envmux.toml` it was created from, identified by config hash, and
is never upgraded in place. When the declaration changes, the path forward is to commit, let capture
or a push preserve the work, and re-create.

**Lease and death date.** Every workspace is stamped with a death date at creation: **7 days from
creation by default, configurable**. The lease is extended in exactly two ways:

- **Explicitly**, via the CLI — extend, shorten, or set the death date outright.
- **On attach**: any shell connection to the workspace that envmux itself brokers — CLI attach, API
  session, desktop terminal — extends the lease by **24 hours from that moment, configurable**,
  if that is later than the current death date.

Nothing else extends life. A running dev server, a chatty agent, task output, git activity — none of
it counts. Activity is not attachment, and inference is exactly the ambiguity this model exists to
remove. The observed effect is simple to state: a workspace nobody has connected to for a day past
its stamp is reaped, and a workspace someone touches daily lives indefinitely.

**Source model.** The workspace checkout is a volume, cloned from the mirror with shared objects as
described in §6. There are no bind mounts to the host. Finished work leaves by being pushed to the
real remote, by the developer or the agent, deliberately.

**Editing.** The opinionated default image includes a hosted VS Code server, exposed as a routed
port through the orchestrator, so "open this workspace in an editor" is a URL — no SSH, no keys, no
per-workspace setup. Developers who bring their own image bring their own editor story; the terminal
over tmux is always present regardless.

**Files in and out.** With no bind mounts, ad-hoc file movement is orchestrated rather than
implicit: the CLI and API expose copy-in and copy-out against a workspace path, and the UI provides
a basic file browser over the same operations — list, upload, download. This is a transfer
mechanism, not a sync mechanism; anything that should survive belongs in git.

**Reuse and revival.** Naming a workspace that still exists reuses it. A workspace that has been
reaped is gone — envmux does not promise to reconstitute a container, its volumes, or its running
state. What survives is its shadow history, on a longer horizon, from which a fresh workspace can be
started at any captured point.

---

## 8. Observation

Random names are only workable if the developer never has to remember one. The daemon therefore
collects a small set of identifying details from every workspace on a regular cycle, and both the
CLI and the UI present workspaces by what they *are* rather than by what they are called.

**What is observed** — the current branch, the HEAD commit, whether the tree is dirty and roughly
how dirty, position ahead of or behind the tracked remote, the time of the last shadow capture,
which tasks are running or have exited, when the workspace was last attached to, the current death
date, and how long the workspace has been up.

**How it is used.**

- The CLI's listing output is designed to be scanned and grepped: stable columns, one workspace per
  line, with a machine-readable format available for scripting. Finding the workspace on a given
  branch with uncommitted changes is a filter, not a hunt.
- The UI presents the same data as searchable, sortable columns, so a dozen workspaces on `main` are
  distinguishable by commit, dirtiness, and activity at a glance.
- The reaper and the disk monitor read the same observations rather than collecting their own.

**How it is collected.** Read-only git inspection inside the workspace, on a schedule, under an
explicit non-disturbance constraint: every invocation runs with `--no-optional-locks`, so no
observation ever writes the index, refreshes the stat cache, or takes a lock an agent's own git
operation could collide with. On large repositories, fsmonitor is used where the image provides it,
and the depth of collection — full dirtiness counts versus a cheap dirty/clean bit — is configurable
per namespace. Stopped workspaces are skipped. Observations are timestamped and stored in SQLite,
and consumers display their age rather than implying they are live.

This is a third category of state alongside the two the daemon already keeps: SQLite holds
**intent**, Docker labels hold **reality**, and observation holds **current condition**. Keeping
them distinct is what allows the daemon to say a workspace should exist, does exist, and is
currently three commits behind with eleven modified files.

---

## 9. The shadow origin

A bare git repository on a local namespace volume. It exists so that reaping a workspace does not
silently destroy work that was never committed.

**Capture** is scheduled. On its interval, the daemon stages everything in the workspace tree —
tracked and untracked alike — builds a commit stamped with the capture time, and writes it into the
shadow origin under a reference keyed by the workspace's name. The workspace's branch is recorded
alongside, so history can be read either per workspace or grouped across every workspace that has
worked a given branch. The snapshot is constructed against a separate index, so the workspace's own
index, HEAD, and branch are untouched while an agent is working.

**Torn captures are detected, not prevented.** A capture reads a tree that an agent may be writing
to, and no amount of git ceremony makes that atomic at the file level. Rather than pretend
otherwise, the capture worker records the file list with sizes and mtimes before staging and checks
it again after: if anything changed mid-capture, the worker retries once, and if the tree is still
moving, the snapshot is written anyway and flagged **torn**. Consumers — the CLI's snapshot listing,
the UI's history view — display the flag. A torn snapshot of recent work beats a clean snapshot of
older work; the flag exists so nobody mistakes one for the other. Repository states that resist
snapshotting — mid-rebase, mid-merge, unresolved conflicts — are likewise captured as-is and
flagged rather than normalised.

**`.gitignore` is inherited as-is.** Whatever the repository ignores, capture ignores. The developer
has already expressed what belongs in version control, and envmux does not maintain a second,
divergent opinion about it.

**The shadow origin is local and stays local.** Capture never pushes to the project's real remote,
never creates branches an upstream would see, and never touches the developer's configured remotes.
Publishing work is always an explicit human or agent decision through normal git.

**Capture is scheduled only.** No event triggers, no watchers, no commit-on-exit. The recommended
complement is an `AGENTS.md` convention prompting agents to commit regularly, which produces better
history than any capture cadence can. Capture is a safety net under that habit, not a replacement
for it.

**Retention and maintenance.** Shadow refs outlive the workspaces that produced them, on a longer
horizon than containers or volumes. Snapshot commits share trees and blobs, so unchanged files cost
nothing after the first capture — but pruned refs reclaim no disk until the objects behind them are
collected, so maintenance is explicit and daemon-owned: on its own schedule, the maintenance worker
prunes refs past their retention horizon, then runs gc on the shadow repository, serialized against
capture by a per-namespace lock, with git's automatic gc disabled so nothing runs implicitly. The
disk monitor attributes the shadow volume as its own line item, because untracked binary churn — a
build artifact the repository forgot to ignore — is the likeliest way this volume grows surprising.

---

## 10. Services

A service is a shared Docker container in the namespace. One Postgres, one MinIO, one Redis, serving
every workspace. Services start with the namespace, are health-checked, and are not recreated per
workspace. They never cross a namespace boundary.

Services are exempt from the tmux requirement. They run stock images, and envmux interacts with them
through the Docker API — exec, logs, health — rather than through a session. The tmux rule applies
to containers envmux gives you a shell in, which means the base container and workspaces.

Each service declares its image and version, its configuration, its health check, and its data
volume.

**Provisioning is the daemon's job.** Each supported service type is backed by an implementation in
the daemon's Rust service library that knows how to create and destroy a per-workspace slice: a
database and role, a bucket and access key, a key prefix. At workspace creation, the daemon
provisions the declared slices — keyed on the workspace name, since branch is not unique — and
injects **only the scoped credentials** into the workspace through the secrets mechanism. Admin
credentials are held by the daemon and never enter a workspace unless the declaration explicitly
supplies them, which is possible but a deliberate act. What runs *against* the slice — migrations,
seeds, fixtures — remains the developer's code, expressed as tasks, using the injected scoped
credentials.

**Services participate in reaping.** When a workspace is reaped, the daemon tells each service
implementation what to reap, and the implementation executes it: drop the database and role, remove
the bucket, delete the prefix. Because the daemon — not a task inside a dying container — performs
deprovisioning, a workspace that is destroyed abruptly does not leave its slices behind, and a
failed deprovision is recorded against the service rather than lost with the workspace. The daemon
can additionally audit: slices matching the naming convention with no live workspace behind them are
reported as orphans.

---

## 11. Tasks

A task is a named tmux window inside the workspace container, running a declared command. This is
the single execution mechanism — there is no separate job runner, and every task is therefore
attachable, watchable, and debuggable by exactly the same means. tmux is the substrate for v1,
accepted with its limits: exit status and readiness are evaluated through checks and window state
rather than a supervisor protocol, and that is sufficient for the task shapes v1 targets.

Each task declares its command, working directory, an optional readiness or completion check, what
it exports into the environment, whether it is expected to exit, and what it depends on:

- **Internal dependency** — run after another named task.
- **External dependency** — wait for a named service to be healthy, or for the daemon to have
  provisioned a declared slice.

The daemon resolves the resulting graph, starts independent tasks in parallel, and does not mark a
workspace ready until the graph is satisfied. One-shot tasks (migrate, seed) are expected to exit;
long-running tasks (dev server, watcher, log tail) are not, and are restarted according to their
declared policy.

Because tasks are tmux windows, they survive a daemon restart, and attaching from the CLI and from a
browser at the same time is ordinary tmux multi-client behaviour. Attaching mid-run gets scrollback,
detaching kills nothing, and read-only attachment is a first-class mode for watching an agent work.

Slice *creation* is no longer a task — that moved to the daemon (§10). Tasks are what the developer
runs against a slice that already exists, with credentials already mounted.

---

## 12. Volumes and persistence

Vanilla Docker named volumes, in classes, with reasonable defaults and no hard rules. Every mode
below is configurable per volume.

| Class | Scope | Default mode |
|---|---|---|
| **Mirror** | Per namespace | Daemon-managed; mounted read-only into workspaces for shared objects |
| **Source** | Per workspace | Read-write, cloned from mirror at create, objects shared via alternates |
| **Cache** | Per namespace, named | Shared read-write across workspaces |
| **Tools** | Per namespace, named | Shared, read-only in workspaces |
| **Sync** | Per namespace, named | Copy-in at create |
| **Shadow origin** | Per namespace | Daemon-managed |
| **Service data** | Per service | Owned by the service |

Caches and tools can be **shared**, **copy-on-start** — each workspace gets its own copy and
diverges harmlessly — or **off**. Shared is the default because genuine concurrent write contention
across workspaces is rare in practice; copy-on-start is the escape hatch when it isn't, and copies
are reaped on a regular cycle so they do not accumulate.

**Disk monitoring** is a daemon responsibility. It polls Docker's usage APIs, attributes consumption
by namespace, workspace, and volume class — with the mirror and shadow origin as their own line
items — and raises an alert when total use crosses a percentage of the disk. The threshold has a
sensible default and is user-configurable. Alerts name the largest contributors, so the response is
targeted rather than a blanket prune.

---

## 13. Configuration

**Files.** `.envmux.toml` in the repository root, TOML, committed. `.envmux.local.toml`, TOML, same
schema, not committed. TOML is chosen deliberately: comments belong in a committed, human-reviewed
file, and the format remains trivially machine-generated.

**Local override is whole-file, not a merge.** If `.envmux.local.toml` exists, it **is** the
configuration — the committed file is not layered underneath it. No deep-merge, no named-list
splicing, no null-to-delete semantics: creating a local config is your call to diff from your own
`.envmux.toml`, and keeping it current is your job. No magic, no drift ambiguity — a workspace was
built from exactly one file, and provenance is a filename, not a per-field lineage.

**Drift detection is opt-in.** The `create local config` utility copies the committed file to
`.envmux.local.toml` and records the hash of the base it was copied from. Thereafter, when the
committed file's hash no longer matches the recorded one, the CLI flags it: the base has moved, your
local copy is a diff away from finding out how. Nothing is merged on your behalf; the flag is the
whole feature.

**Applied at launch, never upgraded.** The resolved configuration is applied when a workspace is
created, and the workspace carries its config hash for the rest of its life. There is no upgrade
mechanism, by design: workspaces are short-lived and ephemeral, and the answer to a changed
declaration is commit and re-create. The UI flags hash mismatch against the current file, as
information — not as a prompt to migrate.

**Precedence**, lowest to highest: daemon defaults → the active file (`.envmux.local.toml` if
present, else `.envmux.toml`) → values supplied at workspace creation.

**Sections.**

| Section | Carries |
|---|---|
| meta | schema version; namespace name, or absent to imply from repository name |
| image | a Dockerfile path with build context and args, or an image reference to pull |
| mirror | fetch mode — periodic with interval, or on-demand — and the upstream remote |
| workspace | working directory, container user, resource limits, naming strategy |
| services | shared containers: image, version, config, health check, data volume; declared slices to provision per workspace |
| tasks | named tmux windows: command, working directory, internal and external dependencies, readiness or completion check, exports, long-running flag, restart policy |
| volumes | cache, tools, and sync volumes; names, mount paths, mode; clone strategy (shared objects or full) |
| capture | snapshot interval, retention horizon, maintenance schedule |
| observe | observation interval, which details to collect, collection depth |
| routes | which internal ports the orchestrator exposes via structured URL |
| secrets | which secrets are needed, by name, and where they mount |
| lease | initial lifetime, attach extension, maximum concurrent workspaces |
| env | literal and interpolated variables |

**Authoring.** The declaration is expected to be generated, not hand-written. The intended path is a
skill that reads the repository, infers services and tasks, and writes `.envmux.toml`. The format
should therefore optimise for being machine-generated and human-reviewable: flat where possible,
explicit rather than clever, commented where a decision needs a reason, and tolerant of being
regenerated wholesale — which the whole-file override model makes safe, since regeneration never
silently interacts with a local layer.

**Interpolation** covers host environment, workspace identity, and service and task exports.

---

## 14. Secrets

Secrets follow the conventions established by git and the AWS CLI: a helper-based lookup with a
documented protocol, a chain of providers tried in order, and a plain-text file fallback for
environments where no store is available. The platform-specific stores — Keychain, Windows
Credential Manager, Secret Service — are providers behind a stable interface rather than three
special cases in the daemon, and a developer with an existing helper can point envmux at it. The
same chain holds the mTLS client key material and the service admin credentials the daemon uses for
provisioning.

Values are mounted into containers as files at a secrets path rather than passed as environment
variables, so they do not appear in Docker API output. `.envmux.toml` declares which secrets are
needed and where they should appear; `.envmux.local.toml` holds references, never literals. Scoped
per-workspace credentials minted by the daemon during provisioning arrive by the same path, so a
task never distinguishes between a secret the developer declared and one the daemon minted.

---

## 15. Daemon architecture

A single Rust binary on the host, talking to the Docker API over the local socket. One instance per
machine, managing every namespace.

| Component | Responsibility |
|---|---|
| Config resolver | Locate, parse, and validate the active `.envmux.toml` or `.envmux.local.toml`; compute and record config and base hashes |
| Image manager | Pull the declared reference, or invoke `docker build` for a declared Dockerfile; verify the tmux requirement |
| Certificate authority | Generate the local CA on first run; issue and rotate server and client certificates |
| Mirror sync | Maintain the per-namespace bare mirror; periodic or on-demand fetch; owned gc with alternates-safe repacking |
| Namespace manager | Networks, base containers, orchestrators, service lifecycle |
| Provisioner | Create and destroy per-workspace service slices via the service library; mint and inject scoped credentials; audit for orphaned slices |
| Task engine | Resolve the task graph, create and supervise tmux windows, evaluate checks |
| Workspace lifecycle | Naming, creation, config-hash stamping, death-date stamping, state machine through to reaping |
| Capture worker | Scheduled shadow snapshots with torn detection |
| Shadow maintenance | Ref pruning by retention; scheduled gc serialized against capture |
| Observer | Scheduled, lock-free collection of branch, commit, dirtiness, and activity per workspace |
| Session broker | Attach clients to in-container tmux; extend leases on attach; multiplex over the API when enabled |
| File transfer | Copy-in and copy-out against workspace paths for the CLI, API, and UI file browser |
| Disk monitor | Poll Docker usage APIs, attribute by namespace and class, raise threshold alerts |
| Reaper | Scheduled sweep against stamped death dates; drive service-side deprovisioning |
| API | Optional mTLS HTTP and WebSocket surface; local socket for the CLI |

**State.** SQLite holds intent — what should exist, from which file at which hash, when it was
created, when its lease was last extended, when it dies — and the observation record. Docker labels
hold reality. On start the daemon reconciles: adopt what matches, flag labelled containers it does
not recognise as orphans, flag recorded workspaces that have vanished as lost, and mark observations
stale until refreshed.

**Reaping** is lease-driven. Every workspace is stamped with a death date at creation — 7 days by
default. Brokered shell attachment extends the lease by 24 hours from the moment of attach when that
is later than the current stamp; the CLI can set the date directly; nothing else moves it. The
reaper runs on its own schedule and selects whatever is past its stamped date. Nothing is computed
from elapsed time at sweep, so a machine that slept for a weekend wakes with the same death dates it
went to sleep with rather than a queue of mass deletions. On reap, the daemon runs one final capture
into the shadow origin, then drives each service implementation to deprovision the workspace's
slices, then removes the container and its volumes. Horizons differ by class: copied cache and tool
volumes are short, workspace leases are as configured, shadow refs are long, base containers,
mirrors, and services do not carry one.

**Labels** on every container, volume, and network: namespace, workspace, role, class, created-at,
config hash. Listing and reaping are single filtered queries.

---

## 16. Interfaces

**CLI** — the complete interface. Everything envmux does is reachable here, and nothing else needs
to be running. Create a workspace by repository reference or context detection. List and filter by
observed state — branch, dirtiness, activity, time to death — in a greppable, scriptable format.
Attach to a named task. Run a one-off command. Extend, shorten, or set a lease. Copy files in and
out of a workspace. Show the active configuration file, its hash, and — where a local config was
created with drift detection — whether the base has moved. Show service health, provisioned slices,
and task graph status. Trigger a mirror fetch. List and inspect shadow snapshots, by workspace or
grouped by branch, torn flags included, and start a workspace from one. Stop, purge, pin, run the
reaper, report disk use, manage client certificates.

**API** — optional. An mTLS HTTP and WebSocket surface over the same operations, enabled when the
developer wants programmatic access or the desktop app. Disabled, the daemon still runs everything
through its local socket.

**UI** — optional, off by default, and a consumer of the API. Vite, React, TypeScript, served by
the daemon. Its supported host is the Tauri desktop app; serving it to a browser is possible but
requires the developer to opt in and to accept browser mTLS client-certificate handling.

- Namespace overview: mirror sync state, base container and service health, disk use by class with
  alert state
- Workspace list: name, branch, commit, dirtiness, running tasks, age, time until death date, last
  capture, config-hash match against the current file, route URLs — searchable and sortable
- Workspace detail: tabbed terminals over the workspace's tmux windows, task graph with per-task
  status, an "open editor" link to the hosted VS Code route where the image provides it, and a basic
  file browser — list, upload, download — over the daemon's transfer operations
- History: shadow snapshots on a timeline, per workspace or across a branch, torn flags shown, diff
  between snapshots, start a workspace from one
- Volumes: sizes, classes, last-touched, what is scheduled for reaping
- Config: the active file, its hash, and drift state where detection was opted into

Terminals are a browser terminal emulator over multiplexed WebSocket streams, with read-only viewing
as a first-class mode.

**Desktop** — Tauri wrapper around the same frontend, with the daemon as a bundled sidecar, holding
its client certificate through the credential helper chain. This is the primary graphical surface.
Windows is the motivating target. The absence of source bind mounts removes most of what usually
makes Windows painful; what remains is the engine dependency and credential helper availability.

---

## 17. Known risks and sharp edges

- **The shadow origin is local, and that is the point — and the risk.** Nothing envmux captures
  leaves the machine. A branch that was worked on but never pushed exists in exactly one place. Disk
  failure, machine loss, or an over-aggressive retention setting are all total loss for that work.
- **Inheriting `.gitignore` inherits its mistakes.** A repository that ignores `.env` will not
  capture the generated config an agent depends on. A repository that fails to ignore a secret will
  capture it permanently into shadow history, where git's append-only nature makes removal a rewrite
  rather than a delete. Both follow from trusting the developer's `.gitignore`, which is the
  accepted trade.
- **Scheduled-only capture has a blast radius equal to the interval — except at reap.** The final
  capture on reap closes the worst case; work is lost to the interval only on a crash or a hard
  kill. The `AGENTS.md` commit convention remains the real mitigation; the interval is the backstop.
- **Torn captures are honest, not clean.** A snapshot taken while an agent writes may contain a
  half-written file. The flag makes this visible; it does not make it not so.
- **Leases do not know about running work.** An agent mid-task in a workspace nobody has attached to
  for a day past its death date is reaped, final capture notwithstanding — in-flight process state
  is gone. This is the cost of refusing to infer liveness from activity, and it is deliberate: the
  mitigation is the CLI lease extension, issued by whatever launched the agent.
- **Attach-based extension can be gamed by habit.** A developer who reflexively attaches to
  everything keeps everything alive. The maximum-concurrent-workspaces cap and disk alerts are the
  counterweights.
- **Observation is a snapshot, not a feed.** Everything the CLI and UI show is up to one interval
  stale. Displaying its age is not optional — a developer picking a workspace to attach to based on
  a five-minute-old dirtiness count will occasionally pick the wrong one.
- **Observation is not free.** Even lock-free, git inspection across a dozen workspaces on a large
  monorepo, on a short interval, is real work. The interval, the collection depth, and skipping
  stopped workspaces are all tunable for this reason.
- **Many workspaces on one branch is unmanaged concurrency.** envmux coordinates none of it. A dozen
  agents on `main` will produce a dozen divergent trees, a dozen shadow histories, and a dozen
  slices of the shared services. This is permitted deliberately, and it is entirely the developer's
  problem.
- **Shared services mean shared blast radius — narrowed, not removed.** Scoped credentials confine a
  workspace to its own slice at the permission level, but the service process, its disk, and its
  connection slots are still shared: one workspace can exhaust connections or fill the data volume
  for everyone. And where the declaration explicitly supplies admin credentials to a workspace, the
  confinement is waived by choice.
- **Workspaces still share a network.** mTLS protects the orchestrator, not the bridge. Any process
  in any workspace can reach a sibling's ports directly by DNS. For agent-run code this is a real
  consideration, not a theoretical one.
- **Alternates couple workspaces to the mirror.** A workspace's git objects live partly on the
  mirror volume. Deleting the mirror, or a gc bug that prunes a referenced object, corrupts every
  sharing clone. The daemon's ownership of mirror gc is the containment; the full-clone opt-out is
  the escape hatch.
- **Whole-file local override trades drift for staleness.** A local config never silently merges
  with the base — but it also never picks up the base's improvements. The hash flag tells you the
  base moved; it cannot tell you whether you care. This is the accepted cost of no-magic.
- **The hosted editor widens the workspace's surface.** VS Code server in every default-image
  workspace is another routed port, another process, and another update stream inside the trust
  boundary. Images built without it give up the browser editor and nothing else.
- **Certificate lifecycle is a support burden.** Expiry, rotation, clock skew, a lost CA after a
  daemon reinstall, and getting client certs onto a second machine are all things Docker's own TLS
  setup is known for generating support questions about. Sensible lifetimes and a one-command
  reissue path matter. Keeping the browser UI off by default removes the worst of it.
- **tmux is a hard requirement for anything envmux shells into.** It is the execution substrate for
  every task, not a convenience, and v1 accepts its supervision limits. An image without it fails
  entirely. Detection belongs at base container verification with a clear message, not at first
  attach.
- **Docker usage APIs are slow.** Full disk accounting can take seconds on a large installation.
  Polling needs caching and rate limiting or it becomes its own performance problem.
- **Building from a Dockerfile shifts cost to first run, and adds a dependency.** Pulling a
  reference is fast; building is not, and a changed declaration rebuilds before a workspace can
  start. Delegating to `docker build` also means the Docker CLI must be installed, not merely the
  engine socket — a namespace that pulls by reference never needs it, one that builds does.
- **Credential helper availability varies.** Headless Linux without a Secret Service provider,
  locked keychains, and Windows profile scope all need a documented fallback path.
- **Monorepo-only is doing a lot of work.** Submodules, LFS objects, sparse checkouts, and large
  histories interact with the mirror, the alternates model, and the capture mechanism. Each needs an
  explicit answer before it can be claimed as supported.