# EnoughFactory workspaces

`WorkspaceManager` owns repository handoffs and immutable evidence. Factory state remains in the coordinator's transactional store. Agent chat history remains on the worker device.

`create()` seeds an isolated handoff repository from an exact source commit through a complete Git bundle. Pass this repository's `path` to envmux; envmux continues to own guest setup, session branches and harvesting. After session stop, call `capture({ workspaceId, reference: session.branch })`. Capture caches a hash-verified full bundle and diff, so later integration does not depend on the worker's conversation or continued availability.

ArtifactFS is a selectable Linux-runtime provider. `ArtifactFsWorkspaceProvider` mounts in a trusted manager and provides private envmux bootstrap environment values. The ordinary Git path is the fallback, with a recorded reason; `fallbackToGit: false` requests a visible failure instead. See `runtime/workspaces/README.md` for installation and mount topology.

`verify()` reconstructs exact candidate inputs. The default executor runs configured commands as root with full access inside isolated Docker containers; it never executes agent-supplied check commands on the host. Configure a project-compatible check image, or inject a typed executor that creates an envmux verification session. An empty command list is recorded as `not-configured`, rather than `passed`.

`integrate()` serializes changes per repository, merges against the current target, checks that exact combined commit, then checks attempt authority again and accepts the branch using a compare-and-swap ref update. Changed targets, local edits, conflicts and failed checks have distinct outcomes. The caller must treat every status except `integrated` as work to reconcile or repair. Intent records make a crash after acceptance recoverable with `reconcileIntegration()`.

`promotePreviousCandidate()` retains prior work for a repair attempt. When current source conflicts with prior work, it commits explicit conflict-marked material on the isolated author branch so envmux can transfer it. Its returned conflict paths belong in the repair prompt. Candidate verification rejects unresolved markers on those recorded paths, even when no check commands are configured.

`ArtifactStore` stores content by SHA-256 and manifests by immutable identifier. Peer transfers assemble into a temporary file, then call `importFile()` or `acceptCandidate()`; complete size/hash and advertised commit checks precede acceptance. Devices can transfer source with `exportSource()` and `importSource()` without opening a Git listener.

Focused verification:

```sh
pnpm --filter @enoughfactory/workspaces typecheck
pnpm --filter @enoughfactory/workspaces test
ENOUGHFACTORY_CHECK_IMAGE=alpine:3.22 pnpm --filter @enoughfactory/workspaces test
```

The opt-in container journey verifies real root execution in Docker. The other journeys cover exact bundle handoffs, changed-base integration, retired authority, recovery, repair inputs, retained conflicts and corrupt transfer refusal.
