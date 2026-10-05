# Connection Method: Dev Containers via Local Docker-Compatible Endpoint

Adds VS Code desktop attachment as a connection method to the existing devtool. No
custom VS Code extension, no proposed APIs, no SSH or tunnel dependency. Works on
Windows, macOS and Linux.

> **Status: built for Windows, run end to end, and zero-touch.** The editor buttons
> (`envmux code`, `e`, the portal) open a VS Code window attached to a session's instance
> in ~8 s, with **nothing to configure** — the endpoint starts itself on demand (§3.2)
> and the launch URI carries its address, so no `settings.json`, Docker context, or
> wrapper is involved (§7). The code is in
> [`src/Envmux/Docker/`](../../src/Envmux/Docker), the Windows transport in
> [`src/Envmux/Docker/Windows/`](../../src/Envmux/Docker/Windows), and the host-free
> parts are covered by `tests/Envmux.Tests/DockerShimTests.cs`. The prose below is the
> design; the call-outs marked **Verified**, **Correction**, and **Resolved** record what
> building it changed. The reverse-engineering log and a standalone reproduction live in
> [`spikes/vscode-remote/`](../../spikes/vscode-remote).
>
> **macOS and Linux are not served yet.** The translator, HTTP, and framing are
> platform-neutral; only the listener is per-platform. §3.1 records the shape the unix
> socket takes, and the same `IShimListener` contract will carry it — noted, not built.

---

## 1. Given

Stated as fact, not to be re-derived:

- The devtool can execute a command on a target VM and stream stdin/stdout/stderr
  bidirectionally, with exit code propagation.
- The devtool knows its targets, holds credentials for them, and manages their
  lifecycle.
- Transport authentication, encryption and audit are solved and out of scope.

**The devtool MUST present a Docker-compatible API endpoint on the local machine.** This
endpoint is the integration surface. Every Docker API call it receives is translated
into an operation the devtool already performs against the target VM.

---

## 2. Architecture

```
VS Code desktop
  └─ Dev Containers extension (ms-vscode-remote.remote-containers)
       └─ docker CLI            [DOCKER_HOST → local endpoint]
            └─ devtool Docker shim  ← THIS SPEC
                 └─ devtool exec channel
                      └─ target VM
                           └─ VS Code REH (installed & launched by the extension)
```

The extension believes it is talking to a Docker daemon that happens to be non-local. It
is talking to the devtool. The "container" is the VM.

### 2.1 What this design deliberately does not require

- **No commit/version awareness.** The extension resolves its own build's commit,
  downloads the matching server, and installs it over exec. The devtool never parses
  `product.json`, never fetches a server tarball, and never breaks when a developer
  auto-updates. This is the single largest simplification versus a custom resolver.
- **No port forwarding or reachable listener** (see §4.4 and §10.1). The connection is
  expected to ride the exec stream.
- **No extension to write, sign, distribute, or gate behind `argv.json`.**
- **No REH bootstrap logic.** The extension owns it.

---

## 3. Endpoint

| Property | Requirement |
|---|---|
| Transport | Unix socket (macOS/Linux), named pipe (Windows) |
| Path | Per-user, under the devtool's existing runtime dir |
| Scope | Loopback/filesystem only; MUST NOT bind a TCP port |
| Auth | Filesystem permissions, 0600 |
| Lifetime | On-demand, leased; one endpoint may serve many targets (§6.1) — see §3.2 |

A TCP endpoint is prohibited even on loopback: the Docker API is unauthenticated by
design and grants arbitrary code execution on every reachable target.

### 3.1 Transport, per platform — and why it is not one listener

The endpoint is a duplex byte stream that the hand-written HTTP (`ShimHttp`) and the
translator (`DockerShim`) sit on unchanged. Only *offering* that stream differs by
platform, behind `IShimListener` / `IShimConnection` in
`src/Envmux/Docker/ShimTransport.cs`. `ShimEndpoint.Listen()` selects the
implementation; everything above it is platform-neutral.

