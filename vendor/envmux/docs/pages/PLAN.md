# envmux — the daemonless plan

**Date:** 2026-08-15 · **Status:** both phases done; kept for the reasoning ·
**Supersedes** everything in
[`archive/`](https://github.com/envmux/envmux/tree/main/archive).

> **Superseded in part, 2026-08-21.** Everything below about *how a session is
> contained and reached* — Docker, a bind-mounted worktree, a claimed port, the
> reverse proxy, the relay, hostname routing — was replaced by an IncusOS host
> and an address per instance. The reason is in [Routing](routing.md) and the
> machine is in [Host](host.md); the specification that drove it is
> [`incus.md`](https://github.com/envmux/envmux/blob/main/incus.md).
>
> The principles below survived the change, and two of them are why it happened:
> "every dependency pays rent" retired a reverse proxy and a second project, and
> "the process is the system" is more true than it was, since there is now
> nothing on this workstation between envmux and the machine it talks to.
>
> What did not survive is principle 3 as written. Git still solves isolation and
> a session is still a branch, but a worktree cannot be bind-mounted across a
> machine boundary, so the repository travels as a bundle and the commits come
> back as one. See [Configuration](configuration.md#the-repository-travels-it-is-not-mounted).

## The one-paragraph version

`envmux` is one console process. You run it in a project directory; it makes a
**branch**, creates one container on an IncusOS host with an address of its own,
clones the repository into it, and starts what you declared. Every port that
container listens on is reached at that address, directly, with nothing in
between. A tabbed window shows you the URLs, the log, and a terminal per task and
per shell. Commits come back into your real repository when the session ends.
When the process exits the instance is stopped and nothing of envmux is left
running on this machine. There is no daemon, no state directory, no database, and
nothing to reconcile.

## The two phases

| Phase | Done when | |
|---|---|---|
| **POC** | A session creates a worktree, you work in it inside a container, and it commits back cleanly on exit. | **done** — as a bundle rather than a worktree, see the note above. Observed: a commit made inside an instance came back as `1 commit(s) fetched onto envmux/bounce`, and the file on the host had the line in it. |
| **MVP** | AI coding tools work out of the box — a session arrives already logged in. | **done** — Claude Code is in the golden image and the account's own state is carried in. Observed: `claude --version` answers inside a session with `~/.claude/.credentials.json` present. |

Everything else is sequenced around those two sentences.

## Principles

1. **The process is the system.** All state is in memory. The durable artifacts
   are the `.envmux.json` you can read and the git repository you already had.
2. **The port claim is a held socket.** Not a lockfile, not a registry, not a
   daemon handing out leases. Binding succeeds or it doesn't; if it doesn't,
   take the next port. Process death releases the socket, so there is no
   stale-claim case to handle.
3. **Git already solved isolation.** Concurrent sessions are concurrent
   branches off one repository. No mirror, no shadow origin, no capture loop.
   They were concurrent *worktrees* until a machine boundary made that
   impossible; the repository now travels as a bundle and the commits come back
   as one, which keeps the property that mattered — your work is in the
   repository you started from.
4. **An address per environment.** Not a port per environment. Every mechanism
   that used to sit between a browser and a dev server existed to undo the
   flattening of every environment onto one host port space, and there is no
   flattening left to undo.
5. **Every dependency pays rent.** The BCL, and nothing else. The window is
   escape sequences written to stdout; a UI toolkit could not make rent, and
   neither could the reverse proxy once there was nothing to proxy.
6. **Ship the thing that launches.** Anything not on the path to the two
   sentences above is deferred by default.

## Architecture

```
envmux  (host, foreground, one process)
 ├─ config      .envmux.json, or defaults inferred from the directory
 ├─ worktree    git worktree add .envmux/worktrees/<session> -b envmux/<session>
 │                then point its .git file at the container's mount path
 ├─ port claim  Kestrel binds 127.0.0.1:<preferred>, walking upward on failure.
 │                the listener it holds IS the claim
 ├─ container   docker run -d --rm  --label dev.envmux.*
 │                -v <worktree>:/work
 │                -v <repo>/.git:/repo/.git          ← shared object store
 │                -v ~/.claude:/home/user/.claude    ← MVP: agent tool state
 │                -p 127.0.0.1:0:<each routed port>  <image>
 ├─ router      YARP on the claimed port. Host header → route → published port
 └─ ui          escape sequences on stdout: two layouts, a command line, a transcript
      exit ──►  docker kill; --rm removes it; git worktree repair; port released
```

### The worktree, which is the interesting part

A session is a git worktree. `envmux` creates one on the host, bind-mounts *it*
rather than the project directory, and the container works in it.

This is what makes several sessions in one directory sane. Four agents on four
branches get four working trees, four containers, and four sets of URLs, sharing
one object store — which is precisely what `git worktree` is for. The archived
design built a bare mirror, cloned into per-workspace volumes with git
alternates, and maintained a shadow origin to get work back out. All three were
reimplementing worktrees, badly, and none of them survive here.

**The sharp edge.** A worktree's `.git` is a *file* holding an absolute path to
`<repo>/.git/worktrees/<name>`. That path is a host path, and it does not exist
inside the container. Two mounts and one rewrite fix it:

| Host | Container |
|---|---|
| `<repo>/.envmux/worktrees/<session>` | `/work` |
| `<repo>/.git` | `/repo/.git` |

and the worktree's `.git` file is rewritten to `gitdir: /repo/.git/worktrees/<session>`.
`commondir` inside that directory is already relative (`../..`), so it resolves
correctly from the container side with nothing else touched.

**Verified on 2026-08-15**, against a real container, before anything was built
on it:

- `git status`, `add`, `commit`, and branch resolution all work inside the
  container — `rev-parse --git-dir` reports `/repo/.git/worktrees/<session>`.
- A commit made inside the container is visible from the **host** repository
  immediately: `git log envmux/<session>` shows it. There is no sync step,
  because there is only one object store.
- Host git *inside the worktree directory* fails while the session holds it
  (`fatal: not a git repository`) — the `.git` file is pointing at container
  paths.
- `git worktree repair` restores it, and `git worktree list` is correct
  afterwards.

So "commits back cleanly" is a property of the shared object store, not of the
teardown: the work is already on the host before the session ends. The repair
only restores host-side git *inside the worktree*, it runs on exit, and it runs
again on the next session start — which makes a SIGKILLed envmux self-healing
rather than a support ticket.

The container also needs `safe.directory` for `/work` and `/repo/.git`, because
the files are owned by the host user and the container is somebody else. That
was hard-won in the archive and it is hard-won here for the same reason.

### Session identity

One name per session, used for everything: the worktree directory, the branch,
the routed hostname, and the container name.

```console
$ envmux                  # generated name, e.g. amber-fox
$ envmux feat-login       # named, when the session is a task
```

Which gives `.envmux/worktrees/feat-login`, branch `envmux/feat-login`, container
`envmux-myproj-feat-login`, and hostnames under `myproj-feat-login-*`. One
identity, so nothing has to be correlated by hand across four running sessions.

### The container user

A container that writes to a bind-mounted worktree as root leaves root-owned
files in your repository. So envmux does not run one.

The container starts as root, keeps `sleep infinity` as PID 1, and is
**bootstrapped once** at session start: envmux execs a script as root that
creates a user named after the host user, with the host's uid and gid where the
host has meaningful ones.

| Variable | Value |
|---|---|
| `ENVMUX_HOST_USER` | The host username. Always set. |
| `ENVMUX_HOST_UID` | The host uid. Empty on Windows. |
| `ENVMUX_HOST_GID` | The host gid. Empty on Windows. |

Where no uid is supplied — Windows, where Docker Desktop does not map ownership
meaningfully anyway — the user is created at **uid 10001**, deliberately
unusual so it cannot silently collide with a uid the image already uses for
something else. Every interactive command afterwards runs `docker exec -u <that
user>`, so nothing envmux hands you is root.

Bootstrapping at runtime rather than shipping an image with the user baked in is
what lets envmux work against *any* image, including
`mcr.microsoft.com/devcontainers/base:ubuntu`. Publishing an image is a
registry, a build pipeline, and a release cadence; the archive paid for those and
never finished.

### Restart is deliberate drift

`r` re-reads `.envmux.json` **from disk as it is right now**, recreates the
container from it, and reroutes. It does not touch git: the worktree stays on
whatever branch it is currently on, including a branch switched inside the
container.

This means a running session can stop matching the config it started from. That
is the point — editing the declaration and pressing `r` is how you iterate on it,
and a session that could only ever be what it was born as would make every config
change a restart of the whole tool. It is the one place drift enters a design
that otherwise has none, and it is deliberate.

### Talking to Docker

By shelling out to the `docker` CLI, not through the engine API. The API would
mean handling a Windows named pipe and a Unix socket as two transports, or taking
a dependency that does. The CLI is one code path everywhere, is already installed
on any machine that has Docker, and returns `--format '{{json .}}'` for
everything we need. The cost is a process spawn per operation, which is invisible
against the cost of starting a container.

**With exactly one exception**, and it is forced. A shell in a tab needs a pty,
and the only pty on offer is the one the engine allocates for an exec created
with `Tty` set — which the CLI will only ask for when *its own* stdin is already
a terminal. envmux's stdin is a TUI, so the CLI refuses, and the request has to
go to the engine directly. That is four endpoints in `Docker/DockerApi.cs`
written by hand, over the named pipe or the socket, and nothing else has moved:
the CLI still knows about contexts, credential helpers and remote engines, and
a second Docker client is not something worth keeping correct.

### Routing

The router is **YARP** on Kestrel, hosted in the same process as the TUI.

Host-based matching, WebSocket and HTTP/2 upgrades, `X-Forwarded-*` handling,
connection pooling and header forwarding are configuration rather than code, and
`InMemoryConfigProvider` fits the problem exactly: routes are known when the
session starts and change only when the container is recreated. A route becomes a
match on `Hosts = ["myproj-feat-login-vite.localhost"]` and a cluster with one
destination at the loopback port Docker published.

The alternative considered was a hand-rolled `TcpListener` that peeks the header
block and splices bytes both ways. It is small, and it gets WebSockets free by
never understanding the bytes — but it also gets HTTP/1.1 keep-alive, chunked
trailers, and half-close wrong in ways that surface as a dev server that *mostly*
works. YARP is a few megabytes to be correct, and correctness in the proxy is the
difference between "envmux launched something" and "hot reload works".

**Kestrel's bind is the claim.** Not a probe followed by a hand-off — probing a
port and then asking someone else to bind it leaves a window for another process
to take it in between. Kestrel is asked for the preferred port; if the bind
throws, it is asked for the next one.

**Hostname shape.** `{project}-{session}-{route}.{domain}` — e.g.
`myproj-feat-login-vite.localhost:8080`. The session label is what keeps four
concurrent sessions distinguishable in browser history and open tabs; they would
otherwise differ only by port number. The delimiter is `-` because underscores
are not legal in DNS hostnames and browsers only tolerate them by accident.

**The domain.** `*.localhost` resolves to loopback with no setup on macOS and
most Linux, and unreliably on Windows even inside browsers. The default is
therefore platform-conditional: `localhost` everywhere except Windows, where it
is `strigops.xyz`, a public wildcard pointing at `127.0.0.1` (verified resolving
2026-08-15). Overridden by `domain` for anyone with their own resolver.

**The index page.** A request whose `Host` matches nothing — including a plain
`http://127.0.0.1:8080` — falls through to a terminal middleware that lists this
session's routes as links. The port is useful before you have learned the scheme.

### Concurrency

Four concurrent sessions per directory is the design target — "many" in practice
means about four, not forty.

Nothing coordinates them. Each takes the next free port, its own worktree, its
own branch, its own container, and its own hostnames. The only shared things are
the git object store, which is built for concurrent worktrees, and the host tool
state directories under MVP, which are not — see the sharp edges below.

### Agent tools (MVP)

The MVP bar is that a session arrives already able to run your coding agent. That
means detecting host tool state and mounting it into the container user's home:

| Tool | Host state |
|---|---|
| Claude Code | `~/.claude`, `~/.claude.json` |
| Codex | `~/.codex` |
| Gemini CLI | `~/.gemini` |
| opencode | `~/.config/opencode` |
| GitHub CLI | `~/.config/gh` |

Detected at first run and written into `tools` in the config, so the decision is
visible and editable rather than magic. Claude Code keeps `.claude.json` beside
`$HOME` rather than inside `~/.claude`, so `CLAUDE_CONFIG_DIR` is set to cover
all of its state — a detail the archive paid to learn.

### Configuration

`.envmux.json`, committed, in the project root. Comments and trailing commas
accepted, so it takes review notes.

```jsonc
{
  "name": "myproj",            // default: the directory name, slugified
  "image": "…",                // default: a public devcontainer base
  "workdir": "/work",
  "shell": "/bin/bash",
  "env": { "NODE_ENV": "development" },
  "routes": { "vite": 5173, "api": 3000 },

  "tasks": {                   // everything that runs inside the container
    "install": { "command": "npm ci", "kind": "once" },
    "vite": { "command": "npm run dev", "dependsOn": "install" }
  },

  "port": 8080,                // preferred router port; taken → next one up
  "domain": "localhost",

  "git": {
    "branchPrefix": "envmux/", // branch = envmux/<session>
    "base": "HEAD",            // what the worktree branches from
    "keepOnExit": true         // leave the worktree; false removes it when clean
  },

  "tools": {                   // MVP; written by first-run detection
    "claude": "auto",
    "gh": "auto"
  }
}
```

Every field is optional, and so is the file.

## What is out of scope

Named here so it is a decision rather than an omission.

| Deferred | Why it is safe to defer |
|---|---|
| ~~**Databases and caches**~~ | ✅ Landed as [services](services.md) — but deliberately *not* the archive's model. These are one session's containers on one session's network, with credentials generated per session. Not a namespace-wide Postgres with per-workspace slices minted into it, which is what cost the archive most of its complexity. |
| **TLS and the local CA** | Plain HTTP on loopback. Certificate minting and platform trust-store installation is a subsystem in service of a padlock on `127.0.0.1`. |
| **More than one port per session** | Hostname routing is exactly the mechanism that makes a second port unnecessary. |
| ~~**A task graph**~~ | ✅ Landed as [tasks](tasks.md). A real project asked, which was the condition. `dependsOn` spans tasks *and* services, readiness is a port probe run from inside the container, and restart policies are per task. It replaced `setup` outright rather than sitting beside it. |
| ~~**A portal**~~ | ✅ Landed as [the portal](portal.md), and not the archive's. That one was a Vite app in front of a resident daemon, with its own transport, its own state, its own auth and its own release; this one is endpoints on the router that is already running, drawn from the same `Session` the window is drawn from, served on the port that is already claimed, out of a zip inside the executable. It has no state, nothing to start, and nothing to release. The page is React and xterm.js because a terminal in a browser is not a thing to write by hand — the archive's mistake was the daemon under it, not the JavaScript on top. |
| **Leases, death dates, reaping** | Lifetime is process lifetime. |
| **Shadow origin and scheduled capture** | The worktree commits into the real object store. There is nothing to rescue. |
| **Windows containers** | Linux containers on all hosts. |

## Milestones

### POC — a worktree that commits back cleanly on exit ✅

**P1 — Config and claim.** ✅ Config model with every field optional and the file
itself optional, directory-name slugging, the hostname scheme, the port walk. All
pure — no sockets, no clock, no subprocess — and unit tested. `--dry-run` reports
the session it would start without an engine running.

**P2 — Worktree lifecycle.** ✅ `git worktree add` under `.envmux/worktrees/`,
branch naming from the session name, the `.git` rewrite to container paths,
`git worktree repair` on exit and on next start, and a report of what the session
produced. Tested against a real repository, including the killed-session path.

**P3 — Launch.** ✅ `DockerCli` over the CLI. Both mounts, the labels, the
environment, published routes read back from the engine, the runtime user
bootstrap, and teardown on exit, on Ctrl-C, and on unhandled exception.

**P4 — Commit back.** ✅ Verified live on 2026-08-15: a session serving a
container through a routed hostname, a commit made inside the container present
in the host repository *with no teardown step*, and the file it wrote owned by
the host user rather than root.

### MVP — AI tools work out of the box

**M1 — The router.** ✅ Kestrel bound to the claimed port, YARP from
`InMemoryConfigProvider`, one route and cluster per declared route, index page as
the fallback endpoint. Verified serving a container through
`{project}-{session}-{route}.{domain}`. *WebSocket hot reload is not yet verified
against a real dev server.*

**M2 — The window.** ✅ Escape sequences written to stdout by a loop, in the
ported palette and the same DOS shapes: two boxes sized to what is in them, a
transcript that follows its own tail, a command line, and a shell you hand the
whole terminal to. *Asserted as composed rows, which is what somebody would
see, and looked at on a real terminal.*

It was a Consolonia — Avalonia rendered into cells — application first, with
tabs, four layouts and a VT100 emulator so a shell tab held a pty. That version
is kept on `feat/consolonia-tui`. It worked, and it cost two upstream bugs
worked around in envmux's own code (a resized console dropping its buffer, and
a console mode never handed back) for a toolkit whose layout engine this UI
barely used. Rule 5 applies to UI frameworks too.

**M3 — Tools.** ✅ Host detection for Claude Code, Codex, Gemini, opencode and the
GitHub CLI; mounts into the container user's home; `CLAUDE_CONFIG_DIR` and
`CODEX_HOME` set; `tools` written by `envmux init`. *Detection and mounting are
verified; that an agent actually arrives signed in is not.*

**M4 — Shell and tasks.** ✅ Tasks run after the session is already usable, so a
slow `npm ci` does not hold the URLs hostage. (This shipped as a single `setup`
field and was replaced by [tasks](tasks.md), which can depend on a service, have
their output read, and be restarted one at a time.) `s` stops the UI completely,
hands the terminal to `docker exec -it`, and starts a fresh window afterwards —
two programs cannot own one console, and suspending would leave the driver
holding raw mode. *Unverified, for the same reason as M2.*

**M5 — First run and packaging.** `envmux init` ✅ detects the stack, proposes an
image, detects tools, writes a commented `.envmux.json`, and adds `.envmux/` to
`.gitignore`. `scripts/dev-install.ps1` / `.sh` ✅ pack this tree as a .NET global
tool named `devenvmux`, so it can be exercised from anywhere without a release
and without shadowing a real `envmux`. Still open: starting a session straight
from onboarding when there is no config, and a size budget in CI.

**M6 — Services and generated environment.** ✅ Declared containers on the
session's own network, with credentials generated once and injected into both
sides; Aspire's `ConnectionStrings__<name>` and `services__<name>__tcp__0`
conventions, plus `<NAME>_HOST`-style variables for everything that is not .NET;
`generate` for values with no service behind them; `dockerSocket`; and `port` as
either a number or a range. Verified live against Postgres and Redis: the
generated password reaches both containers and authenticates, and nothing is
published to the host. See [Services](services.md).

### What is verified, and what is only built

Everything above marked ✅ compiles, is covered by tests where it can be, and the
end-to-end path was driven against real git and real Docker.

The TUI is the exception, and running it turned up two things no test here would
have caught:

- **Keys did nothing except Escape.** They were bound to the focused view's own
  key event, and the routes list had focus, so nothing else ever saw a press.
  That whole class of bug went with the toolkit: there is no focus to lose a
  key to now, only a loop that reads one and decides what it means.

  What is left is testable without a terminal at all. A frame is a function of
  the session and the view state, so the layout, the transcript following its
  own tail, and the scroll holding its place are all asserted as composed rows
  — against what somebody would actually see, rather than the logic beside it.
- **Startup was a long silence.** The window only appeared after the session was
  up, so a first-run image pull was minutes of nothing. The window now goes up
  first and the session comes up behind it, with a phase, a layer count and an
  elapsed counter. Verified through the headless path, which prints the same
  phases.

Still unconfirmed at a real console: that the keys now arrive, and the shell
hand-off. Both need a human.

## Known sharp edges

- **Agent state is shared, and four sessions will fight over it.** Mounting
  `~/.claude` read-write into four concurrent containers means four processes
  writing one set of state files. Read-only breaks token refresh; copy-on-start
  diverges. MVP mounts read-write and names the risk; copy-on-start is the
  escape hatch if it bites.
- **Mounting agent state puts real credentials inside a container an agent
  controls.** That is the point of the feature and it is still worth saying out
  loud. `tools` is explicit in the config so it is a choice, not a default that
  happened to you.
- **Container writes land as the container user.** On Linux that can leave
  root-owned files in your worktree. The image should run a non-root user whose
  uid matches, and that needs an answer before MVP.
- **A crashed envmux leaves a worktree pointing at container paths.** Host git
  inside it fails until `git worktree repair` runs. envmux repairs on start, so
  the fix is "run it again", but someone will hit the confusing state first.
- **A hard-killed envmux leaves its container running.** `--rm` fires when a
  container *stops*, and nothing stops it if the process that owned it was killed
  outright rather than asked to exit. Ctrl-C, `q`, and a closed terminal are all
  handled; a task manager or `kill -9` is not. `envmux prune --all` stops them,
  and starting a session with the same name refuses rather than fighting for it.
- **`--rm` also never fires if Docker itself stops mid-session**, leaving a
  stopped container. `envmux prune` collects those.
- **A task is not a place to background something.** It runs through
  `docker exec`, and a process backgrounded inside an exec dies when the exec
  does. There is no need to: envmux holds each task open and shows its output.
  `config validate` warns about `&` and `nohup`.
- **Worktrees accumulate.** `keepOnExit` defaults to keeping them, because
  deleting someone's uncommitted work by default is unforgivable. `envmux prune`
  is the janitor: it removes stopped containers `--rm` never got to, and clears
  out worktrees on the branch prefix that no running session holds. It refuses
  to remove a worktree with uncommitted changes unless told to.

## Open questions

1. **The default image.** Publish one opinionated base or detect the stack and
   pick from public images? The archive published its own and paid for it in
   registry work that never finished. MVP takes
   `mcr.microsoft.com/devcontainers/base:ubuntu` in the meantime — which the
   user bootstrap below makes viable, since it works against any image.
2. ~~**The Windows wildcard domain.**~~ Settled: `strigops.xyz`, verified
   resolving to `127.0.0.1` on 2026-08-15.
3. ~~**Bind-mount or clone?**~~ Settled: neither — a git worktree, bind-mounted.
4. ~~**Restart semantics.**~~ Settled: from the config on disk right now. See
   [Restart](#restart-is-deliberate-drift).
5. ~~**Container keepalive.**~~ Settled: `sleep infinity`. It cannot reap
   zombies, and for a session container that is acceptable.
6. ~~**Session naming.**~~ Settled: bare `envmux` generates a petname; a name can
   be given positionally when the session is a task.
