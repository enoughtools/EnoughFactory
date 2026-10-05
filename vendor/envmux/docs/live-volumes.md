# Live volumes: a session reads the workstation's state as it is now

Adds a second way for a session to get at the workstation's coding-tool state.
Today it is copied in once at session start and goes stale. This makes it a
filesystem the session reads through to the workstation, per path, under a key
minted for the task that is reading.

> **Status: demonstrated end to end, as a spike, with Claude Code running on
> it.** A container on the envmux host mounts this workstation's `~/.claude`;
> Claude Code started inside it **arrives signed in** (a real completion on the
> Max plan), lands on the prompt with no theme chooser and no trust dialog,
> has the workstation's `settings.json` and the one plugin the session declared
> (`claude plugin list` shows it enabled, its skills are visible to the model),
> keeps its own `projects/` on its own disk, and `git credential fill` inside
> the container answers from the workstation's Git Credential Manager. Nothing
> it wrote reached the workstation's own files. Three tasks in one instance
> hold three differently scoped keys and cannot see each other's files, mounts
> or credentials. Measurements in §9; the reproduction is
> [`spikes/live-volumes/`](../spikes/live-volumes). Demonstrated 2026-08-30 and
> 2026-09-03 on Incus 7.4 / IncusOS 202608251738, kernel 7.1.10-zabbly+,
> Debian trixie guest, rclone 1.60.1, fuse3 3.17.2, Claude Code 2.1.231.
>
> **Not yet in the product.** Nothing under `src/` reads this. §11 is the
> implementation map. The repository itself is **not** a live volume and never
> will be: it travels as a git bundle, copied on launch, exactly as today. Live
> volumes are for dotfiles — credentials, settings, plugins — and only those.

---

## 1. Given

Stated as fact, not to be re-derived:

- envmux runs on the workstation and talks to incusd over HTTPS with a pinned
  certificate. It is daemonless: nothing of envmux runs when no session does.
- A session is an Incus instance with an address of its own, on the `envmux0`
  bridge inside the IncusOS VM.
- The workstation holds the coding tools' state — `~/.claude`, `~/.codex`,
  `~/.config/gh` — and it is the workstation's, not a session's.
- `ToolMounts` already copies that state in at session start, minus the bulk it
  measured and excluded. That path stays; this is a second one.

## 2. The problem this solves, and the one it does not

Two things are wrong with copying, and they pull in opposite directions.

**A copy goes stale.** `~/.claude/.credentials.json` holds an OAuth access token
that Claude Code refreshes on its own schedule. A session handed a copy of it in
the morning is a session whose credential expires during the afternoon, and the
repair is to end the session and start another. The same is true of anything
the workstation edits while a session is open: a new MCP server, a changed
setting, a plugin installed an hour ago.

**A copy is indiscriminate.** Measured on this workstation, `~/.claude` is
317 MB of `projects/` and 15 MB of `file-history/` — every transcript of every
other repository. `ToolMounts.IsHistory` exists to keep that out, and the
comment there gives both reasons: a minute per session, and a session opened for
one repository being handed the conversation history of every other one.

So the same mechanism has to be live for some paths and absent for others, and
which is which is a decision, not a heuristic. That is the whole design: **a
filesystem whose contents are routed per path, by policy, over the connection
envmux already has.**

What this does **not** solve, and should not be asked to: getting the
repository in. Code arrives as a git bundle and leaves as one, and that is
right — a working tree is not something to read over a socket a file at a time.
This is for the small, live, credential-shaped files, and for the large ones
only when someone asks.

---

## 3. Transport: an Incus proxy device

The guest has to reach a server on the workstation, and the workstation is not
the Incus host — incusd runs in a VM one hop away, and the container is behind
that VM's bridge.

Incus has this built in. A **proxy device** with `bind=instance` listens inside
the instance and connects from the host on its behalf:

```json
{"devices": {"envmux-live": {
  "type":    "proxy",
  "bind":    "instance",
  "listen":  "tcp:127.0.0.1:8079",
  "connect": "tcp:192.168.19.21:8079"
}}}
```

The guest sees `http://127.0.0.1:8079`. Nothing inside the container is
configured, no address is baked into an image, and the device is rewritten when
the session starts, so the workstation's DHCP lease can move without anything
in the guest knowing. It is the same shape as `DOCKER_HOST` being carried in the
attach URI rather than written into a `settings.json`: **the address is part of
what envmux builds, not part of what the user maintains.**

