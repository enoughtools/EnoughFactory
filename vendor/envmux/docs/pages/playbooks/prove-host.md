# Playbook: prove a host works

## When to use it

After attaching to a host, after swapping to one, after anything changed on the
Incus host or this workstation's network — and before you trust it with real
work. It exercises every promise once, with a scratch project, and cleans up
after itself.

[Acceptance](../acceptance.md) is the design's criteria and which of them tests
settle. This is the run that settles the rest, on *your* host.

## Prerequisites

| | |
|---|---|
| A host | `envmux install` has finished. Either provider |
| This workstation | `git`, `curl.exe`, a browser envmux can find (Chrome, Edge or Firefox), and an ordinary (not elevated) PowerShell |
| Ten minutes | Most of it the first session starting |

Values used below: zone `envmux`, range `10.100.0.1/24`.

## Steps

### 1. The host, as envmux sees it

```powershell
envmux host status
```

**You should see** these lines, and no `problem` or `warning` under them:

| Line | Healthy | If not |
|---|---|---|
| `provider` | the kind of host you think this is | the wrong host: check `ENVMUX_HOME` — it chooses which host every command talks to |
| `zone` | `*.envmux` | |
| `cert` | a path | `envmux host cert` |
| `api` | `https://<host>:8443` | not reachable: the host is down, or moved address — `envmux host trust <address>` |
| `auth` | `trusted` | `UNTRUSTED`: a new token, and `envmux install` again |
| `network` | the network's name, range and zone, matching `range` and `zone` at the top | a warning that the host and `host.json` disagree: `envmux host range`, or fix `host.json` |
| `addresses` | fewer in use than the capacity | full: new instances fall back to DHCP and start slower |
| `golden` | `envmux-golden/base` | `envmux host golden` |
| `legacy` | absent | present means an older envmux wired this workstation. Harmless; `envmux host unwire` removes it |

### 2. A scratch project with two routes

```powershell
$proof = Join-Path $env:TEMP "envmux-proof"
New-Item -ItemType Directory $proof | Out-Null
Set-Location $proof
git init -q
```

One file, `.envmux.json`. The second server binds the instance's own loopback
on purpose: it is the one a route could never reach and the session's browser
can.

```jsonc
{
  // The smallest project that exercises a host: one server on every
  // interface, one on the instance's own loopback.
  "name": "proof",
  "routes": { "web": 8000 },
  "tasks": {
    "web": { "command": "python3 -m http.server 8000 --bind 0.0.0.0", "ready": 8000 },
    "local": { "command": "python3 -m http.server 8001 --bind 127.0.0.1", "ready": 8001 }
  }
}
```

Check the config, then commit. A session is a branch, so there has to be a commit:

```powershell
envmux config validate
git add -A
git -c user.name=proof -c user.email=proof@example.invalid commit -q -m "proof project"
```

**You should see** `.envmux.json is valid`, with `routes web:8000` and
`tasks web, local`.

### 3. Start a session

```powershell
envmux check
```

**You should see** the window, with both tasks reaching `running`, the `web`
route listed, and in the log a `browser → socks5 on 127.0.0.1:1080` line.

Leave it open. The next steps are in that window and a **second** terminal.

| Result | Means |
|---|---|
| It refuses to start | Not a git repository, or no commit — step 2's last command |
| It stops at creating the instance | The host: `envmux host status`. No golden snapshot makes it slow, not broken |
| A task never leaves `starting` | The server is not listening on its `ready` port. Tab to the task's pane and read its output |

### 4. The browser whose `localhost` is the instance

In the session window press `b`.

**You should see** a browser open, on a profile of its own, at
`http://localhost:8000/` showing the directory listing `python3 -m http.server`
serves from `/work`. Now put `http://localhost:8001/` in its address bar.

**You should see** the same listing — from the server bound to the instance's
own `127.0.0.1`.

| Result | Means |
|---|---|
| No browser opens | None was found. `browser.use` names one, or a path; the log says what it looked for |
| The page is this machine's own `localhost` | The browser was not started by envmux, or is an old window of the same browser reusing the profile. Close it and press `b` again |
| "proof is starting" and it stays that way | The task is not up. The page reloads itself the moment it is; read the task's pane |
| `localhost:8001` fails and `:8000` works | Something other than envmux's proxy answered — check the browser is the one envmux opened, and that `--proxy-bypass-list=<-loopback>` reached it (Chromium) |

