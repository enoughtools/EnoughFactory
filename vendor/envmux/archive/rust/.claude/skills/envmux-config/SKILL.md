---
name: envmux-config
description: Write or revise an .envmux.toml — the envmux environment declaration for a repository. Use when the user asks to set up envmux for a project, generate or fix .envmux.toml, add a service or task to it, or when `envmux config show` reports a validation error. Reads the repository and infers the image, services, tasks, routes, and caches.
---

# Writing `.envmux.toml`

envmux runs several isolated, disposable copies of one project's development
environment side by side, so multiple agents can work in parallel without
colliding. `.envmux.toml` is the committed declaration of what one of those
copies contains.

## Get the authoritative instructions from the binary

The prompt that describes the current schema ships **inside envmux**, so it
always matches the installed build:

```bash
envmux config prompt
```

Read that first and follow it. It covers the sections, the rules that are easy
to get wrong, and a worked shape. Everything below is about *how to work*, not
what to write — the binary is the source of truth for the latter.

If `envmux` is not installed, the same text lives at
`crates/envmux-config/prompts/authoring.md` in the envmux repository.

## How to approach it

1. **Read before writing.** Identify the toolchain (`Cargo.toml`,
   `package.json`, `go.mod`, `pyproject.toml`, `*.csproj`), then the services
   the code actually talks to (`compose.yaml`, `.env.example`, connection
   strings, migration directories), then the commands people run
   (`package.json` scripts, `Makefile`, `justfile`, CI workflows, the README).

2. **Declare only what the repository evidences.** A Postgres service that
   nothing connects to is noise that costs a container per namespace.

3. **Get the task graph right.** One-shot tasks are expected to exit;
   long-running ones are not and need `long_running = true` plus a readiness
   `check`, or `envmux create --wait` cannot tell when the workspace is ready.
   Ordering comes from `after` (tasks) and `requires` (services) — declare it
   rather than relying on luck.

4. **Never put a secret in this file.** It is committed. Slice credentials
   arrive as files under `/run/envmux/secrets/<service>/`; anything
   machine-specific belongs in an uncommitted `.envmux.local.toml`, which
   replaces the committed file wholesale rather than merging with it.

5. **Validate before you finish:**

   ```bash
   envmux config show
   ```

   Errors are diagnostics pointing at the offending key. Fix them; do not hand
   back a file you have not parsed.

## When you are done

Say briefly what you inferred from the repository and what you guessed, so the
reader knows which lines to check. Guesses worth calling out: the image
reference, service versions, and any port you could not find bound anywhere.

## Related

- `envmux config generate` writes a commented static starter, if the user would
  rather fill one in by hand.
- `envmux config prompt --agent <name>` pipes these instructions to another
  agent, for people not using Claude Code.
- Design rationale: `docs/CONCEPT.md` §13 (configuration) and §11 (tasks).