> **Verified.** Both `listen=tcp:127.0.0.1:8079` and
> `listen=unix:/run/envmux/live.sock` work, the second with `mode`, `uid` and
> `gid` honoured. The unix socket is the tidier object — file permissions, no
> port inside the container at all — and is not what this uses, because rclone's
> HTTP backends take a URL and cannot dial a socket. If the client is ever
> replaced with one that can, the device changes and nothing else does.
>
> The unix socket also needs its parent directory to exist before the device is
> attached: `bind: no such file or directory` otherwise.

### 3.1 Why the listener is not on loopback, and what that costs

The container cannot reach the workstation's `127.0.0.1`. The server binds the
one interface that faces the Hyper-V switch the VM is on, found by opening a UDP
socket towards the Incus API and reading back the local endpoint — the route to
incusd is the route the answer comes back on. Not `0.0.0.0`: this endpoint
serves the credential the workstation signs in with and has no business
answering on a café network.

> **Verified, and it is the finding that shapes §5.** The container reaches
> `192.168.19.21:8099` directly, without any proxy device — `envmux0`
> masquerades, so the connection arrives from the VM's address. And a
> connection made *through* the proxy device arrives from that same address.
> The listener therefore cannot tell one instance from another, cannot tell a
> proxied connection from a direct one, and must not try. **The proxy device is
> ergonomics, not isolation.** Every authorisation decision is made on the key.

---

## 4. Protocol: WebDAV, and the client is rclone

The client had to be something already written, already packaged and already
maintained, because a FUSE filesystem is not a thing to write for a feature like
this. That fixes the protocol to one an existing FUSE client speaks.

**`rclone mount` over WebDAV.** Of the candidates it is the one whose server
side is a day's work: `PROPFIND`, `GET`, `PUT`, `DELETE`, `MKCOL`, `MOVE`, one
XML shape, and every verb lands on a filesystem call that already exists.

S3 (`s3fs`) was the other candidate and is about the same size to implement, but
a bucket has no directories and no rename, so the mapping back to a directory of
small config files becomes the client's guesswork instead of the server's
statement — and `s3fs` speaks only S3, where `rclone` also gives us
`--vfs-cache-mode`, `--dir-cache-time` and `--attr-timeout`, which is where the
liveness of this design is actually tuned.

Locking is deliberately not implemented. rclone does not ask for it, and one
workstation with one person at it is not where distributed locking earns its
complexity.

### 4.1 What the freshness knobs mean

| flag | value | what it buys |
|---|---|---|
| `--dir-cache-time` | `5s` | a file the workstation added shows up within five seconds |
| `--attr-timeout` | `1s` | a file the workstation rewrote is re-read within a second |
| `--vfs-cache-mode` | `writes` | a tool that opens its config for update gets a real descriptor to seek in; reads still stream |
| `--vfs-write-back` | `1s` | a write inside the session reaches the workstation about a second later |

The cost of lowering the first two is one `PROPFIND` per directory per interval.
That is the dial: freshness against chatter, and it is per namespace, not global.

---

## 5. Authorisation: one key per task, not one per session

A session is not one program. It is an agent, a dev server, a build, a package
install, and every shell anyone opens in the portal — and they are not equally
trusted. The `install` task runs a package manager's postinstall scripts, which
is the least trusted code on the machine, and it has no business reading the
credential the agent signs in with.

So **the unit of authorisation is the task.** Each is minted a key of its own,
scoped to what its declaration asked for:

```
--task agent=claude                            # all of the claude namespace
--task build=claude:plugins,settings.json      # two entries, nothing else
--task docs=                                   # nothing at all
```

A key is 32 random bytes. The store keeps only its SHA-256 and looks up by the
hash of what was presented — one dictionary probe, no secret-dependent
comparison, and it stays one probe at twenty tasks. Keys expire in 12 hours and
can be revoked by id.

Out of scope is answered **404, not 403**. A task that was not given the
credential should find a directory without one in it, not a locked door telling
it where to knock — and a FUSE client turns 403 into `EACCES`, which surfaces to
the tool as a permissions bug on the workstation rather than as a file it was
never offered.

### 5.1 A scoped key is worth nothing on its own