### 5. The same, from a client that is not that browser

In the second terminal, take the proxy line from the session's log (`/status`
puts it there too): `socks5h://proof-check:<password>@127.0.0.1:1080`.

```powershell
curl.exe -sI -x socks5h://proof-check:<password>@127.0.0.1:1080 http://localhost:8001/
```

**You should see** `HTTP/1.0 200 OK` and a `Server: SimpleHTTP` header.

Now without the credentials:

```powershell
curl.exe -sI -x socks5h://127.0.0.1:1080 http://localhost:8001/
```

**You should see** a refusal, and a line in the session log naming `curl` and
its pid: the port is the session's, and nothing that cannot prove it is let in.

### 6. ssh, by name

```powershell
ssh <user>@proof-check.envmux hostname
```

`<user>` is the account the session runs as — the window's status line shows
it. **You should see** `proof-check`, with no password prompt: the name is an
alias, `~/.ssh/config` sends it through `envmux relay`, and the key envmux made
lets it in.

| Result | Means |
|---|---|
| `Could not resolve hostname` | The `Host *.envmux` block is missing or below a `Host *` in `~/.ssh/config`: `envmux ssh`, and `envmux ssh --print` to read it |
| `Permission denied (publickey)` | The key is not authorised in this instance: it was started before `envmux ssh` made the key. `q` and `envmux check` again |
| `nothing answers on port 22` | `sshd` is not up in the instance yet; a first boot takes a moment. Try again |

### 7. The editor

In the session window press `e`. **You should see** VS Code open on `/work` in
the instance — as a dev container by default. Set `"editor": { "attach": "ssh" }`
in `.envmux.json` and press it again to see the Remote-SSH path, which is step
6's alias.

### 8. A shell, and a commit that comes back

In the session window, press `c`. **You should see** a shell prompt inside the
instance, in `/work`.

```sh
git -c user.name=proof -c user.email=proof@example.invalid commit --allow-empty -m "made inside the session"
exit
```

Press `q` to end the session. Quitting is what brings the commits back. Then, in
the project directory:

```powershell
git log --oneline -2 envmux/check
```

**You should see** `made inside the session` on top of `proof project`.

| Result | Means |
|---|---|
| `c` opens nothing | The exec channel. `envmux host status`; then start the session again — it adopts the instance |
| The branch has only `proof project` | The session was killed rather than quit. `envmux check`, then `q` |
| envmux says the branch moved on both sides | It wrote `.envmux/check.bundle` and printed the `git fetch` that reads it |

### 9. Clean up

```powershell
envmux prune --dry-run
envmux prune
```

**You should see** `would  proof-check` and then `rm     proof-check`. The branch
`envmux/check` is kept, because it has a commit on it. Then remove the scratch
project:

```powershell
Set-Location $env:TEMP
Remove-Item -Recurse -Force $proof
```

## Verify

All nine steps showed what they should. Afterwards:

```powershell
envmux host status
```

has no `instance` line for `proof-check`.

## Roll back

Nothing to roll back: the playbook changes nothing outside the scratch project
and one instance, and step 9 removes both. If it was interrupted:

```powershell
Set-Location $proof
envmux prune --all --force
```

## Troubleshooting

Each step has its own table. What is left is what spans them.

| Symptom | Cause | Fix |
|---|---|---|
| Every connection into the instance is slow to open | Each new connection is one exec against the host's API, and the API is far away or slow | Expected on a distant host: ~50–65 ms on a LAN. A browser keeps its connections open, so it is paid per socket, not per request |
| Step 3 is slow every time, not only the first | The pool does not clone. On a `dir` pool a new session is a full copy | `envmux host status` shows the storage driver on the `incus` line. ZFS and btrfs clone |
| It all passed yesterday | Something changed underneath: the host rebooted, or took a new address | `envmux host status` first; `envmux host trust <address>` if the API moved |
