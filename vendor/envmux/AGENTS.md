# envmux — instructions for agents

This is the one copy. `CLAUDE.md` imports it, so edit here and nowhere else.

## What this is

envmux is a C#/.NET 10 command-line program. Run in a project directory, it makes a branch, creates an
Incus instance with an address of its own, carries the repository into it as a git bundle, starts the
tasks `.envmux.json` declares, and shows the routes and logs in a terminal UI and a browser portal. A
session is reached through the browser its process launches — `localhost` in it is the instance,
over a SOCKS5 port and an exec relay (`Socks/`, `docs/pages/browser.md`) — and through ssh by an
alias whose `ProxyCommand` is `envmux relay`; nothing on the workstation routes to the range or
resolves the zone. Commits come back onto `envmux/<session>`; nothing stays running on the
workstation. The host is an Incus daemon — one envmux attached to (`envmux install --provider
incus`), or an IncusOS VM it built under Hyper-V (`--provider hyperv`) — reached over its REST API
with a pinned certificate, from anywhere that API is reachable. The workstation side is Windows-only
so far.

## Layout

| | |
|---|---|
| `src/Envmux/` | The one project. `Program.cs` parses arguments and dispatches; `Shell.cs` builds guest scripts |
| `Commands/` | One file per subcommand: `install`, `host`, `init`, `autoconfigure`, `config`, `code`, `ssh`, `relay`, `docker`, `logs`, `prune`, `agent` |
| `Config/` | The `.envmux.json` model, its loader and defaults, slugs, port specs |
| `Session/` | The launch sequence and its reverse: plan, workspace (bundle in, commits out), tasks, services, certificates |
| `Incus/` | `IncusClient` (the connection, and the only place trust is decided), `IncusApi` (calls and operations), wire models, instance specs, the golden snapshot, devcontainer features |
| `Host/` | `host.json` (`HostConfig`), the client certificate, the network envmux creates, `host prepare`'s script, the trust token; for the Hyper-V provider, the IncusOS install seed, image index and download. `LegacyUtility` removes an older envmux's `envmux-util` |
| `Host/Windows/` | The whole Windows-specific surface, through PowerShell: the Hyper-V provider (VM, switch, screen and serial watching of the unattended install), a spare range for a new bridge, and `host unwire` for an older envmux's route and NRPT rule |
| `Backends/` | The seam a session runs on: `IBackend` (instances, exec, dialling into the instance, files, images), `IncusBackend`, `BackendCatalog` (which one), and `BackendException`, the one thing a session catches whatever it runs on. `DockerEngine/` is the Docker Engine layer: the API client over the engine's pipe or socket, exec, the relay a session's `localhost` rides on, files, images, the container spec, prune. Not wired to a session yet |
| `images/golden/` | The golden image as a Dockerfile, embedded in the binary and built through the engine; the Docker twin of `Incus/Golden.cs` |
| `Routing/` | Routes as `localhost` URLs for the session's browser, the names instances have inside the host, and the port walk for the portal |
| `Portal/` | Kestrel on loopback: the API, the state object, websocket shells. `Portal/ui/` is the page — React, Vite, xterm.js |
| `Docker/` | A Docker-compatible endpoint so VS Code Dev Containers attaches to an instance (`docs/vscode-remote.md`) |
| `Socks/` | The session's SOCKS5 port and the browser launched on it: `localhost` is the instance over an exec relay, the rest leaves from here (`docs/pages/browser.md`) |
| `Editor/` | VS Code URIs, editor discovery, the ssh key and the `~/.ssh/config` block |
| `Agents/` | Remote agents: the registry, the chatroom carried into the instance, the briefing text (`AgentPrompt`) |
| `Git/`, `Process/` | The git CLI and bundles; subprocesses |
| `Lean/`, `Ui/` | The terminal window, written as escape sequences; colours, keys, console modes |
| `tests/Envmux.Tests/` | xunit, one file per unit under test |
| `tests/proof-of-life/` | A Vite app bound to the instance's own `127.0.0.1:5174`, run by this repo's `.envmux.json`: `b` in a session should show it, its route should not |
| `docs/pages/` | User-facing documentation and the vocs site source (`vocs.config.ts`, root `package.json`) |
| `docs/*.md`, `incus.md` | Design documents (below) |
| `spikes/` | Proofs kept with their evidence, each with a README. Not built, not shipped |
| `skills/`, `.claude-plugin/` | The envmux Claude Code plugin users install. A product artefact, not tooling for this repo |
| `scripts/` | `dev-install` (global tool `devenvmux`), `release-install` (the binary a release ships) |
| `archive/` | Dead code: never edit it, never build it. `archive/rust/` is the retired Rust implementation — read `archive/README.md` before re-proposing a daemon, a proxy or a relay. `archive/zone/` is the workstation-side zone: the route, the NRPT rule, `envmux-util`, the session CA and `envmux ca`, retired when the browser proxy made them unnecessary; its README names the commit they were last live at |

