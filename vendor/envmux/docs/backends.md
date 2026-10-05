# Backends: where a session runs, and how the control channel reaches it

envmux runs a session on an IncusOS VM it built on your workstation. This is
the plan for making that one choice among four — and for proving, with a
Kubernetes cluster on the other side of the internet, that every channel
envmux depends on works when the instance cannot see the workstation at all.

> **Status: plan, grounded.** Nothing under `src/` reads this yet. The
> measurements and permissions below were taken on 2026-09-03 against the dev
> cluster in `.context/devclusta-xl-01-kubeconfig.yaml` (Kubernetes 1.34.9,
> three Ubuntu 22.04 workers, Cinder CSI) with a throwaway `busybox` pod that
> was deleted afterwards. The seams in `src/` were mapped by reading them; the
> file list in §3 is exact.

---

## 1. Given

- Every interaction with the machine sessions run on goes through
  `IncusApi` (`src/Envmux/Incus/IncusApi.cs`): instance lifecycle, exec,
  files, snapshots, devices, and "what address did it get". Fourteen files
  outside `Incus/` call it directly.
- A session is reached by **a name that resolves to an address of its own**:
  `myproj-feat-login.envmux` is a dnsmasq answer on the `envmux0` bridge,
  routed from Windows, with a certificate issued for that name. Routes are
  ports on that address. The editor's SSH form is `user@that-name`. Every one
  of those is an assumption a remote backend breaks.
- The instance reaches the workstation over an Incus **proxy device** on its
  loopback: the room API (`ApiBridge`, `127.0.0.1:8078`) and, in the spike,
  live volumes (`:8079`). Both assume the Incus host can open a TCP connection
  to the workstation's LAN address.
- Onboarding is `envmux install --provider hyperv|incus`: eight or four steps,
  each also an `envmux host` command, recorded in `~/.envmux/host.json` — one
  file, one host, per workstation.

## 2. What was measured on the dev cluster

| | |
|---|---|
| reachability | API at `hcp-….spot.rackspace.com`, static token in the current context, works non-interactively; a second context uses an OIDC exec plugin |
| permissions | `create pods`, `pods/exec`, `pods/portforward`, `persistentvolumeclaims`, `services`, `ingresses`: **all yes** |
| storage | `ssd` (default), `ssd-large`, `sata`, `sata-large` — Cinder CSI, `Delete`, `Immediate` |
| `kubectl exec … echo hi`, cold each time | **2.1–2.3 s** per round trip |
| pod network | `10.20.x.x/32`, egress to the internet works, **no route to the workstation** |
| port-forward | permitted; a 3 s smoke against a `busybox nc` listener did not answer — inconclusive, measure properly in phase 3 |

The 2.2 s is the number that shapes everything: a per-command exec is
unusable as a control channel, exactly as it would be on Incus. envmux
already never does that — a task is one long-lived PTY exec into tmux, and a
shell is another — so the model transfers. What does not transfer is anything
that opens a new connection per operation, which is why §5 is a multiplexed
tunnel and not "port-forward on demand".

---

## 3. The seam: `IBackend`

Everything a session does to the machine, as one interface, extracted from
what `IncusApi`'s callers actually use. Mechanical, testable, and worth doing
before any Kubernetes code exists — it is what turns "add a backend" into
"implement an interface" instead of "grep for `api.`".

```
Instances    Exists, Create(from image, with storage), Start, Stop, Delete, List, State
Exec         Interactive(pty, resize, signal)  ← tasks via tmux, shells, the docker shim
             Captured(one-shot, exit code + output)  ← provisioning, bootstrap scripts
Files        Push(path, bytes, mode), Pull(path)  ← bundle in/out, tool tar, scripts
Reach        HowPeopleReach(session)   → name + address the workstation can dial
             HowEditorReaches(session) → SSH endpoint
             Tunnel(session)           → a stream the instance's loopback ports ride to us
Images       Golden(present?, build), Project(fingerprint, present?, build)
```

