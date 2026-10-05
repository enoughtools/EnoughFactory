# envmux documentation

If you just want to use envmux, start with
**[Getting started](getting-started.md)**. The
[top-level README](https://github.com/strigops-io/envmux#readme) has the install links.

## Using it

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Prerequisites, install, the first session, and where everything goes when it ends |
| [Configuration](configuration.md) | Every section of `.envmux.toml`, and the rules that are easy to get wrong |
| [CLI reference](cli.md) | The command surface, output formats, and exit codes |
| [The TUI](tui.md) | Setup, the dispatch landing page, the management dashboard, and their keys |
| [Troubleshooting](troubleshooting.md) | Failures that have actually happened, and what they mean |

## Working on it

| Page | What it covers |
|---|---|
| [Development](development.md) | Repository layout, build and test, conventions, generated wire types |
| [Deployment](deployment.md) | Cutting a release, container images, running the daemon as a service, exposing the API, backup |
| [Development images](images.md) | The container images that back workspaces |

## Design

| Document | What it is |
|---|---|
| [CONCEPT.md](CONCEPT.md) | Conceptual design — authoritative on **what** and **why**. Namespaces, workspaces, leases, capture, observation, and the reasoning behind each. |
| [SOLUTION_DESIGN.md](SOLUTION_DESIGN.md) | Technical specification — **how**. Crate map, async architecture, schema, git subsystem, tmux integration, API surface, packaging. |
| [V2_PLAN.md](V2_PLAN.md) | The v2 rework — what was deleted and why, and what is still planned (the in-session router lives here). |

Where the first two disagree, CONCEPT.md wins and SOLUTION_DESIGN.md has a bug.
Both describe v1; where v2 changed the architecture, V2_PLAN.md records what and
why.

## Status

| Document | What it is |
|---|---|
| [BETA_RELEASE.md](BETA_RELEASE.md) | The supported beta surface and the gates a tagged build must pass |
| [TODO.md](TODO.md) | Working checkpoint: what is proven, what is known-broken, what is deferred |

**Read TODO.md before relying on anything.** It is written to be honest about
what does not work, including several things that took a while to find.

## Reading order

New to the project and want to understand it rather than use it:

1. [CONCEPT.md](CONCEPT.md) §1–3 — the problem and the vocabulary
2. [Getting started](getting-started.md) — run it once; the concepts land better
   with a workspace in front of you
3. [CONCEPT.md](CONCEPT.md) in full — particularly §17, the known sharp edges
4. [SOLUTION_DESIGN.md](SOLUTION_DESIGN.md) — how it is actually built
5. [Development](development.md) — where things live