## Build, test, run

Needs the .NET 10 SDK. Node 24 if the portal page should be in the binary.

```console
dotnet build                                                   # also the lint: warnings are errors
dotnet test                                                    # hundreds of tests, a few seconds
dotnet test --filter "FullyQualifiedName~SlugTests"            # one class; ~Class.Method for one test
BuildPortal=false dotnet format --verify-no-changes            # what CI's format job runs
dotnet run --project src/Envmux -- --directory <abs path> --dry-run
```

- `Directory.Build.props` sets `net10.0`, nullable, `TreatWarningsAsErrors`, `EnforceCodeStyleInBuild`,
  `AnalysisLevel=latest-recommended`. XML documentation is generated so that a stale `<see cref>` fails the
  build. There is no `Directory.Packages.props`: package versions are inline in the two project files.
- `dotnet build` builds `Portal/ui` with Vite when Node is on `PATH` (running `npm ci` there the first
  time), zips it and embeds it. With no Node, or `BuildPortal=false`, the build still succeeds, the portal
  serves a page saying so, and the tests that need the page skip.
- `dotnet run --project src/Envmux` starts the program in `src/Envmux`, not where you typed it, so
  `.envmux.json` is not found. Pass `--directory`, or run `dotnet src/Envmux/bin/Debug/net10.0/envmux.dll`.
- `envmux` and `devenvmux` on `PATH` are installed copies, not this tree. Run what you just built.
- `--dry-run` and `config validate|show|schema` need no host. Nearly everything else talks to a real one.
- The repository is LF (`.editorconfig`); `*.ps1` is CRLF. Guest scripts are built with
  `StringBuilder.Line(...)` from `Shell.cs`, never `AppendLine` — a CRLF breaks a POSIX shell.
- Docs site: `npm ci`, then `npm run docs:build`. On Windows both `docs:build` and `docs:dev` fail
  inside vocs 1.4.1 (backslash paths), so here a docs change is checked by reading it; the workflow builds
  on Ubuntu. A link from `docs/pages` to a file outside it must be a full GitHub URL — vocs rejects it otherwise.
- CI (`.github/workflows/ci.yml`, `docs.yml`) is paused: `workflow_dispatch` only. When run, it is
  restore, Release build, test, `--dry-run` on three platforms, the format check, then a canary release.
  Until it is back, the four commands above are the only gate.

## House style

- **Comments carry the decision.** Types and non-obvious members get `<summary>` plus `<remarks>` saying why
  it is this way and what went wrong the other way; `//` comments do the same. A comment that restates the
  line below it is deleted. No `<param>` that repeats the argument's name (CS1573 is off for that reason).
  Read `HostConfig.cs` or `IncusClient.cs` before writing one, and match the voice: plain, specific, no filler.
- **Everything is `internal`** (tests see it through `InternalsVisibleTo`), types are `sealed` or `static`,
  namespaces are file-scoped. Nothing here is a library; `public` would claim an API that does not exist.
- **`ConfigureAwait(false)` on every await** in `src/`, and `CancellationToken ct` passed through.
- **`CultureInfo.InvariantCulture` on every parse and format, `StringComparison.Ordinal` on every string
  comparison** — what is parsed and printed is addresses, ports and wire formats. The build catches
  none of these three being skipped (checked: a file without them compiles clean), so they are kept by hand.
- **Errors are written for the person at the terminal**: what happened, then the command that fixes it.
  Each area has one `sealed class XException(string message, Exception? inner = null)`; `Program.Main`
  prints `envmux: <message>` for the types it lists, so a new exception type is added to that list.
