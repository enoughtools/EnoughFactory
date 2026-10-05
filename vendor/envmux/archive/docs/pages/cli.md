# CLI reference

The CLI is the complete interface. The [TUI](tui.md) is a client of the same
local IPC API; there is no other surface.

`envmux --help` and `envmux <command> --help` are authoritative. This page is
the shape and the reasoning.

`envmux` with no subcommand starts (or rejoins) a session on a terminal, and
prints help when output is redirected, so a script never receives a full-screen
UI by surprise. `envmux session` is the explicit spelling.

The UI comes up first and does the work behind it: setting the directory up if
it has no config, forking the folder's daemon if none is running, registering
the namespace, and ensuring a workspace — each reported as it happens. None of
it is privileged; it is these same commands in this same order, so a session
brought up by hand with `envmux up && envmux create` arrives in the same place.

## Output and exit codes

Human tables to a TTY; `--porcelain` for stable tab-separated columns (the
column set is versioned and additions are append-only); `--json` for one object
per line.

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error |
| 2 | usage |
| 3 | not found |
| 4 | daemon unreachable |

These are stable. Script against them. Code 4's message is
``no daemon for this project (run `envmux` to start a session)``, and it names
the state directory it looked in — every project has its own daemon, so a
running daemon and an unreachable one are the same sentence without it.

## Installing

```console
$ envmux install                 # per-user directory, added to PATH
$ envmux install --dir /opt/bin  # somewhere else
$ envmux install --no-path       # copy the files, leave PATH alone
```

Copies the running executable somewhere permanent. Per-user, no elevation, no
service unit — the daemon is forked per session. Installing from a portable
copy does not carry the state with it; the installed copy starts empty and
says so.

## Sessions

```console
$ envmux                  # the setup screen if needed, then the session
$ envmux session --yes    # the same, taking the recommended starting point
$ envmux manage           # the management dashboard for this folder
```

