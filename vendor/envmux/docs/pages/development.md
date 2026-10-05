# Development

## What you need

- **.NET SDK 10.0** or newer. `dotnet --list-sdks` to check.
- **A Linux Docker engine**, for the default backend. Docker Desktop on Windows
  works through its named pipe; the Docker CLI is not required. An Incus host
  is the alternative selected with `--backend incus`. See [Host](host.md).
- **Hyper-V and an elevated prompt**, only when building an IncusOS host.
- **Node.js 24**, to build the portal page into the binary and to build the
  documentation site. `dotnet build` says so and carries on without it.

## Build and test

```console
$ dotnet build
$ dotnet test
```

Warnings are errors (`Directory.Build.props`), so a build that succeeds is a
build with nothing outstanding in it.

Try it without a host:

```console
$ dotnet run --project src/Envmux -- --dry-run
$ dotnet run --project src/Envmux -- --directory ../some-project --dry-run
```

`--dry-run` resolves the config, applies the defaults, walks for a free port, and
prints the URLs it would serve. It is deliberately reachable with no host
configured, and so is every `config` and `host` subcommand that does not talk to
one.

### End to end, on a real backend

```console
$ ENVMUX_E2E="incus-remote;docker" dotnet test --filter FullyQualifiedName~ProofOfLifeTests
```

`ProofOfLifeTests` starts a real headless session per target on a throwaway
copy of `tests/proof-of-life` (Vite bound to the instance's own
`127.0.0.1:5174`) and checks it through the session's browser proxy: the
starting page while Node installs, then the app; the instance's name in
`/@vite/env`; the HMR websocket upgrading; Google traffic leaving from this
machine; headless Chrome rendering all of it; and `POST /api/stop` removing
the instance. Several minutes per target, most of it installing Node.

Opt-in only, because it creates instances on a real host and a real engine.
Each `;`-separated entry is `name[=envmux home]`, and the name's first word
is the backend: `incus-hyperv=D:\envmux-hyperv` points a run at another Incus
host's `host.json` without touching `~/.envmux`. Unset, the case skips.

### Checking a Windows beta candidate

These scripts build and check candidates under ignored `artifacts/`. They do
not install a binary, edit PATH, publish a release or rewrite git history:

```powershell
./scripts/beta-verify.ps1 -Docker
./scripts/secret-audit.ps1 -Betterleaks <path-to-betterleaks>
./scripts/release-build.ps1 -Version 0.1.0-beta.1
./scripts/release-check.ps1 -Version 0.1.0-beta.1 -Docker `
  -Archive artifacts/releases/0.1.0-beta.1-win-x64/dist/envmux-0.1.0-beta.1-win-x64.zip
