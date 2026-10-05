# envmux

A development session gets a branch, a Docker container, tasks and a browser
whose `localhost` belongs to that container. Logs and shells are visible through
the terminal UI and the loopback portal. Commits come back to your workstation
repository when the session ends.

The public MIT beta targets Windows x64 and Docker Desktop in Linux-container
mode. Start with [Getting started](getting-started.md), then
[Configuration](configuration.md) and [CLI reference](cli.md). Incus is an
optional backend: [Host](host.md) explains it.

The bundled setup and chef skills support local Claude Code and Codex projects.
Chef dispatch is opt-in; workers currently run Claude Code. See
[Beta launch](beta.md) for release gates and the Discord checklist.

Download immutable beta archives from
[envmux/envmux releases](https://github.com/envmux/envmux/releases).
