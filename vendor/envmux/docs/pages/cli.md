# CLI reference

```
envmux [<session>] [options]
claude "$(envmux autoconfigure)"
envmux agent <command>
envmux code [<session>] [--print]
envmux config [validate|show|schema]
envmux host <command>
envmux init [options]
envmux install [options]
envmux prune [options]
envmux ssh [--print]
envmux relay <instance> <port>      # what ssh runs; not for typing
```

## `envmux [<session>]`

Start a session and attach the window to it.

The session name becomes its branch, its instance, and the name that instance
answers on in the zone. Omit it and one is generated —
`amber-fox`, `jade-lynx` — which is fine for a quick look and less good for
something you will come back to tomorrow.

```console
$ envmux                 # generated name
$ envmux feat-login      # named, when the session is a task
```

Names are slugged the same way project names are, so `envmux feat/login` becomes
`feat-login` everywhere.

EnoughFactory's private supervisor checks `--factory-capabilities` before
launching. With `ENVMUX_MANAGED_DOCKER=1`, it may set
`ENVMUX_MANAGED_GOLDEN_IMAGE` to an immutable `sha256:` image ID already prepared
on its owned engine. Readiness confirms that base ID. A missing image fails
without pulling or building a replacement; a previous session made with another
base is retained and requires a new session name. Feature caches are bound to the
same exact base. Ordinary invocations ignore the image override, and child
agents do not inherit it.

Starting a session whose instance already exists **adopts** it, with everything
still in it: dependencies installed, uncommitted work in place, latched tasks
still running. Reusing a name returns you to your work.

The link to [the portal](portal.md) — the session in a browser tab, on loopback
— is written into the log as the port is claimed, and `p` opens
it. It carries that session's token, and is the only place that token is ever
written down.

The session also claims a SOCKS5 port on loopback, 1080 upward, and `b` opens
a [browser](browser.md) through it whose `localhost` is the instance. Its URL,
with the credentials for tools that are not that browser, is logged beside the
portal's.

### With no `.envmux.json`

envmux asks before it starts:

```
There is no .envmux.json here.

  A session will still start — but with no routes and no tasks, it will
  only hold an instance open. Declaring them is what makes it useful.

  [w]  write one now       envmux init — detects the stack, leaves comments
  [a]  let an agent do it  the prompt, and how to hand it to one
  [c]  carry on without one
  [q]  quit

  >
```

Only when someone is there to answer it. With `--headless`, with output
redirected, or with stdin closed, it carries on silently — a prompt nobody can
see is a hang.

## `envmux autoconfigure`

Prints a prompt that gets an agent to write — or update — this repository's
`.envmux.json`. It is a prompt, not a config:

```console
$ claude "$(envmux autoconfigure)"      # interactive, prompt already in
$ envmux autoconfigure | codex exec
$ envmux autoconfigure | gemini -p
$ envmux autoconfigure | opencode run
```

Claude gets it as an argument rather than on stdin, so it opens an interactive
session with the prompt already in it. Writing this file is a conversation —
which script starts the dev server, is that database real — and a one-shot with
a closed stdin has nowhere to ask.

The declaration is meant to be generated. Something that has read your lockfile,
your compose file and your README's getting-started section will infer the ports
and the commands better than any template, and envmux is not going to out-guess
it. So envmux ships the instructions and you supply the agent — which also means
agents that did not exist when this was written work fine.

**If a config already exists, the prompt says so in its first line** and tells
the agent to read it, keep what is right, keep the comments, and change only
what the repository shows to be wrong — not to replace it wholesale, and not to
delete a field it cannot see the reason for.

The prompt tells the agent:

- **What to look for, and where** — dev-server config for ports, lockfiles for
  the image, `.env.example` and ORM config for services.
- **When to ask you instead of guessing** — an unclear dev command, a monorepo
  serving four things, a database that might not be needed. And never to enable
  `tools` speculatively, because it copies real credentials into a machine that
  outlives the session.
- **How to check its own work**, with the commands below.
- **Every field that exists**, so it never has to guess whether one does.

It also reports what envmux can already see — the marker files in the root and
the coding tools with state on this host.

The prompt names **the command that printed it**, so a build installed under
another name still sends the agent to the right binary.

## `envmux agent`

