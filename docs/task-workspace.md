# Task workspace

The goal workspace exposes the factory's durable work graph. Select a goal, inspect its board or task list, then select a task and attempt. The selected goal, task and attempt survive navigation into an environment or agent conversation and back. The task's environment can also be opened inside the goal workspace.

## Task contracts

| Kind | Delivery contract |
| --- | --- |
| Feature | Observable product behavior, including relevant acceptance scenarios and failure states |
| Unit | A bounded component or change that preserves surrounding interfaces |
| Architecture | A resolved structural decision with repository deliverables, rationale and an actionable handoff |
| Test | Focused verification of an identified uncertainty with actual recorded results |

The planner chooses kinds according to the outcome. A kind changes the worker's instructions; task acceptance criteria and expected outputs remain attached to the durable task. Kinds do not introduce mandatory review roles or an extra test stage. Older tasks without a kind retain their generic delivery contract.

## Work and evidence

The board derives work state from coordinator records and attempt receipts. Dependency blockers, dispatch eligibility, capacity waits, preparation, execution, capture, checking, integration, accepted work, failure, unknown execution and cancellation remain distinguishable. A successful agent turn is not an accepted task. Acceptance follows candidate capture, configured checks and integration.

Each task exposes its description and delivery contract, dependencies and dependents, configured checks, repairs and attempt history. Attempt evidence includes the workspace base, candidate commit and tree, recorded check output, and integration's previous target head and resulting commit. Missing evidence is reported as missing. Controller activity exposes planning, diagnosis and evaluation sessions and conversations.

Task checks verify the outputs available after that task and its prerequisites. Plan-level checks verify the integrated goal after its tasks finish and must pass before completion. Both contain executable shell commands. Final check receipts record the exact inputs and are reused only while those inputs, commands and goal revision remain unchanged.

Run and retry controls use the coordinator's existing authority rules. Pause and steering apply to the goal. Retiring an attempt revokes its EnoughFactory authority and permits replacement work; it does not prove every external effect has stopped. Device-local chats and live tools depend on their owning device being online. Recorded coordinator evidence remains inspectable.

Run and retry are available when the coordinator is dispatching. Commands carry the observed goal revision and, for retry, the failed attempt identity. If planning, pause, steering or a replacement advances first, the service rejects the stale action instead of changing the newer work. A stale retirement cannot revoke another generation.

## Working folders

The primary Git repository is the integration target. **Project settings → Working folders** accepts up to eight additional Git repositories or ordinary folders on the project's device. Set a path and workspace name for each one; the desktop folder picker is available for its own device. These settings apply to future workspaces.

Each workspace gets private writable snapshots at `/workspaces/<name>`. The original host folders are never mounted for shared writes. Agents can inspect and edit all recorded roots with full container permissions, and the agent instructions identify their locations. A task's Evidence view records the roots actually prepared for its attempt, including their baseline and captured output.

In an environment's **Changes** view, use **Working folder** to inspect a recorded root. **Capture folders** preserves its current edits when the agent is idle. Capture also runs before stopping an environment or accepting a factory candidate; failed capture keeps the environment available instead of discarding its files. Captured output is retained as verified Git bundles and patches, including for ordinary folders.

Only the primary repository integrates automatically. Download supporting-folder output from its recorded evidence and apply it separately. Checks receive the exact captured supporting snapshots, and paired-device dispatch transfers their inputs and output artifacts. Existing workspaces keep their inputs even if their project later points to different folders.

## API

- `GET /api/goals/:id/inspection` returns task work states, retained plan/control details and controller runs.
- `GET /api/tasks/:id` returns the task contract, dependency graph, attempt evidence and artifact metadata.
- `GET /api/attempts/:id` returns one persisted attempt and its receipts.

These are authenticated read projections. They do not advance coordination, repair tasks or run checks. Paired-device requests use the existing owner routing and pairing authorization. Check output is limited to 64 KiB per result; full retained logs remain downloadable artifacts.

The shared UI can connect to older services. When inspection endpoints are unavailable, it shows basic recorded statuses and identifies the unavailable inspection capability. It does not invent execution phases or check results. The new task contracts and detailed inspection require an updated device service; loading a new web UI alone does not update an installed service.
