# The TUI

`envmux` with no arguments, in a project, on a terminal.

```console
$ envmux
```

It is the primary way in — the session it opens is the product. There are
three views: **setup**, which a folder with no `.envmux.toml` lands on;
**dispatch**, the landing page a bare `envmux` opens; and **manage**, the
dashboard with a cursor, reached with `/manage` or `envmux manage`.

Redirect the output and you get `--help` instead. The check is a real TTY test
rather than a guess about who is calling — a script that suddenly receives an
alternate-screen UI instead of its usual output is a genuinely bad day. When
output is redirected, use a subcommand (`envmux ls`, `envmux status --json`);
there is no useful way to pipe a full-screen UI anywhere.

All three are clients of the same IPC API the CLI uses. The TUI has no
privileged access and no second source of truth, which is what keeps it from
ever disagreeing with `envmux ls`.

Nothing on screen is capitalised for effect. That matters most where the string
is *data*: a namespace or a branch rendered in caps looks like a different
string than the one in your config, and "why does it say ENVMUX when my file
says envmux" is a bug report nobody should have to file. There is a test that
reads the whole rendered frame and fails on any shouted word.

## Setup

The first screen in a repository envmux has not seen before. It is a choice,
not a confirmation: envmux reads the repository first and offers a starting
point that fits it.

**What was detected** is on the second line, with provenance — `vite · pnpm ·
5173 (vite default)`. Detection reads a fixed set of well-known files and
nothing else: `package.json` and its lockfile, `compose.yaml`, `Dockerfile`,
`.env`, `launchSettings.json`. No recursive source grep and no heuristic that
fires on one project in ten, because a suggestion that is wrong half the time
still has to be checked and now also has to be un-picked.

**The starting points** are on the left, with the detected one marked and
pre-selected. The list is not re-ordered by relevance — the recommendation
earns its place with a mark, so picking `rust` from the middle keeps working.

| | |
|---|---|
| `minimal` | a shell, and agents that arrive signed in — nothing that can fail |
| `node` | install and dev script, package-manager cache |
| `next.js` | install, `next dev`, and the dev server routed |
| `vite` | install, vite dev bound to `0.0.0.0`, and it routed |
| `rust` | `cargo fetch`, registry and git caches |
| `python` | dependency install, pip cache, django dev server when there is one |
| `go` | `go mod download`, module and build caches |
| `.net` | `dotnet restore`, nuget cache |

**The file it will write** is on the right, in full, before anything is
written. The thing on the other side of `enter` is a commit in someone's
repository, and a preview of a *description* of a file is not a preview.

| key | |
|---|---|
| `↑` `↓` / `j` `k` | choose |
| PageUp / PageDown | read the file |
| `enter` | write it and start the session |
| Esc or `q` | write nothing and quit |

Quitting gets the two spellings because it is the safe answer here; the other
option puts a file in your repository.

Detection only ever *fills a preset in* — it never changes which one you
picked. Choosing `rust` in a repository that also has a `package.json` gives
you the Rust preset, because you said so. Ports it found are routed either
way: a port the repository declares is a fact about the repository, not about
the stack somebody chose for it.

Enter writes the file, creates `.envmux/` and its ignore entries, and starts
the session. The preset is not remembered anywhere: the file is ordinary TOML
the moment it lands, nothing regenerates it, and nothing minds it being
edited.

`envmux session --yes` does the same without the screen, taking the same
answer it would have pre-selected.

## Dispatch

The landing page, and the view a bare `envmux` opens. It is on screen with
your folder's name on it before the first IPC call — everything that used to
happen before the UI existed now happens behind it, reported as it goes.

Top to bottom it answers the questions in the order they get asked.

**Where am I** — the folder, then the namespace, branch and workspace derived
from it, in the order they are decided in.

**Is it working** — a four-step checklist while the session comes up: config,
daemon, namespace, workspace. Each finished step says what it *decided*, not
just that it ran. The namespace step is the slow one on a first run, because
registration pulls or builds the image; it says so, because a step that sits
still for four minutes without explaining itself reads as a hang. Detail is in
the activity feed underneath, which is the daemon's own event stream.

The checklist disappears once the boot settles cleanly — four ticks nobody is
reading are worth less than four more lines of log. A failed boot keeps its
checklist, because it is the only place the reason is written down.

**What can I open** — windows on the left, ports on the right.

**What is it doing** — the activity feed.

**What do I type** — an always-focused `❯` input line. There is nothing else
there to focus.

### Windows

A workspace *is* a tmux session: every declared task is a named window in it,
and so is the terminal you attach to and any ad-hoc window you opened. That
was a good model and it was invisible — you attached into one window and found
the rest with tmux's own chords, which is fine if you already know tmux and a
dead end if you do not.

