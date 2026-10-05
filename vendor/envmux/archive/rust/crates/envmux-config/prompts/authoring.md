# Write an `.envmux.toml` for this repository

You are writing the environment declaration for **envmux**, which runs several
isolated, disposable copies of one project's development environment side by
side — typically so multiple coding agents can work in parallel without
colliding.

Read the repository first. Infer what the environment actually needs from what
is there. Then write `.envmux.toml` in the repository root.

## What you are declaring

One **namespace** per project. Inside it:

- **image** — one container image backing every workspace. Its only hard
  requirement is that **tmux ≥ 3.2 is installed**, because every task runs as a
  tmux window. Declare `reference` to pull a published image, or `dockerfile`
  to have envmux run `docker build` for you.
- **services** — shared containers (Postgres, MinIO, Redis), one per namespace,
  shared by every workspace. envmux creates a per-workspace *slice* of each
  (a database and role, a bucket, a key prefix) and injects only scoped
  credentials.
- **tasks** — named tmux windows running declared commands, with a dependency
  graph. This is the whole execution mechanism; there is no separate job runner.
- **routes** — which container ports are reachable through the in-session
  router, a loopback reverse proxy that serves each route at
  `https://<namespace>_<workspace>_<route>.<domain>/`. Route names become part
  of the hostname: lowercase letters, digits, and hyphens only (no `_`).
- **volumes**, **capture**, **observe**, **lease**, **env**, **secrets**.

## How to decide what goes in it

Work from evidence in the repository, not from convention:

1. **Language and toolchain** — `Cargo.toml`, `package.json`, `go.mod`,
   `pyproject.toml`, `*.csproj`, `Gemfile`. This drives the image choice and
   the build/dev tasks.
2. **Services** — look at `compose.yaml`/`docker-compose.yml`, `.env.example`,
   connection strings, ORM configs, migration directories. A `DATABASE_URL`
   mentioning `postgres` means declare a `postgres` service. Do not declare
   services nothing references.
3. **Tasks** — the commands a developer actually runs. Check `package.json`
   scripts, `Makefile`, `justfile`, `Taskfile`, CI workflows, and the README's
   getting-started section. Typical shape: a one-shot `migrate`, a one-shot
   `seed`, a long-running `dev`.
4. **Ports** — whatever the dev server binds. Declare those under `[routes]`.
5. **Caches worth persisting** — the package manager store for each toolchain
   the repository actually builds with. Declare them as `cache` volumes so a
   new workspace is not slow. In the images envmux ships that means
   `/home/user/.npm`, `/home/user/.cache/pip`, `/home/user/.nuget/packages`,
   `/home/user/go/pkg/mod` and `/home/user/.cache/go-build`, and
   `/usr/local/cargo/{registry,git}` — Rust lives outside any home so a
   non-root workspace can read the toolchain.

## The account, and the agent state that hangs off it

The images envmux ships run as the non-root account **`user`**, home
`/home/user`, with passwordless sudo. Say so — `[workspace] user = "user"` —
rather than leave it implied, because every volume path is a path in that
home, and an image with a different account has to change both together.

A generated starter already declares `sync` volumes for the agent CLIs at
`/home/user/.claude`, `/home/user/.codex`, and `/home/user/.config/opencode`,
plus `CLAUDE_CONFIG_DIR`. Keep them. They are what makes a workspace usable
the moment it exists: `sync` volumes are shared by every workspace in the
namespace, so an agent signed in once is signed in for all of them. They are
envmux volumes, not host directories — nothing is copied off the developer's
machine, and the credentials are shared namespace-wide, which is why work that
must not see them belongs in its own namespace.

## Rules that matter

- **One-shot tasks are expected to exit; long-running ones are not.** Set
  `long_running = true` for servers and watchers, and give them a readiness
  `check`. A one-shot task with a non-zero exit and `restart.policy = "never"`
  fails the whole workspace.
- **Order comes from `after` (other tasks) and `requires` (services).** Do not
  encode ordering by hoping; declare it. Cycles are rejected at validation.
- **Slice credentials arrive as files**, not environment variables, under
  `/run/envmux/secrets/<service>/`. Tasks read them from there. Never put a
  literal secret in this file.
- **Resource limits are optional and off by default.** Only set
  `[workspace] cpus` / `memory` if there is a reason; a number committed here
  applies to every machine that clones the repository.
- **Nothing about this file is per-developer.** It is committed. Anything
  machine-specific belongs in an uncommitted `.envmux.local.toml`, which
  replaces this file wholesale rather than merging with it.
- **Prefer a digest or a pinned tag** for `[image] reference`. A workspace is a
  product of the config it was created from, and a moving tag quietly breaks
  that.

## Shape

Only `schema` and `[image]` are required; every other section has a sensible
default and should be declared only when the repository needs it.

```toml
[meta]
schema = 2
namespace = "acme"                       # absent implies the repository name

[image]
reference = "ghcr.io/acme/dev:2026.08"   # or: dockerfile = "Dockerfile.envmux"

[mirror]
fetch = "periodic"                       # or "on-demand"
interval = "15m"

[workspace]
workdir = "/work"
user = "user"                            # the images' non-root account

[services.db]
kind = "postgres"                        # postgres | minio | redis
version = "16"

[tasks.migrate]
command = "cargo run -p migrations"
requires = ["db"]                        # waits for the service and its slice

[tasks.dev]
command = "cargo run"
after = ["migrate"]                      # waits for the task
long_running = true
check = { kind = "http", port = 8080, path = "/health", timeout = "90s" }
restart = { policy = "on-failure", max = 5, backoff = "3s" }

[volumes.named.cargo-registry]
class = "cache"                          # disposable
path = "/usr/local/cargo/registry"

[volumes.named.claude]
class = "sync"                           # persistent, shared across workspaces
path = "/home/user/.claude"

[routes]
web = 8080

[lease]
initial = "7d"
attach_extension = "24h"
```

## Before you finish

- Every `after` names a task that exists; every `requires` names a service that
  exists.
- Every long-running task has a `check`, or `envmux create --wait` will not
  know when it is ready.
- Comment anything a reader would otherwise have to ask about — the file is
  committed and reviewed by humans.
- Validate it: `envmux config show` parses and checks the file, and reports
  errors pointing at the offending key.

Write the file. Then tell the reader, briefly, what you inferred and what you
guessed, so they know what to check.