This is the part that is easy to get wrong. If every task in the instance mounts
the same path, then by the time the second task reads a file, the kernel is
already holding it open on the first task's behalf and **no request reaches the
workstation to refuse.** The scope would be enforced exactly once, at mount, and
never again.

So the mount is per task too, inside a mount namespace of its own:

```
unshare --mount --propagation private
  ├─ tmpfs over /root/.config/rclone      # the key, 0600, root-owned
  ├─ rclone mount envmux:claude ~/.claude # as root, --allow-other, --uid <session user>
  ├─ mount --bind <local storage> ~/.claude/projects …
  └─ setpriv --reuid <session user> -- <the task's command>
```

Three things keep the key out of reach of the account the task runs as:

- it arrives on **stdin**, never in `argv` — `/proc/<pid>/cmdline` is world
  readable inside the container and every task runs as the same account;
- it is written to a **tmpfs mounted inside the namespace**, root-owned at
  0600, so it exists nowhere on the instance's disk and nowhere a sibling
  namespace can see;
- it is `unset` from the environment before the task is executed.

> **Verified.** With one task's mount live, the instance's own namespace shows
> an empty `~/.claude`; a concurrent task with `scope nothing` shows an empty
> `~/.claude`; a shell running as the session user finds zero 64-hex strings
> across every readable `cmdline` and `environ`, and `cat`ting the rclone config
> gives `Permission denied`.

### 5.2 Minting, revoking, and the audit log

The server offers a small control API on **loopback only** — a session on the
bridge cannot reach it — authenticated with an admin key envmux holds for the
life of the session:

```
POST   /grant?task=<name>&scope=<scope>    → { id, key, expires }
DELETE /grant/<id>                          → 204
GET    /grants                              → what is outstanding
```

That is the seam the task runner uses: mint when a task starts, revoke when it
ends. Every read of the workstation's own state is appended to
`~/.envmux/live/<session>/audit.log` with the task that asked, and so is every
denial — a task reaching for something it was not granted is the event this
design exists to make visible, and the one line in the log worth an alert.

```
2026-08-29T23:44:51Z agent 0772df5737d8 GET    /claude/.credentials.json
2026-08-29T23:45:07Z build 55bf3e2998a1 DENIED GET /claude/.credentials.json
2026-09-03T00:38:49Z agent 6befde61e76c GIT    github.com
```

### 5.3 Git credentials ride the same mount

envmux already carries git credentials in: `GitCredentials` asks `git
credential fill` on the workstation at session start and writes the answer into
the instance as a `store` file. A copy, with the copy's problem — a GitHub token
issued through Git Credential Manager expires, and a session that outlives it
is one whose `git push` fails with a 401 nothing inside can fix.

The live form is a **virtual namespace on the same mount**: `git/<host>` is a
file whose contents are the four credential lines, and reading it is what runs
`git credential fill` on the workstation — against GCM on Windows, a keychain
on macOS, libsecret on Linux, the same four lines back regardless. The
instance's credential helper is six lines of shell that `cat` that file.

A file rather than an HTTP call from the helper, deliberately. A call would need
a key the helper can read, and the helper runs as the session user, so every
task in the instance could read it too. The mount is already per task, already
keyed, and its key sits where the session user cannot get at it. Putting the
credential behind the mount buys all of that for nothing extra.

Read-only in every verb — `store` and `erase` are never forwarded — and by host
allowlist: the hosts the repository's remotes point at, passed in by envmux,
narrowed further by each key's scope (`git:github.com`). `GCM_INTERACTIVE=never`
and `GIT_TERMINAL_PROMPT=0` on the workstation side, so a host with nothing
stored is an empty answer, not a browser window opening on a machine whose owner
is not looking at it.

> **Verified.** Inside the `agent` task (`scope claude; git`) `git credential
> fill` for github.com returns a username and password. Inside `build` (no
> `git` in scope) `/run/envmux/live/git` does not exist and the same command
> returns nothing. The read is audited as `GIT github.com`.

---

## 6. Policy: what is live, what is the session's

Classification is on the **first path segment only**. A tool's state is
organised at the top level — `projects/` is history, `plugins/` is configuration
— and classifying deeper would mean a policy that has to know the shape of every
subtree.

Four routes:

| route | reads from | writes to | how the guest sees it |
|---|---|---|---|
| **shadow** | the workstation, until the session writes its own copy; then that | `~/.envmux/live/<session>/<ns>/` on the workstation | a file that starts as the workstation's and becomes the session's |
| **live** | the workstation's own tool state | the workstation's own tool state | a file, read and written through the pipe |
| **local** | the instance's disk | the instance's disk | an empty directory the guest binds its own storage over |
| **overlay** | the session's directory on the workstation | the same | a file, private to this session |

For `claude`, **shadow** is `.credentials.json`, `.claude.json`,
`settings.json`, `plugins`, `commands`, `agents`, `skills`; **local** is
`projects`, `file-history`, `todos`, `shell-snapshots`, `cache`, `jobs`,
`sessions` and the rest of what `ToolMounts.IsHistory` already names. **Live is
empty by default.**

> **Correction — shadow is the default, not live.** The first design served
> `plugins/` read-write. The first run of Claude Code inside a session re-synced
> its plugin marketplace on startup: eleven `PUT`s and `MKCOL`s into the
> workstation's own `plugins/`, from a container, on the tool's own initiative.
> Same bytes, this time. The lesson is general — a tool treats its state
> directory as its own and will rewrite any of it — so nothing a container
> writes reaches the workstation unless somebody asked for exactly that, per
> entry: `envmux live sync claude/settings.json` promotes one to live. A
> shadowed directory lists as the **union** of both sides with the session's
> copy winning per file, so a write into `plugins/` does not make the
> workstation's plugins vanish from the listing.

**Unclassified is overlay, never live.** That is the security posture in one
line: a file the workstation holds is served because it was named, not because a
tool asked for it. It also means a tool that invents a new state file still
works, and still does not touch the workstation's copy.

### 6.1 Seeds: the session's first copy is rewritten on the way in

A shadowed file is read from the workstation until the session writes its own.
For a credential that is exactly right. For a file full of this workstation's
absolute paths it is not — so for those, the session's copy is **made at session
start** by rewriting the workstation's, and after that the session owns it.

`.claude.json` is not configuration so much as a machine's diary: startup
counts, cached feature flags, which tips have been shown, and a `projects` map
with an entry per directory the tool has ever been run in — seventy-four on this
workstation, by absolute Windows path, plus twenty-five clone paths under
`githubRepoPaths`. The seed:

- finds the entry for **this** repository (Claude Code keys them `Z:/envmux`,
  forward slashes), re-keys it to the instance's workdir (`/work`), keeps the
  settings it has accumulated (allowed tools, MCP servers), and marks it
  trusted — the session is a checkout of a repository the person already
  opened, and asking again inside a container they asked envmux to make is a
  dialog with no information in it;
- drops every other project, every other clone path, and every remaining string
  that names a place on this machine, mapping only two roots — the project to
  the workdir and `~/.claude` to the instance's `~/.claude`;
- leaves `hasCompletedOnboarding`, `oauthAccount` and the rest alone, which is
  what makes the tool land on the prompt rather than the theme chooser.

`plugins/installed_plugins.json` and `plugins/known_marketplaces.json` record
where each plugin and marketplace is installed, by absolute path. Left alone,
the tool inside the container found its plugin's recorded path unreachable,
concluded the plugin was not installed, and **re-cloned two marketplaces —
eight hundred writes on startup — and the plugin still did not load.** With the
`~/.claude` root rewritten, startup is a hundred writes of housekeeping, and
`claude plugin list` shows the plugin enabled.

### 6.2 Plugins are declared, not inherited

A workstation accumulates plugins; a session is for one repository and gets the
ones `.envmux.json` names, which by default is none. The seed cuts
`settings.json`'s `enabledPlugins` and `extraKnownMarketplaces`,
`installed_plugins.json` and `known_marketplaces.json` down to that list, so the
tool never sees a plugin it was not given and has no reason to fetch one. A
plugin whose marketplace the workstation has no record of can name its source —
`prompt-context@prompt-skills=github:PromptNZ/ai` — and the seed adds the
marketplace entry.

`.claude.json` is the one aliased path: Claude Code keeps it beside the home
directory rather than inside the state directory, so the namespace maps
`claude/.claude.json` to `%USERPROFILE%\.claude.json`. Inside the session,
`CLAUDE_CONFIG_DIR` — which `ToolMount.Env` already sets — makes the tool look
for it inside `~/.claude`, so the guest has one directory and one mount.

### 6.3 Turning one on

```
envmux live sync claude/projects
```

