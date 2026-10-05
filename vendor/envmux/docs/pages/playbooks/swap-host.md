# Playbook: swap a workstation from its Hyper-V host to a remote Incus

## When to use it

This workstation runs sessions on the Hyper-V VM envmux built, and you want them
on a remote Incus host instead — **same `~/.envmux`, same zone**, so the
`~/.ssh/config` entry keeps working unchanged and nothing has to be retyped.

The old VM is stopped, not deleted, and the whole swap rolls back in two
commands.

To run both hosts side by side instead, do not swap: that is a second
`ENVMUX_HOME`, in [Add a remote Incus host](add-remote-host.md#more-than-one-host).

## Prerequisites

| | |
|---|---|
| The new host | Prepared, with a token in hand: step 1 of [Add a remote Incus host](add-remote-host.md#1-prepare-the-host) |
| The workstation | An ordinary PowerShell. Nothing in a swap needs elevation: nothing on this machine is routed or resolved |
| Time | Ten minutes, plus the golden instance building on the new host, plus each project's toolchain image rebuilding on its first session there |

Values used below.

| | |
|---|---|
| Old host | Hyper-V VM `envmux-host`, at `192.168.19.47` |
| New host | `192.168.19.43:8443` |
| Range, zone — unchanged | `10.100.0.1/24`, `envmux` |

**What does not move.** Instances. A kept session's instance stays on the old VM
with its uncommitted work in it. Commits are already in your repositories. Step 1
is there so that nothing you want is left only in an instance.

## Steps

### 1. Bring the work back

List what is on the old host:

```powershell
envmux host status
```

**You should see** one `instance` line per session, service and image. For each
session whose work you want, in that project's directory:

```powershell
envmux <session>
```

Press `c` for a shell, commit what is uncommitted, `exit`, then `q`. Quitting is
what bundles the commits back. Check each one landed:

```powershell
git log --oneline -3 envmux/<session>
```

**Stop here if any session is still running.** `instance` lines should say
`Stopped` before you go on.

### 2. Back up what describes the old host

```powershell
Copy-Item $HOME\.envmux\host.json   $HOME\.envmux\host.json.hyperv
Copy-Item $HOME\.envmux\known_hosts $HOME\.envmux\known_hosts.hyperv -ErrorAction SilentlyContinue
Remove-Item $HOME\.envmux\known_hosts -ErrorAction SilentlyContinue
```

`host.json.hyperv` is the rollback. `known_hosts` goes because sessions recreated
under the same names on the new host have new ssh host keys, and ssh refuses a
name whose key changed.

**Keep everything else in `~/.envmux` exactly as it is.** Two things carry over
and must not be regenerated:

| File | Why it stays |
|---|---|
| `envmux-cli.crt`, `envmux-cli.key` | The client certificate. The new daemon is told to trust it; **the old VM trusts only it**, because it was seeded with it. Lose it and the rollback is a rebuild |
| `id_ed25519`, `id_ed25519.pub` | The key `~/.ssh/config` already names |

> **Do not run `envmux host reset` at any point in this playbook.** It deletes the
> client certificate, and on the Hyper-V provider it deletes the VM and its disk.

### 3. Attach to the new host

```powershell
envmux install --provider incus --token <token>
```

**You should see**, at step 1, the swap noticed and asked about:

```
That is a hyperv host, and this is asking for an incus one: a swap.
swap this workstation to the new host? [Y]
```

Answer yes. The range and the zone are **kept** — there is nothing to retype. The
old host's address and fingerprint are forgotten, which is why step 2 backed them
up. The old host itself is not touched.

**You should see**, among the six steps:

| Step | The line to look for |
|---|---|
| 2 the certificate | that the certificate is already here — **not** that one was created |
| 3 the daemon | `https://192.168.19.43:8443`, `matches the token`, and `added — the daemon trusts envmux now`. (Only if an earlier run got as far as redeeming the token: `auth: trusted — envmux is already in this daemon's trust store`, and `the token was not needed, and has not been used`) |
| 4 the network | `created envmux0 on 10.100.0.1/24, dns zone .envmux` |
| 5 the golden instance | built, with how long it took |
| 6 the editor's key | `already here`, and the `~/.ssh/config` line: `*.envmux → that key, through envmux relay` |

The `~/.ssh/config` block is rewritten only if it changed. Its `ProxyCommand`
names the envmux that wrote it, so an installed release and a dev build each
write their own — if you swapped binaries as well as hosts, say yes here.

### 4. Stop the old VM

Elevated, because Hyper-V is. Stop, never remove:

```powershell
Stop-VM -Name envmux-host
Get-VM  -Name envmux-host | Select-Object Name, State      # Off
```

Its disks stay in `~/.envmux/vm/`. They are the rollback, and they are where any
uncommitted work you decided to leave behind still is.

## Verify

```powershell
envmux host status
```

| | Should be |
|---|---|
| `provider` in `status` | `incus` |
| `api` | `https://192.168.19.43:8443` |
| `auth` | `trusted` |
| `network` | `envmux0 10.100.0.1/24`, `envmux made it` |
| no `vm` or `hyper-v` line | those are printed for the Hyper-V provider only |
| `instance` lines | `envmux-golden` only. The old host's sessions are not here |
| `legacy` lines | Present if this workstation was wired by an older envmux. Harmless; `envmux host unwire` removes them when you like |

Then run [Prove a host works](prove-host.md) against it. Do that before starting
real work: it is the only check that involves a session.

The first session of each project rebuilds that project's toolchain image on the
new host. Minutes, once.

## Roll back

Two commands put the workstation back on the VM.

```powershell
Copy-Item $HOME\.envmux\host.json.hyperv $HOME\.envmux\host.json -Force
Start-VM -Name envmux-host                                     # elevated
```

Then restore ssh's memory of the old sessions, and check:

```powershell
Remove-Item $HOME\.envmux\known_hosts -ErrorAction SilentlyContinue
Copy-Item $HOME\.envmux\known_hosts.hyperv $HOME\.envmux\known_hosts -ErrorAction SilentlyContinue
envmux host status
```

`status` **should show** `provider` hyperv, the `hyper-v` line `Running`,
`auth       trusted`, and the old sessions' `instance` lines back.

The rollback leaves envmux's things on the remote host: `envmux-golden`,
`envmux0`, and a trust entry. They are harmless and make the next swap faster.
To remove them, on the Incus host:

```sh
incus delete --force envmux-golden
incus network delete envmux0
incus config trust list                       # note envmux's fingerprint
incus config trust remove <fingerprint>
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Step 1 does not mention a swap | `host.json` already says `incus` — an earlier attempt got that far | Carry on; it resumes. The rollback file from step 2 is still the VM's |
| Install says it **created** a client certificate | `envmux-cli.crt` or `.key` was missing or moved | Stop. Restore both from a backup before going further, or the old VM will answer `auth: UNTRUSTED` on rollback |
| After the swap, `ssh` or the editor says `REMOTE HOST IDENTIFICATION HAS CHANGED` | `~/.envmux/known_hosts` still has the old host's keys for the same names | Step 2's `Remove-Item` |
| After the swap, the editor's SSH attach hangs or says the relay found no host | The `ProxyCommand` in `~/.ssh/config` names a different envmux binary, or an `ENVMUX_HOME` the editor's helper does not have | `envmux ssh` again from the envmux you use; `envmux ssh --print` shows the line |
| After rollback, `api` is not reachable | The VM took a different DHCP lease when it started | `envmux host trust <new address>` |
| After rollback, `auth: UNTRUSTED` | The client certificate changed during the swap | Restore `envmux-cli.crt` and `envmux-cli.key`. Without them the VM has to be rebuilt: `envmux host reset` |
| A session you expected is missing on the new host | Instances do not move | Roll back, do step 1 for that session, swap again. Or start it fresh: its commits are on `envmux/<session>` |
