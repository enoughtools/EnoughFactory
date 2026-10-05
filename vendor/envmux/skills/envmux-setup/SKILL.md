---
name: envmux-setup
description: Set up or repair a project's envmux configuration when the user asks to initialise envmux, configure its tasks and routes, or get a repository running in an envmux session.
---

# Set up a project for envmux

Start with the installed binary's `envmux --help`, `envmux autoconfigure` and
`envmux config schema`. A development build may be called `devenvmux`; use the
command the user is running throughout. The binary owns the grammar.

Read the project's manifests, scripts and existing `.envmux.json`. Use
`envmux init` only when there is no config; preserve an existing config and
explain any replacement. The default backend is Docker and needs a running
Linux engine. Incus setup is a separate choice; an ordinary Docker setup does
not need `envmux install`, Hyper-V, host wiring or elevated PowerShell.

Declare the actual commands this project uses. Name one-off installs as such,
give long-running tasks their readiness ports and dependencies, and declare
routes using the ports the processes really bind. In the session's launched
browser, `localhost` is the guest: a dev server bound to its own `127.0.0.1`
works without publishing a workstation port. Keep image features for expensive
toolchains shared by sessions.

Keep secrets out of config, tasks and committed files. `envFile` names an
ignored local input. `tools` copies local sign-in state into the guest; enable
only the tools the user has chosen. Adding a setup skill grants no credential
access. Docker nesting is not supported by the confined Docker backend; report
that requirement instead of adding privileges or the workstation's engine socket.

Finish by running `envmux config validate` and `envmux --dry-run` in the project.
Explain the first-run downloads, the launch command, how to open the session's
browser, and how commits return to `envmux/<session>`. Start a live session when
the user asked to run it, and verify its declared routes through that browser.
