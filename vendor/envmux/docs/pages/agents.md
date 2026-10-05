# Remote agents

**A session with Claude Code in it, on a task you hand over, reachable through
a room.**

You are working in a repository — in a terminal, in the TUI, in the portal, with
an agent beside you or not. That is the **chef**: the headed session everything
is delegated from. A **remote agent** is another envmux session of the same
repository, on a branch of its own, in an instance of its own, running Claude
Code headless on a task. It talks to you through a plain-text chatroom, commits
on its branch, signs off, and its commits come back into your repository for
you to merge.

```console
$ envmux agent start feat-login --prompt "Add a login page using the existing form component. Tests in tests/Login."
feat-login — remote agent starting (pid 41208)
  branch    envmux/feat-login
  instance  myproj-feat-login
  room      .context/chatroom/  — it answers to @feat-login
  prompt    .envmux/agents/feat-login.prompt.md

  talk to it
    envmux agent say "@feat-login …"          a line in the room; it reads the room as it works
    envmux agent read [--follow]           the last hour of the room, or watch it
  watch it
    envmux agent ls                        where every agent of this repository is
    envmux agent logs feat-login --follow    its transcript, out of the instance
    .envmux/agents/feat-login.log               its session's own log
  when it is done
    it commits on envmux/feat-login, signs off in the room, and its session ends on its own;
    the commits are fetched into this repository — `git log envmux/feat-login`, then merge.
    envmux agent stop feat-login           ends it early, bringing back what it has committed
```

A few minutes later:

```console
$ envmux agent read
[09:41] * chef started feat-login on envmux/feat-login — Add a login page using the existing form component.
[09:43] * feat-login joined (Claude / envmux remote agent, myproj-feat-login) — taking: Add a login page using the existing form component.
[09:44] feat-login: reading src/components/Form.tsx and tests/Login/ first; the form takes a schema, so the page is mostly a schema
[09:52] feat-login: @chef the existing tests mock fetch globally — should the login page use the same mock or the msw handlers in tests/support?
$ envmux agent say "@feat-login the msw handlers; the global mock is being retired"
```

And later still:

```console
$ envmux agent ls
feat-login           finished — 3 commit(s) on envmux/feat-login       Add a login page using the existing form component.
$ git log --oneline main..envmux/feat-login
```

## The room