| today (`IncusApi`) | used by |
|---|---|
| `CreateAsync`/`StartAsync`/`StopAsync`/`DeleteAsync`/`StateAsync`/`InstancesAsync` | `Session`, `PruneCommand`, `DockerShim`, `ProjectImage`, `Golden` |
| `ExecSession.StartAsync` (pty over websocket) | `SessionTask` (tmux latch), `Session.AttachShellAsync`, `PortalHost` shell, `DockerExec` |
| `Command.CaptureAsync`/`ShellAsync` (record-output) | `Bootstrap`, `ToolMounts.PushAsync`, `Workspace`, `Golden`, `ProjectImage`, `CodeCommand`, `PruneCommand` |
| `PushAsync`/`PullAsync` | `Workspace` (bundle), `ToolMounts`, `LogsCommand`, `DockerShim` archive |
| `AwaitAddressAsync` | `Session.Address` → routes, TLS SANs, `ENVMUX_ADDRESS`, editor SSH |
| `SetDeviceAsync` (proxy) | `Session.WireRoomAsync` (`ApiBridge`) |
| `SnapshotAsync`/`SnapshotsAsync`, `copy` source | `Golden`, `ProjectImage` |

`IncusBackend` is `IncusApi` behind that interface with no behaviour change.
`KubeBackend` is §4–§6. The Docker shim, the portal, the editor and the room
all sit above the seam and should not know which one they are on.

---

## 4. Kubernetes: what an instance is

| envmux concept | Incus today | Kubernetes |
|---|---|---|
| instance | system container from a ZFS snapshot | a **Pod**, one container from the golden **OCI image**, plus a **PVC** for `/home` and the workdir |
| kept when stopped | instance stopped, disk kept | pod deleted, **PVC kept**; a new pod re-attaches it. `envmux prune` deletes PVCs |
| golden image | `envmux-golden/base` snapshot | the golden instance **published** as an OCI image and pushed to a registry, tagged by build |
| project image (features) | `envmux-image-<project>-<hash>/base` | a layered image tagged by the same feature hash; built in-cluster by a one-off pod, or on the workstation and pushed |
| services (postgres) | one instance per service on the bridge | one pod + **ClusterIP Service** per service, named as today; the session's env carries `<service>` as the host, which cluster DNS resolves |
| the account, sudo, tmux, sshd | provisioned into golden | the same, in the image |
| exec (pty) | `/1.0/instances/{n}/exec` websocket | `pods/{n}/exec` websocket (v5 channel protocol) — same shape, same tmux latch |
| one-shot exec | `record-output` | exec with stdout/stderr captured; no `record-output` equivalent, so the "pty never closes" problem in `Golden.cs` returns — use the non-tty three-stream exec |
| files | `/1.0/instances/{n}/files` | none. `kubectl cp` is `tar` over exec; do the same — envmux already tars tool state |
| address | pinned `ipv4.address` on `envmux0` | none the workstation can dial. §6 |

**Speak to the API server directly**, not through the `kubectl` binary:
`HttpClient` + `ClientWebSocket`, exactly as envmux talks to incusd. The
kubeconfig is parsed by envmux (clusters, users, contexts; token,
client-certificate, and `exec` plugins by running the plugin as documented).
`kubectl` stays what it is — the tool a person debugs with — and envmux stays
one binary with no runtime dependency it has to explain.

**Cold start** is image pull (cached on the node after the first) plus PVC
provisioning (Cinder, seconds to tens of seconds) plus pod scheduling. Not the
0.7 s of a ZFS clone; likely 20–60 s. Say so in the session log, once, the way
the fallback from golden says so today.

---

## 5. The control channel, remote-capable: a tunnel over exec

This is the part the cluster exists to prove. Today the instance reaches the
workstation because the Incus host is on the same switch. On the cluster the
pod has an address on `10.20/32` and no route to anything of ours. Every
service the instance consumes from the workstation — the room API, live
volumes, git credentials — has to arrive over a connection **the workstation
opened**.

