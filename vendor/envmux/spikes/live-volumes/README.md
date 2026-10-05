# live-volumes spike — the workstation's tool state, mounted live in a session

A working demonstration of [docs/live-volumes.md](../../docs/live-volumes.md):
a container on the envmux host mounts this workstation's `~/.claude` over FUSE;
Claude Code started inside it arrives signed in, lands on the prompt (no theme
chooser, no trust dialog), has the workstation's settings and the one plugin the
session declared, keeps its own `projects/` on its own disk, and `git credential
fill` inside it answers from the workstation's Git Credential Manager. Nothing it
writes reaches the workstation's own files. Three tasks in one instance hold
three differently scoped keys and can see neither each other's files, mounts
nor credentials.

Demonstrated 2026-08-30 and 2026-09-03 on Incus 7.4 / IncusOS 202608251738,
kernel 7.1.10-zabbly+, Debian trixie guest, rclone 1.60.1-DEV, fuse3 3.17.2,
Claude Code 2.1.231. Task entry 277–522 ms; a 154 KB read 6 ms; a cold
recursive walk of 625 files 3.9 s (§9 of the design doc says what to do about
the last one).

## Pieces

| | |
|---|---|
| `server/` | The workstation half (.NET). Policy-routed WebDAV with four routes (shadow, live, local, overlay), per-task scoped 256-bit keys, an audit log, a loopback control API for minting and revoking, seeds that rewrite `.claude.json` and the plugin registries for the instance, and a virtual `git/` namespace answered by `git credential fill`. |
| `guest-enter.sh` | Runs one task in a mount namespace of its own with its own key: mounts the whole tree at `/run/envmux/live`, binds the tool's namespace onto `~/.claude`, binds the session's own storage over the local directories, installs the git credential helper. This is what makes a per-task key mean anything — §5.1. |
| `incus.cs` | A minimum Incus client, so the spike reproduces without envmux and without the `incus` CLI (which has no Windows build). Pins incusd's certificate from `host.json`. |
| `wire.sh` | Attaches the proxy device and installs the guest half. |
| `restart.sh` | Rebuild and put the server back up. The inner loop. |

## Running it

```sh
cd spikes/live-volumes

# 1. The workstation half: three tasks, three scopes, one plugin, one git host.
sh restart.sh \
    --task 'agent=claude;git' \
    --task build=claude:plugins,settings.json \
    --task docs= \
    --project 'Z:\envmux' --workdir /work --home /home/matt \
    --plugin prompt-context@prompt-skills \
    --git-host github.com
# live.out has the URL, the admin key, and one key per task.

# 2. A throwaway instance, if you want one. The golden image already has Claude Code.
dotnet run incus.cs -- api POST 1.0/instances '{
  "name": "envmux-livespike",
  "source": {"type": "copy", "source": "envmux-golden/base"},
  "devices": {"eth0": {"type": "nic", "network": "envmux0", "name": "eth0"}},
  "start": true}'

# 3. The proxy device, rclone, fuse3, and the entry script.
sh wire.sh envmux-livespike matt

# 4. Claude Code, as a task holding its own key.
printf 'echo <key> | envmux-live-enter matt agent http://127.0.0.1:8079 claude \\
  /home/matt/.claude projects,file-history,todos -- \\
  env HOME=/home/matt CLAUDE_CONFIG_DIR=/home/matt/.claude sh -c "cd /work && claude"\n' \
  | dotnet run incus.cs -- exec envmux-livespike
```

`incus.cs` takes API paths **without** a leading slash — `1.0/instances` — because
Git Bash rewrites an argument that starts with one into a Windows path. Do not
pipe `restart.sh`'s output: the server it starts inherits the pipe and the reader
waits forever. Redirect to a file.

## Findings

**The proxy device is ergonomics, not isolation.** `bind=instance` puts the
endpoint on the guest's `127.0.0.1` with nothing configured inside the
container, which is the whole reason to use it. It grants no identity: `envmux0`
masquerades, so a direct connection from a container and a proxied one both
arrive at the workstation from the VM's address, indistinguishable. Every
authorisation decision is made on the key.

**A scoped key with a shared mountpoint authorises nothing.** The first version
mounted once per session. By the time a second task reads a file the kernel is
already holding it open on the first task's behalf, and no request reaches the
workstation to refuse — the scope is enforced once, at mount, and never again.
Hence `unshare --mount` per task.

**Shadow, not live, is the default.** With `plugins/` served read-write, Claude
Code's first start re-synced its plugin marketplace: eleven writes into the
workstation's own `plugins/`, from a container, unasked. A tool treats its state
directory as its own and will rewrite any of it. Now every entry reads from the
workstation and writes to the session unless promoted, and a shadowed directory
lists as the union of both sides.

**Absolute paths in the registries cost 800 writes and lost the plugin.**
`installed_plugins.json` said the plugin was at `C:\Users\Matt\.claude\…`;
inside the container that is nowhere, so Claude Code re-cloned two marketplaces
and still did not load it. Rewriting the `~/.claude` root in the seeds brought
startup to a hundred housekeeping writes and `claude plugin list` to `✔ enabled`.

**`.claude.json` is a diary with 74 project paths in it.** Seeded, not served:
this project's entry re-keyed to `/work` and trusted, everything else that names
a place on this machine dropped. Claude Code keys projects with forward slashes
on Windows (`Z:/envmux`), which matters for finding the entry.

**Git credentials as a file, not a call.** A helper that made an HTTP call would
need a key it can read, and it runs as the session user, so every task could
read it. A virtual file on the already-keyed, already-per-task mount needs
nothing new. `get` only; `store`/`erase` are ignored.

**`fusermount3 -u` fails with `EBUSY` on a mount that has binds on top of it,
and does not say what is holding it.** That left rclone running and the wrapper
waiting on it forever, which from outside read as a task that never finished.
The binds come off first, innermost first.

**Three levels of shell quoting is one too many.** `guest-enter.sh` re-executes
itself as `--inside` under `unshare` rather than passing its second half to
`sh -c '…'`. The version that did the latter lost an apostrophe in a comment and
failed at a line number in a file that does not exist on disk.

**`CreateFromPemFile` leaves the private key where schannel will not take it** —
`the credentials supplied to the package were not recognized`. Export to PKCS#12
and load it back. envmux already does this in `Host/ClientCertificate.cs`; the
spike had to learn it again.

**`XmlWriter` takes its declared encoding from its sink.** Writing the
multistatus into a `StringBuilder` produced `<?xml version="1.0"
encoding="utf-16"?>` on a response body written as UTF-8.

**`wc -c < file` does not read the file.** It `fstat`s it, which is a `PROPFIND`
and not a `GET` — which is why the first look at the audit log was empty and
looked like a bug in the logging.

## Cleaning up

```sh
taskkill //IM envmux-live.exe //F
dotnet run incus.cs -- api DELETE 1.0/instances/envmux-livespike
```

The per-session overlay is `~/.envmux/live/<session>/`, and holds the audit log
and the session's copies of every shadowed file it has written.