- **Name the running command with `CommandName.Current`**, not a literal `envmux`, in anything printed for
  somebody to run: a dev build is `devenvmux`, and the wrong name has sent an agent to another program.
- **Pure where it can be.** Config resolution, slugs, the hostname scheme and the wire models have no
  socket, clock or subprocess in them, and that is where the tests are. Tests build the real thing rather
  than mock it (there is no mocking library), and skip with a reason when the machine cannot run them.
- **Verify a protocol against its source, not its prose.** Where a wire format is load-bearing, a test pins it.
- **No new packages without a reason that survives review.** The main project is the framework and
  almost nothing else, and each thing that left (a UI toolkit, a proxy) took its package with it.
- **One project.** A new file earns a folder; a new folder does not earn a project.

## Safety rails

These are what prevent real damage on the workstation this is developed from.

- **Never run these unprompted:** `envmux install` and every `envmux host` subcommand except `status`
  (a real Incus daemon's trust store and networks, `unwire`'s Windows routes and NRPT rules — and,
  with the Hyper-V provider, building, reinstalling or deleting a VM and its disks); `envmux ssh`
  (`~/.ssh/config`); `envmux prune`, `envmux <session>`, `envmux agent start`, `envmux relay`
  (create, delete or exec into instances on the real host); `scripts/release-install`
  (writes `~/.envmux/bin` and `PATH`).
- **`~/.envmux` is the user's live host state** — `host.json`, the client certificate and key, the ssh key,
  and an older version's CA key. Read-only. Anything experimental sets `ENVMUX_HOME` to a scratch directory (`HostConfig.Directory`),
  and `ENVMUX_SSH_HOME` likewise for `~/.ssh`.
- **A test that sets `ENVMUX_HOME` joins `[Collection(HostHome.Name)]`** (`tests/Envmux.Tests/HostHome.cs`).
  It is one variable per process; run in parallel, a test has written `host.json` into the real home directory.
- **TLS validation is never disabled.** incusd's certificate is self-signed, so the pinned fingerprint is
  the whole trust decision (`IncusClient` remarks). The single callback that returns true is
  `LearnFingerprintAsync`, which sends nothing — no client certificate, no request, never a token — and
  trusts nothing: what was presented is either shown to a person, or compared with the fingerprint inside a
  trust token (`InstallCommand.Pin`). The second is not a weakening: the token arrived out of band, from the
  daemon's own CLI, so whatever answers cannot have chosen the value it is held to. Do not add another.
- **Images come only from `HostConfig.DefaultImageServer`.** Incus image handling has had host file
  read/write vulnerabilities; another remote is trusting a stranger with the host.
- **Never print, log, copy or commit key material** — `*.key`, PFX, tokens, kubeconfigs — and never read
  one into a script, a transcript or a chat channel.

## Working material

- `.hive/` is git-ignored and local to a machine: agents' notes, chatroom, decision log, reference clones
  (the prompt-swarm plugin's conventions). Its index is `.hive/README.md`; chatroom, log and watercooler are
  append-only. It may not exist on the machine you are on.
- `.context/` is the older equivalent, also git-ignored. It holds a kubeconfig and third-party credentials:
  do not read those files. `.context/chatroom/` is also the room envmux's own remote agents talk through.

## Where the design lives

- `docs/pages/host.md`, `routing.md`, `browser.md`, `configuration.md`, `cli.md` — what the program does,
  for its users. **When behaviour, a flag or a message changes, the page and the command's usage text change
  in the same commit.** `docs/pages/development.md` is the contributor page; `PLAN.md` the reasoning.
- `docs/backends.md` — the plan for where a session runs: an Incus elsewhere, Kubernetes, the control channel.
- `docs/live-volumes.md`, `docs/vscode-remote.md` — two designs with their spikes under `spikes/`.
- `incus.md` — the specification the Incus design was built from. History; the code and `docs/pages` win.

## Commits

A subject that is a sentence about what changed, imperative, no trailing full stop, optionally scoped:
`Default the editor attach to a dev container, not SSH`, `docs: the host page said the console was exact;
it is gone`, `host reset (incus): refuse a no-token unattended rebuild instead of stranding`. The body
says why, what was verified and how, and what was not; wrapped at about 76. Agent commits end with a
`Co-Authored-By:` trailer naming the model. Do not push, and do not commit to `main`, unless asked.
