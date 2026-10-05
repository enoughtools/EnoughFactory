# Getting started

From nothing to a running session.

## Before you begin

envmux drives a local container engine and the host's git. You need:

- **Docker** — Docker Desktop on Windows and macOS (Linux containers), Docker
  Engine on Linux. Version 25 or newer, **running**.
- **git 2.40 or newer** on the host. envmux refuses to start below this; the
  mirror and alternates behaviour it relies on needs it.
- The **Docker CLI** as well as the engine, *only* if you declare
  `[image] dockerfile`. Pulling an image by reference does not need it.

## Install

Download the archive for your platform from the
[latest release](https://github.com/strigops-io/envmux/releases/latest) and
unpack it — the one `envmux` binary is the CLI, the daemon, and the TUI. Or
build from source — see [development.md](development.md).

Verify:

```console
$ envmux --version
$ docker version --format '{{.Server.Version}}'
```

Everything works from wherever the archive was unpacked; `envmux install`
copies it somewhere permanent once you decide to keep it.

Working from a clone rather than a release? The default image
(`ghcr.io/strigops-io/envmux-default:0.1.0`) is what a generated config points
at, and it is not published yet. Build it once, with plain Docker, and every
project on the machine that references it starts without a pull:

```console
$ ./scripts/build-default-image.sh     # .\scripts\build-default-image.ps1 on Windows
```

`scripts/install.ps1` does this for you. See [images.md](images.md).

## Run it

```console
$ cd your-project
$ envmux
```

That is the whole workflow. The UI is on screen immediately; everything below
happens behind it, reported as it goes.

In a directory with no `.envmux.toml`, the first screen is **setup**. envmux
reads the repository — `package.json` and its lockfile, `compose.yaml`, a
`Dockerfile`, `.env` — and offers a starting point that fits it, with the
detected one pre-selected and the file it would write shown in full beside the
list. Choose one and press enter (`envmux session --yes` takes the
recommendation without asking) and it writes a config, a `.envmux/` folder for
its state, and a `.gitignore` entry (plus a `.envmux/.gitignore` containing
`*`, belt and braces) so none of it ever reaches a commit.

Then it starts the session, and the **dispatch** view narrates it as a
four-step checklist: it forks a small daemon owned by this folder — state in
`.envmux/state`, so every project gets its own daemon and IPC endpoint —
registers a **namespace** from the repository, clones a bare **mirror** of
your remote, initialises the **shadow origin**, pulls or builds the image,
starts declared services, and makes sure one **workspace** exists. The
namespace step is the slow one on a first run, because that is where the image
is pulled or built.

Redirect the output and you get `--help` instead — a script never receives a
full-screen UI by surprise.

## The session

The dispatch view answers, top to bottom, the questions in the order they get
asked: where am I, is it working, what can I open, what is it doing, what do I
type. Your workspace's tmux windows are listed on the left with tmux's own
numbers; anything it serves is on the right as a whole URL. At the bottom is
an always-focused `❯` input line.

| you type | |
|---|---|
| Enter, on an empty line | open the selected window |
| `tab` | move between windows |
| `alt-<n>` | jump straight into window *n* |
| `/open [route]` | open a routed port in your browser |
| `/window [name]` | a new ad-hoc window |
| `/new [name]` | another workspace |
| `/manage` | the management dashboard |
| `/help` | the commands, in one line |
| `/quit` or Ctrl-C | leave |

Attaching hands the terminal over to tmux entirely and takes it back when you
detach. The [TUI page](tui.md) covers all three views in full; `envmux manage`
opens the dashboard directly.

## Everything dies with it

The daemon is not a service. Every in-flight request and every open attach
counts as a client, and once the last client has been gone for the grace
period — 60 seconds by default, `--grace-secs` to change it — the daemon reaps
its workspaces (final capture first), stops the namespace's base and service
containers, and exits. Closing your terminal *is* the shutdown command; it
just takes the grace period to land, so restarting the TUI or joining with
`envmux manage` from a second terminal reattaches to a world still running.
`envmux down` is the impatient form: it does the same teardown now.

What survives is on disk in `.envmux/` — the state, the mirror, the shadow
history — and the stopped base and service containers, which the next session
adopts by name. Delete the folder and nothing of envmux is left behind.

## Reach it from a browser

Declare named ports and the in-session router serves them on loopback:

```toml
[routes]
vite = 5173
```

Every workspace gets `http://{namespace}_{workspace}_{route}.{domain}:8080` —
`e2e_wobbly-otter_vite.localhost:8080`, say. The domain defaults to
`localhost` (`strigops.xyz` on Windows, where `*.localhost` resolution is
unreliable even in browsers); `[routing]` overrides domain, delimiter, and the
router's port. The router lives inside the daemon, proxies only to ports
Docker published for envmux's own containers, and dies with the session like
everything else. The TUI's detail pane shows each workspace's live URLs.

## Push with your own credentials

Workspace containers carry a small `envmux-agent` binary (shipped beside the
`envmux` executable) installed as the container's git credential helper. When
git in a workspace needs to authenticate, the request travels over the
container's exec stream to the daemon, which asks the **host's** credential
manager — GCM on Windows, osxkeychain, libsecret — and passes the answer
back. Nothing is stored in the container, only `get` is answered, and only
for hosts that match the repository's remote; anything else is refused and
logged as an event. No agent binary, no shim — workspaces degrade to
whatever the image would have done anyway.

## Declare the environment properly

The starter config is enough to attach a shell, and enough for the agent CLIs
in the image to be usable: it declares the workspace account (`user`, non-root)
and `sync` volumes for Claude Code, Codex, and OpenCode. Those volumes are
shared by every workspace in the namespace, so you sign an agent in once, in
whichever workspace you happen to be in, and every workspace created afterwards
starts signed in — `terminal = "claude"` then lands in a session that is
already yours. Nothing is copied off your machine; the first sign-in happens
inside a workspace, and credentials are shared namespace-wide, so give work
that must not see them its own namespace.

What the starter cannot know is your project. Tasks, services, and routes are
left as commented examples, and `.envmux.toml` is meant to be generated — a
tool that reads your repository infers them better than a template does:

```console
$ envmux config prompt --agent claude
```

`--list-agents` shows the names envmux knows; any other command works too, and
`envmux config prompt` with no agent prints the instructions for pasting
anywhere.

Check it parses before going further:

```console
$ envmux config show
```

Errors point at the offending key.

## Understand the death date

While the daemon runs, every workspace is stamped with a death date at
creation, seven days out by default. Attaching a read-write shell extends the
lease by 24 hours from that moment. **Nothing else extends it** — not a
running dev server, not a busy agent, not git activity. Activity is not
attachment, and inferring liveness is exactly the ambiguity this model
removes.

```console
$ envmux lease wobbly-otter --extend 24h
$ envmux lease wobbly-otter --pin          # no death date until unpinned
```

When the reaper takes a workspace — and when the session's own shutdown does —
it runs a final **capture** into the shadow origin first, so uncommitted work
survives even though the container does not. In-flight process state is *not*
saved; if an agent is mid-task, extend the lease from whatever launched it,
and keep a client attached so the daemon's grace timer never starts.

```console
$ envmux snapshots wobbly-otter
```

A fresh workspace can start from any snapshot in that list, including the
final capture of a workspace that is long gone.

## What to read next

- [tui.md](tui.md) — both views, every key
- [configuration.md](configuration.md) — every section of `.envmux.toml`
- [cli.md](cli.md) — the full command surface
- [troubleshooting.md](troubleshooting.md) — when something does not work
- [CONCEPT.md](CONCEPT.md) — why it is built this way
