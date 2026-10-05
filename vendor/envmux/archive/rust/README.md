# envmux

Isolated, disposable development environments for running several coding
agents in parallel on one machine — each with its own database slice, object
store bucket, dev server, and shell sessions, without hand-managed port
ranges or container names.

## What it does

envmux keeps one **namespace** per project: a private Docker network, a bare
git **mirror** of your remote, shared **services** (Postgres, MinIO, Redis),
a **shadow origin** capturing work-in-progress, and any number of
**workspaces** — one container each, cloned from the mirror with shared
objects, running your declared **tasks** as tmux windows. Every workspace is
born with a death date; brokered shell attach extends the lease; the reaper
takes a final shadow snapshot before anything is destroyed.

Run it with no arguments and you get an interactive UI over all of it:

```console
$ envmux
```

It is on screen before it does anything, and brings the session up behind
itself: a landing page with this folder's namespace, branch and workspace, a
four-step checklist while the daemon and image and workspace come up, your
tmux windows numbered as tmux numbers them (`alt-2` here selects what
`prefix 2` selects inside), whatever the workspace serves as a whole URL, and
a live event feed under a prompt. `/manage` swaps to the dashboard —
namespaces, leases, shadow history — and `?` lists its keys.

In a repository it has not seen before, the first screen reads that repository
and offers a starting point that fits it, showing the exact `.envmux.toml` it
would write before it writes it.

Redirect the output and you get `--help` instead, so nothing scripted changes.

Every one of those is a subcommand too:

```console
$ envmux up                 # start/adopt the daemon, register namespace from cwd
$ envmux create --wait      # a workspace: cloned, provisioned, tasks running
$ envmux ls                 # find workspaces by what they ARE, not their names
$ envmux attach wobbly-otter --task dev
$ envmux snapshots wobbly-otter
$ envmux lease wobbly-otter --extend 24h
```

There is also a **desktop app** and a **portal** — the same workspace list,
task graph, terminals, and snapshot history in a window or a browser tab.

## Install

