# vscode-remote spike — `dev-container+…` against an Incus instance

A working demonstration of [docs/vscode-remote.md](../../docs/vscode-remote.md):
VS Code opens a `vscode-remote://dev-container+<hex>/workspaces/<name>` URI, the
Dev Containers extension talks to a Docker-compatible endpoint on a named pipe,
and every call is translated onto the envmux host's Incus REST API. The
"container" is a fresh clone of `envmux-golden/base`.

Demonstrated on 2026-08-27 with VS Code 1.134.0, Dev Containers 0.466.0,
docker CLI 29.6.1, Incus 7.3 on IncusOS. Cold path, folder to connected
window: **7.7 s** (clone 0.13 s, boot to address 0.7 s, server tarball
streamed in over exec 2.9 s, REH up 0.2 s).

## Pieces

| | |
|---|---|
| `shim.mjs` | The Docker API shim (Node). Handshake, containers, exec with stdcopy framing, archive, volumes, events, attach/wait. Logs every request to `shim.log`. |
| `relay/` | Windows transport leg (.NET). Owns `\\.\pipe\envmux-docker` in **message mode** and forwards to the shim's byte-mode inner pipe. See "Findings". |
| `docker-envmux/` | A `docker` wrapper exe for `dev.containers.dockerPath`: pins `DOCKER_HOST`/`DOCKER_CONTEXT` and execs the real CLI. Logs every invocation to `docker-envmux.log` (the §11.1 capture). |
| `launch.mjs` | Builds the §8.1 URI for a folder and launches VS Code on it. |
| `restart.sh`, `watch.sh`, `evidence.sh`, `screenshot.ps1` | Iteration helpers. |
| `settings.json.backup` | The user `settings.json` before this spike touched it. |

## Running it

```sh
cd spikes/vscode-remote
npm i                                   # ws
dotnet build -c Release relay
dotnet build -c Release docker-envmux
sh restart.sh                           # shim + relay in the background

DOCKER_HOST=npipe:////./pipe/envmux-docker docker version   # Server: envmux (Incus)

node launch.mjs C:\path\to\folder --open --no-trust
```

The folder needs a `.devcontainer/devcontainer.json` with an `"image"` (any
name — every image is the golden snapshot) and, ideally, a `workspaceFolder`.
User settings need:

```jsonc
"dev.containers.dockerPath": "Z:\\envmux\\spikes\\vscode-remote\\docker-envmux\\bin\\Release\\net10.0-windows\\docker-envmux.exe"
```

`--no-trust` passes `--disable-workspace-trust` for that window; without it the
extension's first act is a modal workspace-trust prompt.

## What the extension actually asked for (§11.1)

Docker API, cold path, one window (from `shim.log`):

```
GET  /version                      GET  /volumes
GET  /images/{name}/json           GET  /events?filters={"event":{"start":true}}
GET  /containers/json?all=1&filters={"label":…}      (×10, label filters)
POST /containers/create            POST /containers/{id}/attach   (hijack)
POST /containers/{id}/wait?condition=next-exit        POST /containers/{id}/start
GET  /containers/{id}/json         POST /containers/{id}/exec     (×11)
POST /exec/{id}/start              (hijack; ×11, two of them long-lived)
```

Not called on this path: `/build`, `/images/create`, `/containers/{id}/archive`,
`/exec/{id}/json`, `/exec/{id}/resize`, `/containers/{id}/stop`. `archive` is
implemented and tested (`docker cp`) but the extension delivered the server
tarball through `exec -i` (`dd | tar`) instead — 223 MB in 2.9 s.

CLI level (from `docker-envmux.log`): `version`, `-v`, `buildx version`,
`volume ls`, `volume create vscode`, `ps -q -a --filter label=…`,
`inspect --type image`, `inspect --type container`, `events --format {{json .}} --filter event=start`,
`run --sig-proxy=false -a STDOUT -a STDERR --mount … -l … --entrypoint /bin/sh`,
`exec -i -u root …`, `context ls`.

## Findings — corrections and additions to the proposal

