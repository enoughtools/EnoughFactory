# Envmux engine carried by EnoughFactory

Upstream: <https://github.com/envmux/envmux>

Pinned commit: `38914dd0fb49682a062dc17eb3427f6b4f27c5fe` (RC branch inspected during the product investigation).

The complete source was exported with `git archive`; `.git` is deliberately absent. The upstream MIT license remains in `LICENSE`. EnoughFactory's source license does not replace it.

Narrow local changes:

- `MachineBridge.cs`, `Program.cs`: versioned machine startup/phase/error/stop messages through an inherited private descriptor (`ENVMUX_BOOTSTRAP_FD`), separate from human output. The bootstrap carries the portal bearer and SOCKS credentials to the trusted device service.
- `Session/Session.cs`: suppress secrets and external browser launch when that private bridge owns the UI.
- `Commands/SessionsCommand.cs`, `Program.cs`: read-only structured discovery from existing container labels.
- `Portal/PortalHost.cs` and `Portal/PortalRepository.cs`: independent stable terminal identifiers and narrow live Git status/diff operations.
- `Backends/DockerEngine/MachineWorkspaceBinding.cs`, `DockerSpec.cs`, the mount wire format and `Session/Workspace.cs`: permit one explicitly configured manager-owned ArtifactFS workspace with matching state volume in private bootstrap mode. The same source is bound at the configured workspace and ArtifactFS's fixed `/mount/repo` Git worktree path. Mounted source must already hold the expected branch; failed readiness never triggers a destructive clone over it. Normal Git sessions retain named-volume isolation.
- `Backends/DockerEngine/EngineEndpoint.cs`: explicit managed mode requires an absolute private Unix socket and ignores configured Docker endpoints, environment contexts and default sockets. Without managed mode the standalone upstream CLI retains its original behavior.
- `Program.cs`, `MachineBridge.cs`, `DockerSpec.cs`: a capability probe precedes wrapper container operations, readiness reports the actual engine endpoint, and a manager-provided IP can connect the guest chat bridge to its host service.
- `MachineBridge.cs`, `Agents/AgentRegistry.cs`, `Docker/DockerEndpoint.cs`: self-spawned agents/editor endpoints retain the owned engine configuration while clearing bootstrap descriptors and per-attempt ArtifactFS authority that cannot be inherited by a new process.

The engine still owns container setup, running tasks, service state, source transport and teardown. The TypeScript adapter does not reproduce those functions. Rebase these changes against upstream before advancing the pin.

Build from EnoughFactory with `pnpm --filter @enoughfactory/envmux build:engine`. Development builds use the local .NET SDK; distributed self-contained binaries include their runtime and do not require a developer SDK.
