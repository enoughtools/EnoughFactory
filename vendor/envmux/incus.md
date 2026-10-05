# envmux — IncusOS on Hyper-V Integration Spec

**Target platform:** Windows 11 host — Windows-only for v1
**Host OS:** IncusOS (immutable, API-only)
**Client language:** C# (.NET)
**DNS zone:** `*.envmux`
**Status:** Implemented on `feat/incus`, 2026-08-21
**Date:** 2026-08-21

> **v2 changes from v1:** Debian 13 host replaced with IncusOS. All seed data
> (certificates, network, Incus preseed) authored offline and injected into the
> install image before first boot. No Docker, no Compose, no intermediate
> migration step. Exec model is interactive-only with latch semantics.

> **Implemented, with three notes.** The spec is left as it was written; what
> follows is what happened when it met the sources.
>
> 1. **The client certificate nests inside `preseed`.** §3.3 shows
>    `certificates:` as a top-level key of `incus.yaml`. The Go struct has only
>    `version`, `apply_defaults` and `preseed`, and the list belongs to Incus'
>    own `InitPreseed` inside it. At the top level it is accepted silently,
>    installs nothing, and surfaces much later as `auth: untrusted` — exactly the
>    failure §3.3 tells you to guard against by reading the repository.
> 2. **qemu-img is not required.** §3.3's conversion step needs a tool that is
>    not on a Windows workstation. A fixed VHD is the raw image plus 512 bytes of
>    footer, and `Convert-VHD` ships with the Hyper-V role this already needs.
> 3. **The workspace is not addressed here, and is the hardest part.** A git
>    worktree cannot be bind-mounted across a machine boundary. It travels as a
>    **git bundle over the files API** — outbound, because a remote on the
>    workstation would need inbound through the Windows firewall — and the
>    commits come back the same way. Uncommitted work does not, which is why an
>    instance is kept when a session ends rather than deleted.
>
> The seed is JSON rather than YAML, since the installer takes either and .NET
> writes one without a dependency.
>
> `docs/pages/acceptance.md` maps §8's eleven criteria to what satisfies each,
> and says which six a test settles and which five need a real VM.

