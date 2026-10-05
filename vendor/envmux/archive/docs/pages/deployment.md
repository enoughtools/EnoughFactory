# Deployment

Getting envmux to other people, and where its state actually lives.

## Cutting a release

Releases are built from a tag by
[`.github/workflows/release.yml`](https://github.com/strigops-io/envmux/blob/main/.github/workflows/release.yml),
natively on each platform, and attached to a **draft** GitHub Release.

```console
$ git tag v0.2.0
$ git push origin v0.2.0
```

Produces one archive per platform:

| Platform | Artifacts |
|---|---|
| Windows | `envmux-x86_64-pc-windows-msvc.zip` |
| macOS | `envmux-*-apple-darwin.tar.gz`, separately for Apple silicon and Intel |
| Linux | `envmux-x86_64-unknown-linux-gnu.tar.gz` |

Each archive contains the `envmux` binary — the CLI, the daemon, and the TUI
in one executable — plus the README and licence. There are no installers:
unpack it, run it, and `envmux install` copies it somewhere permanent when you
decide to keep it.

`workflow_dispatch` builds everything without publishing, for a dry run.

### Before publishing the draft

The gates in [BETA_RELEASE.md](BETA_RELEASE.md) must pass for that commit.
Beyond them:

- **Sign the artifacts.** These builds are unsigned today, which means Windows
  SmartScreen warns and macOS needs `xattr -d com.apple.quarantine envmux`
  once. The README says so plainly; that is a stopgap, not a position.
- **Exercise each archive on its native OS.** A build that compiles is not a
  build that runs.
- **Publish the development container images** and record their immutable
  digests — see below.

### No auto-updater

Deliberate. A self-updating binary commits you to an update endpoint, signing
keys, and a rollback story. Until those exist, an updater that half-works is
worse than none. Upgrading means downloading a newer archive, and the release
notes say so.

## Container images

One kind now: the **development images** (`images/*.Dockerfile`, documented in
[images.md](images.md)) that back workspaces. They are opinionated defaults,
not a requirement — any image with tmux ≥ 3.2 works.

They assert their own substrate at build time: git ≥ 2.40 and tmux ≥ 3.2,
because envmux refuses to run below those, and every advertised command
resolves. Both guarantees exist because both were shipped broken once.

## There is no daemon service

v1 had a machine-wide daemon worth wrapping in systemd. v2 does not: the
daemon is per-project and ephemeral. `envmux` forks and disowns one for the
folder it runs in, and the daemon supervises itself — every in-flight request
and open attach counts as a client, and after `--grace-secs` (default 60) with
none, it reaps its workspaces (final capture first), stops the namespace's
base and service containers, and exits. Closing the last envmux instance *is*
the shutdown command, so there is nothing for a service manager to keep alive
— keeping it alive would defeat the design.

For debugging, run it in the foreground:

```console
$ envmux daemon --state-dir .envmux/state
$ envmux daemon --state-dir .envmux/state --grace-secs 3600   # a patient one
```

## The API surface

Local IPC only — a Unix socket inside the state directory, or on Windows a
named pipe whose name carries a digest of the state directory, guarded by
filesystem/pipe ACLs plus a capability token. Nothing listens on a network
port, so there is nothing to expose, firewall, or authenticate beyond the
machine boundary. Remote operation is not part of the surface.

## State and backup

Inside a project, everything lives in the project's own `.envmux/state` —
which is what gives every folder its own daemon and IPC endpoint, and means
deleting the folder leaves nothing of envmux behind. Resolution order:

1. `$ENVMUX_STATE_DIR`, because being explicit should beat any heuristic.
2. The project's `.envmux/state`, when the working directory is inside a
   repository or an onboarded directory.
3. Outside any project — which mostly means `envmux install` from a download
   directory — the machine-wide resolution: a `state` directory beside the
   executable (**portable mode**), then the platform data directory
   (`%LOCALAPPDATA%\envmux` or `~/.local/share/envmux`).

The daemon logs which one it chose and why, and `envmux config show` prints it:

```console
$ envmux config show
active: /home/you/project/.envmux.toml
hash:   085a8cdd…
state:  /home/you/project/.envmux/state
```

Worth checking when something is missing: a CLI resolving a different state
directory than the daemon looks exactly like a workspace that vanished.

The state directory holds:

```
envmux.db                 intent: what should exist
ipc.token                 the local IPC credential
namespaces/<ns>/mirror    the bare mirror of the project remote
namespaces/<ns>/shadow    the shadow origin — work in progress
logs/                     rotating daemon logs
```

**The shadow origin is the thing to back up.** It is local and stays local, by
design — nothing envmux captures leaves the machine. That is also the risk: a
branch worked on but never pushed exists in exactly one place, and disk failure
or an over-aggressive retention setting loses it. The mirror can be re-cloned;
the database can be rebuilt by reconciliation; shadow history cannot be
recovered from anywhere. It lives inside `.envmux/`, which is gitignored — so
a repository backup does not cover it unless you back up the working tree.