So they are listed, with **tmux's own indices**. `alt-2` here and `prefix 2`
inside the session select the same window, deliberately: two numbering schemes
for one list is worse than none.

The list merges two sources. The task engine knows what a task's state *is*
(ready, failed, how many restarts); tmux knows what windows actually exist and
in what order. Neither alone is the list — a task that has not opened its
window yet is real and missing from tmux, and an ad-hoc window is real and
unknown to the task engine. A declared task with no window yet is listed
without a number, because there is nothing to press.

The marker says where a window came from: `❯` the terminal, `▪` a declared
task, `+` one you opened.

### Ports

Whole URLs, not a count. Every terminal worth using linkifies a bare
`https://` itself, and an OSC 8 escape smuggled through a cell-based renderer
breaks the width arithmetic for the row it is on. `/open` is there for the
terminals that do not.

Routes come from `[routes]` in the config the workspace was built from. If the
pane says there are none, that is the answer — declare them and re-create the
workspace, since a workspace is a product of the configuration it was created
from.

### Keys and commands

| you type | |
|---|---|
| Enter, on an empty line | open the selected window |
| `tab` / `shift-tab` | move between windows |
| `alt-<n>` | jump straight into window *n* |
| `/attach [task]` (`/a`) | attach, into a named task's window |
| `/window [name]` (`/w`) | open an ad-hoc window and go to it |
| `/open [route]` (`/o`) | open a routed port in your browser |
| `/new [name]` | create a workspace |
| `/code [workspace]` | open a workspace in VS Code |
| `/up` | start a daemon, if there is none |
| `/manage` | swap to the manage view |
| `/help` (`/?`) | the commands, on one line |
| `/quit` (`/q`, or Ctrl-C) | quit |
| Esc | clear the input line |
| `↑` / `↓` | recall input history |
| PageUp / PageDown | scroll the feed |

Enter on an empty line opens what is *selected*, because the windows pane is
on screen with a cursor in it — always landing in the first window regardless
of what is highlighted would make the cursor a decoration.

Arrows recall history by default, which is what a prompt's arrows do
everywhere else. Once `tab` has given the windows pane the keyboard they move
within it instead; Esc on an empty line hands it back.

`/open` with no name opens the only route when there is one — asking someone
to name the single thing on screen is a keystroke tax. With several the name
is required, because guessing which of three services you meant is worse than
asking.