```

`beta-verify -Docker` enables the live fixtures, builds the golden image and
runs the Docker proof of life with scratch envmux and SSH homes. Skipped live
coverage fails the gate; the tmux latch proof is retried using the golden image.
Without `-Docker`, it runs the build, ordinary tests, dry-run and format check.

The secret audit uses [Betterleaks](https://github.com/betterleaks/betterleaks) 1.9.0 in detection-only mode (no live credential validation) and checks tracked working
files, non-ignored new files and all reachable local git history, including the
archive and spikes. It never walks ignored local state. Reports are redacted;
the only exceptions are exact reviewed fixture values in named files.
`-Strict` removes those exceptions, and `-TreeOnly` omits history. A clean scan
does not establish that a credential was never exposed outside this clone.

The builder requires Node 24, packages only the executable, licence and product
skills, writes checksums and source metadata, and refuses an existing output
version. A dirty tree produces a review candidate, not a tagged release.
`release-check -Docker` launches the executable extracted from the archive
through the E2E harness (`ENVMUX_E2E_BINARY`), so the proof covers the downloaded
binary rather than the SDK build. It requires the checkout's Release tests.

The archive also contains `scripts/install-project-skills.ps1`. Given an
explicit `-Directory`, it copies the packaged envmux skills to `.claude/skills`
and `.agents/skills`, or only the tool selected with `-Agent Claude|Codex`.
It is idempotent, copies no sign-in state, and refuses differing existing files.
This is a standalone delivery helper; `envmux init` does not install skills yet.

For a repository reset, `scripts/export-initial.ps1 -Betterleaks <path>` requires
a clean committed tree, runs the secret audit, and exports only `HEAD` into a
new directory under `artifacts/initial-export/`. It does not carry `.git`,
rewrite this clone, make the new initial commit or push. Initialise the reviewed
export as a new repository; pushing the old clone's refs is a different operation.


## Installing it for real use while you work on it

```console
$ ./scripts/dev-install.sh            # or .\scripts\dev-install.ps1
$ devenvmux --dry-run
```

Packs this tree as a .NET global tool and installs it from a local folder, so you
can drive envmux from any directory without cutting a release. Re-run after any
change; it replaces what was there.

The command is `devenvmux`, not `envmux`, deliberately: a half-built binary
shadowing a real install is a debugging session nobody enjoys. `--uninstall`
removes it, `--debug` (or `-Configuration Debug`) installs a build with usable
stack traces.

## Native beta archives

`scripts/release-build.ps1 -Version <version> -Rid <rid>` builds Native AOT
archives without installing anything. The beta workflow runs this on Windows
x64, Linux x64 and ARM64, and macOS ARM64. It enables trimming and size
optimization, strips symbols, and embeds the portal and local skills.
Build on the target operating system and architecture with .NET 10, Node 24
and a native compiler: Visual Studio C++ tools on Windows, clang and zlib
headers on Linux, or Xcode command-line tools on macOS.

`scripts/release-check.ps1 -Archive <path> -Version <version>` checks the
checksum, extracted executable, project initialization with both skills,
configuration commands and dry-run. Add `-Docker` on a prepared development
machine to exercise the extracted native binary through the browser relay,
portal and chef/chat fixtures. `builds.json` records native compilation and
binary/archive sizes alongside the source commit and tool versions.

SDK builds stay managed for development and xunit. AOT and trimming analyzers
remain enabled, and production JSON contracts use source-generated metadata
with reflection disabled. New wire models belong in `WireJsonContext`; ad hoc
responses name their fields explicitly through `WireJson.Object`.

## Installing what a release actually ships

```console
$ ./scripts/release-install.sh        # or .\scripts\release-install.ps1
$ envmux --version
2026.08.27.0808
```

The legacy local publish helper builds — self-contained, single file, compressed,
stamped with the UTC minute — for this machine's platform, installed to
`~/.envmux/bin` as **`envmux`**. This helper retains the older managed publish mode; use the native beta archive
scripts above to verify what the beta release ships.

Use it for the last check before a release, where `dev-install` is wrong for two
reasons: a global tool runs on the SDK that is already on the machine, so it
proves nothing about a binary that carries its own runtime; and it answers to a
command name that appears nowhere in the documentation. Every page here says
`envmux`, and so does every error message the program prints about itself — this
is how you find out whether that is true.

| | |
|---|---|
| `--archive` | Also write a legacy zip or tarball, and `SHA256SUMS.txt`, under `artifacts/dist` |
| `--rid <rid>` | Publish for another platform. It will not run here; it is for reproducing a platform-specific report |
| `--version <v>` | Stamp it with something other than the minute |
| `--uninstall` | Remove the binary, and the PATH entry if the script added one |

It goes in `~/.envmux/bin` and nowhere else, because uninstalling envmux is
deleting `~/.envmux` — a binary somewhere else would survive that and keep
answering. On Windows the script offers to add that directory to your account's
PATH, which is the one thing it writes outside envmux's own directory and so the
one thing it asks about; elsewhere it prints the line and leaves your shell's rc
file to you.

**A build with no Node in front of it is not a release.** `dotnet build` embeds
the portal page when Node is on `PATH` and quietly skips it when it is not, so
the binary still builds, still runs and still routes — and its portal answers
"built without Node". The script says so before the five minutes rather than
after.

## Layout

```
src/Envmux/                    one console app
  Program.cs                   argument parsing, the session loop, the reports
  Commands/InstallCommand.cs   the wizard: build a host or attach to one, then converge
  Commands/HostCommand.cs      building the machine sessions run on, step by step
  Commands/InitCommand.cs      stack and tool detection -> a commented config
  Commands/PruneCommand.cs     the janitor for instances sessions leave behind
  Config/SessionConfig.cs      the .envmux.json model, its loader, its defaults
  Config/Slug.cs               a name -> a DNS label
  Config/PortSpec.cs           a port, or a range, from the same field
  Config/ServiceConfig.cs      service declarations and what each type implies

  Host/HostConfig.cs           the range, the zone, the network, the way in — and where they live
  Host/ClientCertificate.cs    generated offline; the PKCS#12 round trip Windows needs
  Host/Seed.cs                 install/network/incus as JSON, and the tar they go in
  Host/LegacyUtility.cs        removing an older envmux's envmux-util; the rest of it is in archive/zone
  Host/DiskImage.cs            reading GPT, and writing the seed at partition 2
  Host/ImageIndex.cs           the published IncusOS builds, and which one to take
  Host/ImageDownload.cs        fetching one, checksummed before it is unpacked
  Host/Windows/VhdFooter.cs    512 bytes that make a raw image a VHD
  Host/Windows/HyperV.cs       the one VM configuration that works
  Host/Windows/HyperVSwitch.cs the External switch, made when there is none
  Host/Windows/WindowsNetwork.cs  a spare range for a new bridge, and taking an older envmux's route and NRPT rule off
  Host/Windows/Provisioning.cs what this machine has to have before any of it starts
  Host/Windows/Powershell.cs   the boundary, and making its errors readable

  Incus/IncusClient.cs         the connection, and the only place trust is decided
  Incus/IncusApi.cs            the calls, and the operations they wait on
  Incus/IncusModels.cs         what is on the wire
  Incus/InstanceSpec.cs        what a session's instance is, as a request
  Incus/ExecSession.cs         one interactive exec, and the latch it goes through
  Incus/Golden.cs              one-shot commands, and the snapshot sessions copy

  Editor/VsCodeUri.cs          the ssh-remote URI, and the attached-container one
  Editor/EditorDiscovery.cs    finding a VS Code-family editor on this machine
  Editor/EditorLaunch.cs       spawn it and get out of the way
  Git/GitCli.cs                the git CLI, and the bundles that cross the boundary
  Process/ProcessRunner.cs     subprocesses, captured and interactive
  Routing/RouteTable.cs        the hostname scheme, which is all the routing there is
  Routing/RouteListing.cs      what every view lists, portal included
  Routing/PortFinder.cs        the port walk, for the one port left to claim
  Portal/PortalListener.cs     the one listener: Kestrel, on loopback
  Portal/PortalPlan.cs         whether there is a page, and its token
  Portal/PortalHost.cs         the endpoints, and the gate in front of them
  Portal/PortalState.cs        the session as one JSON object
  Portal/PortalShell.cs        a websocket spliced to a pty in the instance
  Portal/PortalAssets.cs       the built page, unzipped out of this executable
  Portal/PortalPage.cs         the two pages the app is not involved in
  Portal/ui/                   the page itself: React, TypeScript, Vite, xterm.js
  Session/Session.cs           the launch sequence, and its exact reverse
  Session/SessionPlan.cs       config + defaults -> what the session will do
  Session/Workspace.cs         the repository in, and the commits back out
  Session/TaskPlan.cs          a task resolved, and the dependency tree
  Session/SessionTask.cs       the latch, the log it is followed by, and the restarts
  Session/ServicePlan.cs       a service, resolved: credentials and the env both sides read
  Session/Bootstrap.cs         the account inside, which is only "not root"
  Session/Generated.cs         passwords, tokens and identifiers, made once per session
  Session/SessionName.cs       petnames, and the one identity they become
  Session/HostUser.cs          who to be inside the instance
  Session/ToolMount.cs         agent state detection, and getting it in there
  Session/SessionLog.cs        the event log
  Ui/Palette.cs                the colours, declared once
  Ui/Rgb.cs                    a colour, as the three bytes a terminal is told
  Ui/ReplCommand.cs            what a typed command means
  Ui/ConsoleModes.cs           the console's modes, borrowed and handed back
  Lean/LeanHost.cs             putting the window on the terminal, and taking it off
  Lean/LeanConsole.cs          the screen, as escape sequences and nothing else
  Lean/LeanFrame.cs            the session, turned into rows of text
  Lean/LeanShell.cs            the loop, the keys, and what they do