Promotes an entry from the session's own storage to the workstation's: the
server starts serving it, and the guest unmounts the bind that was covering it.
The performance cost is exactly the point — the session now reads 317 MB of
transcripts over a socket instead of having an empty directory — so it is a
thing someone asks for, per session, and never a default.

> **Verified.** With `projects` promoted and the bind unmounted, the container
> lists 21 project directories against the workstation's 21, and reads a
> transcript out of one. No restart, no remount.

### 6.4 Directories are bound, files are routed

Two mechanisms, and the split is principled rather than accidental. A **bulk
subtree** gets container disk, because that is where the performance argument
lives and where a bind mount is a clean instrument. A **single small file** the
policy does not serve gets the per-session overlay, because a bind mount per
file is fragile — a rename over a bind-mounted file fails with `EBUSY`, and
atomic-rename is how config files get written.

---

## 7. What the guest actually sees

```console
$ ls -a ~/.claude
.  ..  .claude.json  .credentials.json  backups  cache  chrome  daemon
downloads  file-history  ide  jobs  mcp-needs-auth-cache.json  paste-cache
plugins  projects  session-env  sessions  settings.json  shell-snapshots
statsig  tasks  todos

$ sha256sum ~/.claude/.claude.json    # 59acfcb8… — the workstation's, byte for byte
$ ls ~/.claude/projects               # empty: this session's own
```

and with a key scoped to `claude:plugins,settings.json`:

```console
$ ls -a ~/.claude
.  ..  plugins  settings.json
$ cat ~/.claude/.credentials.json
cat: /home/matt/.claude/.credentials.json: No such file or directory
```

### 7.1 Claude Code on it

Run inside the `agent` task, as the session user, with `CLAUDE_CONFIG_DIR`
pointing at the mount (which `ToolMount.Env` already sets):

```console
$ cd /work && claude -p "Reply with exactly one word: AUTHENTICATED"
AUTHENTICATED

$ claude plugin list
Installed plugins:
  ❯ prompt-context@prompt-skills
    Version: 0.6.0    Scope: user    Status: ✔ enabled
```

Interactively it lands on the prompt — `Fable 5 · Claude Max`, `/work` — with
no theme chooser and no trust dialog. Its seven skills from that plugin are
visible to the model. Afterwards, on the workstation: `.credentials.json` and
`plugins/` unchanged; the session's overlay holds its rewritten `.claude.json`
(84 keys, one project, zero host paths) and the marketplace housekeeping the
tool did on startup.

---

## 8. Refusals

Checked at the server, so they hold whatever the client does:

| request | answer |
|---|---|
| a key that was never issued | 403 |
| a revoked or expired key | 403 |
| a path outside the key's scope | 404, and a `DENIED` line in the audit log |
| `/claude/../../../.ssh/id_ed25519` | 404 |
| `/claude/%2e%2e%2f%2e%2e%2fDesktop` | 404 |
| `GET` on a directory | 405 |
| `PROPFIND` with `Depth: infinity` | 403 |
| `PUT` onto a local placeholder | 403 |

Traversal is caught by resolving the joined path and comparing it against the
root prefix, not by scanning for `..` — the scan misses the encodings. `Depth:
infinity` is refused rather than served because the one caller who would ask for
it is something walking 317 MB of transcripts one HTTP response at a time.

---

## 9. Measurements

On the workstation described in the status note, container to workstation
across the Hyper-V switch.

| | |
|---|---|
| task entry — namespace, mount, binds, teardown | **277–522 ms** |
| first read of `settings.json` (363 B) | **8 ms** |
| read of `.claude.json` (154 KB) | **6 ms** |
| read of a transcript (1.4 MB) | **18 ms** |
| `du -sh plugins` with the directory cache warm | **132 ms** |
| **cold walk of `plugins/` — 625 files** | **3.9 s** |
| Claude Code startup writes, plugin registries with host paths | **800** (two marketplaces re-cloned) |
| Claude Code startup writes, registries seeded | **100** (housekeeping) |
| `git credential fill` inside the instance, cold (GCM on the workstation) | ~1 s |

The last row is the one to look at. Everything else is a round trip or two; a
recursive walk is one `PROPFIND` per directory, serialized, and latency
dominates. Three things follow, in order of how much they help:

1. **Keep bulk trees local.** That is already the default, and it is why the
   default is the default.
