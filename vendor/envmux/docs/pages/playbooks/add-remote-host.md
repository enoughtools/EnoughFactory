# Playbook: add a remote Incus host

## When to use it

You have a Linux machine running Incus, and you want sessions on this
workstation to run there. Two steps on the happy path: one on the host, one here.

Not for building the Hyper-V VM on this machine — that is plain `envmux install`,
and [Host](../host.md) is its guide. Not for moving a workstation that already
has a host: that is [Swap a workstation to a new host](swap-host.md).

## Prerequisites

| | |
|---|---|
| The Incus host | Linux, Incus 6.0 LTS or 7.x, and a shell on it with `sudo`. Written against Ubuntu 26.04, Incus 7.0.1, btrfs, Docker installed beside it |
| The network between them | This workstation can open a TCP connection to the daemon's API port. That is all: a LAN, an overlay, or one port forwarded across the internet are the same to envmux |
| The workstation | Windows 11 and `envmux` on `PATH`. An ordinary PowerShell — nothing here needs elevation |

Values used below. Substitute your own.

| | |
|---|---|
| Incus host, LAN address | `192.168.19.43`, API on `8443` |
| Workstation | `192.168.19.21` |
| Range, zone | `10.100.0.1/24`, `envmux` |
| Client name in the trust store | `envmux` |

## Steps

### 1. Prepare the host

From the workstation, if you can ssh to the host:

```powershell
envmux host prepare --ssh you@192.168.19.43
```

It runs over your own `ssh -t`, so when the script reaches `sudo` the password
prompt is yours to answer, in your terminal.

Or on the host itself, with no ssh from here. Print the script, and paste what it
prints into a shell on the host — a console, a web shell, anything:

```powershell
envmux host prepare | Set-Clipboard
```

The script is paste-safe: it is wrapped so that its own `exit` never closes your
login shell, and it calls `sudo` itself where it needs to. Do not run the whole
thing as root.

It is idempotent, so running it twice is safe. It does four things, each only if
needed:

1. sets `core.https_address` to `:8443`, if the daemon is only on its unix socket
2. turns IPv4 forwarding on, persistently
3. adds a forward-accept for the envmux bridge where Docker (a `FORWARD` policy of
   `DROP`, the `DOCKER-USER` chain) or ufw is in the way — and says so instead,
   when a rule or a unit of the owner's already handles it
4. runs `incus config trust add envmux` and prints the token, **last**

Items 2 and 3 are for the instances, not for this workstation: an instance on
the bridge reaches the internet through the host's NAT, and Docker's `FORWARD
DROP` on the same host discards that too — an `npm ci` that hangs is what it
looks like from inside a session.

To see what it would change and change nothing:

```powershell
envmux host prepare --ssh you@192.168.19.43 --check
```

**You should see** a line per item saying what it found and what it did —
`ok`, `info`, `doing`, or `would` under `--check` — and then the token, which
arrives differently on the two routes.

**Pasted on the host**, the result is one marked final line:

```
ENVMUX-TOKEN: <token>
```

Copy what follows the marker. Nothing else in the output is needed on the
workstation, which is the point: a shell you can only read by eye — a web
console, a screen share — still hands over everything in one line.

**Over `--ssh`**, envmux takes that line itself and keeps it off your screen:

```
ENVMUX-TOKEN: (received, and kept off the screen)

  continue into install with this token? [Y/n]
```

Yes runs step 2 for you, in the same window, with the token. If you answer no,
or the install stops before the daemon trusts envmux, it prints the
`ENVMUX-TOKEN:` line for you to use yourself. The token is never written to a
file or a log.

`--check` mints no token, and its last line says so: `ENVMUX-TOKEN: none (--check)`.

`envmux host prepare` with no `--ssh` writes **only the script** to stdout — the
lines saying what it is go to stderr — which is what makes
`| Set-Clipboard` copy exactly the script. `--network` and `--cidr` default to
what `host.json` records, or `envmux0` on `10.100.0.1/24` with no `host.json`;
`--name` is the client name, `envmux` unless you say otherwise. An option it
does not recognise is refused rather than ignored.

