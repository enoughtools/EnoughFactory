# Configuration

`.envmux.json` in the project root, committed. Comments and trailing commas are
accepted, so it takes review notes:

```jsonc
{
  // Everything here is optional, and so is this file.
  "name": "myproj",

  "workdir": "/work",
  "shell": "/bin/bash",
  "env": {
    "NODE_ENV": "development"
  },
  "routes": {
    "vite": 5173,
    "api": 3000
  },
  "tasks": {
    // Everything that runs inside this instance, the toolchain included.
    // A session starts from a plain Debian instance, so what has to be
    // installed is declared here rather than baked into an image.
    "node": {
      "command": "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs",
      "kind": "once"
    },
    "install": { "command": "npm ci", "kind": "once", "dependsOn": "node" },

    // --host, because a server bound to 127.0.0.1 inside this machine is
    // reachable from inside it and from nowhere else.
    "vite": { "command": "npm run dev -- --host 0.0.0.0", "dependsOn": "install" },
    "api": { "command": "npm run api", "dependsOn": "install", "ready": 3000 }
  },
  "port": 8080,

  "git": {
    "branchPrefix": "envmux/",
    "base": "HEAD",
    "keepOnExit": true
  },

  "tools": {
    "claude": "auto",
    "gh": "auto",

    // Not a file: this asks git for the credential its own helper holds.
    "git": "auto"
  }
}
```

## Don't write it by hand

```console
$ envmux autoconfigure | claude -p
$ envmux config validate
```