Remote agents: a headless session on `envmux/<name>` with Claude Code running in
it on a task you hand over, talking through the `.context/chatroom/` room, its
commits back as a branch. See [Remote agents](agents.md) for what one is and how
it ends.

```console
$ envmux agent start feat-login --prompt "Add a login page."     # or --prompt-file task.md, or stdin
$ envmux agent ls                                                 # every agent here, and where each is
$ envmux agent say "@feat-login use the msw handlers" --as hazel   # one line into the room
$ envmux agent read --follow                                      # the last hour, then as it arrives
$ envmux agent logs feat-login --follow                           # its transcript: `envmux logs feat-login agent`
$ envmux agent stop feat-login                                    # end it early; its commits come back
$ envmux agent prompt                                             # brief the agent on this side
```

The verbs are the session's where one exists — `start`/`stop`, `logs` — and the
room's where the room is the thing: `say` and `read` are named for what a person
does in one. `agent run <name>` is the agent itself, the process `start` spawns;
it is in the usage so `ps` can be read.

| Option | What it does |
|---|---|
| `--prompt <text>` | The task, inline |
| `--prompt-file <path>` | The task, from a file. With neither, `start` reads stdin |
| `--as <nick>` | Who you are in the room. Default `chef` |
| `--to <name>` | `say`: prefix the line with `@name` |
| `--buckets <n>` | `read`: how many quarter hours back. Default 4, the last hour |
| `--follow`, `-f` | `read`, `logs`: keep printing as more arrives |
| `--portal <url>` | Drive a running session's portal API instead of acting directly — the link the session logged, `?k=` and all. `ENVMUX_PORTAL` does the same |

Everything but `run`, `logs` and `prompt` has two ways of happening: through a
running session's portal when given its link, or directly against the same
files — `.envmux/agents/` for the registry, `.context/chatroom/` for the room —
and the same host. The outcome is the same: the room is watched, so a line said
either way is on the other side as it lands, and the registry is read on every
ask.

`start` prints what to do next and names the command that printed it. It warns
when `claude` is not in `tools`, because the agent then arrives signed out.

## `envmux code`

Attach VS Code to a session running in this directory — the same thing the `e`
key does, from another terminal.

```console
$ envmux code                 # one session running here: that one
$ envmux code feat-login      # name it when there are several
$ envmux code --print         # write the link instead of opening it
```

It needs nothing from the session process. The link is derived from the
instance's name, so this and the running session agree without talking to each
other. With several sessions running and no name given, it lists them rather
than picking somebody's afternoon for them.

By default it attaches as a **dev container**, bringing the Docker endpoint up if
nothing is serving it (below). `"attach": "ssh"` in `.envmux.json` opts a session
into a Remote-SSH window instead. See [Editor](editor.md) for both.

## `envmux docker`

Serve the Docker-compatible endpoint that VS Code's Dev Containers extension
attaches to — a session's instance, presented to the editor as a container, which
is the **default** way the editor buttons attach.

You rarely run this yourself: the editor buttons (`envmux code`, `e`, the portal)
start it on demand and hold it open with a lease, and it closes itself once
nothing needs it. Run by hand it serves until Ctrl-C, which is useful for
watching it work.

```console
$ envmux docker               # serve until Ctrl-C (mostly for watching it)
$ envmux docker --print       # print the address and how to point VS Code at it
```

It presents a per-user named pipe on Windows (`\\.\pipe\envmux-docker`) and
translates every Docker call the extension makes into an operation against the
IncusOS host: a container is an instance cloned from the golden snapshot, and the
editor's server is installed and reached over the exec channel — no published
port, no TCP listener. Loopback and filesystem only, because the Docker API is
unauthenticated.

The editor buttons need **nothing configured in VS Code**: the attach link
carries this endpoint's address, so the extension reaches it with no
`settings.json` edit — it only needs a `docker` CLI on `PATH`, which it requires
anyway. `--print` shows the address for wiring a plain `docker` up by hand.

**Windows only so far.** macOS and Linux will offer the same endpoint on a unix
socket, and default to SSH until they do; the design is in
[`docs/vscode-remote.md`](../vscode-remote.md).

## `envmux config`

The loop `autoconfigure` tells the agent to use. None of these need a host, git,
or a running session.