tests/Envmux.Tests/            xunit, one file per unit under test

docs/pages/                    the documentation, also the vocs site source
scripts/                       dev-install, for using it while you build it
                               release-install, for the binary a release ships
archive/                       the retired Rust implementation and its docs
```

`DiskImageTests` builds a real GPT image in a temporary file rather than mocking
one, because writing a seed at the wrong byte offset produces an install that
hangs on a machine with no console — the one failure mode there is no way to
debug after the fact.

**One project.** There used to be two, and the boundary between them was an
operating system: the relay was compiled for Linux, statically, ahead of time,
and copied into somebody else's container. There is no relay, so there is one
project.

The archived design had twelve crates, and the boundaries between them mostly
described the daemon's internal seams rather than anything a consumer cared
about. New files earn a folder; new folders do not automatically earn a
project.

## The portal page

`src/Envmux/Portal/ui` is a Vite app. `dotnet build` builds it when Node is on
`PATH`, zips `dist/` and embeds the zip in the executable; with no Node it says
so and carries on, and the portal then serves a page explaining that this build
has none. `BuildPortal=false` in the environment skips it even where Node is
installed.

Working on the page itself wants Vite's dev server rather than a rebuild per
keystroke. Start a session with the token turned off — the dev server proxies
`/api` to it, and cannot be handed a cookie it does not have — and point the
proxy at the port that session claimed:

```console
$ envmux portal-dev                                  # in the project you are testing against
$ ENVMUX_PORT=8080 npm --prefix src/Envmux/Portal/ui run dev
```

```jsonc
// .envmux.json, in whatever project you point it at
{ "portal": { "token": false } }
```

The websocket proxies too, so shells work against the dev server.

## Conventions

**The Web SDK, without a web app.** `Envmux.csproj` uses `Microsoft.NET.Sdk.Web`
because it hosts Kestrel for the portal. There is no `wwwroot`, no launch
profile, and no controller — the HTTP surface is a small API and one fallback
page.

**No packages.** Not a goal in itself; it is what is left. The reverse proxy went
with the port translation it existed to hide, and the UI toolkit went before it.

**Pure where it can be.** Config resolution, slugging, the hostname scheme, the
seed, the GPT reader, the VHD footer and the wire models have no sockets, no
clock and no subprocess in them, which is why they are the parts with real test
coverage. The API client and the TUI are shells around that core.

**`internal`, with `InternalsVisibleTo` for tests.** Nothing here is a library and
nothing outside the process consumes these types. Making them public would be
claiming an API surface that does not exist.

**Comments explain decisions, not mechanics.** If a comment restates the line
below it, delete it. If a line looks wrong until you know why it is that way, the
comment is the why. Several of the more surprising choices — the delimiter, the
Windows domain, why the port walk only probes — carry their reasoning in the code
because that is where the next person meets them.

**Verify a protocol against its source, not its prose.** The seed schema is
checked against the Go structs in `lxc/incus-os`, and one field the documentation
places at the top level actually nests inside `preseed` — accepted silently,
installs nothing, and surfaces days later as `auth: untrusted`. Where a wire
format is load-bearing, the test is the place that says what it is.

## The documentation site

The Markdown under `docs/pages/` is both what GitHub renders and what the site is
built from — one source, so the web version cannot quietly drift from the repo.

```console
$ npm ci
$ npm run docs:dev      # local preview
$ npm run docs:build    # into docs/dist
```

## The archive

`archive/` is the Rust implementation and the v1/v2 design documents, retired on
2026-08-15. It is not built and not tested, and CI ignores it. It is worth reading
before re-proposing something: several ideas in it were tried and abandoned for
reasons written down at the time. `archive/README.md` is the index.

CI now checks pushes to main and pull requests. Immutable beta tags trigger a
Windows x64 draft prerelease; the old rolling canary publisher is removed.
Review `docs/pages/beta.md` before making the draft public. `init --skills both`
now installs the embedded skills directly; the PowerShell helper remains useful
for an unpacked archive. Live Docker/archive evidence and a second clean-machine
onboarding test remain separate from hosted CI's unit tests.
