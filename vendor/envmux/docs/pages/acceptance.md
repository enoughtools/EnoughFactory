# Acceptance

The eleven criteria from [`incus.md`](https://github.com/envmux/envmux/blob/main/incus.md),
what satisfies each, and — honestly — which of them a test can settle and which
need a real VM.

Six are settled by tests. Five need a host, and all five were observed on one —
Hyper-V on Windows 11, IncusOS 202608201218, incus 7.3, on 2026-08-22. What was
seen is recorded per row rather than summarised.

| | Criterion | Where | Verified by |
|---|---|---|---|
| 1 | Seeded IncusOS VHDX builds from a scripted, repeatable process | `envmux host build` | **tests** — `HostSeedTests`, `DiskImageTests`, `VhdFooterTests` |
| 2 | VM boots with Secure Boot off and vTPM enabled | `Host/HyperV.cs` | **observed** — booted; its own status line reads `Degraded security state: Secure Boot is disabled` |
| 3 | The client authenticates with the pre-seeded certificate; no trust token | `Host/Seed.cs`, `Incus/IncusClient.cs` | **tests** — `HostSeedTests`, `ClientCertificateTests` |
| 4 | `envmux0` uses the configured CIDR and DHCP range, both build parameters | `Host/HostConfig.cs` | **tests** — `HostConfigTests`, `HostSeedTests` |
| 5 | `curl http://<name>.envmux:3000` succeeds from PowerShell | `envmux host wire` | **observed** — `curl http://planno-planno.envmux:5173/` returns the app's HTML, ~20 ms. *Since retired with the zone (`archive/zone`): a session is reached through its browser proxy, held to it by `ProofOfLifeTests`* |
| 6 | Two instances bind 3000 and 5432 with no conflict and no proxy | `Routing/RouteTable.cs` | **tests** — `RouteTableTests` — and **observed**: two sessions of one project both on 5173 (10.100.0.2, 10.100.0.6); two sessions of another each holding a Postgres on 5432 (10.100.0.4, 10.100.0.8), each having run its own migrations |
| 7 | An interactive exec survives client disconnect and reattaches | `Incus/ExecSession.cs`, `Session/SessionTask.cs` | **tests** — `LatchTests`, `LatchedTaskTests` |
| 8 | Terminal resize propagates over the control socket | `Incus/ExecSession.cs` | **tests** — `ExecPostTests` |
| 9 | Output is retrievable from `/var/log/envmux/<taskId>.log` after disconnect | `envmux logs`, `GET /api/tasks/{name}/log` | **tests** — `LatchedTaskTests` — and **observed**: `envmux logs dev api` read a running .NET server's log out of its instance from a separate process |
| 10 | A new environment from the golden snapshot in under 10 seconds | `Incus/Golden.cs`, `Incus/InstanceSpec.cs` | **observed** — the copy itself is about a second; instance created to route answering was 9 s for a Vite app, including installing Node |
| 11 | No Docker or Compose artefact remains | the whole repository | **checked** — see below |

## What "needs a host" means

Five criteria are statements about a machine that has to exist: that Hyper-V
accepts the configuration, that Windows resolves and routes the zone, and that a
ZFS clone is as fast as ZFS clones are. No test on this side can settle any of
them, and a test that pretended to would be worse than not having one.

They stay marked **observed** rather than **tests**, and the distinction is not
pedantry: one workstation on one evening is evidence, not coverage. A second
machine could still fail any of them — a different Hyper-V build, a VPN with an
opinion about the range, a storage pool that is not ZFS.

What *is* settled is everything they depend on. The seed is the bytes that reach
partition 2. The certificate is the one the seed carries and the one the client
sends. The hostname is the instance's name plus the zone. The exec keys are the
keys on the wire. If those are right and the VM still does not come up, the
problem is in the VM, and `envmux host status` is the command for it.

## Criterion 11, checked

The cutover deleted rather than ported:

- `src/Envmux.Relay/` — the whole project, and the second RID matrix in CI
- `src/Envmux/Docker/` — the CLI wrapper, the container spec, the engine socket
- `src/Envmux/Devcontainer/` — feature resolution and the reference CLI runner
- `src/Envmux/Routing/Router.cs` — Kestrel + YARP, and the YARP package with it
- `src/Envmux/Git/Worktree.cs` — the `.git`-file rewrite that made a worktree
  work inside a container
- `.dockerignore`, and every `docker build` in the scripts and the workflow
- the `features`, `devcontainer`, `dockerSocket`, `relay`, `entrypoint` and
  `command` fields, and `routes[].host`
- the `*.localhost` and `strigops.xyz` hostname schemes

Nothing in envmux runs `docker`, opens its socket, or requires it to be
installed. What `git grep docker` still finds is three things, all deliberate:

- **Prose about what this replaced.** "Under Docker this had to walk `/proc`…"
  is the comment explaining why the code is now three lines. Deleting the
  comparison would delete the reason.
- **`AutoconfigureCommand` reading `compose.yaml` and `Dockerfile`** as
  *evidence* of what a project needs. Those files are somebody else's, and they
  are the best description of a stack anybody has written down.
- **`ServicePlan` naming `docker.io`**, because a service is published as an OCI
  image and Incus runs those directly. Making people find a system-container
  equivalent for Postgres would be a worse answer.

The dead code went with the dependency rather than being left behind: the
`attached-container` URI and its reference vectors, the three `ProcessRunner`
overloads that existed for `docker cp`, `docker exec` and `docker exec -it`, and
the xunit collection that serialised tests against the one engine on the machine.

## The two things the specification got wrong

Both are worth naming, because both would have cost a day.

**The certificate is not a top-level key.** `incus.yaml` is documented in places
with `certificates:` beside `preseed:`. The Go struct has only `version`,
`apply_defaults` and `preseed`, and the list belongs to Incus' own `InitPreseed`
inside it. At the top level it is accepted, installs nothing, and surfaces much
later as `auth: untrusted`. `HostSeedTests` pins the nesting.

**qemu-img is not required.** The specification's conversion step is
`qemu-img convert`, which is not on a Windows workstation. A fixed VHD is the raw
image plus a 512-byte footer, and `Convert-VHD` ships with the Hyper-V role this
design already needs — so the conversion needs nothing that is not already
installed. qemu-img is still used when it happens to be there.

## The one thing it did not address

`incus.md` says nothing about the workspace, and the machine boundary makes it
the hardest part: a git worktree cannot be bind-mounted into a VM.

The answer is a **git bundle over the files API** — outbound, on the connection
envmux already has, because a remote on the workstation would need inbound
through the Windows firewall. Commits come back the same way. Uncommitted work
does not, which is why an instance is kept rather than deleted. See
[Configuration](configuration.md#the-repository-travels-it-is-not-mounted).