```console
$ envmux config validate    parse it, resolve it, report what is wrong
$ envmux config show        the resolved result, with defaults applied
$ envmux config schema      every field envmux accepts
```

`validate` exits **0** when the file is good and **2** when it is not, which is
what makes it usable in a loop:

```console
$ envmux config validate
.envmux.json is not valid
  .envmux.json: 'volumes' is not a field envmux knows. Run `envmux config schema` for every field it accepts.
```

**Unknown fields are errors, not ignored.** A typo or an invented field that
silently does nothing is the worst possible outcome — most of all when something
is writing the file and checking its own work.

It also warns about things that parse but are probably wrong, without failing:

```console
$ envmux config validate
.envmux.json is valid
  project   demo
  image     node:latest
  routes    none — nothing will be reachable in a browser
  services  db(postgres)
  warning   services are declared but no routes — nothing will be reachable in a browser
  warning   task 'web' looks like it backgrounds something — it does not need to. envmux holds the task open and shows its output; a task that backgrounds itself hides that output and exits immediately
  warning   image 'node:latest' is unpinned — a moving tag makes sessions differ over time
```

`config show` prints environment variable *names* only. `envmux --dry-run` shows
their values, including generated passwords; a resolved config is the sort of
thing that ends up pasted into an issue.

## `envmux init`

Write a `.envmux.json` that fits this repository.

Detects the stack from a marker file (`package.json`, `Cargo.toml`, `go.mod`,
`pyproject.toml`, `requirements.txt`), proposes an image and likely routes, finds
the coding tools that have state on this host, writes a commented file, and adds
`.envmux/` to `.gitignore`.

```console
$ envmux init
wrote .envmux.json
  tasks  toolchain, install
  routes vite:5173, api:3000
  tools  claude, codex — mounted, so they arrive signed in
  added .envmux/ to .gitignore
```

`--force` overwrites an existing file.

You never have to run this: envmux works in a directory with no config at all.
It exists to show you what the defaults were and give you something to edit.

## `envmux prune`

Remove the instances sessions leave behind. They are kept on purpose — starting
a session again picks one up where you left it — so they accumulate.

| | |
|---|---|
| *(no flags)* | Stopped instances with nothing uncommitted in them |
| `--dry-run` | Report what would go; remove nothing |
| `--all` | Also take down instances that are still running |
| `--force` | Also remove instances with uncommitted work in them |

A service is kept when its session is. Keeping a session for its uncommitted work
and then removing its database is a state nobody asked for: the session comes
back with an empty one, and whatever the work was doing has to migrate again.

Only instances envmux made **for this repository** are considered: each carries
the directory it was started in as a label, and one belonging to another project
is not this command's to remove.

Without `--force` a stopped instance is started just long enough to ask whether
its tree is dirty. That is slower than not asking, and the alternative is
deleting work without having looked.

Removing an instance does not remove its commits. Those were fetched into this
repository when the session ended, and `git log envmux/<session>` still finds
them.

A project's toolchain image goes too, under three conditions. **After its
sessions**, and **only when none are left** — on a copy-on-write pool a session is
a clone of that image's snapshot, and removing what a clone came from is at best
refused. And **never while the image itself is running**: a running image is one
being built by an envmux in another terminal, and during a build there is no
session instance yet to say the project is busy. `--all` covers that case as well
as running sessions.

In practice the images that matter are the superseded ones, and nothing is
running on those.

The branch goes with the instance **only when there is nothing on it**. That test
is `git branch -d`, which refuses a branch holding commits reachable from nowhere
else — so a session that brought work back keeps its branch, and a session that
produced nothing does not leave one behind forever.

## `envmux install`

Install the downloaded native executable into `~/.envmux/bin`, add it to your
user PATH, and check Git and the Linux Docker engine. On Windows, run
`.\envmux.exe install` from the extracted archive; on Unix use `./envmux install`.
Open a new terminal, then run `envmux --version`. No administrator privileges,
.NET or Node are needed. The release archive includes its own getting-started
README and embedded project skills.

`--check` checks prerequisites and writes nothing. `--no-path` installs the
executable without updating PATH. Windows updates your user PATH; bash/zsh
startup files or fish configuration are updated on Unix. Other Unix shells
use `.profile`. `ENVMUX_HOME` overrides `~/.envmux`; only its `bin` directory
is written. SDK builds can use `--check`, but must use the development install
scripts rather than copying an SDK apphost. Repeated identical installations
are safe, including running `install` from the installed executable. Close other
envmux sessions before replacing an executable Windows has locked.

