# ArtifactFS workspaces

EnoughFactory can use a real writable ArtifactFS mount for each author attempt.
Ordinary Git workspaces are the fallback when the managed engine cannot support
FUSE or shared Linux mounts. Choosing ArtifactFS preserves the same envmux
workbench, candidate and integration flow.

## Install the optional runtime

Start EnoughFactory's managed container runtime. The device service supplies an
explicit descriptor for its private Linux engine: `host`, bundled `cliPath` and
private `configDirectory`. Its runtime calls carry that descriptor through
`resolveDockerRuntime()` and `managedDockerInvocation()`.

For a direct image build, supply the same descriptor through
`ENOUGHFACTORY_DOCKER_HOST`, `ENOUGHFACTORY_DOCKER_CLI` and
`ENOUGHFACTORY_DOCKER_CONFIG`, then build the pinned OSS source:

```sh
bash runtime/workspaces/build.sh
```

These three variables are required. The script invokes the absolute bundled CLI
with explicit `--host` and `--config` arguments and clears inherited Docker
context, daemon and TLS selection variables. Missing configuration is an error;
the helper does not discover a personal Docker daemon.

An existing RepoReach checkout can supply that committed source without a clone:

```sh
ENOUGHFACTORY_ARTIFACTFS_SOURCE=/path/to/reporeach bash runtime/workspaces/build.sh
```

The build always archives commit `6a62f2f34aebe75da3d8b917131a6ace185928e5`,
regardless of the checkout's current branch or uncommitted changes. It builds the
Go CLI for the Linux image architecture and creates
`enoughfactory/artifactfs:6a62f2f34aeb`. Source, revision and Apache-2.0 labels,
the upstream LICENSE/NOTICE and dependency notices remain in the image. See
[source.json](source.json) and [NOTICE.md](NOTICE.md) for provenance and the narrow
patch allowing envmux's container user to write this private attempt's mount.

## Ownership and topology

The current ArtifactFS provider requires a rootful Linux engine inside
EnoughFactory's private Mac Lima VM. The rootful daemon and mount capabilities
remain inside that VM. EnoughFactory's native Linux runtime is rootless; this
shared-mount topology cannot use its host mount namespace, so Linux selects
ordinary Git with a recorded ArtifactFS availability reason. Setting
`fallbackToGit: false` instead returns a visible error. An image being installed
does not establish that its engine supports the mount topology.

On the supported managed VM, the trusted device service creates an exact Git
source bundle and starts a manager with `/dev/fuse` and `SYS_ADMIN`. A short,
path-bounded helper prepares
`/var/lib/enoughfactory/workspaces/<attempt-id>` as a shared mount in the Linux
VM. A Mac FUSE installation is unnecessary. Source bundles and runtime records
stay in the app's managed data/workspace directory, which the VM mounts
explicitly; arbitrary host directories are not a runtime dependency.

The manager mounts the writable repository at `/mount/repo`. Envmux receives
that same repository at its configured workdir and at `/mount/repo`, plus the
attempt's Git state volume at `/var/lib/artifact-fs`. The alias keeps ArtifactFS's
absolute Git worktree setting consistent across containers. Envmux verifies the
expected session branch before using the mount and never clones over a mismatched
or unreadable managed workspace.

Agents receive **no Docker socket, FUSE device, mount capability or host PID
namespace** from this provider. Candidate capture and repair use ordinary helper
containers, so author-controlled Git configuration cannot execute with manager
capabilities. Git hooks and fsmonitor are disabled for those operations.

Each attempt has a distinct manager, mount, state volume and durable mount record.
Remote refresh is disabled. The source bundle and initial SHA comparison pin the
input, while ordinary ArtifactFS HEAD watching retains new commits and overlays.
Its fixed-artifact `--require-commit` mode is intentionally unsuitable for a
writable author attempt because it restores the input HEAD after restart.

## Integrate and recover

Construct the provider with `{ rootDirectory, dockerRuntime }`, and construct
`EnvmuxEngine` and the Docker check executor with that same runtime descriptor.
`ArtifactFsWorkspaceProvider.prepare(record)` returns `bindSource`, `stateVolume`
and the expected branch. Pass the first two to `EnvmuxEngine.start({ workspace })`.
Use `providerState.sessionName` and `providerState.workspaceBranch` when the
project's configured session naming differs from the defaults.

`capture(record)` returns an exact commit, bundle path and bundle reference.
Stop the writer before capture. `promotePreviousCandidate` retains prior work for
a repair attempt, including explicitly identified merge-conflict inputs.

`dispose(record)` stops the manager while preserving its state.
`readMountRecord(attemptId)` and `recover(mountRecord)` reopen the same attempt.
This does not claim that an interrupted agent process resumed; its execution
status and authority remain the coordinator's responsibility.

Only remove storage after envmux has released the mount:

```ts
await provider.remove(attemptId);
```

Removal stops and removes the manager, removes its unused state volume, unmounts
the generated Linux host path and removes the local record/bundles. A retained
engine container keeps its volume reference, so it must be removed first. Do not
delete these volumes manually when recovering work.

## Verify the real journeys

The real ArtifactFS journeys require the managed VM topology, the installed image
and the descriptor variables above. Set `ENOUGHFACTORY_WORKSPACE_ROOT` to the
app's managed workspace directory; fixtures are created there rather than in an
arbitrary operating-system temporary directory. Then run the focused
mount/recovery scenario:

```sh
pnpm exec tsx runtime/workspaces/verify.mts
```

It checks the exact source, independent container-user writes, immutable Git
bundles, committed and dirty work across manager restart, repair conflicts and
cleanup. With the pinned envmux binary installed, verify the product integration:

```sh
pnpm exec tsx runtime/workspaces/envmux-verify.mts
```

Both scripts resolve the explicit runtime and use its bundled CLI, private config
and managed endpoint for every Docker call, including teardown. They refuse to
fall back to a user daemon. The envmux journey creates the attempt through `WorkspaceManager`, checks a real
envmux session, Git status/diff through its API, reattachment and source
harvesting, then captures the immutable candidate and integrates it after
configured checks in the actual engine image. Both create isolated repositories
under the managed workspace root and remove their own runtime storage.