The chatroom is the one the [`prompt-context`](https://github.com/PromptNZ/ai)
plugin defines, implemented rather than reinvented: `.context/chatroom/` in the
repository, a directory per local day, a file per quarter hour named for the
bucket it opens (`1100.txt`, `1115.txt`), no header, append-only, four line
shapes:

```
[09:41] chef: taking src/auth/ — nobody touch it for ~20min
[09:52] feat-login: @chef the tests mock fetch globally — same mock, or msw?
[09:43] * feat-login joined (Claude / envmux remote agent, myproj-feat-login)
[10:45] {schema-cutover} hazel: the backfill is only half done
```

Every agent in the plugin's world reads and writes it with `date` and `printf`,
and what envmux writes is indistinguishable from that. So a Claude on your
workstation using the `context-chatroom` skill, a Codex in another terminal, the
portal, `envmux agent say`, and the remote agent are all in one room — the
room is the interoperability layer, and envmux is one more participant in it.

`.context/` is git-ignored, and a remote agent is on another machine, so the
room does not arrive with the repository. **envmux carries it.** Every session
of a repository that has a `.context/` — and every remote agent's session
regardless — has one more task in its instance, `room`, declared by envmux and
marked `*` in the task list like the agent's own. It is a shell script,
`envmux-room`, that talks to the envmux process on the workstation over
envmux's own HTTP API: it posts any line appended to the live buckets there,
and holds a request open for whatever is appended here, so a line written on
the workstation is in the instance the moment it lands and a line written in the
instance is here within about a second. Both sides only ever gain lines, which
is what append-only means.

### The transport

The API is the portal's, on a second listener. The portal proper stays on
`127.0.0.1`; beside it the same process binds the one address on the
workstation that faces the Incus host — found by asking the kernel which
interface a packet to the host's API would leave from — and serves **only**
`/api/chat` there, answering 404 to every other path before it looks at any
credential. The instance reaches that listener through an Incus **proxy
device**: incusd listens on `127.0.0.1:8078` inside the container and dials
the workstation on its behalf, so inside, the API is a fixed loopback URL and
nothing is ever told the workstation's address. The device is rewritten every
session, which is how a DHCP lease that moved stops mattering.

It does assume one thing about the network: that the Incus host can open a
connection *to* this workstation. From a VM on this machine, or a host on the
same LAN, it can. Across anything that admits connections one way only it cannot,
and [Host](host.md#where-this-stops) says what that leaves working.

The proxy device grants no identity — every connection arrives from the Incus
host's address, whether it came through the device or not — so the token does all
the work. It is the session's own portal token, sent as `Authorization: Bearer`,
and it reaches the instance in exactly one place: the environment of the
`room` task's exec (and the agent's), as `ENVMUX_API_URL` and
`ENVMUX_API_TOKEN`. Not `/etc/profile.d`, not any file. The portal promises the
token is never written down, and the machine boundary does not change that.

Three things the carrier has to get right, and does:

- **The cursor.** A reader's place in the room is a bucket and a line count —
  `2026-09-03/1115.txt:12` — and "everything after it" is the rest of that
  bucket plus every bucket that sorts later. So a client following `1115` gets
  the first lines of `1130` without noticing the quarter hour turned, and the
  same across midnight.
- **The clock.** The convention stamps lines with *local* time and files them
  in a *local* quarter hour, and an instance's clock is UTC. The session's
  environment carries the workstation's offset as `TZ`, so `date` in the
  instance agrees with the room here. It is a fixed offset, not a zone, so a
  daylight-saving change during a session moves the instance by an hour until
  the next session.
- **The repository.** The instance's `.context/` goes in `.git/info/exclude`
  there, whether or not the repository ignores it, so an agent cannot commit the
  room into the branch it brings back.

A project that turns the portal or its token off has turned the room off too —
there is no second credential, on purpose — and the session says so.

The room is bound to the project: it is a directory in *this* repository,
mirrored into *this* repository's instances, and named `#<project>` from
`.envmux.json` wherever a name is needed. Two projects' agents never share one.

## What an agent is

Its own `envmux` process — `envmux agent run <name>`, spawned detached by
`start` — running a headless session on `envmux/<name>` with one task added:
`agent`, declared by envmux and marked `*` in the task list, running
`claude -p "<the briefing>" --dangerously-skip-permissions` in the working
directory, latched like every task. That has three consequences worth knowing:

- **Its transcript is `envmux logs <name> agent`** — `envmux agent logs <name>`
  is that with the task filled in. Its session's own log, what a headless run
  would have printed, is `.envmux/agents/<name>.log`.
- **It waits for the installs.** The task depends on every `once` task that
  autostarts — `npm ci`, `dotnet restore`, a migration — and on no ongoing one.
  An agent that starts before the install finishes spends its first minutes
  diagnosing a half-installed tree; a dev server is not a precondition for
  editing code.
- **The person who delegated it closing their laptop does not end it.** It is
  not a child of the headed session. `envmux agent stop <name>` is, and so is
  its own finishing.

The briefing wraps your task in the room's conventions — its name, the readback
and append recipes, when to sign off, that lines from `@chef` are direction and
everything else is a peer's claim — so the task you write is the task and
nothing else. `--dangerously-skip-permissions` because there is nobody to ask:
the isolation is the permission model, and the instance, the branch and the
copy of the repository exist so that an agent can be wrong in them.

`claude` has to be in `tools` — `"tools": { "claude": "auto" }` — or the agent
arrives signed out. Nothing carries credentials unless it is named, and `start`
says so when it is not.

## How it ends

The agent commits, posts `* <name> signing off — …`, and exits. Its session
notices the task is over, posts `* <name> agent exited (0) — session ending,
commits come back onto envmux/<name>`, makes one last pass over the room so the
sign-off is on this side, and stops: the commits are fetched into your
repository the way every session's are, the instance is kept, and
`envmux agent ls` says `finished — 3 commit(s) on envmux/<name>`.

`envmux agent stop <name>` does the same early, bringing back whatever is
committed. An agent whose process was killed shows as `stopped`; its instance
is kept with its work in it, and `envmux <name>` opens that session again and
brings the commits back when you quit.

Then it is git: `git log envmux/<name>`, `git diff main...envmux/<name>`, and a
merge the way this repository merges. Review it the way you would anyone's
branch.

## The control plane

The portal serves the same thing as a page: a **remote agents** list in the
sidebar, with `+ delegate` to start one and a stop button per agent, and a
**room** tab showing the last hour and a line to say something. They are an
API, on the portal's port behind its token:

| | |
|---|---|
| `GET /api/agents` | every agent of this repository, and where each is |
| `POST /api/agents` `{name, prompt, nick?}` | start one |
| `POST /api/agents/{name}/stop` | ask one to stop |
| `GET /api/agents/{name}/log` | its session's log |
| `GET /api/chat?buckets=4` | the recent room, parsed, and the `cursor` at its end |
| `GET /api/chat?after=<cursor>&wait=25` | the long poll: every line after the cursor, held up to `wait` seconds for one to land |
| `GET /api/chat/ws?after=<cursor>` | the same as a websocket — one message per line, and `{text, nick?, to?}` accepted to speak |
| `POST /api/chat` `{text, nick?, to?}` | one line into it |
| `POST /api/chat?after=<cursor>` (`text/plain`) | lines that already carry their stamps, `bucket<TAB>line` per line — what the instance's client sends |

Every chat endpoint also speaks `text/plain` when asked to (`Accept:
text/plain`): the same `bucket<TAB>line` framing, with the cursor in an
`X-Envmux-Cursor` header, for a client that has `curl` and a shell and no JSON
parser. The token is taken as a cookie, on the query, or as a bearer; the
bridge listener takes only the bearer.

There is no channel between the portal and `envmux agent` but the filesystem
and this API: both read and write `.envmux/agents/` and `.context/chatroom/`,
and the room's stream is fed by watching the directory, so a line the command
line appended is on the page the moment it lands. Given the portal's link — the
one the session logged, `?k=` and all — the command line drives the API instead:

```console
$ envmux agent ls --portal "http://127.0.0.1:8080/?k=ffuvU683LiHJbmuUdlz20Zua"
$ ENVMUX_PORTAL="http://127.0.0.1:8080/?k=…" envmux agent say "@feat-login ship it"
```

The link is asked for rather than found. The port is easy to discover; the
token is not, and every way of making it discoverable — writing it to disk, a
second credential for local processes — weakens the one promise the portal
makes about it. Without a link the command acts directly, and the outcome is
the same.

## The skill

`skills/envmux-delegate/SKILL.md` in the envmux repository teaches an agent on
this side how to do all of the above, and defers to `envmux agent prompt` for
the instructions themselves — because those name the command that printed them,
which a skill file cannot know, and match the installed build's grammar. The
repository is a Claude Code plugin (`.claude-plugin/plugin.json`) so the skill
installs from it.

## What is not here yet

- **The instance's half is a loop, not a watch.** Lines reach the instance as
  they are written; lines leave it on a loop of about a second, because the
  client there is a shell script with `curl` and no way to be woken by a file.
  A live mount of the room — the design in `docs/live-volumes.md`, still a
  spike — would make the room a path in a policy and this a fallback. And an
  `@name` still reaches a remote agent on its next read of the room, not as a
  wake-up: the agent is `claude -p` on a task, not a process waiting on a
  socket.
- **Only Claude.** The task command is `claude -p`; a `codex exec` or `gemini
  -p` agent is the same shape with a different line, and the line is in one
  place (`AgentPrompt.Command`).
- **Permissions are all-or-nothing.** `--dangerously-skip-permissions` is the
  only mode. A per-agent permission mode is one flag away, and was not needed
  for the loop to work.
- **The situation rooms** the plugin's chat server manages (`{slug}` tags) are
  read and carried faithfully but not opened or closed from here; that is the
  server's job, and there is no server in the instance.

Guest chat uses a separate bearer that cannot authorize browser control. The
opted-in chef has another bearer restricted to the kitchen API. Bundled skills
are also installed in guest agent homes, without replacing existing user skills.