`autoconfigure` prints a prompt that gets an agent to read your repository and
write this file, then check its own work. See
[the CLI reference](cli.md#envmux-autoconfigure).

**Unknown fields are rejected, not ignored** — a typo does not silently do
nothing — and `envmux config validate` exits 2 with the specific problem, which
is what makes that loop work.

## Fields

| Field | Type | Default | What it does |
|---|---|---|---|
| `name` | string | the directory name, slugified | The project label — the first label of this session's hostname. The *session* label comes from the command line, not from here. |
| `image` | string | `debian/13/cloud` | The image an instance is created from when there is no golden snapshot to copy. An alias on the official remote, and rarely worth setting. |
| `workdir` | string | `/work` | Where the repository is cloned inside the instance, and its working directory. |
| `shell` | string | `/bin/bash` | What `c` in the TUI hands you. |
| `editor` | path *or* object | found on this machine | How `e` attaches VS Code over SSH. See [Editor](editor.md). |
| `tasks` | object | `{}` | Everything that runs inside the instance — the toolchain, the installs, the dev servers — with a `dependsOn` tree over them and the services. A task's `ready` port says when it is up; its `url` pattern says where in its output the URL to open is, for servers that print a token. See [Tasks](tasks.md). |
| `env` | object | `{}` | Environment variables for the session. Values are literal — no interpolation. |
| `envFile` | path *or* list | none | Files on **this machine** to read the environment from, relative to the project. For the gitignored `.env` the bundle does not carry. See below. |
| `features` | object | `{}` | Dev container features to install, spelled as `devcontainer.json` spells them. Installed once into a project image every session is copied from. |
| `routes` | object | `{}` | Route name to the port the server binds. Each is opened at `http://localhost:<port>/` in the session's [browser](browser.md), whose `localhost` is the instance. See below. |
| `backend` | `"incus"` *or* `"docker"` | `docker` | What the session runs on: an Incus host, or the Docker engine on this machine. `--backend` wins over it. |
| `port` | number *or* range | `8080` | The loopback port the portal is served on, or the range to claim within. See below. |
| `services` | object | `{}` | Machines this session depends on. See [Services](services.md). |
| `generate` | object | `{}` | Environment variables envmux makes up once per session. See [Services](services.md#generated-values). |
| `domain` | string | the host's DNS domain, usually `envmux` | The domain the session's instance and services are named under inside the host: how a task reaches a service. Nothing on this machine resolves it; the session's proxy carries names under it into the instance, and ssh uses it for its aliases. |
| `portal.enabled` | bool | `true` | Serve the session as a page on loopback: tasks, their output, the routes, and shells in the instance. See [Portal](portal.md). |
| `portal.token` | bool | `true` | Ask for a per-session token first. Turning it off hands a shell in your instance to anything else on this machine. |
| `portal.open` | bool | `false` | Open a browser at the portal when the session starts. |
| `browser.enabled` | bool | `true` | Claim a SOCKS5 port on loopback for this session, so `b` can open a browser whose `localhost` is the instance. See [Browser](browser.md). |
| `browser.egress` | `"local"` *or* `"instance"` | `"local"` | Where that browser's other traffic leaves from. `local` keeps maps, fonts and SSO working as they do in any browser here. |
| `browser.port` | number *or* range | `1080` | The loopback port the proxy claims, or the range to claim within. Walks upward when taken. |
| `browser.use` | `"chrome"`, `"firefox"`, `"edge"` *or* path | the first found | Which browser `b` opens. |
| `browser.open` | route name *or* URL | the first web route, by name | Where `b` opens. A route opens at `http://localhost:<port>/`. A name that is not a route is an error. |
| `browser.color` | `"#rrggbb"` | one of ten, from the session's name | The Chrome or Edge profile's colour theme, so each session's window is its own colour. Set when the profile is first made. |
| `git.branchPrefix` | string | `envmux/` | Prefixed to the session name to make the branch. |
| `git.base` | string | `HEAD` | What the session's branch is created from. |
| `git.keepOnExit` | bool | `true` | Whether the instance outlives the session. See below. |
| `tools` | object | none | Host tool state to copy in so agents arrive logged in. `"auto"`, `"off"`, or a path. Each one you can sit in front of also gets a button in [the portal](portal.md#a-button-per-tool). See below. |

## `envFile` carries the secrets git was told to ignore

The repository crosses to the instance as a git bundle, so it carries what git
tracks. A `.env` in `.gitignore` — which is where a project's local secrets
normally are — does not, and the session gets the code without what makes it run.

```jsonc
{ "envFile": ".env" }
{ "envFile": [".env", ".env.local"] }
```

Read on this machine, merged into the session's environment, and written into the
instance where every shell finds it. Later files win over earlier ones, and the
literal `env` block wins over all of them — that one is written down in the
repository and is the more deliberate of the two.

A file that is not there is skipped. The declaration describes the project; a
machine where it has not been set up yet should hear about that from whatever
needed the value, not from a config parser.

**This is secrets leaving your machine**, so it is named rather than found.
envmux does not go looking for dotfiles.

## `features` installs a toolchain, once

```jsonc
{
  "features": {
    "ghcr.io/devcontainers/features/dotnet:2": { "version": "10.0" },
    "ghcr.io/devcontainers-extra/features/bun:1": { "version": "latest" },
    "ghcr.io/devcontainers/features/docker-in-docker:2": { "moby": false }
  }
}
```

Spelled exactly as `devcontainer.json` spells them, so a project that has one can
have its `features` block copied across unedited.

They install into a **project image** — the golden snapshot with this toolchain on
top — which is built once and copied per session. A .NET SDK and a browser is
minutes; paying that per session is the difference between a tool worth using for
a five-minute question and one only worth it for the afternoon.

The image's name carries a hash of the base and the features, so it cannot drift
from the config: change a version and the next session finds no image under that
name and builds one.

That hash is over what you wrote, not what it resolves to. `node:1` is a floating
tag — republished upstream with a newer node, the hash does not move and the
existing image is reused. That is the right default, because a toolchain that
changed under you without the config changing is worse than one that is a few
weeks old. To rebuild against whatever is current, `envmux prune` removes an
image nothing is built on and the next session makes a new one.

What is **not** taken from a `devcontainer.json` is its base image. The base is
always the golden snapshot, because that carries what envmux itself needs — the
multiplexer every task is latched into, sshd for the editor, the agent — and
features are written to layer onto a Debian or Ubuntu base, which is what that is.

> A feature whose name mentions Docker also turns on `security.nesting` for the
> instance, because a system container cannot start containers without it. That
> is derived rather than declared: a project asking for Docker wants Docker to
> work, and one that is not should not carry the permission.

## `tools` carries credentials, and only when asked

`claude`, `codex`, `gemini`, `opencode` and `gh` are directories on this machine,
copied into the instance under the session account's home. Claude Code itself is
already in the image — a signed-in agent with no binary is not a signed-in agent
— so what travels is the part that is yours.

`git` is the odd one, and is not a file. A session clones from a bundle and has
no remote, so the moment anyone adds one and pushes, they need whatever this
machine authenticates with. Looking for `~/.git-credentials` finds nothing on a
typical Windows workstation: Git Credential Manager keeps the token in the
Windows Credential Manager, which is not a file and has no Linux counterpart.

So envmux asks git rather than looking. `git credential fill` runs whichever
helper the host has configured, wherever it keeps things, and answers the same
four lines either way — which is also why this works unchanged from a macOS
keychain or a Linux libsecret. Inside the instance it lands as
`~/.git-credentials` with the `store` helper, mode 0600, owned by the session
account.

Only the hosts **this repository's own remotes point at**. A credential store is
not enumerable through that interface and should not be; asking for what the
repository needs is both possible and the right amount.

**All of this is a credential leaving your machine**, which is why none of it has
a default. Nothing is carried unless it is named here, and `envmux init` fills in
what it found rather than deciding for you.

## `routes` takes a port, and what is on it

```jsonc
{
  "routes": {
    "api": 3000,
    "vite": 5173,
    "dashboard": { "port": 15260, "tls": true },
    "db":        { "port": 5432, "scheme": "postgres" }
  }
}
```

The port a server binds is the port it is reached on — `http://localhost:3000/`,
in the session's [browser](browser.md), where `localhost` is the instance. It
reaches a server bound to the instance's own `127.0.0.1` too, which nothing else
can. There is nothing to translate, so there is nothing to declare about the
translation. Two sessions both have a `localhost:3000`; each has its own browser.
The name is a label for the list, the log line, and `/browser <name>`.

What is left to declare is what the server on the other end **is**: some of it
speaks TLS with a certificate of its own, and some of it is not HTTP at all —
and envmux carries bytes, so it cannot find out. `"tls": true` is the one-bit
shorthand; `"scheme"` is the same field spelled out, for a Postgres or a Redis.
Saying both is refused rather than resolved.

Two routes on one port are refused: there is nothing left to tell them apart, so
that was a mistake in the declaration rather than a routing feature.

A route whose URL is more than its port — a server that prints a login token as
it starts, the way Aspire's dashboard does — takes that URL from the task that
runs it, not from here. Put `"url": "<regex>"` on the task; the route on the
task's `ready` port, or with the task's name, shows what it printed, with the
host swapped for this session's own name. See
[Tasks](tasks.md#a-url-with-a-secret-in-it).

The thing that *does* follow from having a real address: **a server bound to
`127.0.0.1` is reachable from inside the instance and from nowhere else.** Give
anything behind a route `--host 0.0.0.0` in its task command. See
[Routing](routing.md).

## `port` takes a number or a range

```jsonc
{ "port": 8080 }            // prefer this, walk upward 20 if it is taken
{ "port": [2050, 2060] }    // claim somewhere in here, and nowhere else
```

This is the portal's port, and the only one envmux allocates. Nothing in the
instance is reached through it.

A bare number still walks, because a single port with no room to move would fail
the moment a second session started. A **range** is a promise: this project's
sessions live in here and nowhere else, so a firewall rule or a bookmark can name
it. envmux refuses to spill past the end of it.

## `git.keepOnExit`

```jsonc
{ "git": { "keepOnExit": true } }   // the default
```

A session's **commits** are bundled back into your repository when it ends.
Anything **uncommitted** lives only in the instance.

So the instance is kept by default: stopped, not deleted. That is what makes
starting the same session again pick it up where you left it — dependencies
installed, uncommitted work in place, latched tasks still running — and on a
copy-on-write pool it costs almost nothing.

`false` deletes it instead, *except* when the tree is dirty, where envmux keeps
it anyway and says so in the summary. Deleting somebody's uncommitted work
because a default said so is unforgivable, and so is doing it because a flag did
without checking.

`envmux prune` is how a kept instance goes.

## The session name is not in here

It comes from the command line, because it changes every run:

```console
$ envmux              # generated, e.g. amber-fox
$ envmux feat-login   # named, when the session is a task
```

That one name becomes the branch, the instance, and the name that instance
answers on — so nothing has to be correlated by hand across several sessions
running at once.

Because it is also a DNS label, `{project}-{session}` has to fit in 63
characters. envmux checks before creating anything, rather than letting Incus
refuse several seconds into a session that looked like it was starting.

## No file at all

`envmux` in a directory with no `.envmux.json` still runs. It takes the directory
name, copies the golden snapshot, clones your repository into `/work`, and gives
you a session with no routes — a machine with your project on it, and a shell.

That is the floor the design is measured against, and it is why every field has a
default rather than a required marker.

## The repository travels; it is not mounted

`workdir` is where the repository is **cloned** inside the instance, from a git
bundle sent over the files API.

That is the one thing the machine boundary genuinely changed. A session used to
be a `git worktree` bind-mounted into a container, sharing your object store
directly — which is only possible while the container and the repository are on
the same machine. They are not: the instance is inside a VM, and a Windows path
is not something it can be handed.

A bundle is a complete git remote in a single file, so the instance gets real
history, real refs and a real repository rather than a copied directory that
resembles one. When the session ends, its commits come back the same way and are
fetched onto the branch in your repository. `git log envmux/<session>` finds
them, and merging is ordinary git.

It travels over the files API rather than over a git remote on your workstation
deliberately: a remote would mean the instance connecting **inbound** to a
listener on Windows, which the firewall blocks by default on any profile worth
having — a rollout failure that would look like git being broken.

Two consequences to know about:

- **Uncommitted work does not come back.** It is in the instance, which is why
  the instance is kept. Commit before you care about it, the way you would on any
  other machine.
- **If the branch moved on both sides**, the fetch would not fast-forward.
  envmux refuses rather than choosing, writes the bundle to
  `.envmux/<session>.bundle`, and tells you the `git fetch` that reads it.

Nothing the session writes is ever read back through a host filesystem, which is
why the account inside is simply not root rather than a careful reproduction of
your uid and gid. That reproduction existed to stop a bind mount filling your
working tree with root-owned files, and there is no bind mount.

## The other file: `host.json`

`.envmux.json` describes a project. `~/.envmux/host.json` describes the machine
sessions run on, once per workstation, outside any repository — every project on
this host shares it. `envmux install` writes it and you rarely open it, but it is
JSON with comments allowed, and **an unknown field is an error** here too.

| Field | Default | What it is |
|---|---|---|
| `provider` | `hyperv` | `hyperv` — a VM envmux built — or `incus`, a daemon it attached to |
| `api` | *(empty)* | Where incusd answers, as `host:port`. Empty until the host has an address |
| `fingerprint` | *(empty)* | SHA-256 of the certificate incusd presents. Pinning it is the whole of the trust decision; empty means every call refuses |
| `cidr` | `10.100.0.1/24` | The bridge's own address and prefix. Read from the network when it was adopted |
| `dhcpRange` | `10.100.0.100-10.100.0.200` | What the bridge leases. Addresses below it are pinned to instances |
| `dnsDomain` | `envmux` | The zone instance names resolve under. An adopted network brings its own |
| `network` | `envmux0` | The Incus network sessions attach to. Any other name is a network the daemon already had, adopted with `envmux install --network`: read, never reconfigured, never deleted |
| `gateway` | *(empty)* | Written by an older envmux, for the route it added. Read so the file still parses; nothing uses it |
| `resolver` | *(empty)* | Written by an older envmux, for `envmux-util`. Read so the file still parses; nothing uses it |
| `image`, `imageServer` | `debian/13/cloud`, the official remote | What instances are created from, and the only place it is pulled from |
| `vmName`, `switch`, `mac` | `envmux-host`, `External`, `00:15:5D:E5:60:01` | The Hyper-V VM. Unused, and unchecked, under the Incus provider |

`ENVMUX_HOME` moves the whole directory — `host.json`, the client certificate,
the ssh key. That is how one workstation holds a second host: a second
directory, with a range of its own. See
[Two hosts from one workstation](host.md#two-hosts-from-one-workstation).

## Interpolation, secrets, and the things that are not here

`env` values are literal strings. There is no `${HOST_VAR}` expansion, no secret
references, and no credential helper chain.

The archived design had all of it — a helper protocol, a provider chain, platform
keyring integration, and per-workspace credentials minted into a secrets path. If
you need a secret in the instance today, put it in `env` in a `.envmux.json` you
do not commit, or export it in the shell and let your own tooling read it. A
better answer can come back when the shape of the need is clearer than "secrets
are a thing tools have".

## Chef dispatch

`"chef": true` grants the session named `chef` a separate guest bearer capability
for `/api/kitchen/agents` (GET and POST), `/api/kitchen/agents/<name>/stop` (POST),
and `/api/kitchen/agents/<name>/log` (GET). It is scoped to this repository and
allows at most three active workers. The portal and token must be enabled.
Other session names and agent worker plans do not get the chef capability.
`ENVMUX_CHEF_URL` and `ENVMUX_CHEF_TOKEN` are supplied in the chef's environment;
do not print them or carry them into a prompt. The bundled chef skill describes
the requests and commit handoff. The worker runner currently uses Claude Code.

Docker uses a shared envmux network and kernel. No hostile-tenant isolation is
promised. Docker endpoints may use local pipes, Unix sockets or loopback TCP;
remote plain TCP is refused. Use the pinned Incus backend for a remote host.
Codex conversation history, memories, logs and known local state databases are
excluded from tool-state copying. Copied credentials persist in kept volumes;
turning a tool off does not revoke earlier copies.