> **Since: a host envmux did not build (2026-09-18).** This spec is the VM, and
> stays that way. `envmux install --provider incus` attaches to an Incus that
> already exists, and two lines of §2 and §4.3 read differently there. The
> route's next hop is the **Incus host's own address**, which forwards between
> its LAN and the bridge. And the NRPT rule names **a utility instance**
> (`envmux-util`, a dnsmasq forwarding the zone to the bridge's) rather than
> `<bridge IP>`: on a machine with a firewall of its own, a query to the bridge
> address is a packet to the host's INPUT chain, which it commonly drops, where a
> query to an instance is forwarded like any session's traffic. §4.1's network
> may also be one the daemon already had, adopted with `--network` — its range
> and its `dns.domain` read, never written. `docs/pages/host.md` is the guide.

---

## 1. Purpose and scope

Replace the Docker Compose + YARP relay development topology with Incus instances,
each holding a real routable IP on a configurable range, resolvable under `*.envmux`.

The problem being solved is **port translation**. Under Docker on Windows every
environment is flattened onto the Windows host port space, so applications that
generate absolute URLs emit the wrong port. YARP exists only to paper over this.
Give each environment its own IP and the problem disappears at the source.

### In scope

- IncusOS host VM under Hyper-V, provisioned from an offline-seeded image
- C# client against the Incus REST API
- Complete cutover from Docker/Compose — no dual-running period

### Out of scope

- Strong sandboxing or multi-tenant isolation
- macOS/Linux client parity (planned; the client certificate and API are portable)
- Incus VMs (containers only for v1)

---

## 2. Architecture

```
Windows 11 host
│
├── envmux CLI (C#)
│     └── HTTPS + pre-seeded TLS client cert ──┐
│                                              │
├── Hyper-V "External" virtual switch          │
├── Static route:  <RANGE> → <VM IP>           │
└── NRPT rule:     .envmux → <bridge IP>       │
                                               │
        ┌──────────────────────────────────────▼─────────┐
        │ Hyper-V Gen 2 VM "envmux-host"                 │
        │ IncusOS — no shell, REST API only              │
        │                                                │
        │   incusd :8443                                 │
        │   envmux0 bridge + dnsmasq (DHCP + DNS)        │
        │   ZFS pool "local"                             │
        │                                                │
        │   ┌────────────┐ ┌────────────┐                │
        │   │ dev-01     │ │ dev-02     │   …            │
        │   │ .0.10      │ │ .0.11      │                │
        │   │ app :3000  │ │ app :3000  │                │
        │   │ pg  :5432  │ │ pg  :5432  │                │
        │   └────────────┘ └────────────┘                │
        └────────────────────────────────────────────────┘
```

`http://dev-01.envmux:3000` resolves and routes from Windows. Both instances bind
3000 and 5432 with no conflict and nothing rewriting anything.

---

## 3. Host: IncusOS under Hyper-V

### 3.1 Hard constraints — read before building

**Secure Boot must be disabled, and a real vTPM is mandatory.** Per the IncusOS
system requirements, certain physical servers *and Microsoft Hyper-V* have known
incomplete or broken UEFI implementations that do not permit enrolling custom Secure
Boot keys, so IncusOS must run with Secure Boot disabled on Hyper-V. Critically,
**it is not possible to run IncusOS with both Secure Boot disabled and a
software-backed TPM.** Hyper-V Gen 2 vTPM satisfies the TPM half; there is no
fallback if it is unavailable.

Consequences:

- The install seed **must** set `security.missing_secure_boot = true`.
- The VM **must** have `Enable-VMTPM` applied before first boot.
- Boot integrity binds to **PCR 4** rather than PCR 7 (PCR 7 carries no useful data
  with Secure Boot off). Changing the UKI changes PCR 4, which is expected on update.

Other constraints:

- **System disk ≥ 50 GiB.** Enforced in the installer; smaller fails outright.
- **Hyper-V cannot boot raw disk images** — the `.img` install media must be
  converted to VHDX.
- **IncusOS has no local or remote shell.** The entire system is managed through an
  authenticated REST API. If something is wrong at the OS layer, there is no `ssh`
  and no console login — you use the API, or you rebuild. Plan operational tooling
  accordingly; this is a design decision, not a limitation to work around.

### 3.2 Partition layout (for context when injecting the seed)

IncusOS uses `systemd-repart` at first boot:

```
EFI ESP (2 GiB)
seed data (100 MiB)          ← the seed partition
A-side signing / hashes / root
B-side signing / hashes / root
LUKS encrypted swap (4 GiB)
LUKS encrypted ext4 system data (25 GiB)
ZFS encrypted pool "local" (remaining space)
```

A/B roots give atomic updates and rollback. The seed partition is consumed during
install and factory reset.

### 3.3 Authoring the seed offline

The install seed is a **tar archive of JSON or YAML files written directly to the
start of the second partition of the install image**. Alternatively, a separate
partition labelled `SEED_DATA` on a FAT-formatted USB or an ISO can hold the files
directly on the filesystem rather than as a tar.

For this build we inject into the VHDX before first boot, so we use the tar-to-
partition-2 form.

> **Recommended path:** the project ships a web-based **IncusOS customizer** that
> produces a pre-seeded image, including a toggle for `missing_secure_boot` under
> "Advanced settings". Prefer it over hand-assembling the tar for the first build,
> then automate once the seed content is settled.

#### `install.yaml`

Presence of this file — even empty — triggers installation.

```yaml
# Required for Hyper-V: broken UEFI cannot enroll custom Secure Boot keys
security:
  missing_secure_boot: true

# Omit `target` when exactly one suitable disk is present; the installer
# auto-selects. Specify explicitly if the VM has more than one disk attached.
# target:
#   id: /dev/sda

force_install: false
```

Verify field names against `incus-osd/api/seed/install.go` in the `lxc/incus-os`
repository before committing — the schema is young and the API is not frozen.

#### `network.yaml`

**IncusOS prefers IPv6 and, by default, Incus will only be reachable on the IPv6
address after install.** For a Windows/Hyper-V client this is almost never what you
want, so pin IPv4 explicitly:

```yaml
version: "1"
interfaces:
  - name: enp0s3
    hwaddr: "00:15:5d:xx:xx:xx"     # the Hyper-V vNIC MAC, fixed at VM creation
    required_for_online: both
    addresses:
      - dhcp4
```

#### `incus.yaml` — certificates and network in one shot

This is where the offline credential injection happens. Pre-seeding the client
certificate removes the trust-token exchange entirely: the client is trusted from
first boot.

```yaml
apply_defaults: true

preseed:
  config:
    core.https_address: "[::]:8443"

  networks:
    - name: envmux0
      type: bridge
      config:
        ipv4.address: "10.100.0.1/24"          # ← configurable, see §4
        ipv4.nat: "true"
        ipv4.dhcp: "true"
        ipv4.dhcp.ranges: "10.100.0.10-10.100.0.200"
        ipv6.address: "none"
        dns.domain: "envmux"

  profiles:
    - name: default
      devices:
        eth0:
          type: nic
          network: envmux0
          name: eth0
        root:
          type: disk
          path: /
          pool: local

certificates:
  - name: envmux-cli
    type: client
    certificate: |
      -----BEGIN CERTIFICATE-----
      ... generated offline, see §5.1 ...
      -----END CERTIFICATE-----
```

`apply_defaults: true` makes the Incus application create a ZFS-backed pool named
`local` using remaining free space, create a bridge `incusbr0`, install the listed
trusted client certificates, and listen on 8443 on all interfaces.

> **Verify:** whether `apply_defaults` and an explicit `preseed.networks` block
> compose cleanly, or whether the default `incusbr0` also gets created alongside
> `envmux0`. If they conflict, either drop `apply_defaults` and specify the storage
> pool in `preseed`, or accept `incusbr0` existing unused. Test both before
> committing to a build script.

#### Assembling and injecting

```bash
tar -cf seed.tar install.yaml network.yaml incus.yaml

# Convert the raw USB install media to VHDX (Hyper-V cannot boot raw images)
qemu-img convert IncusOS_<version>.img -O vhdx -o subformat=dynamic \
    IncusOS_<version>.vhdx

# Write seed.tar to the start of partition 2 of the install image, before conversion
# (do this against the .img, then convert). Confirm the partition offset with
# `parted <img> unit B print` rather than assuming.
```

The seed must be written **before** the VHDX conversion, or against a mounted VHDX
using `Mount-VHD` on Windows. Keep the tar under the 100 MiB seed partition size —
not a real constraint for a few YAML files.

### 3.4 Hyper-V VM creation

```powershell
$VM    = "envmux-host"
$Root  = "D:\Hyper-V\$VM"
$Media = "$Root\IncusOS_<version>.vhdx"     # seeded install media

# Gen 2, "install an OS later" equivalent, blank system disk >= 50 GiB
New-VM -Name $VM -Generation 2 -MemoryStartupBytes 16GB `
       -NewVHDPath "$Root\$VM-system.vhdx" -NewVHDSizeBytes 256GB `
       -SwitchName "External"

Set-VMProcessor -VMName $VM -Count 8
Set-VMMemory    -VMName $VM -DynamicMemoryEnabled $false

# Secure Boot OFF — Hyper-V cannot enroll IncusOS's custom keys
Set-VMFirmware -VMName $VM -EnableSecureBoot Off

# vTPM is mandatory. Requires a key protector first.
Set-VMKeyProtector -VMName $VM -NewLocalKeyProtector
Enable-VMTPM -VMName $VM

# Attach the seeded install media as a SECOND disk
Add-VMHardDiskDrive -VMName $VM -Path $Media

# Harmless here, avoids a class of confusion later if bridged mode is ever used
Set-VMNetworkAdapter -VMName $VM -MacAddressSpoofing On

# Record the MAC for network.yaml
(Get-VMNetworkAdapter -VMName $VM).MacAddress
```

Note the ordering problem: `network.yaml` needs the vNIC MAC, but the MAC is
assigned at VM creation. Either create the VM first and then inject the seed, or set
a static MAC with `Set-VMNetworkAdapter -StaticMacAddress` and hard-code it in the
seed. **Static MAC is the better option for a repeatable build script.**

### 3.5 First boot

1. Start the VM. The installer reads the seed from partition 2 of the media disk,
   installs to the blank system disk, and reboots.
2. **Detach the install media disk.** IncusOS becomes confused if seed data is still
   present at boot; it also checks the `IncusOSInstallComplete` UEFI variable and
   will refuse to proceed if it believes it booted the install media again.
3. On the following boot IncusOS performs first-boot configuration, applies the
   Incus preseed, and installs the trusted certificates.
4. Verify from Windows: `curl -k https://<vm-ip>:8443/1.0` should return server info,
   and with the client certificate attached, `auth: trusted`.

---

## 4. Networking

### 4.1 The range is configuration, not a constant

The address range lives in exactly one place — `incus.yaml` at seed time, and the
`envmux0` network object thereafter. Expose it as a build parameter:

| Parameter | Default | Notes |
|---|---|---|
| `EnvmuxCidr` | `10.100.0.1/24` | Bridge address + prefix |
| `EnvmuxDhcpRange` | `10.100.0.10-10.100.0.200` | Leave headroom below `.10` for pinned addresses |
| `EnvmuxDnsDomain` | `envmux` | Drives `*.envmux` resolution |

Changing the range post-install is a single API call against
`PUT /1.0/networks/envmux0` plus a restart of attached instances, so this is not a
one-way door — but the Windows-side route and NRPT rule must be updated in step,
which is the part that will be forgotten. Make the CLI own both.

### 4.2 dnsmasq and `*.envmux`

Incus runs dnsmasq on the managed bridge, providing DHCP and DNS for attached
instances. `dns.domain: envmux` makes instance `dev-01` resolve as `dev-01.envmux`
from the bridge address. No separate dnsmasq deployment is required, and none should
be added — it would duplicate lease state.

### 4.3 Windows-side wiring (elevated, one-time per workstation)

```powershell
route add 10.100.0.0 mask 255.255.255.0 <envmux-host-LAN-IP> -p
Add-DnsClientNrptRule -Namespace ".envmux" -NameServers "10.100.0.1"
```

NRPT is the Windows analogue of macOS `/etc/resolver`. After this, `*.envmux`
resolves for **every** client — PowerShell, curl, .NET `HttpClient`, database
drivers — not just browsers.

**Verify with `curl`, never only with a browser.** Chromium and Firefox resolve some
names internally and will mask a broken OS-level resolver, which is precisely the
trap that `*.localhost` sets.

Also confirm: Windows Firewall permits outbound to the range; no VPN client claims
the range or overrides NRPT. VPN interaction is the most likely rollout surprise.

### 4.4 Address assignment

Prefer **pinned addresses** for orchestrator-created instances — it removes a
poll-for-IP round trip and makes generated connection strings deterministic before
the instance has booted:

```
POST /1.0/instances
  devices.eth0 = { type: nic, network: envmux0, "ipv4.address": "10.100.0.5" }
```

Keep pinned addresses below the DHCP range start. Ad-hoc instances can take DHCP and
have their address read back from `GET /1.0/instances/{name}/state`.

---

## 5. C# client — connection points

### 5.1 Authentication

The client certificate is generated **offline** and injected via `incus.yaml`
(§3.3). There is no trust-token exchange and no `POST /1.0/certificates` call in the
normal path.

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 \
  -nodes -keyout envmux-cli.key -out envmux-cli.crt \
  -days 3650 -subj "/CN=envmux-cli"
```

**C# gotcha — the single most likely thing to burn a day.** On Windows,
`X509Certificate2.CreateFromPemFile()` produces a certificate whose private key
SChannel cannot use for TLS client authentication. Round-trip it through PFX:

```csharp
var pem  = X509Certificate2.CreateFromPemFile("envmux-cli.crt", "envmux-cli.key");
var cert = new X509Certificate2(pem.Export(X509ContentType.Pfx));

var handler = new HttpClientHandler();
handler.ClientCertificates.Add(cert);

// incusd presents a self-signed server cert. Pin its fingerprint.
// Do NOT disable validation wholesale.
handler.ServerCertificateCustomValidationCallback =
    (_, srvCert, _, _) =>
        srvCert!.GetCertHashString(HashAlgorithmName.SHA256)
                .Equals(ExpectedServerFingerprint, StringComparison.OrdinalIgnoreCase);
```

The same certificate and code work unchanged from macOS and Linux clients later.

### 5.2 Endpoint map

| Purpose | Endpoint |
|---|---|
| Server info, feature detection | `GET /1.0` — inspect `api_extensions` |
| **IncusOS host management** | `GET/POST /os/1.0/...` (proxied through Incus) |
| Networks (range changes) | `GET/PUT /1.0/networks/envmux0` |
| List / create instances | `GET`, `POST /1.0/instances` |
| Start / stop / restart | `PUT /1.0/instances/{name}/state` |
| Read assigned IP | `GET /1.0/instances/{name}/state` |
| Exec | `POST /1.0/instances/{name}/exec` |
| Push / pull files | `GET`, `POST /1.0/instances/{name}/files?path=` |
| Snapshot / restore | `POST /1.0/instances/{name}/snapshots` |
| Copy (CoW clone) | `POST /1.0/instances` with `source.type=copy` |
| Live event stream | `GET /1.0/events` (websocket) |
| Await async work | `GET /1.0/operations/{uuid}/wait?timeout=` |

The API is published as OpenAPI at `doc/rest-api.yaml` in `lxc/incus` and can be
used to generate a typed C# client rather than hand-writing DTOs.

IncusOS-specific endpoints require the `/os/` prefix — e.g.
`GET /os/1.0/applications`. Debug endpoints under `/os/` carry no stability
guarantee; do not depend on them.

### 5.3 Async operations

Mutating calls return `202 Accepted` with an operation URL. Poll
`GET /1.0/operations/{uuid}/wait?timeout=30`. Use `status_code` (integer) for
control flow, never `status` (string).

### 5.4 Exec — interactive-only with latch

**Decision: every exec is interactive.** `record-output` and the non-interactive
three-socket mode are not used.

`POST /1.0/instances/{name}/exec` with `interactive: true` returns an operation of
class `websocket` whose `metadata.fds` map holds one-time secrets: a single
bidirectional PTY socket, plus a `control` socket. Dial both with `ClientWebSocket`
using the same client certificate.

```jsonc
{
  "command": ["tmux", "new-session", "-A", "-s", "<taskId>",
              "bash", "-lc", "<user command>"],
  "environment": { "TERM": "xterm-256color" },
  "wait-for-websocket": true,
  "interactive": true,
  "width": 120,
  "height": 40
}
```

#### Why a multiplexer is mandatory, not optional

An interactive exec is a PTY owned by the connection. **Closing the websocket tears
down the PTY and kills the process group.** Without a multiplexer inside the
instance, a dropped connection kills a running build — and since `record-output` is
not in use, its output is lost too.

**Decision: tmux**, reusing the existing session-handling code in the codebase.

`tmux new-session -A -s <taskId>` attaches to an existing session or creates it if
absent, which is exactly latch: attach, detach, reattach, with the process surviving
throughout. tmux also retains scrollback, so a reattaching client can see what it
missed — something a socket-only multiplexer such as `dtach` would not provide.

Session naming is the orchestrator's contract. Use a stable `taskId` per logical
task so reattachment is deterministic; `tmux list-sessions` via a throwaway exec
enumerates what is currently latchable in an instance.

**tmux must be baked into the golden instance image (§6.2).**

#### Control socket

The control socket carries signals and window-resize messages. The client must:

- put the local console in raw mode and restore it on exit;
- send a resize message on `Console.WindowWidth`/`WindowHeight` change;
- forward Ctrl-C as a signal rather than swallowing it.

#### Log capture without `record-output`

Since `record-output` is out of scope, capture inside the instance and retrieve via
the files API:

```
tmux new-session -A -s <taskId> \
  bash -lc "<cmd> 2>&1 | tee /var/log/envmux/<taskId>.log"
```

`tmux pipe-pane -o -t <taskId> 'cat >> /var/log/envmux/<taskId>.log'` is an
alternative that captures without wrapping the command, and can be toggled on an
already-running session.

Then `GET /1.0/instances/{name}/files?path=/var/log/envmux/<taskId>.log`. Unlike
`record-output`, these logs do not auto-expire — the CLI owns retention.

### 5.5 Containers only

Container exec goes through liblxc and always works. VM exec requires `incus-agent`
running inside the guest and has a known inconsistency in how it honours
`wait-for-websocket`. v1 is containers only. Nested Incus VMs would additionally
require nested virtualisation on the Hyper-V host, which is out of scope.

---

## 6. Cutover from Docker + YARP

**No transitional period.** The Compose files and the Docker CLI are removed in the
same change that introduces envmux. Running both invites the port-space problem to
persist in whichever half still has it.

### 6.1 Concept mapping

| Docker / Compose | envmux / Incus |
|---|---|
| Compose service | Instance |
| Compose project | Incus project + network |
| Compose network | `envmux0` (or per-project network) |
| `ports:` publishing | **Deleted.** Instance owns an IP |
| YARP relay | **Deleted** |
| `X-Forwarded-*` middleware | **Deleted** for local dev |
| Named volume | Storage volume on pool `local` |
| Bind mount | `disk` device with `source=` |
| Dockerfile | Golden instance + snapshot + `incus copy` |
| `docker exec` | `POST .../exec` (interactive, latched) |
| `depends_on` | Launch ordering in the C# orchestrator |
| Image registry | `images:` remote |
| `healthcheck:` | Orchestrator-side polling |

### 6.2 Golden instance workflow (replaces image builds)

There is no Dockerfile equivalent and no layer cache. The pattern is:

1. `POST /1.0/instances` from `images:debian/13/cloud`
2. Provision via `exec` and the files API — toolchain, `tmux`,
   `/var/log/envmux`, user accounts
3. `POST /1.0/instances/golden/snapshots` → `base`
4. `POST /1.0/instances` with `source.type=copy` from `golden/base`

On a ZFS or btrfs pool the copy is near-instant and near-zero disk. **This is the
mechanism that makes "another dev machine" cheap** — verify the pool backend is ZFS
(it will be, via `apply_defaults`) before benchmarking anything.

Drift is managed by rebuilding `golden` and re-snapshotting, not by layering.

### 6.3 What gets deleted — track as acceptance criteria

- The YARP relay project
- Forwarded-headers middleware configuration for local development
- The host port allocation table and `.env` port offsets
- `docker compose port` discovery calls
- Any `*.localhost` hostname scheme
- All `docker-compose.yml` files and Docker Desktop as a dependency

### 6.4 Aspire — demo scenario only

Aspire is **not** part of the target architecture and imposes no requirements on
this build. It appears here solely as a demonstration workload, because it exercises
the exact failure mode envmux exists to remove.

Used as a demo: an Aspire AppHost runs unchanged inside a single instance. Its
endpoints bind natural ports on a dedicated IP, and its dashboard's fixed default
ports stop colliding across projects because each project has its own address. The
orchestration-on-orchestration problem resolves itself — Incus owns the machine
boundary, Aspire owns the process graph within one machine.

Do not treat Aspire compatibility as an acceptance criterion or design constraint.

### 6.5 Phasing

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Seeded IncusOS image builds reproducibly | VM boots, API reachable with pre-seeded cert |
| 1 | Route + NRPT; `envmux0` live | `curl http://<name>.envmux:3000` from PowerShell |
| 2 | C# client: create, copy, exec-latch, files | `envmux up` yields an addressable, attachable instance |
| 3 | Golden instance + snapshot workflow | New environment in under 10 seconds |
| 4 | First project fully on envmux | §6.3 list empty for that project |
| 5 | Docker Desktop uninstalled | No Docker dependency in any repo |

---

## 7. Risks and known issues

**Degraded security posture is expected, not accidental.** Secure Boot off plus real
vTPM is the only supported Hyper-V configuration. Boot integrity binds to PCR 4.
Document this so it is not later mistaken for a misconfiguration.

**No shell on the host.** Debugging IncusOS itself means the REST API or a rebuild.
Budget for the operational discipline this requires; it is the main cost of choosing
IncusOS over Debian.

**Image trust.** Incus 7.x has had repeated critical vulnerabilities in image
handling — arbitrary host file read/write via crafted `metadata.yaml` templates,
backup-import path traversal, image-fingerprint path traversal — fixed across 7.2
(June 2026) and 7.3 (July 2026). Restrict image sources to the official `images:`
remote. Do not import untrusted images or backups. Keep the daemon current; IncusOS
A/B updates make this low-risk.

**Seed schema is young.** IncusOS reached GA in November 2025. Validate seed field
names against the repository before each version bump rather than assuming
stability.

**IPv6-first default** will silently produce an IPv6-only management endpoint if
`network.yaml` is omitted or wrong. Symptom: the API is unreachable from Windows for
no obvious reason.

**Install media must be detached** after install, or the next boot fails a sanity
check.

**VPN and NRPT** interact badly on many corporate configurations. Test before
rollout.

**No live migration.** Instances are disposable and reproducible from profile plus
golden snapshot.

---

## 8. Acceptance criteria (v1)

1. Seeded IncusOS VHDX builds from a scripted, repeatable process.
2. VM boots to a working Incus API with Secure Boot off and vTPM enabled.
3. The C# client authenticates with the pre-seeded certificate — no trust token
   exchanged at any point.
4. `envmux0` uses the configured CIDR and DHCP range; both are build parameters.
5. `curl http://<name>.envmux:3000` succeeds from Windows PowerShell, not only from
   a browser.
6. Two instances simultaneously bind 3000 and 5432 with no conflict and no proxy in
   the path.
7. An interactive exec attaches, survives client disconnect, and reattaches to the
   same running process (latch).
8. Terminal resize propagates correctly over the control socket.
9. A command's output is retrievable from `/var/log/envmux/<taskId>.log` via the
   files API after the client has disconnected.
10. A new environment is created from the golden snapshot in under 10 seconds.
11. No Docker or Compose artefact remains in the migrated repository.

---

## 9. References

**IncusOS**
- System requirements (Secure Boot / TPM constraints) — https://linuxcontainers.org/incus-os/docs/main/getting-started/requirements/
- Hyper-V installation — https://linuxcontainers.org/incus-os/docs/main/getting-started/installation/virtual-hyperv/
- Installation seed reference — https://linuxcontainers.org/incus-os/docs/main/reference/seed/
- Incus application seed (`apply_defaults`, certificates) — https://linuxcontainers.org/incus-os/docs/main/reference/applications/incus/
- Partitioning scheme — https://linuxcontainers.org/incus-os/docs/main/reference/partitioning-scheme/
- System security (PCR usage) — https://linuxcontainers.org/incus-os/docs/main/reference/security/
- IncusOS REST API (`/os/` prefix) — https://linuxcontainers.org/incus-os/docs/main/reference/api/
- Seed schema source of truth — https://github.com/lxc/incus-os (`incus-osd/api/seed/`)

**Incus**
- REST API — https://linuxcontainers.org/incus/docs/main/rest-api/
- OpenAPI source — `doc/rest-api.yaml` in https://github.com/lxc/incus
- API extensions (feature detection) — https://linuxcontainers.org/incus/docs/main/api-extensions/
- Preseed initialisation reference — https://linuxcontainers.org/incus/docs/main/howto/initialize/
- Security advisories — https://linuxcontainers.org/incus/news/
- Go reference client, useful as a behavioural spec for the exec websocket
  handshake — https://pkg.go.dev/github.com/lxc/incus/client