**What the token is.** A single-use secret, base64, minted by the daemon. It
carries the client's name, the daemon's certificate fingerprint, every address
the daemon listens on, and the secret itself. Whoever redeems it becomes a trusted
client of that daemon, which is full control of it. Treat it as a password until
it is used. Unused, `incus config trust revoke-token envmux` cancels it.

### 2. Install, on the workstation

```powershell
envmux install --provider incus --token <token>
```

No `--api`. The token lists the daemon's addresses and its fingerprint, so envmux
tries the addresses, takes the one that answers with the matching certificate,
pins it, and redeems the token. Nobody compares hex, and there is no "pin it?"
question. Step 3 reads like this — the `tried` line lists only the addresses that
got as far as an answer or a failure before the right one was found:

```
[3/6] the daemon
  token        for 'envmux': it names the daemon's certificate and 8 address(es) it listens on
  tried        192.168.19.43:8443 presented the token's certificate
  address      https://192.168.19.43:8443
  subject      <the subject of the daemon's certificate>
  fingerprint  <its sha-256, sixty-four hex digits>
  matches the token — which came from the daemon's own command line, so it is pinned without asking
  added — the daemon trusts envmux now
  incus 7.0.1 on <architecture>, storage btrfs
```

The token is never echoed. `--api <address>` beside the token dials that address
instead of trying the token's, and is held to the same certificate: if what
answers there is not the daemon the token came from, it is **refused, with no
question**, nothing is pinned and the token is not sent. With nothing on the
command line, the first question takes either — `incus address (host[:port] or
https://…) — or paste a trust token`. An expired token is refused before anything
is dialled, with the way to mint another.

**You should see** six numbered steps, `[1/6]` to `[6/6]`: the range, the
certificate, the daemon, the network, the golden instance, the editor's key.
The lines that matter:

| Step | The line to look for |
|---|---|
| 1 the range | that the range waits for step 4. Nothing is asked here |
| 3 the daemon | `address`, `subject` and `fingerprint` lines for `https://192.168.19.43:8443`, and that the daemon trusts envmux now |
| 4 the network | the range and the zone asked for — accept `10.100.0.1/24` and `envmux` — then `created envmux0 on 10.100.0.1/24, dns zone .envmux` |
| 5 the golden instance | built, and how long it took |
| 6 the editor's key | the key, and the `~/.ssh/config` line: `*.envmux → that key, through envmux relay` |

The last step asks before it acts: it writes a `Host *.envmux` block into
`~/.ssh/config`. Say yes unless you know why not — it is what makes the
editor's SSH attach work.

## Verify

```powershell
envmux host status
```

`status` shows `provider` incus, `auth       trusted`, a `network` line for
`envmux0` saying envmux made it, and a `golden` line. Then run
[Prove a host works](prove-host.md). It is ten minutes and it is the only check
that involves a session — and the browser step in it is the one that proves the
host is reachable in the way that matters.

## Roll back

On the workstation. This removes envmux's instances, `envmux0` and envmux's
entry in the daemon's trust store, and deletes this client's certificate:

```powershell
envmux host reset --keep-down --yes
```

On the host, undo what step 1 added, if you want it gone:

```sh
sudo iptables -S DOCKER-USER                  # delete only ACCEPT lines that name envmux0
sudo iptables -D DOCKER-USER -o envmux0 -j ACCEPT
sudo iptables -D DOCKER-USER -i envmux0 -j ACCEPT
incus config trust list                       # envmux should not be listed
incus config trust revoke-token envmux        # only if the token was never used
```

