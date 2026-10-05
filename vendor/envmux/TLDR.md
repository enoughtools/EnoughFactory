# envmux quickstart

Windows x64, Git on PATH, Docker Desktop running Linux containers.
Download the self-contained archive and checksums from
[envmux/envmux releases](https://github.com/envmux/envmux/releases), verify and
extract. Run these in a committed git repository:

```console
envmux init --skills both
envmux config validate
envmux --dry-run
envmux first-session
```

Edit the generated tasks to fit your project before launching. Press b for the
session browser, p for the portal, c for a shell, and e for VS Code (Dev Containers
extension required). Commit guest work so it returns to `envmux/<session>`.
Kept containers and volumes retain uncommitted work and copied credentials.

For optional guest orchestration, set `"chef": true`, enable the worker tool
credentials you intend to use, and start `envmux chef`. The installed chef skill
handles dispatch and chat. Workers currently run Claude Code; at most three are
active. The shared Docker kernel and network are for trusted development work.

Incus is optional: select `--backend incus` and follow
[the host guide](docs/pages/host.md). No Incus install is required for Docker.
See [the full README](README.md) and [beta checklist](docs/pages/beta.md).