Attaching hands the terminal over to tmux entirely and takes it back when you
detach — a real attach cannot share a screen with a rendering loop. Exiting
the shell you attached into does not end the attach: a read-write attach opens
a fresh terminal and reconnects, and the TUI comes back only when you detach
for real. See [the CLI's workspaces section](/cli#workspaces).

## The manage view

The dashboard: every workspace, snapshot, and event for this folder's
namespace, with a cursor. `q` quits; Esc goes back to dispatch.

**Namespaces** on the left, with the workspace count for each. Moving between
them changes what the workspace table lists.

**Workspaces** — name, state, branch, dirtiness, tasks ready out of tasks
declared, and time until the death date. States are coloured because that is
the column you actually scan: green ready, cyan provisioning, amber degraded,
red lost.

**Detail**, which follows the focus. With the workspace pane active it shows
that workspace: id, namespace, whether its frozen config still matches the file
on disk, HEAD, its task windows and their states, and any declared routes.
With the namespace pane active it shows the namespace instead — remote, mirror
mode and age, and the shared services declared for it.

**Telemetry** — the daemon's event stream, newest first, at the level it
reported.

### Keys

| key | |
|---|---|
| `↑` `↓` / `j` `k` | move within a pane |
| `tab` / `shift-tab` | cycle panes |
| `1` `2` `3` | jump to namespaces / workspaces / telemetry |
| `o` | open a project directory |
| `n` | new workspace |
| `s` | new ad-hoc session in this workspace |
| `a` | attach read-write — extends the lease |
| `v` | attach read-only — does not |
| `g` | go to VS Code, attached into the container |
| `h` | shadow history — and revive from a snapshot |
| `c` | capture a shadow snapshot now |
| `p` | pin / unpin the lease |
| `e` | extend the lease by an hour |
| `f` | fetch the namespace mirror |
| `x` | reap this workspace (asks first) |
| `u` | start a daemon, if there is none |
| `I` | install envmux somewhere permanent |
| `r` | refresh now |
| `?` | all of the above, on screen |
| `q` | quit |
| Esc | back to dispatch |

Reaping asks first. Not for ceremony: a single keystroke that destroys a
workspace is a keystroke away from being pressed by accident, and while a final
shadow snapshot means the work survives, the container and its volumes do not.

## Opening a project

envmux needs to know about a repository before it can build anything from it —
usually that is the folder you ran `envmux` in, and the session handles it.
`o` browses for another one: arrows to move, enter to open a directory, left
to go back up, and the first row is always **use this directory**, so choosing
one never needs a second key that means "this one, not the one under the
cursor".

Directories that look like something envmux can take are flagged — `git` for a
repository, `.envmux.toml` for one that already declares its environment. The
rest are still listed rather than hidden, because a repository that has not
been declared yet is still one you might want, and an empty-looking browser is
a mystery.

Choosing a directory registers it and opens the new-workspace form on it
straight away. The two are one intention — *work on this project* — and
stopping at a registered namespace would leave you looking at an empty list.

## Shadow history

`h` lists the shadow snapshots for the selected workspace, newest first, and
`enter` starts a **fresh workspace** from the one under the cursor.

Fresh, not restored: the existing workspace is untouched and a new one is built
from the snapshot commit. A workspace is a product of the configuration it was
created from and is never upgraded in place, so reviving over the top of a live
one would be exactly the thing the model rules out.

Two flags are worth reading before you pick one:

- **torn** — the capture caught the tree mid-write. Still restorable, but it is
  a moment nobody chose.
- A **repository state** such as `rebase in progress` — the snapshot preserves
  it faithfully, which is the point, and also means you will land back in it.

The final capture taken before a workspace is destroyed — by the reaper, or by
the session's own shutdown — is in this list too, so a workspace that is long
gone is still somewhere you can start from.

## Open in VS Code

`g` in the manage view (on the selected workspace) or `/code [workspace]` from
dispatch launches your local VS Code attached into the workspace container —
VS Code installs its server over `docker exec` and opens the workspace folder
inside it. The Dev Containers extension is required, and VS Code offers to
install it itself the first time. The launch never suspends the TUI: it hands
off, flashes, and the attach happens in the VS Code window. Editor path and
window behaviour come from the `[editor]` section, which is machine-specific
and so belongs in `.envmux.local.toml` — see the
[CLI reference](cli.md#open-in-vs-code).

## Ad-hoc windows

`/window [name]` from dispatch, or `s` in the manage view, opens a **named
tmux window** in the workspace and attaches to it.

Declared tasks come from `.envmux.toml` and are the same in every workspace
built from that config. This is the other kind: a window you made, for whatever
you are doing right now — a shell, a one-off `tail -f`, a REPL. Give it a name
and optionally a command; leaving the command blank opens a login shell.

It is a `new-window` in the same session, so it appears in the windows pane
beside the tasks marked `+`, survives detaching, and `alt-<n>` finds it again
afterwards. The name matters for that last part: an unnamed window is reachable
only by an index that shifts as other windows come and go.

Nothing here needs an endpoint the CLI does not already have — it is
`POST /v1/workspaces/{id}/run` with a `tmux new-window`, then the ordinary
attach.

## Installing

Everything works from wherever the archive was unpacked. `I` is the step for
once you have decided to keep it: it copies the executable into a per-user
directory and adds that to your `PATH`. Per-user, so no elevation; no service
unit, because the daemon is forked per session.

It asks first, and the prompt says where the files are going. `envmux install`
does the same thing from the command line, with `--dir` and `--no-path`.

One thing worth knowing: installing from a **portable** copy does not carry the
state with it. The installed copy resolves state the normal way — the project's
own `.envmux/state` — while the portable one keeps its machine-wide state
beside itself. Both the prompt and the command say so, because "where did my
workspaces go" is the failure this arrangement invites.

## First run

Press `?` in the manage view with nothing running and the help screen leads
with the next step rather than an index of keys you have no use for yet —
start a daemon, open a project, create a workspace, in that order, each naming
the key that does it. It goes back to being a plain key list once there is a
workspace to look at.

## The look

Ratatui, and unapologetically 1985-imagining-2050: neon on near-black, double
rules on whatever has the keyboard, and a missing daemon that blinks
`no carrier` rather than sitting quietly in red.

The decoration is not free — it costs rows on a terminal that may not have many
— so there is very little of it and none of it charges the panes. Regions give
up their rows when they have nothing to say: the boot checklist once the
session is up, the windows and ports band until there is a session to have
either. The wordmark lives at the bottom of the manage view's detail pane, and
only while nothing is selected: space that was blank anyway, given up the
moment there is something to read there. It shrinks to fit — the block form on
a pane wide enough for it, a single line otherwise, nothing at all in a column
too narrow for either. Panels are clamped so the layout holds down to sizes
nobody should be using; there are tests that render every view into an
in-memory backend at 20×8 and 10×5 to keep it that way.