After installation, in a committed repository:

```console
envmux init --skills both
envmux config validate
envmux first-session
```

### Optional Incus and Hyper-V hosts

Use `envmux install --provider incus` to attach to an existing daemon, or
`envmux install --provider hyperv` to build an IncusOS VM. Plain `install`
defaults to Docker and never builds a VM.

The whole host build, asked rather than typed. Ten steps on the Hyper-V path —
six when it attaches to an Incus you already run — each of which is one of the
`envmux host` commands below, plus the parts that are tedious by hand: it
reads the published image index and verifies what it downloads, creates the
virtual switch, suggests a range nothing else on this machine uses, and waits
out the unattended install so nobody has to watch Hyper-V Manager for the moment
it is safe to detach the media.

The Hyper-V path needs an elevated prompt — a VM and a disk conversion do — and
says so immediately rather than three gigabytes later. Attaching to an Incus you
already run needs no elevation at all: nothing on this workstation is wired.

| Option | What it does |
|---|---|
| `--yes`, `-y` | Take every default; ask nothing |
| `--provider <name>` | `docker` (default, install the executable), `hyperv` (build a VM) or `incus` (attach to a daemon you already run). Any of `--api`, `--token` or `--network` implies `incus`, and nothing is asked. A name it does not know is refused |
| `--api <host[:port]>` | (incus) The daemon's address, instead of being asked. No port means 8443, and the address it prints says so. `https://host[:port]` is accepted and any path ignored; `http://` is refused. Optional with `--token`, which lists the addresses itself; given beside one, a certificate that is not the token's is refused with no question |
| `--token <token>` | (incus) A trust token, from `envmux host prepare` or `incus config trust add envmux`. It also carries the daemon's addresses and fingerprint, so it makes `--api` optional, and the certificate it names is pinned without asking. It can be pasted at the address prompt instead. Expired, it is refused with how to mint another; unreadable, it is sent as it is when `--api` is given. Never printed. Only redeemed when the daemon does not already trust this client |
| `--network <name>` | (incus) Adopt a managed bridge the daemon already has instead of creating `envmux0`. Its range, its DHCP ranges **and its `dns.domain`** are read from it — unset means the zone is `incus`. It is never written to and never deleted. A name that does not exist is refused, and so is a network sessions could not live on |
| `--image <path>` | Use this `.img` instead of downloading one |
| `--version <build>` | Install this build, e.g. `202608201218` |
| `--channel <name>` | `stable` (default) or `testing` |
| `--cidr <a.b.c.d/n>` | The range, instead of the one it suggests. On the Incus provider, only when `envmux0` is being created: a network that already exists has its range read, and this is ignored with a line saying so |
| `--domain <label>` | The zone. Default `envmux`. Ignored the same way, for the same reason |
| `--switch <name>` | The virtual switch. Default `External` |
| `--vm <name>` | The VM's name. Default `envmux-host` |
| `--disk <GiB>` | System disk. Default 256, minimum 50 |
| `--memory <GiB>` | Default 16 |
| `--cpus <n>` | Default 8 |

**Every step is skipped when it is already done**, so running it again after a
failure resumes rather than restarting. The two slow parts — a ~600 MB download
and a ~25 minute install — are never repeated.

A redirected stdin behaves as `--yes`, because a prompt nobody can see is a hang
and this is exactly the command somebody puts in a setup script.

The Hyper-V steps: the range, the certificate, the image, the switch, the
install media, the machine, installing, trust, the golden instance, the editor's
key. Only the last asks before it acts, because it is the only one that writes
outside envmux's own directory — the `Host *.<zone>` block in `~/.ssh/config`.

### `--provider incus`

