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

Run and retry controls use the coordinator's existing authority rules. Pause and steering apply to the goal. Retiring an attempt revokes its EnoughFactory authority and permits replacement work; it does not prove every external effect has stopped. Device-local chats and live tools depend on their owning device being online. Recorded coordinator evidence remains inspectable.

Run and retry are available when the coordinator is dispatching. Commands carry the observed goal revision and, for retry, the failed attempt identity. If planning, pause, steering or a replacement advances first, the service rejects the stale action instead of changing the newer work. A stale retirement cannot revoke another generation.

## API

- `GET /api/goals/:id/inspection` returns task work states, retained plan/control details and controller runs.
- `GET /api/tasks/:id` returns the task contract, dependency graph, attempt evidence and artifact metadata.
- `GET /api/attempts/:id` returns one persisted attempt and its receipts.

These are authenticated read projections. They do not advance coordination, repair tasks or run checks. Paired-device requests use the existing owner routing and pairing authorization. Check output is limited to 64 KiB per result; full retained logs remain downloadable artifacts.

The shared UI can connect to older services. When inspection endpoints are unavailable, it shows basic recorded statuses and identifies the unavailable inspection capability. It does not invent execution phases or check results. The new task contracts and detailed inspection require an updated device service; loading a new web UI alone does not update an installed service.