In a directory with no `.envmux.toml` the first screen offers a starting point
chosen from what the repository looks like, showing the file it would write
before it writes it — see [the TUI page](tui.md#setup). `--yes` takes the same
recommendation without the screen, for the scripted case.

The session is the product; the rest of the surface exists for scripts and for
moments the TUI is the wrong tool. The daemon behind it is per-folder and
ephemeral: forked and disowned on first need, state in the project's own
`.envmux/state`, and self-terminating — any in-flight request or open attach
counts as a client, and after `--grace-secs` (default 60) with none it reaps
its workspaces (final capture first), stops the namespace's base and service
containers, and exits.

## Lifecycle

```console
$ envmux up        # start the folder's daemon and register the namespace, no TUI
$ envmux status    # namespace status
$ envmux down      # capture, close containers, stop the daemon — now
$ envmux daemon    # run the daemon in the foreground
```

`up` is the scriptable half of what a bare `envmux` does. `down` is the
impatient form of the grace timer: the same teardown — reap with a final
capture, stop the containers, exit — without waiting for the grace period.

`envmux daemon` is the same executable doing the other half of its job — the
CLI and the daemon are one binary. The session forks it for you in the
background; run it directly to keep it in the foreground and see its logs on
stderr.

```console
$ envmux daemon --state-dir .envmux/state    # which state directory to own
$ envmux daemon --grace-secs 300             # idle seconds before self-shutdown (default 60)
$ envmux daemon --disk-threshold 90          # disk alert percent (default 80)
$ envmux daemon --register /path/to/repo     # register a namespace at boot
```

## Images

```console
$ envmux image build           # build or pull, docker progress on this terminal
$ envmux image build --force   # rebuild even when present
$ envmux image tag             # print the exact tag the daemon will use
```

The daemon builds images itself on first registration — detached, output in
its log file. `image build` is the visible form: same tag (built images are
tagged by config hash, so the daemon finds it and skips), the docker CLI's own
progress on your terminal. The dev scripts run it before launching so a first
session never builds in the dark.

## Prune

```console
$ envmux prune             # summary, then y/N confirmation
$ envmux prune --dry-run   # print what would go, remove nothing
$ envmux prune --all       # also stop and remove RUNNING envmux containers
$ envmux prune --force     # skip the prompt (required off a terminal)
```

The janitor for whatever ephemeral daemons missed, modeled on `docker system
prune` — it talks to Docker directly and needs no daemon running. Scope is
strictly objects carrying the envmux label schema (`dev.envmux.schema`);
nothing unlabelled is ever touched. The default sweep removes stopped envmux
containers, then envmux volumes no surviving container mounts, then idle
`envmux-*` networks — running containers are someone's live session and are
left alone unless `--all` takes them, which the confirmation calls out
loudly. Off a terminal, prune refuses without `--force`: scripts must opt in
to deletion.

## Workspaces

```console
$ envmux create --wait                    # from cwd; blocks until tasks are ready
$ envmux create --branch feature/x --name my-workspace
$ envmux ls
$ envmux ls --branch main --dirty --porcelain
```

Names are random on purpose. `ls` exists so you find a workspace by what it
*is* — branch, commit, dirtiness, tasks up, time to death — rather than by
remembering a name. Every observed column shows its age, because observation is
a snapshot and not a feed.

```console
$ envmux attach wobbly-otter --task dev    # a task's tmux window
$ envmux attach wobbly-otter --ro          # watch without extending the lease
$ envmux run wobbly-otter -- cargo test
$ envmux cp wobbly-otter:/work/out.txt .
$ envmux cp ./fixture.json wobbly-otter:/work/
```

A read-write attach extends the lease by the configured extension. **Read-only
attach does not** — watching an agent work should not keep its world alive.
Any attach counts as a daemon client, though, so an attached session also
holds off the grace timer.

**Exiting your terminal reconnects it.** `exit` (or quitting the agent
`[workspace] terminal` names) closes that tmux window, and closing the
session's last window ends the session — so the stream you were attached to
drops for reasons that have nothing to do with wanting to leave. A read-write
attach reads the difference between that and a detach, says
`[envmux] the terminal exited — reconnecting…`, and opens a fresh terminal in
the same workspace. Nothing else in the workspace is touched: task windows,
files, and the lease all carry on. To actually leave, detach (`ctrl-b d`) or
close the workspace. A read-only attach never reconnects, because recreating
a terminal is exactly the side effect that mode exists to avoid; it reports
the session is over and returns. If a reconnected terminal cannot stay up,
the third immediate failure in a row is reported as an error instead of
retried forever.

## Open in VS Code

```console
$ envmux code                  # first live workspace in this folder's namespace
$ envmux code wobbly-otter     # a named one
```

Launches your local VS Code attached **into** the workspace container: VS Code
installs its server over `docker exec` and opens the workspace folder inside,
so its terminal, debugger, and extensions all run in the environment. It needs
the Dev Containers extension, and VS Code prompts to install that itself on
first use. `envmux code` hands off and returns immediately — the attach
happens in the VS Code window. Editor discovery tries `[editor] path`, then
`$VSCODE_BIN`, then `code`/`code-insiders`/`codium`/`cursor`/`windsurf` on
PATH, then the platform's well-known install locations; since editor location
and window habits are machine-specific, `[editor]` overrides belong in
`.envmux.local.toml` rather than the committed file:

```toml
[editor]
path = "/usr/local/bin/code"      # optional; discovery covers normal installs
window = "reuse"                  # or "new" for --new-window
default_folder = "/"              # fallback when no better folder is known
[editor.folders]
wobbly-otter = "/work/backend"    # per-workspace folder override
```

## Leases

```console
$ envmux lease wobbly-otter --extend 24h
$ envmux lease wobbly-otter --until 2026-09-01T00:00:00Z
$ envmux lease wobbly-otter --pin          # no death date
$ envmux lease wobbly-otter --unpin
$ envmux reap --dry-run
```

Nothing else moves a death date. A running dev server, a chatty agent, task
output, git activity — none of it counts. The reaper selects on the stamped
date, so a machine that slept for a weekend wakes with the same dates rather
than a queue of mass deletions.

## History

```console
$ envmux capture wobbly-otter              # snapshot now
$ envmux snapshots wobbly-otter
$ envmux snapshots --branch main           # across every workspace on a branch
$ envmux snapshots wobbly-otter --from <snap> create
```

Snapshots carry `torn` and flagged-state markers. A torn snapshot of recent work
beats a clean snapshot of older work; the flag exists so you can tell.

A reaped workspace is gone — envmux does not promise to reconstitute a container
or its running state. What survives is the shadow history, on a longer horizon,
from which a fresh workspace can start at any captured point — including the
final capture the session's own shutdown takes.

## Configuration

```console
$ envmux config show                       # active file, hash, drift state
$ envmux config show --hash
$ envmux config prompt                     # the authoring instructions
$ envmux config prompt --agent claude      # run them through an agent
$ envmux config prompt --list-agents
$ envmux config generate                   # a commented static starter
$ envmux config create-local               # local override with drift detection
```

The declaration is meant to be generated — see
[configuration.md](configuration.md).

## Services and resources

```console
$ envmux services                          # health per namespace
$ envmux slices                            # provisioned slices
$ envmux slices --orphans                  # slices with no live workspace
$ envmux disk                              # attributed by namespace and class
$ envmux mirror fetch
```

`slices --orphans` reports; it never deletes. A failed deprovision is recorded
against the service rather than lost with the workspace, and keeps being
reported until resolved.

## Shell completions

```console
$ envmux completions bash > /etc/bash_completion.d/envmux
$ envmux completions powershell | Out-String | Invoke-Expression
```

Supports bash, zsh, fish, PowerShell, and elvish.