Attaches to a daemon you already run. [Host](host.md#an-incus-you-already-run)
is the guide, and [the playbook](playbooks/add-remote-host.md) is the same thing
as a procedure.

```console
$ envmux install --provider incus --token <token>
$ envmux install --provider incus --token <token> --network incusbr0
$ envmux install --provider incus --api 192.168.19.43 --token <token>
```

Six steps: the range, the certificate, the daemon, the network, the golden
instance, the editor's key. **Step 1 asks nothing** on this path — it says the
range waits for step 4 — because a network that already exists has a range of
its own. Step 4 reads `envmux0` if another workstation already made it, or the
network `--network` names, and takes its range and zone into `host.json`; only
when `envmux0` has to be created are the two asked for. `--cidr` and `--domain`
given against an existing network print that they do not apply.

**The token is enough.** It carries the addresses the daemon listens on and its
certificate's fingerprint, so with no `--api` envmux tries them, keeps the one
that answers with the matching certificate, and pins it without asking — it
prints a `tried` line saying how each address went, then `matches the token`.
A token pasted at the address prompt works the same way. `--api` beside a token
is for choosing the address yourself, and it is held to the same check: a
certificate that is not the token's is **refused, with no question**, and the
token is not sent. `--api` with no token prints the address, the subject and the
fingerprint and asks before pinning — unless that fingerprint is the one already
pinned. A `--token` envmux cannot read is sent as it is when there is an `--api`
to send it to, and says so; an expired one is refused with how to mint another.
A daemon that already trusts this client is not given it at all.
`envmux host prepare` is what mints one.

**Where the daemon is does not matter**, beyond its API answering. A session is
reached through its [browser](browser.md) and its ssh alias, both over that
API, so a daemon on the far side of an overlay or the internet is as good as
one on the LAN.

**A swap is detected, not declared.** Running this over a `host.json` that
describes a Hyper-V host — or the reverse — is noticed at step 1, and asked
about: *swap this workstation to the new host?* The range and the zone are kept;
the old host's address and fingerprint are forgotten; the old host itself is not
touched. [The swap playbook](playbooks/swap-host.md) is the whole procedure,
with its rollback.

## `envmux host`

The same steps, one at a time, for a machine where one of them needs doing
differently — and what `install` calls. Run it with no arguments for the list,
and see [Host](host.md) for what each one does.

| Command | What it does |
|---|---|
| `status` | The configuration, the provider, the VM when there is one, an older envmux's route and NRPT rule if this workstation still has them, the API, the network, and what is running. Safe at any point |
| `init` | Write `host.json` — the range, the zone, the VM's name and MAC. `network` is written by `install`, which is what learns it |
| `cert` | Generate the client certificate the host will trust on sight |
| `build <img>` | Seed a copy of the install image and convert it to VHDX |
| `vm` | Create the Generation 2 VM: Secure Boot off, vTPM on |
| `installed` | Detach the install media, so it does not install again |
| `screen` | Save a PNG of the VM's screen. The only way to see a machine with no shell |
| `console` | Print what the VM's serial port is saying. Silent on current images, which seed no console |
| `prepare` | (incus) Print the script that gets an Incus host ready: `core.https_address` if unset, IPv4 forwarding and the forward-accept where Docker or ufw is in the way — the instances' own way out — and a trust token, printed last. The script is the only thing on stdout, so it pipes to the clipboard; what it is goes to stderr. `--ssh user@host` runs it over your own ssh, keeps the token line off the screen, and offers to continue straight into `install` with it; `--check` reports, changes nothing and mints nothing. `--network` and `--cidr` default to `host.json`'s, or `envmux0` on `10.100.0.1/24`; `--name` is the client's name in the daemon's trust list (default `envmux`). An option it does not know is refused. Idempotent |
| `trust [<addr>]` | Look at the certificate incusd presents, and pin it |
| `unwire` | Remove the route and the NRPT rule an older envmux added to this workstation. Needs an elevated prompt; says so when there is nothing to remove. `wire` no longer exists — nothing is wired — and says so if typed |
| `range` | Move the range on a host that is already up: the network object and `host.json`. Refused on an adopted network, which is not envmux's to move. A leftover `envmux-util` from an older envmux is removed, since it is pinned on the old range |
| `golden` | Build the instance every session is copied from |
| `reset` | Tear the host down and build it again. `--keep-down` stops after the teardown. On the Incus provider it removes envmux's instances, a leftover `envmux-util` among them, and deletes the network only if envmux made it. On either provider it takes off an older envmux's route and NRPT rule when it can |

`screen` is how you see a machine that has no shell and no login. `console` would
be better when it works, because text can be searched and pasted — but envmux no
longer seeds a console device, since naming one was fatal on current IncusOS (see
[Host](host.md#knowing-when-the-install-has-finished)), so the port is silent and
`screen` is the diagnostic. `screen` needs an elevated prompt: the thumbnail API
will not answer otherwise.

## `envmux ssh`

Set this machine up to reach sessions over ssh — which is how the editor
attaches. `envmux install` runs it; this is for when it needs doing again.

```console
$ envmux ssh
  key     ~/.envmux/id_ed25519 (created)
  config  ~/.ssh/config — *.envmux → that key, through `envmux relay` (added)

  Sessions started from now on let it in. Running ones pick it up when they
  are started again. `envmux code` is the editor.
```

Two halves, both idempotent:

- **One ed25519 key**, in `~/.envmux` beside `host.json` and the client
  certificate. Every session authorises it as the session starts. It is never
  regenerated — it is live inside every session currently running, and replacing
  it would lock the editor out of all of them at once.
- **A `Host *.<zone>` entry** at the top of `~/.ssh/config`, naming that key and
  a `ProxyCommand` that reaches the instance. At the *top* because ssh takes the
  first value it obtains for each keyword, so an entry appended below a
  `Host *` you already have would quietly do nothing.

It does not open a shell into a session. `c` in the session window does that, and
`envmux code` attaches the editor.

### The name is an alias

`myproj-feat-login.envmux` resolves nowhere on this workstation — nothing here
routes to the range or answers for the zone. The block makes it an **ssh
alias**: ssh matches the `Host` pattern, never looks the name up, and runs the
`ProxyCommand` instead, handing it the name as `%h` and the port as `%p`. That
command is [`envmux relay`](#envmux-relay), which takes the instance off the
front of the name and opens its port 22 from *inside* the instance, over the
host's API — the same channel the session's [browser](browser.md) uses. Nothing
is routed, resolved or forwarded on this machine, and it works against a host
anywhere the API is reachable from.

### The zone, not `.envmux`

The `Host` line is built from the zone that is actually configured — `dnsDomain`
in `host.json` — plus the `domain` a repository's `.envmux.json` names, when you
run this inside one. So `envmux ssh` from a project with
`{ "domain": "lab.local" }` writes:

```
Host *.envmux *.lab.local
```

Zones are only ever added. Running this from a second project does not take the
first one's zone back out — that project's editor would stop attaching, from a
command run somewhere else entirely. Delete the block to start it over.

A zone that is not a DNS name is dropped rather than written. One of the two
sources is a file that arrives with a checkout, ssh config has no escaping to
reach for, and this is a file that decides what your machine connects to and with
what.

### What it writes

```
# >>> envmux >>>
Host *.envmux
    ProxyCommand "C:/Users/you/.envmux/bin/envmux.exe" relay %h %p
    IdentityFile ~/.envmux/id_ed25519
    IdentitiesOnly yes
    UserKnownHostsFile ~/.envmux/known_hosts
    StrictHostKeyChecking accept-new
# <<< envmux <<<
```

The `ProxyCommand` names **the envmux that wrote the block**, by absolute path,
because ssh runs it from an editor's helper process with whatever `PATH` that
has. A dev build installed as `devenvmux` writes itself; a build run as
`dotnet envmux.dll` writes `"…/dotnet.exe" "…/envmux.dll" relay`, since the
runtime alone would run nothing of envmux's. Run `envmux ssh` again after moving
or reinstalling the binary.

`--print` writes exactly that to stdout and changes nothing — for reading before
you let it happen, or for pasting into a config you manage yourself.

Everything outside the two markers is copied through byte for byte, line endings
included. A block whose end marker has been deleted is **refused rather than
guessed at**: where it stops is a guess, and a wrong guess takes your next `Host`
entry with it. Delete or repair it by hand and run this again.

See [Editor](editor.md#how-it-authenticates) for why each of the key lines is
there.

## `envmux relay`

```console
$ envmux relay <instance>[.<zone>] <port>
```

What ssh runs as the `ProxyCommand` above; it is not for typing, and it is not
in `envmux --help`. It joins its own stdin and stdout to a TCP port inside an
instance: it loads `host.json`, connects to the host exactly as a session does,
and dials the port from inside the instance on `127.0.0.1` and then `::1`, over
an exec carried by the host's API. Stdin closing — ssh hanging up — ends it, and
so does the instance's side going away.

The first argument is the alias as ssh has it; the instance is everything before
the first dot, which is safe because an instance name has no dot in it. When
nothing answers on the port — the instance is stopped, or `sshd` is not up in it
yet — it says so on stderr, which ssh shows, and exits 1. Stdout carries nothing
but the connection.

## Options

| Option | What it does |
|---|---|
| `-C`, `--directory <path>` | Run against this directory instead of the current one |
| `--dry-run` | Resolve everything and report it; start and change nothing |
| `--headless` | Run a session with no UI, until interrupted |
| `--backend <incus\|docker>` | What the session runs on, over `backend` in `.envmux.json`. Default: Docker, even where an Incus host is set up |
| `--print` | See `code` and `ssh` above |
| `--force` | See `init` and `prune` above |
| `--all` | See `prune` above |
| `-h`, `--help` | Usage |
| `--version` | The version |

### `--dry-run`

Everything the session would be, without a host to reach or an instance created.
The whole of config resolution, the hostname scheme and the port walk is
exercised by it, which is why CI runs it as a smoke test.

```console
$ envmux feat-login --dry-run
directory  /home/matt/myproj
project    myproj
session    feat-login
branch     envmux/feat-login  (from HEAD, in this repository)
instance   myproj-feat-login  on envmux0
hostname   myproj-feat-login.envmux  (an address of its own)
host       10.0.0.42:8443
image      debian/13/cloud  (or a copy of envmux-golden/base, when there is one)
workdir    /work  (cloned from a bundle of envmux/feat-login)
shell      /bin/bash
on exit    the instance is kept, so starting this session again picks it up
task       install      npm ci  (once)
task       api          npm run api  (after install; ready on 3000)
task       vite         npm run dev  (after install, api)
portal     127.0.0.1:8080  (token minted per session)
browser    socks5 on 127.0.0.1:1080  (localhost is the instance; the rest from here)

  api           3000  http://myproj-feat-login.envmux:3000
  vite          5173  http://myproj-feat-login.envmux:5173
```

### `--headless`

A real session — branch, instance, workspace, services, tasks — with the log
going to stdout instead of a window, running until interrupted. Task output is
interleaved into it and labelled with the task's name.

For CI, for scripting, and for anything that wants envmux under a supervisor. It
is also what you get told to use if you pipe `envmux` somewhere, because drawing
a TUI into a pipe would be worse than not starting.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Fine |
| 1 | The session, git, or the host failed — the message says which |
| 2 | The command line or the config file was wrong |

### Project skills and Docker selection

`envmux init --skills claude|codex|both` installs the embedded product skills in
`.claude/skills` and/or `.agents/skills`. It preserves an existing config without
`--force`; customized skill files cause a conflict before any skill is copied.
This installs instructions, separately from the `tools` credential settings.

`code`, `logs`, `prune`, and `ssh` accept the same `--backend docker|incus`
selection as sessions, defaulting to the project's backend and then Docker.
SSH blocks include the selected backend in their relay command. Re-run
`envmux ssh --backend incus` to update an older Incus block. Review `--print`
before applying a block; a managed SSH zone can select only one backend at a time.
Prune keeps a workspace it cannot inspect unless `--force` is explicit.

## macOS release candidate

Use the `osx-arm64` archive on an Apple Silicon Mac with Git and Docker Desktop's
Linux engine running. Run `./envmux install --check`, then `./envmux install`,
and open a new terminal. No .NET SDK is required for the native release.

Install Chrome, Firefox or Edge in `/Applications` or `~/Applications` for the
session browser. envmux launches its app-bundle executable with a separate
profile and authenticates proxy connections using macOS `lsof` and `ps`.
Safari is not supported. VS Code Dev Containers uses a private Unix socket;
explicit SSH attach remains available. The macOS binary is unsigned and
unnotarized: verify the release checksum before approving it through macOS.

For a first check, run `envmux init --skills both`, `envmux config validate`,
`envmux --dry-run`, then `envmux mac-smoke` in a Git project with a commit.
Check that the portal opens, the session browser reaches your development task,
and VS Code attaches. Report the command, envmux version and error text, without
credentials, tokens or private repository contents.
