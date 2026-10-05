# Editor

Press `e`. VS Code opens, attached to the session's instance.

```console
$ envmux code                 # the same thing, from another terminal
$ envmux code --print         # just the link
```

Two ways to attach, chosen by `editor.attach`: **dev container** (the default)
or **SSH**.

## Dev container, by default

The default is VS Code's **Dev Containers** extension, attached to the instance
as a running container through envmux's Docker-compatible endpoint. Any instance
attaches this way — no `devcontainer.json`, nothing built — and the endpoint
looks after itself: the first attach starts it, a lease keeps it up while the
session runs, and it closes once nothing needs it.

**Nothing to configure.** The link envmux opens carries the endpoint's address
inside it, so VS Code reaches the endpoint with **no settings to set** — no
`dev.containers.dockerPath`, no Docker context, no `settings.json` edit. The one
thing it relies on is a real `docker` CLI on `PATH`, which the Dev Containers
extension needs regardless and Docker Desktop provides. (Verified: the
extension's "is Docker running" check reports `Server: envmux (Incus)` and never
falls back to Docker Desktop.) [`docs/vscode-remote.md`](../vscode-remote.md) has
the whole of it.

## Or SSH

Set `"attach": "ssh"` and the editor points at the instance's hostname over
VS Code's **Remote-SSH** instead:

```
vscode-remote://ssh-remote+matt@myproj-feat-login.envmux/myproj_feat-login
```

envmux already knows the name the instance answers on, so the only thing missing
was the link. Nothing has to be running for it, and it works from any machine
that resolves the zone — which is the dev-container attach's one limitation, and
why SSH stays a first-class option rather than a legacy one. On platforms where
the Docker endpoint is not built yet (anything but Windows, so far), SSH is the
default.

## Which folder opens

`/<project>_<session>` — a symlink to the session's workdir that every session
makes as it starts, so the window is called `myproj_feat-login` rather than
`work`.

Every instance clones the repository to the same place, `/work` unless
`workdir` says otherwise, and VS Code files a window under the last segment of
the folder it opened. So the recent list held a dozen entries all called `work`,
the hostname in grey beside each, and reopening the one from Tuesday meant
trying them in turn. The link is a name for the same directory that says which
session it is. It is an underscore between the halves because a slug never
contains one, so it reads back unambiguously where the hostname's hyphen would
not, and cannot be the name of anything the image already has at its root.

Only the editor goes through it. Tasks, shells, the clone and `ENVMUX_WORKDIR`
all stay on the real path — the one that appears in the log and the config is
the one things actually happen in. Set `editor.folder` and that path is opened
exactly as written, whether or not it is under the workdir.

## What you need

The [Remote-SSH extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)
installed in the editor. envmux does not check — the connection happens inside VS
Code's window, and that is where the error would appear if it is missing.

VS Code, Insiders, Cursor, Windsurf and VSCodium all work; anything that
understands `vscode-remote://` and `--folder-uri` does.

