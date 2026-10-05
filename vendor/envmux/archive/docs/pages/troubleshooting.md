# Troubleshooting

Failures that have actually happened, and what they mean.

## The daemon will not start

### `host git 2.39.5 is older than required 2.40`

envmux needs git 2.40+ on the host. Debian Bookworm ships 2.39, so a container
image based on it cannot run the daemon — this is why the development images
moved to Trixie.

### `Docker daemon is not reachable over the local socket`

Docker Desktop is not running, or is in Windows-container mode. envmux needs
Linux containers.

### `memory allocation of N bytes failed` on startup

Seen once, on a state directory left behind by a **killed** daemon; a fresh
state directory started cleanly. Not root-caused — a corrupt WAL is the leading
suspect. If it happens, move `.envmux/state` aside and let the daemon rebuild
it. You lose the intent database, not your shadow history if you keep the
`namespaces/` directory.

### `IPC server failed: Access is denied`

Another daemon already holds this project's pipe. Each state directory gets
its own endpoint — on Windows the pipe name carries a digest of the state
directory — so the holder is almost always a stale daemon for this same
project. Find it:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'envmux.exe'" |
  Where-Object { $_.CommandLine -match 'daemon' }
```

## The daemon stopped on its own

By design, and not a failure. The daemon is ephemeral: every in-flight request
and every open attach counts as a client, and once the last client has been
gone for the grace period (60 seconds; `--grace-secs`), it reaps its
workspaces — final capture first — stops the namespace's base and service
containers, and exits. Closing your last terminal is the shutdown command; it
just takes the grace period to land. Run `envmux` again and the next session
adopts the stopped containers by name.

If the grace period is too short for your workflow — a TUI you restart slowly,
a long gap between CLI commands — start the daemon with a larger
`--grace-secs`, or keep something attached.

## The CLI cannot talk to the daemon

### `unauthorized: the daemon rejected this client's credential`

The CLI reads its IPC credential from the state directory. If `ENVMUX_STATE_DIR`
differs between the CLI and the daemon, they are looking at different files.
Make them match.

### Exit code 4

Documented as "daemon unreachable". Other exit codes: 0 ok, 1 error, 2 usage,
3 not found.

The message names the directory it looked in:

```
error: no daemon for this project (run `envmux` to start a session)
  looked in: /home/you/project/.envmux/state
```

Every project has its own daemon, so this usually means exactly what it says —
no session has started here yet, or the last one's grace period elapsed. Run
`envmux` in the project. If the directory shown is *not* the project's
`.envmux/state`, an `ENVMUX_STATE_DIR` override is pointing the CLI somewhere
else, or you are running outside the project entirely.

### "My workspaces disappeared"

Two different answers now. If the daemon is gone too: the session ended and
its grace shutdown reaped them — that is the model, and the final captures are
in `envmux snapshots`, ready to revive from. If the daemon is running but the
list is empty: the CLI is addressing a different state directory — check the
`state:` line from `envmux config show` against the daemon's startup log, and
whether `ENVMUX_STATE_DIR` is set.

## Images

### `manifest unknown` / `denied` pulling `ghcr.io/strigops-io/envmux-default:0.1.0`

The tag a generated `.envmux.toml` declares is not published yet, and the
daemon only pulls a reference when nothing local carries that tag. Build it
once from a clone and every project referencing it starts offline:

```console
$ ./scripts/build-default-image.sh     # .\scripts\build-default-image.ps1 on Windows
```

`scripts/install.ps1` already does this. See [images.md](images.md).

### `pull access denied` for an image you built locally

A local-only tag has no registry behind it. This bites hardest inside a nested
Docker daemon (the self-host demo), which starts with an empty image store and
cannot see the host's images. Either publish the image or build it inside.

### `LNK1104: cannot open file 'msvcrt.lib'` when building

A machine with several Visual Studio installs, where rustc picked one carrying
only the onecore libraries. It reads like "MSVC is not installed"; it means "the
wrong MSVC was chosen". `scripts/install.ps1` detects and skips incomplete
toolsets. By hand, run `vcvars64.bat` from an install that has
`lib\x64\msvcrt.lib` first.

### `docker: not found` inside a workspace, while `dockerd` runs

Debian Trixie's `docker.io` package only *recommends* `docker-cli`, so
`--no-install-recommends` installs the daemon without the client. The images
install `docker-cli` explicitly and assert every advertised command resolves at
build time.

### `error writing a body to connection: The parameter is incorrect (os error 87)`

Historic. envmux used to pack build contexts itself and shipped the whole
directory because it never implemented `.dockerignore` — ~15 GB on a repository
with a `target/` tree, which is slow everywhere and fatal over a Windows named
pipe. Builds now shell out to `docker build`. If you see this on an older build,
add a `.dockerignore`.

## Routing

### Routed URLs do not resolve

They will not: `[routes]` and `[routing]` parse but nothing serves them right
now. The v1 orchestrator is gone, and its replacement — an in-session router —
is planned; see [V2_PLAN.md](V2_PLAN.md). Until it lands, reach a workspace
port with `envmux attach` and the tools inside, or `envmux run`.

## Workspaces

### A workspace was reaped while an agent was working

By design. Leases do not know about running work — a running dev server, a busy
agent, and git activity all count for nothing. Only a brokered read-write attach
extends the lease. Have whatever launches the agent extend it:

```console
$ envmux lease <workspace> --extend 24h
```

And keep a client attached: an agent left alone in a session nobody is
connected to is also racing the daemon's grace timer. The final capture means
uncommitted files survive either way; in-flight process state does not.

### Snapshots are flagged `torn`

A capture read a tree an agent was writing to. envmux detects this rather than
pretending otherwise: it records the file list before and after staging, retries
once, and flags the snapshot if the tree is still moving. A torn snapshot of
recent work beats a clean snapshot of older work — the flag exists so nobody
confuses one for the other.

### `envmux ls` shows stale information

Observation is a snapshot, not a feed. Everything shown is up to one interval
old, and its age is always displayed. Lower `[observe] interval` if it matters,
bearing in mind that git inspection across a dozen workspaces on a large
monorepo is real work.

## Getting more detail

```console
$ envmux daemon --state-dir .envmux/state    # run in the foreground, logs on stderr
$ RUST_LOG=debug envmux daemon --state-dir .envmux/state
```

The daemon also writes a rotating JSON log under `logs/` in the state
directory — `.envmux/state/logs/` in a project. The TUI's telemetry pane shows
the same event stream live.