- **Windows — built.** A per-user named pipe, `\\.\pipe\envmux-docker`, in
  `src/Envmux/Docker/Windows/MessagePipeListener.cs`. **Correction to the table above:
  the pipe MUST be message-mode, not the default byte-mode.** The docker CLI ends stdin
  on a hijacked exec with `CloseWrite()`, and go-winio implements that for a
  message-mode pipe only (a zero-length message) — which is why dockerd itself listens
  with `MessageMode: true`. The Dev Containers extension writes every file it puts in a
  container with `docker exec -i … sh -c "cat > f"`, so on a byte-mode pipe the `cat`
  never sees EOF and the connect hangs. Neither Node's pipes nor Kestrel's named-pipe
  transport can create a message-mode pipe: this listener is the one piece that could
  not be borrowed. EOF *towards* the client is the same zero-length message, which
  `PipeStream` drops — so it is written with a raw overlapped `WriteFile` (event handle
  low-bit set, so the completion bypasses the runtime's I/O completion port). The pipe's
  DACL grants the current user only.
- **macOS / Linux — noted, not built.** A unix socket at
  `~/.envmux/docker.sock`, mode 0600, where the half-close is the socket's own
  `shutdown(SHUT_WR)` and the same `IShimListener` contract applies. `ShimEndpoint`
  throws a clear "Windows only so far" message there rather than pretending. When it is
  written it belongs in `src/Envmux/Docker/Unix/` beside the Windows one.

### 3.2 Lifetime — on-demand, leased, self-closing

Daemonless: nothing runs at login and nothing is left resident. The endpoint is a
machine-wide **singleton** that clients start on demand and keep alive with a **lease**,
and which **closes itself** once nothing needs it. In envmux this is `envmux docker`
(`src/Envmux/Docker/`), and the parts are:

- **Auto-launch (`DockerEndpoint.EnsureAsync`).** A client wanting a dev-container attach
  takes a lease and, if the pipe is not already answering, spawns `envmux docker --auto`
  detached and waits for it. The spawn is serialised by a file lock (`launch.lock`) so a
  burst of clients yields one endpoint, not several.
- **Singleton.** The serving process holds `endpoint.lock` (opened `FileShare.None`) for
  its whole life; a second one that starts finds it held and exits at once. A file lock,
  not a named mutex — the lock is held across `await`s, and a mutex's thread affinity
  makes that throw; the file lock also frees itself if the process dies.
- **Lease (`DockerLease`).** A file under `~/.envmux/docker/leases/` whose mtime is a
  heartbeat, touched every 5 s while held and read as dead by the endpoint once older
  than 20 s — so a crashed client strands nothing. A running session heartbeats a lease
  for its lifetime and deletes it on exit; a short-lived `envmux code` *lingers* its
  lease (stops beating, leaves the file) so the endpoint survives the ~20 s until VS Code
  connects.
- **Self-close (`ShimServer`, `--auto` only).** A monitor closes the endpoint once there
  is **no live lease and no open connection** for a 30 s grace. The open-connection check
  is the safety that matters: quitting the last session — its lease gone — never severs a
  VS Code window that is still attached, because that window is a live connection. A
  manual `envmux docker` skips the monitor and stays up until Ctrl-C.

Verified end to end: the endpoint comes up on the first attach, stays up while a lease is
held or a connection is open (past the idle grace, both), and closes on its own once
quiet and unleased. `DockerLease` is covered by `DockerLeaseTests`.

---

## 4. API surface

Implement only what the extension calls. Determine the actual set empirically (§11.1);
the list below is the expected minimum.

### 4.1 Handshake

| Endpoint | Notes |
|---|---|
| `GET /_ping` | Must return 200 with `API-Version` header |
| `GET /version` | `ApiVersion` must be high enough for the extension's minimum; report a plausible `Version` |
| `GET /info` | `OSType: "linux"`, `Architecture`, `ServerVersion`. The extension branches on `OSType` for path semantics — returning anything else changes its behaviour |

### 4.2 Lifecycle

| Endpoint | Translation |
|---|---|
| `GET /containers/json` | Enumerate targets as containers; must support the `filters` query param, especially label filters |
| `GET /containers/{id}/json` | Inspect. See §5 for required fields |
| `POST /containers/create` | Provision/select a target; return an id |
| `POST /containers/{id}/start` | Ensure target is running and exec-ready |
| `POST /containers/{id}/stop`, `/kill`, `/restart`, `DELETE` | Stop/remove the instance, or no-op and 204 |
| `POST /containers/{id}/attach`, `/wait` | **Verified required** — `docker run` is create → attach (hijack) → `wait?condition=next-exit` → start; the CLI blocks on the attach stream for the first line of its own entrypoint. The instance's init is systemd, so that echo is replayed once the instance is running |
| `GET /events` | **Verified required** — the devcontainers CLI opens `events?filters={"event":{"start":true}}` and blocks on the container's `start` event before it does anything else. Without it the flow parks forever |
| `GET/POST /volumes`, `POST /volumes/create` | **Verified required** — the extension creates a `vscode` volume first. Nothing is mounted across this boundary; a name that answers is enough |
| `POST /images/create`, `POST /build` | Stubbed: every image is the golden snapshot, `build` is refused. `images/create` must return a well-formed progress stream, not an empty body |

### 4.3 Filesystem

| Endpoint | Translation |
|---|---|
| `GET /containers/{id}/archive` | tar stream of a path on the target |
| `PUT /containers/{id}/archive` | extract a tar stream onto the target |
| `HEAD /containers/{id}/archive` | stat |

Used for configuration probing and possibly server delivery. Implemented (`tar` over a
non-tty exec), rather than stubbed. **Verified:** on the observed path the extension
delivered the ~223 MB server tarball through `exec -i` (`dd | tar`), not through
`archive`, so `archive` is exercised by `docker cp` but is not on the server-install
critical path. Two corrections landed here: a `HEAD` response must carry **no body**
(a body on a HEAD is read as the next response and poisons the kept-alive connection —
"Unsolicited response received on idle HTTP channel"), and the stat's `mtime` in the
`X-Docker-Container-Path-Stat` header must be canonical RFC3339 with a `Z` and
milliseconds — the .NET round-trip (`"o"`) form, with seven fractional digits and a
numeric offset, fails the Go client's time decode, and a failed stat decode surfaces as
`docker cp … no such directory`.

### 4.4 Exec — the critical path

```
POST /containers/{id}/exec       → {"Id": "<execId>"}
POST /exec/{execId}/start        → hijacked bidirectional stream
GET  /exec/{execId}/json         → {"Running": bool, "ExitCode": int}
POST /exec/{execId}/resize       → TTY resize
```

This is the handoff to the devtool's existing exec capability. Everything else in this
spec is scaffolding around it.

---

## 5. Container identity

`GET /containers/{id}/json` must return, at minimum:

```jsonc
{
  "Id": "…",
  "State": { "Running": true, "Status": "running" },
  "Config": {
    "Labels": {
      "devcontainer.local_folder": "<host path, verbatim as received>",
      "devcontainer.config_file":  "<host path to devcontainer.json>"
    },
    "User": "<remote user>",
    "Env": [ … ]
  },
  "Mounts": [ … ],
  "NetworkSettings": { … }
}
```

**Label round-tripping is not optional.** The extension finds an existing container for a
workspace by filtering on these labels. If `POST /containers/create` does not persist
them and inspect does not return them byte-identical, every reconnect provisions a new
target instead of reattaching. Do not normalise, case-fold, or path-rewrite these values.
**Verified:** the Windows path with backslashes and the lowercased drive on
`config_file` came back byte-identical and the reattach filter found the instance. The
mapping is persisted in `~/.envmux/docker.json` (`ShimState`); the container id is the
SHA-256 of the instance name, so it survives a devtool restart even if the file is lost.

---

## 6. Multiplexing and framing

### 6.1 Target selection

One endpoint serves many targets. The container id is the routing key: `create` allocates
an id bound to a target, and every subsequent call carries it. Ids must be stable across
devtool restarts if reattachment is to survive them; persist the mapping.

### 6.2 Stream framing

`POST /exec/{execId}/start` upgrades to a hijacked connection. Framing depends on the
`Tty` field supplied at exec-create:

- `Tty: true` — raw bidirectional bytes.
- `Tty: false` — **stdout and stderr multiplexed with the 8-byte stdcopy header**: one
  byte stream type (1 = stdout, 2 = stderr), three zero bytes, then a 4-byte big-endian
  payload length.

Emitting unframed bytes when `Tty: false` is the most likely single point of failure in
this integration. It presents as the extension hanging or reporting corrupt output, not
as a protocol error. The framing is `StdCopy.Frame` (`src/Envmux/Docker/StdCopy.cs`),
applied by `ExecBridge`.

**Correction — the two "it is over" signals are not the same event.** Incus signals a
stream's EOF with an *empty* websocket message, not a socket close, and on a pty it then
leaves the socket open until the client lets go. And the exec operation finishing is a
different moment from the output draining: a pty outlives the command, and a command's
last bytes can arrive after the operation reports done. `ExecBridge` therefore ends the
hijack when the output sockets close, answering Incus' empty message with a close from
its side, and treats the operation finishing only as a fallback that first waits for the
output to fall quiet. Ending on "operation finished" alone truncates output — a 20 MB
read stopped at ~18 MB in testing.

### 6.3 Stream fidelity

The exec channel must be byte-faithful in both directions:

- No line buffering, no newline translation, no encoding conversion.
- No injected banners, MOTDs, or progress output on the stream.
- Backpressure propagated; the server install pushes tens of megabytes.
- Exit code available via `GET /exec/{execId}/json` after the stream closes.

Shell startup scripts must not run and must not contribute output. **Verified:** exit
codes propagate (a non-zero exec reports its code), `Tty: false` stdout/stderr stay
separated under the stdcopy header, stdin half-close reaches the far `cat` as EOF, and
20 MB each way is byte-exact. **Correction:** on a hijacked `POST /exec/{id}/start` that
carries a JSON body, the body must be fully read *before* taking the connection over —
any unread body bytes are otherwise delivered as the first bytes of stdin.

---

## 7. Client configuration — none

**Resolved: the attach needs nothing in the user's `settings.json`.** The endpoint's
address rides inside the launch URI, so VS Code reaches it with no
`dev.containers.dockerPath`, no Docker context, no `containers.environment`. This is
the zero-touch answer, and it replaces everything the spec and the earlier drafts said
about client configuration.

The mechanism is `settings.host` on the `attached-container` authority (§8.3). The
extension reads it — `let f = settings && "host" in settings && settings.host` in its
`resolve` — and turns it into `DOCKER_HOST` for *every* docker invocation, the "is
Docker running" preflight included. So the URI alone points the extension's own,
well-tested `docker` CLI at the endpoint. `Editor.DockerUri.AttachedContainerUri` bakes
it in.

**Why the earlier route was abandoned.** `containers.environment.DOCKER_HOST` and a named
Docker context both failed: the extension resolves a context before it reads
`DOCKER_HOST`, the preflight ignores `containers.environment`, and on a machine with
Docker Desktop it launches Desktop and stalls there. `dev.containers.dockerPath` → a
wrapper worked but was a per-user setting *and* a binary to ship. `settings.host` needs
neither — it is carried per-attach, in the URI, by envmux.

The one remaining dependency is a real `docker` on `PATH`, which the Dev Containers
extension requires regardless (Docker Desktop provides it). **Verified:** with an empty
`settings.json`, the preflight reported `Server: envmux (Incus)` and the window connected
in ~8 s, never touching Docker Desktop. `envmux docker --print` still shows the endpoint
address for wiring a plain `docker` CLI up by hand, but nothing has to.

> Machine scope vs workspace scope no longer applies, since there is no setting — which
> also closes the workspace-scoped-Docker-settings code-execution vector the earlier
> draft warned about.

---

## 8. Launch

### 8.1 URI construction

```
vscode-remote://dev-container+<hex>/<path-inside-target>
```

`<hex>` is the hex encoding of the UTF-8 bytes of either a bare host path or a JSON
object. Use the JSON form:

```jsonc
{
  "hostPath": "<host path>",
  "localDocker": false,
  "configFile": { "$mid": 1, "fsPath": "…", "path": "/…", "scheme": "file" }
}
```

`localDocker: false` exists for exactly this case. `<path-inside-target>` defaults to
`/workspaces/<folder-name>` unless `workspaceFolder` overrides it in devcontainer.json.

### 8.2 Invocation

```
code --folder-uri "vscode-remote://dev-container+<hex>/workspaces/<name>"
```

Resolve the `code` binary the way the devtool already resolves developer tools; do not
assume it is on PATH.

### 8.3 Attach variant — and how it carries the docker host

If the devtool has already started the target — which for envmux is always; a session's
instance is already running — `attached-container+<hex>` names it and skips container
creation. This is the form envmux uses, and its `<hex>` is the UTF-8 of
`{"containerName", "settings"}`:

```jsonc
{
  "containerName": "<instance name>",           // what the extension inspects
  "settings": { "host": "npipe:////./pipe/…" }  // becomes DOCKER_HOST — the whole of §7
}
```

`settings.host` is the zero-touch hook (§7): the extension applies it as `DOCKER_HOST` to
every docker call, so no `settings.json`, context, or wrapper is needed. The path after
the authority is the folder to open inside the instance.

---

## 9. Constraints to surface to the user

- **No local bind mounts.** Docker cannot bind-mount the client filesystem into a remote
  container. Source lives on the target. The devtool must either provision it there or
  refuse the operation with a clear message — not fail obscurely at mount time.
- **The extension believes the target is a container.** Anything reading
  `/.dockerenv`, cgroup paths, or container-shaped environment may misbehave. This
  includes third-party extensions. Document as unsupported or fake selectively.
- **Undocumented URI format.** §8.1 is reverse-engineered and may change in a VS Code
  point release. Pin `ms-vscode-remote.remote-containers` and gate its updates.

---

## 10. Resolved design questions

### 10.1 Connection transport — **resolved: it rides the exec stream**

The design assumed the extension tunnels the REH connection over the exec stream rather
than requiring a published port. **Verified true.** The server is started with
`--host 127.0.0.1 --port 0`, and the extension then runs
`docker exec -i … node -e "const net = require('net') …"` per connection (one short
handshake, then two long-lived: the management channel and the extension host). The
target listens on loopback only — nothing inbound is opened on it. No port publishing,
no `NetworkSettings.Ports`, no forwarding primitive was needed. (The client side does
open a loopback TCP port for its own forwarder; that is the extension's, not the shim's.)

### 10.2 Image/build semantics — **resolved: pre-provisioned**

Targets are pre-provisioned: every image name maps to the golden snapshot, `images/create`
returns a progress stream that says so, and `build` is refused with a clear message
pointing at `devcontainer.json`'s `image` field.

---

## 11. Verification

### 11.1 Determine the real API surface

Before implementing, front the developer's actual Docker socket with a logging proxy,
run a normal dev container session end to end, and capture every request. Implement
against the observed set. Repeat per VS Code minor version during pinning review.

### 11.2 Test matrix

| Axis | Cases |
|---|---|
| Cold | No prior container for the workspace; full server install |
| Warm | Existing target found via label filter; reattach without re-provisioning |
| Editor upgrade | Developer updates VS Code; new server installs alongside old |
| Restart | Devtool restarted; container ids still resolve |
| Concurrency | Two windows against one target |
| Framing | `Tty: false` exec with interleaved stdout/stderr, and a >10 MB transfer |
| Exit codes | Non-zero exec propagated |
| Failure | Target unreachable mid-session; exec channel dropped during server install |
| Platform | Windows named pipe, macOS, Linux |

### 11.3 Expected failure signature

`ENOPRO: No file system provider found for resource 'vscode-remote://dev-container+7b22…'`
means the authority decoded but a path inside it did not resolve — usually `configFile`.
Hex-decode the URI and check the paths before suspecting the format.

---

## 12. Acceptance

1. Developer runs one devtool command; VS Code opens attached to the target.
   — **Met** (`envmux docker`, then open the folder URI; cold path ~8 s to connected).
2. Integrated terminal is a shell on the target. — Not yet exercised by hand (needs an
   unlocked desktop); the remote extension host reached "Connected".
3. Extensions install into the target and persist. — Not yet exercised by hand.
4. Window reload reattaches without re-provisioning. — **Met at the docker level:** the
   extension's own label filter returns the existing container; `ShimState` persists the
   mapping.
5. Developer updates VS Code; the next connection works with no devtool change. — Holds
   by construction: the extension owns server resolution and install (§2.1); the shim
   never parses `product.json`.
6. No inbound port is opened on the target, and no TCP listener on the client. —
   **Met** (§10.1): the target listens on loopback only; the REH connection rides exec.

The remote user is currently `root` — the golden image bootstraps no user; sessions do
that per instance, and the shim should too (`runuser -u` is already wired through
`Command`/`DockerExec` for it).

---

## 13. Implementation map

Everything is under [`src/Envmux/Docker/`](../../src/Envmux/Docker), reached by
`envmux docker` ([`Commands/DockerCommand.cs`](../../src/Envmux/Commands/DockerCommand.cs)).
The split keeps the platform-specific surface to one file.

| File | What it is |
|---|---|
| `ShimTransport.cs` | `IShimListener` / `IShimConnection` / `ShimEndpoint` — the platform seam (§3.1) |
| `Windows/MessagePipeListener.cs` | The Windows listener: message-mode pipe, per-user DACL, zero-length EOF |
| `ShimHttp.cs` | Hand-written HTTP/1.1 over the duplex — head parse, chunked/length bodies, keep-alive, hijack. Kestrel can't: it rejects an upgrade request that carries a body |
| `ShimServer.cs` | Accept loop; one `ShimHttp` per connection, all sharing one translator |
| `DockerShim.cs` | The translator — every endpoint (§4) mapped to `IncusApi` |
| `DockerExec.cs` | One Incus exec with its websockets left raw (tty and non-tty) |
| `ExecBridge.cs` | The critical path (§4.4/§6.2): pumps the hijack ↔ the exec sockets, framing and EOF |
| `StdCopy.cs` | The 8-byte stdcopy header |
| `ShimState.cs` | The persisted container/volume map (`~/.envmux/docker.json`) |
| `DockerModels.cs` | The Docker request bodies and the `filters` grammar |
| `Editor/DockerUri.cs` | The `dev-container+<hex>` folder URI (§8.1) |

The Incus-facing helpers (`IncusApi`, `IncusClient`, `Command`) are envmux's existing
ones, unchanged — the shim is a new caller of them, not a new copy.