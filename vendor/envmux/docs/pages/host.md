# The host

The optional Incus backend runs sessions on an IncusOS virtual machine under Hyper-V — or on an Incus you
already run, which has [a section of its own](#an-incus-you-already-run). You
build it once per workstation and then mostly forget it. This page is what each
step is doing, and why the constraints are the ones they are.

**`envmux install --provider hyperv` does all of it as a wizard**, and is what you want the first
time. This page is what it is doing on your behalf, and `envmux host` is the same
steps one at a time for when one of them needs doing differently.

Everything envmux keeps lives in `~/.envmux`: `host.json`, the client
certificate, downloaded images, and the VM's disks. One directory, on purpose —
all of it is something a person has reason to look at, copy to another machine,
or delete.

## Why a VM at all

The whole design turns on one thing: **an environment gets a machine of its
own**. Under Docker on Windows every environment is flattened onto the host's
port space, which is why a dev server has to be published on some other port, why
two sessions cannot both bind 3000, and why an application that generates
absolute URLs emits the port it bound rather than the one it was reached on.

Incus gives each instance a real address on a bridge, and its own loopback. A
dev server in a session binds 5173 — or `127.0.0.1:5173` — exactly as it would
on a laptop, and the session's [browser](browser.md) reaches it at
`http://localhost:5173/` with nothing in between. That needs a Linux machine to
run incusd on, and on Windows that means a VM.

IncusOS rather than Debian because it is immutable, updates A/B, and has no shell
— which is a real cost, and is discussed below.

## How the workstation reaches a session

Through the host's REST API, and nothing else. The session process holds a
SOCKS5 port on `127.0.0.1` and opens a browser on it whose `localhost` is the
instance; each connection is an exec into the instance, carried over the API.
The editor's SSH attach goes the same way: a session's name under the zone is an
ssh alias whose `ProxyCommand` is `envmux relay`. **Nothing on this workstation
routes to the range or resolves the zone**, nothing needs an elevated prompt for
that, and a host is usable from anywhere its API port is reachable — a LAN, an
overlay, or the far side of the internet.

That is a change. envmux used to add a persistent route for the range and an
NRPT rule for the zone, so `http://myproj-feat-login.envmux:5173` resolved and
routed from Windows; on an Incus you already ran it also started a small
instance to answer the zone, checked the path with a real DNS query, and issued
a certificate per session. All of it is retired, and
[`archive/zone/`](https://github.com/envmux/envmux/tree/main/archive/zone)
says what each piece was and why it went. A workstation set up by that version
still has its route and rule; `envmux host unwire` removes them, and
`envmux host status` says when they are there.

## Two hosts, one shape

The VM is a means, not the point. The point is **a trusted incusd at an address,
with a network sessions attach to** — and if you already run Incus somewhere,
envmux can point at it instead of building anything:

```console
$ envmux install --provider incus
```

`hyperv` is the default and is most of this page. `incus` skips the entire first
half of it — no image, no switch, no VM, no install to wait out. It trusts the
daemon you name and gives it an `envmux0` bridge, or adopts a network it already
has. The next section is the guide to that path, and
[Add a remote Incus host](playbooks/add-remote-host.md) is the same thing as a
procedure: the commands, what you should see, and how to back out.

Everything from **The hard constraints** up to **Trust** is the Hyper-V build
path, and an existing-Incus install does none of it. From **The range** onward
the two are the same host and the same commands.

## An Incus you already run

The promise is the same one the VM makes: a session's browser reaches the
session, and the editor attaches to it, from this workstation, over the host's
API. What differs is whose machine is in the path. It is yours, it was there
first, and it runs other things — so this section is as much about what envmux
leaves alone as about what it does.

### What the host has to be

- **A Linux machine running incusd, able to have a bridge Incus manages.** envmux
  makes one or adopts one. Either way Incus owns the bridge, its DHCP and its
  dnsmasq. A macvlan or a physical NIC will not do: a pinned address is handed
  to an instance by the bridge's DHCP, and a session reaches its own services
  by names the bridge's dnsmasq answers.
- **The API reachable from this workstation.** 8443 is the convention and the
  default; `--api host:port` takes any other, and `https://host:port` is
  accepted the way it is usually pasted. A daemon that only listens on its unix
  socket needs `incus config set core.https_address :8443` first. That is the
  whole of the network requirement: a TCP connection to one port.
- **A trust token.** `incus config trust add envmux` on the host, and paste what
  it prints. A daemon you did not seed has never met your certificate, so there
  is no first-boot trust to inherit — this is the online version of the same
  exchange.

**`envmux host prepare` gets a host to that state for you.** It prints a script —
or, with `--ssh user@host`, runs it over your own ssh, with your terminal still
attached so `sudo` can ask you for a password — that sets `core.https_address`
only if it is unset, turns IPv4 forwarding on persistently, adds the
forward-accept for the bridge where Docker or ufw is in the way and nothing of
the owner's already handles it, and mints the token, printed last on one marked
line: `ENVMUX-TOKEN: …`. The forwarding and the firewall rule are for the
instances' own traffic out through the host's NAT — Docker's `FORWARD DROP` on
the same host discards that too, and it presents as an `npm ci` that hangs.
One line for the token, because the shell on a host is not always one you can
copy a screenful out of. Printed, the script is the only thing on stdout — what
it is goes to stderr — so it pipes to the clipboard as it is. Over `--ssh`, the
token's line is kept off the screen and envmux offers to carry straight on into
`install` with it; it is shown only when envmux is not going to use it, and is
never written anywhere. It is idempotent, and `--check` reports, changes nothing
and mints nothing. It is the one place envmux offers to change the host's
firewall or sysctls, and it does it as a script you run, as you, where you can
read it first.

**The token is enough on its own.** An Incus trust token carries the addresses
the daemon listens on and its certificate's fingerprint, so
`envmux install --provider incus --token <token>` needs no `--api`: it tries the
addresses, keeps the one that answers with the matching certificate, and pins it
without anybody comparing hex. That matters more than it sounds. The address a
person is *given* for a daemon is often a name that resolves somewhere the
daemon cannot be reached from here — an overlay address, a reverse proxy — while
the daemon answers happily on the LAN. The token knows where it really listens.
`--api` beside a token still names the address to use, and is held to the
token's certificate: one that does not match is refused outright, and the token
is not sent.

For a scripted install, `--token <token>` — with `--api <host[:port]>` to choose
the address yourself — supplies everything
without a prompt, so the whole attach runs unattended. The trust call sends the
token in Incus' `trust_token` field, which is what the daemon expects across the
6.0 LTS and 7.x series alike.

### What envmux does to it, and what it never does

Six steps, and install says which one it is on. Every one is skipped when it is
already done.

| | | |
|---|---|---|
| 1 | the range | Asks nothing on this path, and says the range waits for step 4 — a network that already exists has one of its own. It is also where a `host.json` describing a *different* kind of host is noticed, and a [swap](playbooks/swap-host.md) offered |
| 2 | the certificate | The client certificate, generated on this machine, or found already here |
| 3 | the daemon | Finds the daemon — with a token and no `--api`, by trying the addresses the token lists and keeping the one that presents the token's certificate (a `tried` line says how each went). Reads the certificate, prints its address, subject and fingerprint, and pins it: without asking when it `matches the token`, after asking otherwise — the same one silent connection `envmux host trust` makes, on which nothing is ever sent. Then adds envmux's certificate to the daemon's trust store with your token; a daemon that already trusts it is not given the token at all |
| 4 | the network | Reads the network if it is already there — `envmux0` made from another workstation, or the one `--network` names — and takes its range and zone into `host.json`. Otherwise asks for the two and creates `envmux0`: NAT on, IPv6 off, `dns.domain` set to the zone |
| 5 | the golden instance | The snapshot every session is copied from |
| 6 | the editor's key | An ed25519 key every session lets in, and a `Host *.<zone>` entry in `~/.ssh/config` naming it and the `ProxyCommand` that reaches an instance |

Sessions, their services and project images come later, each an instance
carrying envmux's labels.

And it never does these:

- **It never reconfigures or deletes a network it did not create.** `envmux0`
  carries the description `envmux sessions`; a network without it is read and
  attached to, nothing else. `envmux host reset` leaves it where it found it.
- **It never edits the default profile.** Every envmux instance names its network
  on its own `eth0`, so your other instances keep coming up wherever they always
  did. Storage is the opposite case: an instance takes its root disk from the
  default profile, so it lands on whatever pool you already chose.
- **It never touches the host's firewall, sysctls or routes over the API.** It has
  no shell there and does not want one. `envmux host prepare` writes the script;
  running it is your decision about your machine, made with your own shell.
- **It never touches an instance it did not make.** `prune` and `reset` go by
  envmux's labels, not by what happens to be on the network.
- **It never pulls an image from anywhere but the official remote.** See
  [Image trust](#image-trust).

### Adopting a network you already have

```console
$ envmux install --provider incus --network incusbr0
```

`--network` names a managed bridge the daemon already has, and envmux **adopts**
it: reads it, attaches sessions to it, and never reconfigures or deletes it.

It has to be something sessions can live on, and install refuses one that is not,
rather than fixing it: a name the daemon does not have, a network that is not a
bridge, one with no `ipv4.address`, one with `ipv4.dhcp` turned off, or one with
`dns.mode` set to `none` — no dnsmasq answering for names inside the instances,
which is how a session finds its services.

What it reads becomes what envmux uses:

| From the network | Becomes in `host.json` | |
|---|---|---|
| `ipv4.address` | `cidr` | The range is the network's. `--cidr` has nothing to say about it |
| `dns.domain` | `dnsDomain` | **The zone is adopted with the subnet.** Unset means Incus' default, `incus`, so a session's ssh alias is `myproj-feat-login.incus` |
| `ipv4.dhcp.ranges` | `dhcpRange` | Empty when the network sets none |

A stock `incusbr0` is the usual case and shows all three: an address Incus picked
for itself — `10.252.20.1/24` on the host this was written against — no
`dns.domain`, and no DHCP ranges. Adopted, that is the range `10.252.20.0/24`, the
zone `.incus`, and a pinned band that is the whole subnet above the bridge.

The zone comes with the network because of who answers for it inside the
instances. The bridge's dnsmasq answers for its own domain and no other, and
envmux will not change that domain on a network that is not its own. So
`--domain` has nothing to say either: given with `--network`, both are ignored,
and install says so in a line. If you want `.envmux` on an adopted bridge, set
`dns.domain` on it yourself first — it is your network — and then adopt it.

**Pinning is lease-aware**, because an adopted network has tenants envmux did not
create. An address is chosen only if no instance pins it *and* the network's
lease table does not hold it. With no DHCP range set, the pinned band is the
whole subnet above the bridge; with one, it is what lies below it, as on
`envmux0`.

`envmux host range` moves `envmux0` and refuses an adopted network, for the same
reason as everything else here: the range is the network's, and the network is
not envmux's to change.

### Two hosts from one workstation

`host.json` describes one host. A second host is a second directory:

```powershell
$env:ENVMUX_HOME = "$HOME\.envmux-lab"
envmux install --provider incus --api 192.168.19.43 --domain lab
```

Every command run with `ENVMUX_HOME` set talks to that host, and every command
run without it talks to the one in `~/.envmux`. The two may share a range —
nothing here routes to either — and should differ in zone, because the zone is
the suffix of a session's ssh alias and `~/.ssh/config` holds one envmux block.
Two zones in it are two aliases that reach two hosts, but the `envmux relay`
they run reads `host.json` from whatever `ENVMUX_HOME` *it* is given, and an
editor's helper process rarely has yours; the second host's aliases work best
from a shell that has it set.

Copy `id_ed25519` and `id_ed25519.pub` from `~/.envmux` into the new directory
**before** installing, and both hosts' sessions let in the one key the block
names — they are files, not platform credentials, and neither is regenerated
while it exists.

### Where this stops

The one limit points inward. The room a [remote agent](agents.md#the-transport)
talks through reaches the workstation over an Incus proxy device, which has the
Incus **host** dial the workstation. On a LAN it can. Across anything that admits
connections one way only, it cannot, and that part waits for the tunnel in
[the backends plan](https://github.com/envmux/envmux/blob/main/docs/backends.md).
Sessions, the browser, the editor and the portal do not depend on it.

## The hard constraints

Read these before building anything; two of them have no workaround.

**Secure Boot must be off, and the TPM must be real.** Hyper-V's UEFI cannot
enrol IncusOS' custom Secure Boot keys, so IncusOS has to run with Secure Boot
disabled — and it refuses to run with Secure Boot disabled *and* a
software-backed TPM. So the vTPM has to be the Hyper-V one, enabled with
`Enable-VMTPM` before first boot. There is no third configuration and no fallback
if the vTPM is unavailable.

The consequence is that boot integrity binds to **PCR 4** rather than PCR 7,
because PCR 7 carries nothing useful with Secure Boot off. Changing the UKI
changes PCR 4, which is expected on update. This is a degraded security posture,
it is deliberate, and it is written down here so it is not later mistaken for a
misconfiguration.

**The system disk must be at least 50 GiB.** Enforced by the installer; smaller
fails outright. `envmux host vm` refuses before creating anything rather than
after.

**There is no shell on the host.** No `ssh`, no console login. The entire system
is managed through an authenticated REST API. If something is wrong at the OS
layer you use the API or you rebuild. That is the main cost of choosing IncusOS
over Debian, and `envmux host status` exists because of it — it is the command to
run when something is wrong, because there is nothing on the far end to run
anything else on.

## Choosing the image

`envmux install --provider hyperv` reads
[the published index](https://images.linuxcontainers.org/os/index.json), which
lists every published build and every file in it, and takes the newest **stable**
one for this machine's architecture. `--version` pins a build and `--channel
testing` takes the other stream.

Two things it gets right that are easy to get wrong by hand:

- **The `image-raw` file, not `image-iso`.** The ISO is not a hybrid image,
  Hyper-V will not boot it, and envmux reads a GPT out of a raw one to find where
  the seed goes. The IncusOS documentation says this in a sentence that is easy
  to read past.
- **The URL.** A build's `url` and a file's `filename` are both relative to the
  index, and joining them the obvious way — root plus filename — is a 404. The
  build's own directory goes between them.

The download is checksummed against the index before it is unpacked, because this
file is about to be seeded with a private credential and installed unattended on a
machine with no console; a truncated one would fail somewhere unrelated, hours
later, with nothing pointing back at it.

Unpacked images are kept in `~/.envmux/images/`, named for their build, so a
second host or a rebuild costs nothing. If the index is unreachable and there is
a cached build, the wizard offers it.

> **Do not use the [customizer](https://incusos-customizer.linuxcontainers.org/ui/).**
> The IncusOS documentation recommends it and it is a good tool, but it produces
> a *pre-seeded* image — and envmux writes its own seed, with your certificate in
> it. Take the plain image.

## The seed

Everything about the host is decided before it has ever booted. The installer
reads a tar of JSON files written to the start of the install image's **second
partition**, and that seed says what to install, what address to come up on, and
whose certificate to trust.

envmux writes four files.

**`install.json`** — its presence is what triggers an install at all. It declares
`security.missing_secure_boot`, which is not optional on Hyper-V, and leaves
`missing_tpm` false, because there is no supported configuration with both. No
install target is named: the VM has a blank system disk and the install media,
the media is not a candidate, so the installer's own choice is unambiguous.
Naming `/dev/sda` would be asserting a device order nothing guarantees.

**`network.json`** — one interface, matched by MAC, asking for `dhcp4`
explicitly. IncusOS prefers IPv6 and, left alone, comes up with a management
endpoint only on its IPv6 address; from a Windows client that is a host which
installed perfectly and cannot be reached, with nothing in the symptom pointing
at the cause.

The MAC is decided in `host.json` *before the VM exists*, because the seed has to
name it and Hyper-V would otherwise assign one at creation. That ordering only
works one way round, which is why the VM is created with
`Set-VMNetworkAdapter -StaticMacAddress`.

**`incus.json`** — `apply_defaults: true`, which creates the ZFS pool `local` out
of the remaining space, creates `incusbr0`, and listens on 8443; plus a preseed
declaring the `envmux0` bridge, the default profile every instance inherits, and
the client certificate.

> **The correction that matters.** The certificate list is documented in places
> as a top-level `certificates:` key of `incus.yaml`. The Go struct has only
> `version`, `apply_defaults` and `preseed` — the list belongs to Incus' own
> `InitPreseed`, nested inside. Seeded at the top level it is accepted silently,
> installs nothing, and surfaces much later as a host that answers
> `auth: untrusted` for no visible reason. envmux nests it, and a test says so.

`incusbr0` is created by `apply_defaults` and then never used. It is left alone
deliberately: the alternative is dropping the defaults and spelling out the
storage pool too, which trades a harmless unused bridge for the one piece of the
seed there is no second chance to get right.

**`kernel.json`** — a version and, deliberately, an empty console list. It once
named `ttyS0` so the installer could be read as text; that turned out to be fatal
on this image rather than free, and *Knowing when the install has finished* below
is the whole story. It stays in the seed as an empty file rather than a missing
one, so the shape is explicit.

## Trust

The client certificate is generated **on your machine** and its public half is
written into the image. So the host trusts envmux from first boot: there is no
trust-token exchange, no window in which an untrusted client is talking to it,
and no token to lose.

It is generated in .NET rather than by `openssl`, which is not on a Windows
workstation and would have to be installed before the first build could run. The
same certificate and the same key work unchanged from a macOS or Linux client
later — it is a file, not a platform credential.

In the other direction, incusd signs its own server certificate. There is no
chain to validate, so pinning the fingerprint is the whole of the trust decision.
**Validation is never disabled.** `envmux host trust` makes one connection
without a pinned fingerprint, and that connection sends nothing at all — not the
client certificate, not a request. It exists only to read the certificate off the
wire and show you a hash to approve.

> **A C# gotcha worth a paragraph.** On Windows,
> `X509Certificate2.CreateFromPemFile` produces a certificate whose private key
> SChannel cannot use for TLS client authentication. The handshake completes, the
> client certificate is simply never sent, and the server answers
> `auth: untrusted` as though nothing had ever been seeded. Exporting to PKCS#12
> and loading that back is what puts the key somewhere SChannel can reach.
> envmux does it unconditionally, and a test pins it.

## Converting the image

Hyper-V cannot boot a raw `.img`, and the documented conversion is `qemu-img`,
which is not on a Windows workstation.

A fixed VHD, though, *is* a raw image: the payload is the disk byte for byte,
followed by a 512-byte footer. envmux writes that footer and then calls
`Convert-VHD`, which ships with the Hyper-V role this design already requires. So
the conversion needs nothing that is not already installed. qemu-img is still
used when it happens to be on `PATH`, because it goes straight to a dynamic VHDX
in one step.

`Convert-VHD` needs an elevated prompt, and envmux says so before copying several
gigabytes rather than after.

## Knowing when the install has finished

Harder than it sounds, and worth writing down because the obvious answers all
fail. The installer writes the image in about ten seconds, logs that it worked,
and then waits to be told the media has gone. During that wait the machine is
still running, nothing is listening on any port, there is no guest agent and
there is no address. Every state that can be polled from Windows is identical
before and after.

So envmux has two ways to tell, and on this image only one of them works.

**The screen, which is a guess, and is what runs.** Two weak signals together:
the framebuffer has not changed in twenty seconds, and the system disk has grown
past half a gigabyte. Nothing is happening, and something happened. The guess is
never trusted on its own — `envmux install --provider hyperv` acts on it by detaching the media and
waiting for the API, and the host answering on 8443 is the proof. If the guess
was wrong nothing was lost, because a VM sitting unchanged for twenty seconds with
an empty disk was not about to finish anyway.

**The serial console, which would be exact — and is given up on purpose.** A
kernel console on `ttyS0`, with the VM's COM1 pointed at a named pipe
(`\\.\pipe\envmux-<vm>-console`) that envmux reads, would turn the guess into the
installer's own words — *IncusOS was successfully installed*, or not. envmux used
to seed exactly that. It does not any more, because naming a console IncusOS
cannot find is not free; it is fatal.

> **Why the console is gone.** On a Generation 2 Hyper-V VM, IncusOS
> `202608201218` does not enumerate COM1 as `/dev/ttyS0`. Told by the seed to
> configure a console there, its startup runs `stty -F ttyS0 115200`, the device
> is not present, and the whole boot stops with *!! IncusOS critical startup
> error !!* — a host that installs perfectly and then will not come up. So the
> seed declares no console at all. The COM port is left attached and harmless,
> and the listener is kept in the code as a fast path for a platform that one day
> writes to it; none that envmux builds on today does, so the screen is the
> answer, and `envmux host status` — not `envmux host console`, which now has
> nothing to print — is where you look when a build is stuck.

> The framebuffer signature deliberately ignores the top of the screen. IncusOS
> draws a status bar there with a clock in it, and sampling it would mean the
> screen was never still for longer than a minute.

## Detaching the media

**This step is not optional and is the easiest to forget.** After the install,
shut the VM down and run `envmux host installed`. IncusOS becomes confused if
seed data is still present at boot, and it checks the `IncusOSInstallComplete`
UEFI variable and refuses to proceed if it believes it booted the install media
again.

## Automatic checkpoints

Client Hyper-V takes a checkpoint every time a VM starts, unless told not to.
That is not a small annoyance here: a checkpoint puts a differencing `.avhdx`
with a fresh GUID in front of every disk, so the paths envmux reads no longer
name the files it created and the disk sizes it reads are of files nothing is
writing to. Anything that recognised a disk by its filename silently stops
working, and the install media becomes indistinguishable from the system disk.

envmux turns them off at creation and identifies disks by controller slot rather
than by name. For a VM created before it knew to, `envmux install --provider hyperv` clears the
existing checkpoints and waits out the merge.

## The switch

The VM's adapter has to be on an **External** virtual switch: the VM needs an
address this workstation can reach its API on, and a way out to the image
remote and to whatever the sessions install. An internal switch would give it
neither.

`envmux install --provider hyperv` makes one if there is none, offering the physical adapters that
are up and not already backing a switch. Creating it briefly interrupts that
adapter while Windows rebuilds the stack around it — a second or two, and worth
knowing about before it happens to somebody on a call.

## The range

Three values, and they live in `host.json`:

| Parameter | Default | Notes |
|---|---|---|
| `cidr` | `10.100.0.1/24` | The bridge's own address and prefix |
| `dhcpRange` | `10.100.0.100-10.100.0.200` | Everything below it is pinnable — 98 addresses. Pinning is the normal path; DHCP is the fallback |
| `dnsDomain` | `envmux` | The zone: the suffix of a session's ssh alias, and what the bridge's dnsmasq answers for inside the instances |

And one that says which network they describe. The default is a host envmux
built, so a `host.json` written before it existed still means what it meant:

| Parameter | Default | Notes |
|---|---|---|
| `network` | `envmux0` | The Incus network sessions attach to. Anything else is a network the daemon already had, [adopted](#adopting-a-network-you-already-have) with `--network` — and then the three values above were read from it, not chosen |

Two more keys, `gateway` and `resolver`, may be in a `host.json` an older envmux
wrote. They are read so the file still parses, and nothing uses them; `reset` and
a swap clear them.

The range is the instances' own. Nothing on this workstation routes to it, so it
does not have to be free here — but an instance whose bridge shares a range with
a VPN or the LAN cannot reach those addresses, which is why `install` still
suggests a `10.x.0.0/24` this machine does not already use.

The headroom matters. Addresses between the bridge and the DHCP range are pinned
to instances at creation, which removes a poll-for-address round trip and makes a
connection string writable before the instance has booted — which is what lets a
session's environment name a database that does not exist yet.

Changing the range afterwards is one call against the `envmux0` network object
plus a restart of whatever is attached — so it is not a one-way door.
`envmux host range --cidr 10.42.0.1/24` owns it: the network object, `host.json`,
and naming the instances that are pinned to the old range and will need
recreating. Nothing on this workstation has to follow.

All of that is about `envmux0`. An adopted network's range is not envmux's to
move, and `envmux host range` refuses it: change the network yourself, as its
owner, and run `envmux install --provider incus` again, which reads it back.

## The golden instance

There is no Dockerfile equivalent and no layer cache. `envmux host golden`
creates an instance from the official Debian image, provisions it with exec and
the files API, stops it, and snapshots it as `base`. A new session is a copy of
that snapshot.

On a ZFS pool — which is what `apply_defaults` makes — a copy is a clone:
near-instant, and near-zero disk until something is written. **That is the
mechanism that makes another dev machine cheap**, and it is why the storage
backend is worth checking before benchmarking anything. An Incus you already run
has the pool it has: btrfs clones the same way, and a `dir` pool copies, so a new
session there costs what copying a root filesystem costs.

What goes into golden is deliberately short: `tmux`, because every exec goes
through it; `openssh-server`, because that is how an editor attaches across a
machine boundary; and the handful of things a session assumes a machine has. A
project's toolchain is *not* here — it belongs in that project's tasks, where it
is declared, reviewed and changed alongside the code.

Drift is handled by rebuilding golden and re-snapshotting, never by patching it
in place. A golden instance that has been patched is one nobody can reproduce.

## Image trust

Incus 7.x has had repeated critical vulnerabilities in image handling — arbitrary
host file read and write through a crafted `metadata.yaml` template, path
traversal on backup import, path traversal on image fingerprints — fixed across
7.2 and 7.3. envmux pulls only from the official `images:` remote and imports no
backups. Do not point it at anything else, and keep the daemon current: IncusOS'
A/B updates make that low-risk, which is much of the reason for choosing it.

## Rebuilding — the host is meant to be ephemeral

Nothing on the host is precious. The sessions are clones of a snapshot, the
snapshot is rebuilt from a script, and the client certificate is regenerated and
re-seeded on every build. So the recovery for almost anything wrong at the host
layer — a lost certificate, a daemon that will not answer, a build you want to
start clean — is to throw it away and build it again:

```console
$ envmux host reset
```

It tears the host down and, unless you pass `--keep-down`, reinstalls from the
top. On the Hyper-V path that reseeds the certificate, so trust comes back with
**nothing to paste** — the reason a rebuild is often less work than chasing a lost
credential. It is provider-aware: a VM it built is stopped, removed and its disk
deleted; an Incus daemon it only attached to is left alone, and reset removes only
what envmux put there — its own instances, a leftover `envmux-util` from an older
version among them, the `envmux0` network, and its entry in the daemon's trust
store. A network it adopted is not something envmux put there: reset says it was
adopted, and leaves it exactly as it is. On either provider it also takes off an
older envmux's route and NRPT rule if this workstation still has them, and says
so if it could not because the prompt was not elevated. Either way the local
certificate and key go and the pinned fingerprint is cleared, while the range,
zone and provider are kept so the rebuild does not re-ask what you already
decided.

It destroys every session on the host, so it asks first — and refuses rather than
assume a yes when it cannot ask, so a script or a redirected prompt has to pass
`--yes`. **Uncommitted work in a session is lost.** The workspace crosses the
machine boundary as a git bundle, so everything committed comes back with the
session on the next rebuild; a dirty tree does not.

## When something is wrong

```console
$ envmux host status
```

It reads, in order: the configuration and anything wrong with it — the provider,
the range, the zone — the certificate, the VM when the host is one, an older
envmux's route and NRPT rule if this workstation still has them, the API, whether
the host trusts this client, the network as the host actually has it and whether
envmux made it or adopted it, whether there is a golden snapshot, a leftover
`envmux-util` if there is one, and every instance envmux has made. Each line that
is missing says which command supplies it.

It is the only diagnostic there is, and that is on purpose: the alternative was a
shell on a machine that does not have one. On an Incus you already run there *is*
a shell, and it is yours — which is why `envmux host prepare` hands you a script
rather than running one.