The primitive: **the workstation execs a small relay in the instance, and the
relay multiplexes the instance's loopback ports over the exec stream.**

```
workstation                                              instance
─────────────────────────────                            ─────────────────────────────
envmux ── pods/exec websocket ──────────────────────────► envmux-tunnel (stdin/stdout)
   │  dials 127.0.0.1:<portal>                                │ listens 127.0.0.1:8078  ← room API
   │  dials 127.0.0.1:<live>                                  │ listens 127.0.0.1:8079  ← live volumes
   └─ one framed stream, many connections ◄──────────────────┘ (open/data/close frames, per-connection ids)
```

- It is `ExecBridge` (`src/Envmux/Docker/ExecBridge.cs`) run backwards, with
  a connection id on each frame. The framing is ours and tiny; yamux-shaped.
- **It is backend-neutral.** Over Incus it rides the same exec websocket
  envmux already holds open for tasks. The proxy device becomes an
  optimisation for the local case, not the mechanism — which is what "prove
  the control channel is remote capable" means in practice: land the tunnel,
  switch the room API and live volumes to it on Incus, watch nothing change,
  then bring up the cluster.
- **The guest end** has to exist in the image with no runtime. Debian cloud
  ships `python3`; an asyncio multiplexer is ~150 lines and is the MVP.
  Production is a static binary built on the Linux side during the golden
  build (NativeAOT for linux-x64 needs a Linux build host, which the golden
  build is) — and once that binary exists it is also the natural home for a
  FUSE client that replaces rclone.
- Authentication does not change: the tunnel carries bytes, and the API on
  the workstation end still wants the session token or the task's live-volume
  key. What the tunnel adds is that **the listener on the workstation can go
  back to loopback** — the bridge-facing listener and the Windows firewall
  question disappear for any backend using it.
- One tunnel per session, held for the session's life, re-established on
  drop like the tmux reattach. Latency per connection is the frame round
  trip, not a new exec.

The alternative considered — a relay pod in the cluster, reached by
`port-forward`, that session pods connect to over the cluster network — is
cleaner on Kubernetes and useless on Incus, and needs an image deployed into
every cluster before the first session can start. Rejected for the MVP;
noted as an optimisation if one tunnel per session proves costly.

---

## 6. Reaching the session: names, addresses, and the promise

The promise is "an address of its own, the real port, nothing in between".
On a remote backend nobody can route to the pod, so the address the person
dials has to be **on the workstation**, and it has to be one address per
session or two sessions binding `3000` collide again — the whole flattening
this project exists to remove.

**Per-session loopback aliases.** `127.0.0.0/8` is all loopback; Windows
answers on any address in it with nothing configured, Linux likewise, macOS
needs one `ifconfig lo0 alias`. A session is assigned `127.<x>.<y>.<z>`
(hashed from its name, collision-checked against running sessions), its name
resolves to that, its certificate is issued for the name exactly as today, and
**each route is a `pods/portforward` stream from `127.x.y.z:<port>` to the
pod's `<port>`** — the same port, on an address that is the session's. Two
sessions both bind `3000`, neither moves. `https://myproj-feat.envmux:5173`
opens with a padlock. `ssh matt@myproj-feat.envmux` reaches the pod's sshd
through a forward of `22`. The editor, the browser and `curl` cannot tell.

**Resolving the name.** Today NRPT sends `.envmux` to dnsmasq on the bridge.
With no bridge, envmux answers DNS itself: a UDP resolver on a fixed loopback
alias, NRPT pointed at it, owned by whichever envmux process is running
(leased and self-closing, the way the Docker endpoint is — `DockerLease`,
`ShimServer`), other sessions registering their names with it over loopback.
Daemonless still holds: with no session running nothing resolves, and nothing
is listening to be resolved to.

