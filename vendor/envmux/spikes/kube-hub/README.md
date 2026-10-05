# kube-hub spike — one public IP, DNS for the zone, mTLS at the edge

Proves, with shell scripts against the dev cluster, the question behind
[docs/backends.md](../../docs/backends.md) §6: can a pod in the cluster be the
address every session name resolves to, and route to each session by name on a
shared public IP and port, letting through only clients that hold a certificate
from the envmux CA?

**Yes.** Verified 2026-09-03 against `devclusta-xl-01` (Kubernetes 1.34.9,
Rackspace spot, Cinder CSI): `verify.sh` 10 of 10.

| claim | result |
|---|---|
| a `LoadBalancer` Service gets a public IP | yes, in ~13 s; mixed UDP/53 + TCP on one IP accepted |
| the hub answers DNS for `*.envmux` from the public internet | yes — CoreDNS `template`, any name → the hub's IP |
| two sessions on port 3000 are told apart on one public IP | yes — nginx routes by SNI/`server_name`, terminating TLS |
| only a client with a certificate from the envmux CA gets through | yes — `ssl_verify_client on` against `~/.envmux/envmux-ca.crt`; no cert → 400, stranger → handshake refused |
| the session sees who connected | yes — `X-Envmux-Client: CN=matt,O=envmux` |
| unknown name | 421 |
| node public IPs reachable directly | **no** — firewalled; `hostPort` is not an option, the LB is |

`envmux ca` already trusts the root on this machine, so the browser side of
"pre-installed" is the client PFX in the personal store; the server side is a
certificate the hub is issued from the same CA. Nothing new is trusted anywhere.

## Pieces

| | |
|---|---|
| `certs.sh` | Mints a wildcard `*.envmux` server cert and a `CN=<you>` client cert from `~/.envmux/envmux-ca.{crt,key}`, plus a legacy-algorithm PFX the Windows store accepts. Into `certs/`, git-ignored. |
| `deploy.sh` | The hub Service (LoadBalancer, UDP 53 + TCP 3000 + TCP 5173), three pretend sessions (`http-echo`, two of them on 3000), the TLS Secret, CoreDNS and nginx ConfigMaps, and the hub Deployment. Writes `hub.ip`. |
| `verify.sh` | From the workstation: DNS, three mTLS routes, the identity header, three refusals, latency. |
| `cleanup.sh` | Takes it all down. |

```sh
export KUBECONFIG=Z:/envmux/.context/devclusta-xl-01-kubeconfig.yaml
cd spikes/kube-hub
sh certs.sh            # once
sh deploy.sh           # ~90 s: LB IP, then rollouts
sh verify.sh           # 10 checks
sh cleanup.sh
```

## Findings

**Git Bash's curl is schannel-built and cannot be an mTLS client here.** It
fails to import a PEM client certificate (`0x80092002`) and rejects an OpenSSL 3
PFX (`SEC_E_UNKNOWN_CREDENTIALS`). `verify.sh` uses `openssl s_client`, which is
OpenSSL-backed and behaves like a browser with the PFX installed. The PFX itself
is exported with `-legacy` (3DES/RC2) because the Windows store refuses the
AES-256/PBKDF2 defaults; `certutil -dump` confirms it parses.

**`MSYS_NO_PATHCONV=1`, then Windows-style paths.** Git Bash rewrites
`-subj /O=envmux/…` into `C:/Program Files/Git/O=envmux/…`. With conversion off,
a Windows `openssl.exe` then cannot open `/z/envmux/…`, so paths go through
`cygpath -m`. Both halves are needed; `incus.cs` in the live-volumes spike hit
the first half.

**The DNS answer has to be the load balancer's IP, so the Service comes first.**
Create it, wait for the address, then write the Corefile.

**What this means for the plan.** §6 of `docs/backends.md` proposed reaching
remote sessions through per-session loopback aliases and `port-forward`. This
is the other way: sessions reachable from anywhere the person is, no
port-forward per route, NRPT pointing the zone at a public IP, and the client
certificate doing what the private bridge does today. The two are not
exclusive — the hub is the right answer for a shared or remote cluster, the
loopback aliases for a laptop with a local cluster and no public IP to be had.
In envmux proper the hub is one Deployment per namespace, its server
certificate is issued per session name exactly as today (one `server` block
each, added when a session starts), and the client certificate is minted at
onboarding beside the CA.

**Not measured:** throughput, WebSocket passthrough (dev servers' HMR), and
whether the cloud LB preserves source IP. All routine for nginx; check them
when it is built.
