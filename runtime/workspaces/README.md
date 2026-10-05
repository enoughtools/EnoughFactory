# ArtifactFS workspaces

EnoughFactory can use a real writable ArtifactFS mount for each author attempt.
Ordinary Git workspaces are the compatible fallback when a device's engine
cannot support FUSE or shared Linux mounts. Choosing ArtifactFS preserves the
same envmux workbench, candidate and integration flow.

## Install the optional runtime

Docker must be running with a Linux engine, either natively or in its Linux VM
on Mac. Build the image from the pinned OSS source:

```sh
bash runtime/workspaces/build.sh
```

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

The trusted device service creates an exact Git source bundle and starts a
manager with `/dev/fuse` and `SYS_ADMIN`. A short, path-bounded helper prepares
`/var/lib/enoughfactory/workspaces/<attempt-id>` as a shared mount in the Linux
Docker host. On Mac, this directory lives in the Docker VM; a Mac FUSE installation
is unnecessary.

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

With the image installed, run the focused mount/recovery scenario:

```sh
pnpm exec tsx runtime/workspaces/verify.mts
```

It checks the exact source, independent container-user writes, immutable Git
bundles, committed and dirty work across manager restart, repair conflicts and
cleanup. With the pinned envmux binary installed, verify the product integration:

```sh
pnpm exec tsx runtime/workspaces/envmux-verify.mts
```

That journey checks a real envmux session, Git status/diff through its API,
reattachment and source harvesting. Both create isolated temporary repositories.