**The address inside.** `ENVMUX_ADDRESS` and the certificate's IP SAN are the
instance's own address today. In the pod that is the pod IP, which nothing
outside dials; keep the DNS SAN, drop the IP SAN on this backend, and have
`ENVMUX_ADDRESS` say the loopback alias — which is what a URL the task prints
gets rewritten to by the URL-pin path anyway.

### 6.1 The other way: a hub in the cluster, on a public IP, behind mTLS

> **Verified, 2026-09-03, with shell scripts** — [`spikes/kube-hub/`](../spikes/kube-hub).
> `verify.sh` 10 of 10 against the dev cluster.

Instead of bringing every session to the workstation's loopback, put one
**hub** in the namespace on a `LoadBalancer` IP (the cluster hands one out in
~13 s, and accepts UDP 53 and TCP on the same IP). It does two things:

- **answers DNS for the zone** — CoreDNS, any `*.envmux` → the hub's own IP.
  NRPT on the workstation points the zone at that public IP instead of a bridge;
- **terminates mTLS and routes by name** — nginx with `ssl_verify_client on`
  against the envmux CA, one `server` block per (port, session name), proxying
  plain HTTP to the session's ClusterIP Service. `a.envmux:3000` and
  `b.envmux:3000` reach different sessions on the **same public IP and port**;
  a client without a certificate from our CA never completes the handshake;
  the session sees `X-Envmux-Client: CN=matt,O=envmux`.

