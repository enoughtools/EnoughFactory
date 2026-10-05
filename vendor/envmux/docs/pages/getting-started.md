# Getting started

The public beta supports Windows x64 with Docker Desktop running Linux
containers. Get the archive and checksum file from
[envmux/envmux releases](https://github.com/envmux/envmux/releases), verify with
PowerShell `Get-FileHash`, and extract. Git must be on PATH. The self-contained
binary needs no host .NET or Node runtime. The first launch builds a Docker
image and downloads its Linux packages and Claude Code.

## First session

In a git repository with a committed starting point:

```console
envmux init --skills both
envmux config validate
envmux --dry-run
envmux first-session
```

Edit `.envmux.json` before launching: declare install and development commands,
readiness ports and routes. The setup skill helps Claude or Codex make this
configuration. Host toolchains are not automatically installed in the guest.
The project skills go in `.claude/skills` and `.agents/skills`; choose one with
`--skills claude` or `--skills codex`. Customized skills and an existing config
are preserved. `--force` explicitly replaces an existing config.

Press **b** for the [session browser](browser.md), whose `localhost` reaches the
container, **p** for the [portal](portal.md), **c** for a shell, and **e** for VS
Code. Install its Dev Containers extension for the default attach. The browser
can reach a dev server bound to the container's own `127.0.0.1`; no route or DNS
change is made on the workstation.

## Keep and return work

A session gets an `envmux/<session>` branch. Commit inside the guest to bring
work back when it ends. Kept sessions retain uncommitted files and copied tool
credentials. Starting the same name resumes it. `envmux logs <session> <task>`
reads task output. `envmux prune --dry-run` previews cleanup; dirty or unreadable
workspaces are protected unless you explicitly force deletion. Docker named
volumes survive container deletion.

## Agents and optional hosts

Set `"chef": true` and start `envmux chef` for scoped guest dispatch. Follow the
bundled chef skill; workers currently use Claude Code and the credentials you
explicitly enable. See [beta launch](beta.md) for rehearsal and support gates.

For an optional Incus host, see [Host](host.md). Select it with
`--backend incus` or `"backend": "incus"`. That path uses pinned TLS trust and
may provision a Hyper-V VM; it is not required for the Docker quickstart.

Report versions and redacted errors to Discord. Do not share portal token URLs,
credentials, transcripts or environment exports.
