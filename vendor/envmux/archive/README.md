# Archive

The Rust implementation of envmux, and the documentation that described it,
retired on **2026-08-15**. Nothing here is built, tested, or maintained. It is
kept because the thinking in it was expensive and some of it is still right.

| Path | What it is |
|---|---|
| `rust/` | The whole Rust workspace as it stood on `feat/vnext`: 12 crates, the daemon, the TUI, the images, the scripts, the CI and release workflows, and the `.envmux.toml` that self-hosted it. |
| `docs/pages/` | The v1 and v2 design documents, and the user-facing docs that went with them. |

Files moved with `git mv`, so `git log --follow` still reaches their history.

## Why it was retired

v1 grew a resident daemon with SQLite, three HTTP transports, five background
workers, a certificate authority, a proxy container, a Tauri desktop app and a
React portal — all so that state could outlive the terminal. v2 (in
`docs/pages/V2_PLAN.md`) diagnosed that correctly and cut most of it, but landed
on a *per-folder ephemeral daemon* rather than no daemon: still a forked
process, still a state directory, still an IPC transport, still a SQLite file.

The rewrite goes the rest of the way. envmux is now a single .NET console
process with a Terminal.Gui front end. There is no daemon at all: the process
holds one TCP port, that port *is* the claim, and when the process exits the
port is released and the containers are gone. Rust was also a practical
problem — the owner of this repository does not read it, which made every
review a matter of trust rather than inspection.

## What survived the move, as ideas

- **Hostname routing on one port.** `{name}-{route}.{domain}` resolved from the
  `Host` header, proxied to a loopback port. `rust/crates/envmux-daemon/src/router.rs`
  is still the reference for the host-resolution edge cases, and the wildcard-DNS
  reasoning in `docs/pages/V2_PLAN.md` §Routing (why `*.localhost` is unreliable
  on Windows) carried over intact.
- **Docker labels as the only durable truth.** `rust/crates/envmux-core/src/labels.rs`.
- **Ephemeral by construction.** Containers are created with `AutoRemove` and
  owned by the session that made them.
- **The declaration is generated, not hand-written.**
  `rust/.claude/skills/envmux-config/SKILL.md` and
  `rust/crates/envmux-config/prompts/authoring.md` are the prior art for the
  authoring skill the new config will want.

## What did not survive, deliberately

Leases and death dates, the reaper, shared Postgres/MinIO/Redis with per-workspace
slice minting, the mirror and its git alternates, the shadow origin and scheduled
capture, the observation loop, the task DAG, mTLS and the local CA, the secrets
helper chain, the portal, and the desktop app. Two of those have since come back
in a form the argument against them does not reach — the task DAG as
[tasks](../docs/pages/tasks.md), and the portal as
[a page on the port the session already claimed](../docs/pages/portal.md), with
no daemon behind it, no state of its own and nothing to release separately. Each is argued for in
`docs/pages/CONCEPT.md`; none of them is needed to launch a container and reach
it in a browser, which is the whole of the new MVP.

## Reading it

Start with `docs/pages/CONCEPT.md` for what the project was trying to be —
§17, the known sharp edges, is the most durable part of it. `docs/pages/V2_PLAN.md`
is the closest ancestor of the current design. `docs/pages/TODO.md` is an honest
record of what actually worked and what never did.