1. **§7 `containers.environment` does not reach the CLI on this build.** The
   extension resolves a Docker *context* first: `containers.environment.DOCKER_CONTEXT`
   → `docker.environment.DOCKER_CONTEXT` → `docker.context` → `$DOCKER_CONTEXT`
   → `docker context ls` (current). On a machine with Docker Desktop the current
   context is `desktop-linux`, so it exports `DOCKER_CONTEXT=desktop-linux` and
   never looks at `DOCKER_HOST`. Setting `DOCKER_CONTEXT=default` alongside
   `DOCKER_HOST` in `containers.environment` still landed on Docker Desktop in
   testing (window 5). The `dev.containers.dockerPath` alternative works first
   time and is what this spike uses; the spec should prefer it, and note that
   the extension will **auto-launch Docker Desktop** (`dev.containers.optimisticallyLaunchDocker`,
   default true) if its first `docker version` fails.

2. **§3 Windows transport: the pipe must be message-mode, and Kestrel can't.**
   The docker CLI half-closes stdin with `CloseWrite()`, which go-winio only
   implements for message-mode pipes (a zero-length message). dockerd listens
   with `MessageMode: true` for exactly this. Node/libuv and Kestrel's named-pipe
   transport both create byte-mode pipes, so `docker exec -i … sh -c "cat > f"`
   — which the extension uses for *every* file it writes — never sees EOF.
   `relay/` owns the public pipe in message mode and forwards over a byte pipe
   with a length prefix upstream (zero length = half-close). EOF towards the
   client is the same zero-length message; .NET's `PipeStream` drops empty
   writes, so it is a raw overlapped `WriteFile`, with the event handle's low
   bit set so the completion bypasses the CLR's I/O completion port. The C#
   implementation will need a hand-rolled `NamedPipeServerStream` accept loop
   plus HTTP/1.1 parsing for hijack, not Kestrel.

3. **Incus exec EOF is an empty websocket message, not a close.** On a pty exec
   the operation stays `Running` until the *client* closes the socket after the
   empty message; non-interactive streams get the empty message and then close.
   Ending the hijacked stream when the operation finishes is wrong — output is
   still draining (a 20 MB read truncated at ~18 MB) — so the bridge ends on
   stream closes, with an idle-output fallback only.

4. **§4.2 needs `/events`.** The devcontainers CLI opens
   `docker events --filter event=start` before `docker run` and blocks on the
   container's `start` event. Without it the flow parks forever after start.

5. **§4.2 needs `/volumes`.** The extension creates a `vscode` volume before
   anything else. It is never mounted across this boundary; a name that answers
   is enough.

6. **`docker run` is create → attach (hijack) → wait?condition=next-exit → start.**
   The CLI waits for `Container started` on the attach stream — the first line
   of its own entrypoint script, which does not run here because the instance's
   init is systemd. The shim echoes it once the instance is running.

7. **Label round-tripping (§5) worked as specified**: Windows paths with
   backslashes and a lowercased drive on `config_file` came back byte-identical
   and the reattach query found the container.

8. **§10.1 resolved: the connection rides exec.** The server is started with
   `--host 127.0.0.1 --port 0`; the extension then runs
   `docker exec -i … node -e "const net = require('net') …"` per connection
   (one short handshake, two long-lived: management and extension host). The
   target listens on loopback only. The client side does open a loopback TCP
   port (`Port forwarding for container port 34095 starts listening on local port`)
   — that is the extension's own forwarder, not the shim's.

9. **First launch on an unseen folder is a workspace-trust modal**, before any
   Docker call. Per-window `--disable-workspace-trust` avoids it; a headless
   launch must account for it.

10. VS Code keeps **one window per folder URI**; a second launch of the same URI
    focuses the existing window rather than retrying, which matters for
    "restart the devtool and reconnect" flows.

## What was not exercised

Integrated terminal and extension installs (§12 items 2–3) need an unlocked
desktop; the window reached "Connected" with the remote extension host running.
Window reload (§12 item 4) was shown at the docker level only: the extension's
own label query returns the container. The remote user is `root` — the golden
image has no user bootstrapped; sessions do that per instance and the shim
should too (`runuser -u` is wired for it).