`core.https_address` and IPv4 forwarding are left on. Other clients of that
daemon, and Incus' own NAT, may depend on them.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| You were given a URL for the daemon — `https://incus.int.example` — and `--api` with it fails: refused on 443, or no answer on 8443 | The name resolves to an address the daemon is not reachable on: an overlay address, or a reverse proxy. The daemon was answering all along on its LAN address | **Give envmux the token, not a URL.** The token lists the addresses the daemon really listens on — LAN, overlay and Docker bridges alike — and envmux probes them and keeps the one whose certificate matches |
| Not sure whether the API port is open | | `Test-NetConnection 192.168.19.43 -Port 8443`. Fails **at once**: refused, nothing is listening there — `core.https_address` is unset, or it is the wrong address. Fails **after about twenty seconds**: timed out, something is filtering — a host firewall, or an overlay that does not carry it |
| The right address **times out** on 8443, from this workstation only | The host's owner allowlists the API port — an nft table or a firewall rule restricting tcp/8443 to named subnets — and this workstation is not in one | On the host: `sudo nft list ruleset \| grep -B3 -A3 8443`. Add the workstation's subnet to the owner's allowlist. A timeout is a filter; a refusal is nothing listening |
| Install finds no address in the token that answers, and prints one report line | It says, per address, which kind of no: `timed out (filtered, or nothing at that address)` or `refused the connection (nothing listening there)`. Docker bridge addresses (`172.17.0.1` and the like) always time out | All timed out: get onto a network the host is on, or into its API allowlist. Refused on the right address: `core.https_address`. Then the same command again; or `--api <address>` with the token, to name the one to use |
| A session starts, and `npm ci` or `apt` in it hangs | The instances have no way out: the host is not forwarding for the bridge, or Docker's `FORWARD DROP` is discarding it | Step 1 again, without `--check`. Or by hand: [the forwarding fix](#the-forwarding-fix) |
| `auth: UNTRUSTED` after it worked | The daemon was rebuilt, or envmux's entry was removed from its trust store | A new token from the host, then `envmux install --provider incus --token <token>` |

## The manual route

The same thing, one decision at a time. Use it when the script cannot run on the
host, or when you want to see each change before it is made.

### On the host

1. **The API.** Empty output means the daemon is only on its unix socket.

   ```sh
   incus config get core.https_address
   incus config set core.https_address :8443
   ss -ltn 'sport = :8443'                     # a LISTEN line on *:8443
   ```

2. **An address this workstation can reach the API on.** Any address will do
   as long as a TCP connection to it gets through.

   ```sh
   ip -4 -br addr
   ```

3. **A firewall on the API port**, if the host runs one:

   ```sh
   sudo ufw allow from 192.168.19.21 to any port 8443 proto tcp
   ```

4. **A bridge.** Nothing to do unless you want envmux on a bridge that already
   exists. envmux creates `envmux0` itself. To adopt one instead, it must be a
   managed bridge with an IPv4 address, DHCP on, and DNS on:

   ```sh
   incus network list                          # TYPE bridge, MANAGED YES
   incus network show incusbr0
   ```

5. **The token.**

   ```sh
   incus config trust add envmux
   ```

   It prints the token once. `incus config trust list-tokens` shows it is
   pending; `incus config trust list` shows `envmux` once it has been redeemed.

### On the workstation

`--api` names the address; without `--token` it asks for one.

```powershell
Test-NetConnection 192.168.19.43 -Port 8443      # TcpTestSucceeded : True
envmux install --provider incus --api 192.168.19.43 --token <token>
```

With `--api` and no token-carried fingerprint to match, it shows you the
fingerprint the daemon presents and asks before pinning it. Compare it with the
host's own:

```sh
incus info | grep certificate_fingerprint
```

To adopt a bridge the daemon already has, instead of creating `envmux0`:

```powershell
envmux install --provider incus --api 192.168.19.43 --token <token> --network incusbr0
```

**You should see**, at step 4, for the host this was written against:

```
adopting incusbr0 — read, never reconfigured, never deleted
range 10.252.20.1/24 dhcp none, so addresses are pinned around its leases
zone *.incus  (the network names none, which is Incus for 'incus')
```

Its range **and its DNS domain** become envmux's. `--cidr` and `--domain` print
that they do not apply. A stock `incusbr0` has no `dns.domain`, so the zone is
`incus` and a session's ssh alias is `<project>-<session>.incus` — substitute
`.incus` everywhere this playbook says `.envmux`. envmux never writes to an
adopted network and never deletes it. It refuses one sessions could not live on:
no such network, not a bridge, no `ipv4.address`, `ipv4.dhcp` off, or `dns.mode`
`none`.

### The forwarding fix

