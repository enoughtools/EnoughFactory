# envmux development images

The images are deliberately batteries-included beta defaults. All use Debian
Trixie and Node.js 24 LTS, and contain:

- git (≥ 2.40, which envmux itself requires — Debian Trixie carries 2.47;
  Bookworm's 2.39 is why the base moved), Git LFS, tmux (≥ 3.2, a hard
  requirement for anything envmux shells into), the Docker CLI *and* daemon,
  curl, jq, ripgrep, fd, shellcheck, build tools, Python 3,
  pip/pipx, Docker CLI/daemon, and AWS CLI v2;
- Codex CLI, Codex Security, Claude Code, and OpenCode.

`default.Dockerfile` is the general Node/Python image.
`dotnet-node.Dockerfile` adds the .NET 10 SDK.
`rust-node.Dockerfile` adds Rust 1.95 with rustfmt and Clippy.

Build locally from the repository root:

```console
docker build -t envmux-default -f images/default.Dockerfile .
docker build -t envmux-dotnet-node -f images/dotnet-node.Dockerfile .
docker build -t envmux-rust-node -f images/rust-node.Dockerfile .
```

## The default image, ready before the first project

`envmux config generate` writes `reference =
"ghcr.io/strigops-io/envmux-default:0.1.0"`, and the daemon pulls a reference
only when no local image carries that tag. Building the default image under
exactly that tag is therefore how a project in any other directory starts
without touching a registry:

```console
./scripts/build-default-image.sh          # macOS, Linux, Git Bash
.\scripts\build-default-image.ps1         # Windows
```

Both skip the work when the tag is already present, take `--force`/`-Force` to
rebuild after editing `default.Dockerfile` or `dev-common.sh`, and read the tag
out of the starter template so the script and the generated config cannot
drift. `scripts/install.ps1` runs the PowerShell one as its last step, and
rebuilds automatically when an update pulls changes under `images/`.

This is a local convenience, not a substitute for publishing: pin a digest for
anything shared, since a locally built tag is only as reproducible as the day
it was built.

The OS/runtime versions are pinned. Agent CLIs intentionally
track their npm `latest` dist-tags at image build time because they ship API
compatibility and security updates frequently. A release pipeline should record
the resulting lock/provenance and publish immutable image digests.

The images do not bundle an editor. For graphical editing, attach your local
VS Code to the workspace container — see the TUI and CLI pages for the
attach workflow.

## The account: `user`, not root

All three images run as **`user`** — uid 1000, home `/home/user`, passwordless
sudo for the times root is genuinely wanted. It is the base image's own uid
1000 account renamed rather than a second one added, so it keeps the uid a
Linux host user almost always has: the mirror and the shadow arrive as bind
mounts owned by the human outside, and an account at 1001 would read them as a
stranger's.

Two consequences worth knowing:

- Every path in a config is a path in that home — `/home/user/.claude`, not
  `/root/.claude`. `[workspace] user` overrides the account per project, and
  then the volume paths have to move with it.
- Rust does not live in a home directory. `rust-node.Dockerfile` sets
  `CARGO_HOME=/usr/local/cargo` and `RUSTUP_HOME=/usr/local/rustup`, world
  writable, because a toolchain under `/root` is unreadable to `user` and one
  under `/home/user` would be shadowed by a volume mounted over that home.

The repository's own `.envmux.toml` is the exception that stays `user =
"root"`: it runs `dockerd` in a privileged container, which is root's job.

## Agent state and caches

The generated starter and the example TOML files use shared envmux named
volumes for package caches and agent state. `class = "cache"` is disposable;
`class = "sync"` is persistent across every workspace in the namespace, which
is what makes a new workspace immediately usable — sign Claude Code or Codex in
once, in any workspace, and every workspace created afterwards starts signed
in.

These are Docker volumes, **not host-directory bind mounts**: nothing is copied
off your machine, and the first sign-in happens inside a workspace. Claude Code
keeps `.claude.json` beside `$HOME` rather than inside `~/.claude`, so the
starter also sets `CLAUDE_CONFIG_DIR=/home/user/.claude` — without it the
volume preserves the credentials and loses the onboarding state, and every
workspace re-onboards. Credentials are shared namespace-wide: use a separate
namespace when they must not be.

## Dangerous Docker modes

The two configuration switches are intentionally verbose:

- `dangerously_mount_docker_socket = true` gives the workspace control of the
  host Docker daemon and is supported only on native Linux hosts.
- `dangerously_enable_dind = true` makes the workspace privileged so it can run
  an isolated nested daemon. This removes the container security boundary.

They are mutually exclusive and disabled by default. The repository's own
`.envmux.toml` uses privileged DinD solely as a recursive demonstration.