Download the installer for your platform from the
[latest release](https://github.com/strigops-io/envmux/releases/latest).

| Platform | Download | Notes |
|---|---|---|
| Windows | `envmux_<version>_x64-setup.exe` | Per-user install, no administrator rights. `.msi` also provided. |
| macOS (Apple silicon) | `envmux_<version>_aarch64.dmg` | Unsigned for now — see below. |
| macOS (Intel) | `envmux_<version>_x64.dmg` | Unsigned for now — see below. |
| Linux (Debian/Ubuntu) | `envmux_<version>_amd64.deb` | `sudo apt install ./envmux_*.deb` |
| Linux (any) | `envmux_<version>_amd64.AppImage` | `chmod +x` and run |

Each installer contains the desktop app, the `envmux` CLI, the daemon, and the
portal. Prefer the command line only? The same release has
`envmux-cli-<target>.tar.gz` / `.zip` with just the CLI, daemon, and portal
assets — unpack it anywhere and run it from there.

No install step is needed to try it. Once you decide to keep it, `envmux
install` (or `I` in the UI) copies it somewhere permanent and puts that on your
`PATH` — per-user, no elevation.

**These builds are not code-signed yet.** Windows SmartScreen will warn
("More info" → "Run anyway"); macOS will need
`xattr -dr com.apple.quarantine /Applications/envmux.app` on first run. Signing
is on the release checklist, not done.

### You also need Docker

envmux drives a local Docker engine — **Docker Desktop** on Windows and macOS
(using Linux containers), Docker Engine on Linux. Version 25 or newer, with the
engine running. Also host `git` 2.40 or newer.

Building an image from a Dockerfile additionally needs the Docker **CLI**, not
just the engine; pulling an image by reference does not.

### First run

```console
$ cd your-project
$ envmux                                   # pick a starting point, then go
```

envmux reads the repository — `package.json` and its lockfile, `compose.yaml`,
a `Dockerfile`, `.env` — and pre-selects a starting point that matches, with
the ports it found already routed. Or hand the job to an agent, which does
better than any template on a repository with more going on:

```console
$ envmux config prompt --agent claude      # have an agent write .envmux.toml
$ envmux
```

…or the same thing one command at a time:

```console
$ envmux up                                # register the namespace
$ envmux create --wait                     # a workspace
$ envmux ls
```

The declaration is meant to be generated: something that reads your repository
and infers its services, tasks, and ports does better than a template. envmux
ships the instructions and pipes them to whichever agent you use —
`--list-agents` shows the ones it knows, and any other command works too.
`envmux config prompt` with no agent just prints them, so you can paste them
anywhere. Prefer to start from a template? `envmux config generate` writes a
commented one.

Configuration lives in a committed `.envmux.toml`, whole-file overridable by an
uncommitted `.envmux.local.toml`.

Open the desktop app for the same thing in a window, or run the portal in a
browser:

```console
$ envmux daemon --http-bind 127.0.0.1:7700   # then open http://127.0.0.1:7700
```

The portal is **off unless you pass `--http-bind`, and unauthenticated when
on** — anything that can reach that port controls the daemon. It refuses a
non-loopback bind unless you also pass `--http-allow-public`.

## Building from source

```console
$ git clone https://github.com/strigops-io/envmux
$ cd envmux
$ cargo build --workspace
$ cargo test --workspace
$ npm --prefix ui ci && npm --prefix ui run build     # the portal
```

Requires a Rust toolchain matching `rust-toolchain.toml`, Node.js for the
portal, and Docker for the integration tests.

On **Windows**, `scripts/install.ps1` does all of that and installs per-user
into `%LOCALAPPDATA%\Programs\envmux`:

```powershell
.\scripts\install.ps1              # build, install, and build the default image
.\scripts\install.ps1 -Update      # pull, rebuild, reinstall
.\scripts\install.ps1 -Uninstall   # remove files and the PATH entry
```

It also builds `images/default.Dockerfile` under the tag a generated
`.envmux.toml` declares — `ghcr.io/strigops-io/envmux-default:0.1.0`. The
daemon pulls a reference only when nothing local carries that tag, so a
project in an adjacent directory starts against the image already on the
machine instead of a registry. Pass `-SkipImage` to leave it out, or build it
on its own with plain Docker:

```powershell
.\scripts\build-default-image.ps1          # skipped when already present
.\scripts\build-default-image.ps1 -Force   # rebuild after editing the image
```

```console
$ ./scripts/build-default-image.sh         # the same, on macOS and Linux
```

<details>
<summary>If linking fails with <code>LNK1104: cannot open file 'msvcrt.lib'</code></summary>

A machine can carry several Visual Studio installs, and rustc picks one
itself. If it picks an installation carrying only the onecore libraries, every
C-compiling dependency fails to link with that error — which reads like "MSVC
is not installed" when it means "the wrong MSVC was chosen".

`scripts/install.ps1` detects this: it enumerates installs with `vswhere`,
skips any without `lib\x64\msvcrt.lib`, and imports the survivor's
environment. To do it by hand, run `vcvars64.bat` from an install that has the
x64 CRT before building. `.cargo/config.toml` has the details.
</details>

### Platform notes

Mirror and shadow repositories live in the daemon state dir on the host
filesystem and are bind-mounted into containers (host git must reach them
directly; named-volume internals are not host-accessible under Docker
Desktop). Workspace *source* stays in named volumes — never bind-mounted.
Service admin ports are published on loopback so the daemon's admin
connections work on Docker Desktop; workspaces publish nothing.

## Documentation

Everything lives in [`docs/`](docs/pages/index.md):

**Using it** — [Getting started](docs/pages/getting-started.md) ·
[Configuration](docs/pages/configuration.md) · [CLI reference](docs/pages/cli.md) ·
[Desktop and portal](docs/pages/desktop-and-portal.md) ·
[Troubleshooting](docs/pages/troubleshooting.md)

**Working on it** — [Development](docs/pages/development.md) ·
[Deployment](docs/pages/deployment.md) · [Images](docs/pages/images.md)

**Design** — [CONCEPT.md](docs/pages/CONCEPT.md) (what and why) ·
[SOLUTION_DESIGN.md](docs/pages/SOLUTION_DESIGN.md) (how) ·
[BETA_RELEASE.md](docs/pages/BETA_RELEASE.md) (supported surface and gates) ·
[TODO.md](docs/pages/TODO.md) (what is proven, what is known-broken)

## Status

Beta-candidate. It runs, and the core loop — namespaces, workspaces, services,
slices, secrets, tasks, capture, reap, the portal — is verified end to end on
Windows. Several things are known-incomplete and written down honestly in
[docs/TODO.md](docs/pages/TODO.md); read it before relying on anything.

## Workspace layout

| Crate | Role |
|---|---|
| `envmux-core` | domain newtypes, lifecycle state machine, label schema |
| `envmux-config` | `.envmux.toml` model, validation, hashing, drift detection |
| `envmux-docker` | typed bollard layer: labelled creates, filtered lists, exec, archives |
| `envmux-git` | mirror, clone-with-alternates, capture (torn detection), observation, shadow maintenance |
| `envmux-tmux` | tmux control-mode client over Docker exec |
| `envmux-services` | Postgres/MinIO/Redis slice provisioning |
| `envmux-secrets` | helper chain: platform keyring → file fallback → external helpers |
| `envmux-ca` | local CA, cert issue/rotation, denylist mTLS verifier |
| `envmux-api-types` | wire DTOs (JSON Schema via schemars for UI codegen) |
| `envmux-daemon` | the worker library: SQLite state, workers, reconciliation, IPC + mTLS API |
| `envmux-cli` | `envmux` — the one binary: CLI and daemon |
| `envmux-proxy` | the orchestrator: structured-URL ingress, one per namespace |
| `ui/` | the portal: Vite/React/TypeScript, types generated from `envmux-api-types` |
| `desktop/` | the Tauri desktop app (its own cargo workspace) |