`openssh-server` is in the golden instance, so there is nothing to install on the
far side, and nothing to arrange on this one either: `envmux install` makes a key
and points `~/.ssh/config` at it, and every session puts that key inside as it
starts. See [How it authenticates](#how-it-authenticates), and
[`envmux ssh`](cli.md#envmux-ssh) if it ever needs doing again.

## Which editor

In order:

| | |
|---|---|
| `editor.path` in `.envmux.json` | authoritative — set but missing is an error, not a fallthrough |
| `$VSCODE_BIN` | the same contract |
| `PATH` | `code`, `code-insiders`, `codium`, `cursor`, `windsurf` |
| the platform's install locations | `/Applications`, `%LOCALAPPDATA%\Programs`, `/usr/share/code`, snap, flatpak |

The `PATH` search is name-major, so `code` anywhere on it beats `code-insiders`
everywhere: somebody with both installed meant the stable one unless they said
otherwise.

Two installs come with a warning attached, neither of which stops the launch —
VSCodium, whose marketplace may not carry the Remote-SSH extension, and a flatpak
VS Code, whose sandbox has its own SSH configuration.

## Configuring it

```jsonc
{ "editor": "cursor" }

{
  "editor": {
    "path": "/usr/local/bin/code",  // default: found on this machine
    "newWindow": true,              // default: reuse the window in front of you
    "folder": "/work/api",          // default: /<project>_<session>, a link to the workdir
    "attach": "ssh"                 // default: "devcontainer" (ssh off Windows)
  }
}
```

`attach` is what `e`, `envmux code`, and the portal's **open in VS Code** button
all follow: `devcontainer` (the default — see above) or `ssh`. Left unset, it is
the dev-container attach wherever the endpoint can serve it, and SSH elsewhere.

## The link

```
vscode-remote://ssh-remote+<user>@<hostname>/<path>
```

The path is percent-encoded with an allow-list that never touches `/`.

The link depends on nothing but the session's name — which is why `envmux code`
works from a terminal that knows nothing about the running session, and why
`--print` is worth having. Paste it in a note, a task description, a message to
whoever is pairing with you. It keeps working as long as the instance exists, and
instances are kept.

It also works from **any machine with the `envmux ssh` block**, which the
attached-container link never did: the name is an ssh alias, and the block's
`ProxyCommand` carries the connection over `envmux relay`, so nothing has to
resolve it.

## The target is validated, not escaped

A user or a hostname that is not something SSH could address is refused rather
than quoted around. On Windows the editor is usually a `.cmd`, which runs through
a command interpreter, and a value carrying metacharacters would reach one.
envmux only ever generates names of the form `<project>-<session>` from
already-slugged parts, so this is a floor rather than a daily concern.

## How it authenticates

Over ssh, as the session's account, with **one key envmux owns**.

`envmux install` makes an ed25519 key in `~/.envmux`, beside `host.json` and the
client certificate, and writes an entry naming it into `~/.ssh/config`. Every
session writes its public half into the instance's `authorized_keys` as the
session starts. Both halves are [`envmux ssh`](cli.md#envmux-ssh), which is worth
knowing because it is the command that repairs this.

A public key is the half of a keypair that exists to be handed out, so putting
one into a container you just started on your own machine needs none of the
ceremony the coding tools and the git credentials do — it is not behind the
`tools` opt-in that carries actual secrets.

Without it there is nothing to connect with: the account is created with no
password, sshd answers `Permission denied (publickey,password)`, and the editor
link points at a machine that will not let it in.

### Why a key of its own

Because the two ways this used to fail are the same message.

Every `*.pub` in `~/.ssh` is *also* authorised, and still is — a courtesy to
whoever would rather use theirs. But ssh only **offers** keys it recognises by
name, `id_ed25519`, `id_rsa` and the rest. A key called `work_laptop` was
authorised inside the instance and refused on the way in, and a workstation that
had never run `ssh-keygen` had nothing to authorise at all. Both arrive as
`Permission denied (publickey)`, which says nothing about either.

One key envmux makes, in a place envmux controls, named by a config entry envmux
writes, is a path with no step in it that somebody has to know about.

### The four lines in `~/.ssh/config`

```
Host *.envmux
    IdentityFile ~/.envmux/id_ed25519
    IdentitiesOnly yes
    UserKnownHostsFile ~/.envmux/known_hosts
    StrictHostKeyChecking accept-new
```

`IdentitiesOnly` so a workstation with eight keys does not walk through the other
seven and hit `MaxAuthTries` before reaching the one the session authorised.

The other two are the host-key problem. A recreated session is a **new machine
answering to the old name**, with a new host key — which ssh reports as
`REMOTE HOST IDENTIFICATION HAS CHANGED!` and, under strict checking, refuses
outright. It is right to shout and wrong here: envmux destroyed that machine and
made this one. So the zone's host keys go in a file of their own, where that
churn is not mixed in with the machines you actually care about being warned
about, and `accept-new` takes the first sight of a name without asking while
still refusing a key that changed underneath it. envmux also forgets the
remembered key for that one hostname whenever it creates an instance — adopting
an existing one leaves it alone, because that is the same machine.

`Host *.envmux` is written from the zone that is actually configured, not from the
word `envmux` — see [the zone, not `.envmux`](cli.md#the-zone-not-envmux).

### When it does not work

The session log names the keys it authorised — `envmux` is the one above — which
is how to tell a key that never arrived from one that arrived and was never
offered. Both look like "Permission denied".

No key at all is not an error: the session runs and only the editor cannot
attach. `envmux ssh` fixes it for every session started after, and for running
ones the next time they are started.

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