2. **Ship a current rclone in the golden image.** Debian trixie has 1.60.1, from
   2022, and `rclone mount --help` there has no `--vfs-refresh`. Current rclone
   does: it walks the tree once in the background at mount time, which moves the
   cost off whatever reads it first.
3. **Lengthen `--dir-cache-time` per namespace.** `plugins/` changes when
   someone installs a plugin; it does not need five-second freshness.
   `.credentials.json` does.

---

## 10. Open questions

**A token refresh from inside diverges the session from the workstation.**
`.credentials.json` is shadowed: the session reads the workstation's until it
writes its own, and a refresh performed inside lands on the session's copy, not
the workstation's. That protects the workstation's file, and it is what was
tested. What it does not solve is the OAuth refresh token itself — refreshing
rotates it, and a rotation performed inside a container may invalidate the one
the workstation holds. The copy-based `ToolMounts` path has exactly the same
hazard today; this design makes it more likely by making sessions live longer.
Not observed in testing. Worth a deliberate test: run a session past the access
token's expiry and see which side loses.

**Should `settings.json` changes made inside ever come back?** Shadowed by
default, so no. `envmux live sync claude/settings.json` promotes it to live for
someone who wants one settings file across sessions and the workstation. A
`/model` change made in a session is probably the common case for wanting it.

**One rclone per task is one process per task.** Fine at five tasks. A session
with twenty shells open in the portal is twenty rclone processes and twenty FUSE
mounts. The mounts are per namespace, so tasks with identical scope *could*
share one — at the cost of losing exactly the isolation §5.1 is about. Measure
before optimising.

**`Input/output error` on one transcript read, once**, during an early run,
against a mount whose server had been restarted underneath it. Not reproduced
since; recorded because an unexplained EIO from a filesystem is not a thing to
leave unexplained.

---

## 11. Implementation map

| | |
|---|---|
| `src/Envmux/Live/Policy.cs` | namespaces, the live/local split, per-session overrides |
| `src/Envmux/Live/Tree.cs` | path resolution, the three-source listing, traversal refusal |
| `src/Envmux/Live/Dav.cs` | the WebDAV verbs |
| `src/Envmux/Live/Grants.cs` | per-task keys, scopes, expiry, revocation |
| `src/Envmux/Live/LiveServer.cs` | Kestrel on the bridge-facing address; admin on loopback |
| `src/Envmux/Commands/LiveCommand.cs` | `envmux live`, `envmux live sync <ns>/<entry>` |
| `src/Envmux/Incus/InstanceSpec.cs` | the proxy device, alongside `Attached` |
| `src/Envmux/Session/SessionTask.cs` | mint a key per task, wrap its command, revoke on exit |
| `src/Envmux/Config/LiveConfig.cs` | the `live` block in `.envmux.json` |
| golden image | `rclone` (current, not Debian's) and `fuse3` |

The spike's `server/` maps onto the first four rows unchanged; `guest-enter.sh`
becomes a file written into the instance at session start, the way
`Bootstrap.EnvironmentScript` writes the profile.

### 11.1 Configuration

```jsonc
{
  "tools": { "claude": "auto" },

  "live": {
    // Which tools are mounted live rather than copied.
    "claude": {
      // Promote one of the session's own directories to the workstation's
      // ("live"), or hand the workstation's file back to it read-write.
      "projects": "live",
      "settings.json": "live",

      // The plugins this session gets. None declared is none carried. A
      // marketplace this workstation has no record of names its source.
      "plugins": [
        "prompt-context@prompt-skills",
        "some-plugin@some-marketplace=github:Owner/repo"
      ]
    },

    // Git credentials, served from the workstation's helper on demand. The
    // hosts default to the ones this repository's remotes point at.
    "git": true,

    // Per task, what its key reaches. A task not named here gets no key —
    // and no mount, and no git credentials.
    "tasks": {
      "agent": "claude; git",
      "build": "claude:plugins,settings.json",
      "docs": ""
    }
  }
}
```

The workdir (`/work`) appears in none of this. It is where the seed re-keys the
project's trust entry to, and that is all — the repository itself is copied on
launch as a bundle, and the editor opens `/{project}_{session}` which is a link
to it. Live volumes are dotfiles.

A missing `live` block mounts nothing and changes nothing: the existing copy at
session start is what happens, exactly as it does today. Credentials do not
start travelling live because something inferred that they should — the same
rule `ToolMounts` already states, applied to a mechanism that is harder to take
back.
