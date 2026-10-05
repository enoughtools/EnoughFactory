# Configuration

`.envmux.toml` in the repository root, committed. `.envmux.local.toml`, same
schema, not committed.

**Local override is whole-file.** If `.envmux.local.toml` exists it *is* the
configuration; the committed file is not layered underneath it. No deep merge,
no null-to-delete, no per-field lineage — a workspace was built from exactly one
file, and provenance is a filename.

**Applied at launch, never upgraded.** A workspace carries the hash of the file
it was created from for its whole life. When the declaration changes, the path
forward is to commit, let capture preserve the work, and re-create. The CLI
and TUI flag a hash mismatch as information, not as a prompt to migrate.

Write it with `envmux config prompt --agent <name>`; validate with
`envmux config show`.

## The minimal file

Schema plus an image source is a complete, valid configuration — everything
else has a default:

```toml
[meta]
schema = 2

[image]
reference = "ghcr.io/acme/dev:2026.08"
```

Grow it from there: declare a section only when the repository needs it.

## `[meta]`

```toml
[meta]
schema = 2              # 2 is current; 1 is still accepted, unchanged
namespace = "acme"      # absent implies the repository directory name
```

Namespaces are hard boundaries: services never cross one, and two projects on
one machine cannot see each other's databases.

## `[image]`

One image backs the base container and every workspace. Exactly one source.

```toml
[image]
reference = "ghcr.io/acme/dev:2026.08"
```

```toml
[image]
dockerfile = "Dockerfile.envmux"
context = "."
args = { RUST_VERSION = "1.95" }
```

The only hard requirement is **tmux ≥ 3.2**, because every task is a tmux
window. This is checked at base-container verification with a clear message,
not at first attach.

`dockerfile` shells out to `docker build`, so `.dockerignore`, BuildKit, and the
layer cache behave exactly as on the command line — and the Docker CLI must be
installed, not just the engine. Anything more demanding (multi-architecture,
registries, build secrets) belongs in compose or CI, with the published result
named as a `reference`.

Prefer a digest or a pinned tag. A moving tag quietly breaks the guarantee that
a workspace is a product of the config it was created from.

## `[mirror]`

```toml
[mirror]
remote = "https://github.com/acme/project"   # absent detects `origin`
fetch = "periodic"                           # or "on-demand"
interval = "15m"
```

The mirror is a bare clone the daemon maintains, and the origin every workspace
clones from — over a read-only volume mount, with git alternates, so N
workspaces on a monorepo share one object store. A request for a branch the
mirror has never seen triggers a fetch before the clone fails.

## `[workspace]`

```toml
[workspace]
workdir = "/work"
user = "user"           # the account in the images envmux ships
naming = "random"       # or "branch"
terminal = "claude"     # what a session drops you into (see below)
# cpus = 4.0
# memory = "8g"
```

**`user` is not root.** The images envmux ships run as `user` — uid 1000, home
`/home/user`, passwordless sudo. Absent means whatever the image's own `USER`
says, so the key exists to override an image that differs; set it and the
volume paths in `[volumes]` have to agree with the home it names.

**`terminal` chooses what you land in.** `"shell"` (the default) keeps the
image's shell. `"manage"` opens the management view on the host instead of
attaching. Anything else is a command run in the workspace's first tmux
window — `"claude"`, `"codex"`, or any command line the image can execute —
so a session drops you straight into your agent. When the command exits, that
window closes; declared task windows are unaffected, and `envmux attach
--task` still reaches them. Exiting is not a one-way door: a read-write attach
recreates the terminal window (and the session, if that was the last thing in
it) and runs `terminal` again, so quitting your agent hands you a new one
rather than a dead workspace.

**Resource limits are optional and off by default** — absent means no limit, and
the workspace gets whatever the host gives it. A number committed here applies
to every machine that clones the repository, which is rarely what the author
meant. `memory` is parsed when the config loads, so a typo is a diagnostic
rather than a limit that silently is not applied.

Two deliberately unsafe options exist and default to false:
`dangerously_mount_docker_socket` (Linux only; root-equivalent host access) and
`dangerously_enable_dind` (a privileged nested daemon). Validation rejects
enabling both.

## `[services.*]`

Shared containers, one per namespace, used by every workspace.

```toml
[services.db]
kind = "postgres"       # postgres | minio | redis
version = "16"
```

At workspace creation the daemon provisions a **slice** — a database and role, a
bucket and service account, a key prefix — keyed on the workspace name, and
injects only scoped credentials. Admin credentials stay with the daemon.

Slices are destroyed by the daemon at reap, not by a task inside the dying
container, so an abruptly destroyed workspace does not leak them.

## `[tasks.*]`

A task is a named tmux window running a command. This is the only execution
mechanism, so everything is attachable and debuggable the same way.

```toml
[tasks.migrate]
command = "cargo run -p migrations"
requires = ["db"]                     # a service must be healthy and provisioned

[tasks.dev]
command = "cargo run"
cwd = "/work"
after = ["migrate"]                   # another task must finish first
long_running = true
check = { kind = "http", port = 8080, path = "/health", interval = "2s", timeout = "90s" }
restart = { policy = "on-failure", max = 5, backoff = "3s" }
exports = { RUST_LOG = "debug" }
```