On the host. This is about the instances' way *out* — to the internet, through
the host's NAT — not about reaching them from here. First find out which it is,
and whether it is already handled:

```sh
sysctl net.ipv4.ip_forward                    # must say 1
sudo iptables -S FORWARD | head -n 3          # '-P FORWARD DROP' and a jump to DOCKER-USER are Docker's doing
sudo iptables -S DOCKER-USER                  # an ACCEPT naming your bridge means somebody got here first
systemctl list-units --type=service | grep -i -E 'incus|firewall'
```

**If `DOCKER-USER` already accepts the bridge, stop: add nothing.** A host that
runs Incus beside Docker has usually met this already, and its owner keeps the
rule in a unit or a script of their own. The host this was written against does:
a oneshot unit that inserts `-i`/`-o incusbr0` accepts after Docker starts. If
envmux is on a *different* bridge from the one that unit names — `envmux0`, not
`incusbr0` — add the bridge to the owner's mechanism rather than putting a second
mechanism beside it.

Forwarding off:

```sh
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-envmux-forward.conf
```

Docker's `FORWARD DROP`, with iptables. Match the **bridge interface**: it
survives a change of range, and iptables accepts a rule naming an interface that
does not exist yet, so this can be done before install creates `envmux0`. With an
adopted network, its name goes where `envmux0` is.

```sh
sudo iptables -I DOCKER-USER -o envmux0 -j ACCEPT
sudo iptables -I DOCKER-USER -i envmux0 -j ACCEPT
```

The same pair in nft. Docker's rules are in `ip filter` either way:

```sh
sudo nft insert rule ip filter DOCKER-USER oifname "envmux0" accept
sudo nft insert rule ip filter DOCKER-USER iifname "envmux0" accept
```

Where ufw is the firewall. These persist on their own:

```sh
sudo ufw route allow out on envmux0
sudo ufw route allow in on envmux0
```

**To keep the iptables pair across a reboot**, a unit that runs after Docker has
made its chains. It checks before it inserts, so it is safe to start twice. Save
this as `/etc/systemd/system/envmux-forward.service`:

```ini
[Unit]
Description=Accept traffic for the envmux bridge past Docker's FORWARD policy
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -o envmux0 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -o envmux0 -j ACCEPT'
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -i envmux0 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i envmux0 -j ACCEPT'

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now envmux-forward.service
sudo iptables -S DOCKER-USER                  # both ACCEPT lines, above the RETURN
```

`netfilter-persistent save` also works, and saves every rule on the machine with
them, Docker's included.

Then, from inside a session (`c` for a shell), `curl -sI https://deb.debian.org`
should answer. No reinstall.

## More than one host

What is true today, stated as a limit:

- **One `~/.envmux` is one host, one range, one zone.** `host.json` has room for
  exactly one of each.
- **A second host is a second `ENVMUX_HOME`**:

  ```powershell
  $env:ENVMUX_HOME = "$HOME\.envmux-lab"
  envmux install --provider incus --token <token> --domain lab
  ```

  Every command run with `ENVMUX_HOME` set talks to that host. Every command run
  without it talks to the one in `~/.envmux`.
- **The ranges may be the same.** Nothing on this workstation routes to either,
  so two hosts on `10.100.0.0/24` do not collide here.
- **The zones should differ**, because the zone is the ssh alias's suffix and
  `~/.ssh/config` holds one envmux block. `*.envmux` and `*.lab` in it are
  two aliases that reach two hosts — but only if the `envmux relay` the block
  runs sees the same `ENVMUX_HOME` your shell does. The editor's helper process
  usually does not, so the second host's aliases are best used from a shell
  that has it set.
- **Copy two files into the second directory before installing** —
  `id_ed25519` and `id_ed25519.pub`. `~/.ssh/config` names one key, and a
  second host that generated its own would have sessions that let in a key the
  block does not offer.
- A session does not remember which host it is on. The directory you start it
  from does not choose one. `ENVMUX_HOME` does, every time.

There is no registry of hosts and no `--host` flag. One is planned — named
backends, a default, a per-repository choice — in
[the backends plan, §8](https://github.com/envmux/envmux/blob/main/docs/backends.md).