"Pre-installed" is exactly what envmux already has: `envmux ca` trusts the root
on the workstation; the hub's server certificate is issued from that root per
session name as today; the one new artefact is a **client certificate**
minted at onboarding beside the CA and imported into the personal store (PFX,
legacy algorithms — the Windows store refuses OpenSSL 3's defaults).

This makes a session reachable from anywhere the person's certificate is, with
no `port-forward` per route and no in-process resolver — the client
certificate does the job the private bridge does today. The two designs are
not exclusive: the hub is right for a shared or remote cluster; the loopback
aliases for a laptop with a local cluster and no public IP to be had. Node IPs
on this cluster are firewalled, so `hostPort` is not a third option.

Not yet measured on the hub: WebSocket passthrough (HMR), throughput, source
IP preservation through the cloud LB. Routine for nginx; check when built.

### 6.2 Chosen: Ingressive, a site per workspace route

> **Decision, 2026-09-03.** The hub in §6.1 is superseded. **Verified live** —
> [`spikes/kube-ingressive/`](../spikes/kube-ingressive), `verify.sh` 11 of 11
> against the dev cluster and the domain `its.matto.dev`.

[Ingressive](https://ingressive.cloud) is an edge network whose connector
**dials out** from wherever it runs; its Kubernetes controller turns an
`Ingress` with `ingressClassName: ingressive` into a **site** — DNS, a
Let's Encrypt certificate, and routing from the edge back over the connector's
overlay. The cluster opens no port, has no public IP, and installs no
cert-manager. The install is three commands (`.context/ingressive`: namespace,
credentials Secret, `helm install`); the controller checks in, creates a paired
connector, and is ready in about fifteen seconds.

**A route is a hostname.** Each route of a session is one `Ingress` with one
host, `<project>-<session>-<route>.<domain>`, pointing at that route's
`Service` port. Measured: **63 s** from `kubectl apply` to a live public site
with a trusted certificate; two workspaces both on `:3000` reached on the same
edge by name; a WebSocket upgrade answered `101` (so HMR works);
100–230 ms per request from the workstation; deleting the `Ingress` deletes the
site and the edge stops answering within about twenty seconds.

What it replaces and what it changes:

| | before (§6, §6.1) | with Ingressive |
|---|---|---|
| DNS | dnsmasq / in-process resolver / CoreDNS in a hub; NRPT on Windows | Ingressive hosts the zone; nothing on the workstation |
| certificates | envmux's own CA, per-session leaf, `envmux ca` trusted | Let's Encrypt, issued and renewed by Ingressive; a browser anywhere trusts it |
| reach | loopback aliases + `port-forward`, or a LoadBalancer IP | the public edge; the connector dials out |
| the URL | `https://name:5173` | `https://<project>-<session>-<route>.<domain>/` — **ports collapse into hostnames**; the URL-pin path rewrites what a dev server prints onto the route's hostname |
| access control | mTLS with a client certificate (hub) | **Shield**: password-protected routes, JS/captcha challenge; SSO planned; no client-certificate option. The portal keeps its own token |
| onboarding | build a hub, wire DNS, mint a client cert | two facts: an account with a connected domain, and the controller installed. envmux **verifies** by creating a probe `Ingress` and waiting for the first 200 |

The API behind the controller is small and known
(`PUT /sites/<host>` with `{ "config": { "locations": [...] } }`, SigV4-signed
with the account key, region `global`, service `api`), and a location carries
a `shield_id` the controller does not set. So a route declared private in
`.envmux.json` can be given its Shield through the same call envmux would
otherwise leave to the controller — the one place envmux might speak to
Ingressive directly rather than through an `Ingress`.

Two behaviours to design around: a site for a hostname whose domain is **not**
connected is created by the API but answers `404 Site is not configured` at the
edge — so envmux must check the domain at onboarding, not at session start;
and every route is a site, so a session with many routes is many sites — find
out whether the account has a limit before making routes cheap to declare.

The loopback-alias design (§6) remains the answer for a **local** cluster with
no public presence and no Ingressive account; the hub (§6.1) is kept as a
record of what was proven, not as a path.

---

## 7. Isolation, per backend

What keeps one session from another, and one person from another.

| | who trusts whom | between sessions | between people | where secrets live |
|---|---|---|---|---|
| **Build a VM here** (`hyperv`) | your client certificate is written into the install image; incusd's fingerprint is pinned | separate system containers on a private bridge only this machine routes to | one person, one VM | on the workstation; live volumes stream them, the guest holds copies only in the session overlay |
| **Connect to an Incus you have** (`incus`) | a trust token → your certificate added; fingerprint pinned | as above, on their bridge | **Incus projects**: one per person, sessions and images inside it; a restricted certificate scoped to the project | as above, but the tunnel (§5) is required — their bridge does not route to your workstation |
| **Kubernetes, local** (kind / k3d / Docker Desktop) | the kubeconfig it wrote | a Pod each; a NetworkPolicy is optional on a machine with one user | one person | as above |
| **Kubernetes, remote** | the kubeconfig — a token or an exec plugin — is the credential; never copied anywhere, referenced by path from `~/.envmux` | a Pod each; **default-deny NetworkPolicy** between session pods, allow to that session's own service pods; ResourceQuota per namespace | **one namespace per person** (`envmux-<user>`), RBAC scoped to it: pods, pods/exec, pods/portforward, pvcs, services, no cluster-wide verbs | **nothing sensitive is stored in the cluster.** No Secret objects carry credentials: the credential arrives live over the tunnel, into a process's mount namespace, and is gone when the pod is |

The last cell is the argument for doing live volumes before Kubernetes rather
than after. The copy-based `ToolMounts` would put the workstation's Claude
credential on a Cinder volume in someone else's datacentre. The live version
puts nothing there.

**FUSE and mount namespaces in a pod.** The spike's per-task isolation is
`unshare --mount` plus `/dev/fuse`, both of which a default pod security
context refuses. Options, in order of preference: (a) a `fuse` device plugin
on the cluster and `CAP_SYS_ADMIN` only for the tiny mount helper, not the
task; (b) one live-volume mount per **pod** rather than per task, keys scoped
per session — weaker, honest, and probably the right default for a remote
backend where the whole pod is one trust boundary anyway; (c) a non-FUSE
client (the static binary of §5 syncing the shadowed files into the pod's
overlay) for clusters that allow neither. Decide per cluster, at onboarding,
by asking the API what it permits.

---

## 8. Onboarding

`envmux install` gains one question first, and the rest follows from it:

```
Where should sessions run?

  1  Build a VM on this machine            Hyper-V, IncusOS installed by envmux — today's default
  2  Connect to an Incus you already have   a daemon on your LAN or a server; trust token, project
  3  A local Kubernetes                     kind, k3d, Docker Desktop — for working on envmux itself
  4  A Kubernetes cluster                   a kubeconfig you were given
```

`--backend hyperv|incus|kube` answers it on the command line;
`--kubeconfig <path> --context <name> [--namespace <ns>] [--registry <ref>]`
are the kube options, `--api`/`--token` the incus ones as today.

**More than one backend, at once.** `~/.envmux/host.json` becomes
`~/.envmux/backends/<name>.json` with a default. A repository may say
`"backend": "devclusta"` in `.envmux.json`; `envmux --backend <name>` overrides
per session; a session remembers which backend it is on (the instance record
already carries labels). `envmux host` takes the backend name and lists that
backend's steps. Sessions on different backends coexist because names resolve
through the one resolver (§6) and each backend hands out addresses it owns.

**The kube steps** (each an `envmux host` command, resumable):

1. **the kubeconfig** — read it, list contexts, pick one; run the exec plugin
   if the user is that kind; say what cluster and user it resolves to.
2. **permissions** — `SelfSubjectAccessReview` for exactly the verbs §7 lists;
   refuse clearly on the first `no`, naming the verb.
3. **the namespace** — use the context's, or create `envmux-<user>`; apply the
   default-deny NetworkPolicy and a quota if allowed.
4. **storage** — pick the default StorageClass (`ssd` here); say the size.
5. **the image** — find `envmux-golden:<build>` in the registry, or publish it:
   `incus publish envmux-golden/base` → OCI → push. If there is no Incus here
   either, pull the published image from the project's own registry.
6. **the tunnel** — start a probe pod from that image, open the exec tunnel,
   round-trip one connection, report the latency. Delete the pod. This is the
   step that proves the channel; it fails here or nowhere.
7. **the edge** (§6.2) — ask for the Ingressive domain; confirm the controller
   is installed (`ingressive-system`, an `IngressClass` named `ingressive`) or
   print the three-command recipe; then create a probe `Ingress` on a throwaway
   hostname under the domain and wait for the first 200 — about a minute — and
   delete it. A domain that is not connected fails here with the edge's own
   message, which is the moment to say so. Nothing is wired on Windows: no
   NRPT, no resolver, no route. For a local cluster with no Ingressive account,
   this step is the loopback-alias resolver of §6 instead.
8. **trust** — unchanged for the portal and the instance's own store. Routes no
   longer need it: their certificates come from Let's Encrypt via Ingressive.

For **kube local** the steps are identical; the difference is that step 5 can
`docker load`/`kind load` rather than push to a registry, and step 7 is the
same resolver.

For **remote Incus**, the delta from today is: the tunnel (§5) replaces the
proxy device; addresses come from §6 rather than the bridge; the project is
created and the certificate restricted to it.

> **Status, 2026-09-18 (`feat/incus-routed`) — part of phase 6, without the
> tunnel.** `envmux install --provider incus` now reaches a daemon it did not
> build by **routing**: the session subnet goes via the Incus host's own IPv4
> address (`envmux0`, or an existing network adopted with `--network`), and the
> zone is answered by a utility instance, `envmux-util`, whose dnsmasq forwards
> to the bridge's — so nothing depends on the host's INPUT chain. `host.json`
> records `network`, `gateway` and `resolver`; wiring refuses to take a range or
> zone wired to another host; install ends with a path check and a diagnosis for
> the host. That covers a host on the LAN, or over an overlay that carries the
> subnet. **What still needs the tunnel (§5):** the room's proxy device, and live
> volumes after it, still assume the Incus host can dial the workstation; a
> daemon with no routable subnet at all still needs §6's addresses; and a second
> host is still a second `ENVMUX_HOME`, not `backends/<name>.json`. No project is
> created and the certificate is not restricted to one.

---

## 9. What does not change

The parts of envmux that are above the seam and should be untouched by any of
this, listed so the plan is honest about its size:

- `.envmux.json`, tasks, routes, services declarations, `autoconfigure`
- the TUI and the portal (they read `Session`, not the backend)
- the room, `envmux agent`, the skill
- the git bundle in and out, commits coming back to a branch
- TLS: one CA, one certificate per session name
- the Docker shim's API surface (its translation target becomes `IBackend`)
- live volumes' policy, seeds, grants and audit — only their transport moves
  onto the tunnel

---

## 10. Phases

Each phase leaves `main` working on Hyper-V exactly as before.

| | phase | proves |
|---|---|---|
| 0 | **Extract `IBackend`** from `IncusApi`'s callers; `IncusBackend` behind it; no behaviour change; tests over the interface | the seam is real |
| 1 | **The exec tunnel**, guest end in python3 first; move the room API and live volumes onto it on Incus; proxy device kept as the fast path | the control channel needs nothing from the network |
| 2 | **`KubeBackend`: pods, exec, files-over-exec, PVC**, kubeconfig parsing including exec plugins; `envmux install --backend kube` steps 1–6; a session starts, a task runs, a shell opens, the bundle goes in and commits come back | a session runs somewhere envmux did not build |
| 3 | **Reach**: loopback aliases, port-forward per route, the in-process resolver, NRPT; editor over SSH through the forward | the promise holds without a bridge |
| 4 | **Images**: publish golden as OCI, project images by feature hash | cold start is honest and repeatable |
| 5 | **Services** as pods + ClusterIP; NetworkPolicy; quota | a whole `.envmux.json` runs remotely |
| 6 | **Remote Incus** as the third backend, reusing 1 and 3 | one design, three hosts |

**Acceptance for the cluster, end to end:** from this repository,
`envmux install --backend kube --kubeconfig .context/devclusta-xl-01-kubeconfig.yaml`
completes; `envmux --backend devclusta feat-x` opens a window with the docs
route reachable at `http://envmux-feat-x.envmux:5173` in a browser on this
machine; `c` gives a shell in the pod; Claude Code in it arrives signed in
through live volumes over the tunnel and lands on the prompt; `envmux agent
start` on that backend joins the room; `q` leaves the PVC; running it again
picks the session up; `envmux prune` removes it. Nothing envmux wrote is in
the cluster afterwards except what the person committed.

---

## 11. Risks, named

- **2.2 s exec setup.** Every design decision here assumes one connection
  held open, not many opened. Anything that regresses to per-op exec —
  `LogsCommand` reading a file, `PruneCommand` surveying — will feel it.
  Batch behind the tunnel or accept the wait, but decide per call.
- **FUSE in pods** (§7). Decide the fallback before phase 2 lands, so phase 2
  can be tested with live volumes and not only with the copy path.
- **Registry.** Phase 4 needs somewhere to push; a project-published golden
  image is the default that needs no cluster-side setup, and it is also a
  supply-chain surface. Pin by digest.
- **Cinder `Delete` reclaim.** A kept session is a PVC; a mistaken
  `kubectl delete pvc` is the session's uncommitted work. `envmux prune
  --force` is the only thing that should delete one, and it should say the
  branch name it is discarding.
- **OIDC exec plugins** open browsers. Run them only at onboarding and when
  a token has actually expired, never on a background poll.
- **`.context/` kubeconfigs.** The dev kubeconfig lives in `.context/`,
  which is git-ignored — correct — and outside `~/.envmux`, which is where
  a backend record will point. Onboarding should offer to copy it into
  `~/.envmux/backends/` so a `.context/` clean-up does not take the backend
  with it.