- **One-shot tasks are expected to exit**; a non-zero exit with
  `restart.policy = "never"` fails the workspace.
- **Long-running tasks are not**, and need `long_running = true` plus a `check`,
  or `envmux create --wait` cannot tell when the workspace is ready.
- Check kinds: `exec` (a command, exit 0), `http` (port and path), `port` (TCP
  connect).
- Cycles are rejected at validation, not at run time.

## `[volumes]`

```toml
[volumes.named.cargo-registry]
class = "cache"         # cache | tools | sync
path = "/usr/local/cargo/registry"
mode = "shared"         # shared | copy-on-start | off

[volumes.named.claude]
class = "sync"
path = "/home/user/.claude"
```

`shared` is the default because genuine write contention across workspaces is
rare; `copy-on-start` is the escape hatch, and copies are reaped on a cycle so
they do not accumulate.

`cache` is disposable and `sync` is not — which is the whole mechanism behind
agent state. A `sync` volume on `~/.claude` or `~/.codex` is shared by every
workspace in the namespace, so an agent signed in once is signed in for all of
them, including workspaces that do not exist yet. Paths are paths in the
container: the images envmux ships run as `user`, so they start `/home/user`.

Workspace *source* is always its own volume, never a bind mount — which is what
sidesteps macOS and Windows filesystem performance entirely.

## `[routes]` and `[routing]`

Served by the **in-session router**: a loopback reverse proxy that runs with
your session and forwards each named route to the right workspace container.

```toml
[routes]
web = 8080
editor = 3000

[routing]
# port = 8443               # router loopback port; absent = default, with fallback
# domain = "dev.example"    # absent = platform default (see below)
# delimiter = "_"           # separator inside the host label
```

`[routes]` names which container ports are reachable — a `name -> port` map;
undeclared ports 404. Route names become part of the hostname, so they must be
hostname-label-safe: lowercase letters, digits, and hyphens. `_` is rejected
inside a name because it is the delimiter between host fields.

The [setup screen](tui.md#setup) fills this section in from what it finds in
the repository — a `ports:` list in a compose file, an `EXPOSE` line, a
`--port` flag in a `package.json` script, a `PORT` in a `.env`, an
`applicationUrl` in a .NET launch profile — and shows you which line each
number came from before writing any of it. It is a starting point, not a
mechanism: what ends up here is whatever you leave here.

One thing worth checking whatever wrote it: the port has to be one the process
actually **binds on `0.0.0.0`**. A dev server on `127.0.0.1` inside a container
is reachable from nothing at all, and the workspace comes up perfectly healthy
while the route serves nobody. This is why the `vite` preset writes
`--host 0.0.0.0` and the `python` one writes `runserver 0.0.0.0:8000`.

`[routing]` says how the URLs are spelled — a **single label** per route:

```
https://<namespace>_<workspace>_<route>.<domain>/
https://acme_wobbly-otter_web.localhost/
```

One label is the whole design: `*.<domain>` is then a single certificate
covering every workspace and route that will ever exist, and `_` — illegal
under RFC 952/1123, accepted everywhere that matters — cannot collide with
generated workspace names, which are lowercase ASCII and hyphens.

Every `[routing]` field is optional:

- `port` — the router's loopback listen port. Absent means the router's
  default, and the router falls back on its own when that port is taken.
- `domain` — absent means the platform default: `localhost` everywhere except
  Windows, where it is `strigops.xyz` — public wildcard DNS resolving to
  loopback — because Windows resolves `*.localhost` unreliably, even in
  browsers. A custom domain needs a wildcard DNS record pointing at
  `127.0.0.1`.
- `delimiter` — `_` by default, for the collision-avoidance above.

## `[capture]`, `[observe]`, `[lease]`

```toml
[capture]
interval = "5m"         # scheduled snapshots into the shadow origin
retention = "30d"

[observe]
interval = "30s"
depth = "full"          # or "cheap": a dirty/clean bit instead of counts

[lease]
initial = "7d"
attach_extension = "24h"
max_workspaces = 8
```

Capture is scheduled only — no event triggers, no commit-on-exit. The
recommended complement is an `AGENTS.md` convention prompting agents to commit
regularly, which produces better history than any cadence can. Capture is the
backstop under that habit.

## `[secrets]` and `[env]`

```toml
[secrets.api-key]
mount = "/run/envmux/secrets/api-key"

[env]
RUST_LOG = "debug"
```

Secrets are declared here by **name and mount point only** — never a literal.
Values come from the helper chain (platform keyring, then a file fallback) and
are written into the container as files, so they never appear in Docker API
output. `.envmux.local.toml` holds references, not literals.

Interpolation covers host environment, workspace identity, and task exports.

## Drift detection

`envmux config create-local` copies the committed file and records the hash it
was copied from. Thereafter, when the committed file's hash no longer matches,
the CLI and TUI flag it: the base moved, and your local copy is a diff away
from finding out how. Nothing is merged on your behalf — the flag is the whole
feature.
