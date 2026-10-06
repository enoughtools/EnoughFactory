# Parallel work

Create a goal with an outcome, specification and completion criteria. New goals allow up to eight concurrent workers by default; existing goals keep their configured limit. This is a ceiling, not a request to create eight tasks. Available devices, task dependencies and resource reservations determine how many workers actually run.

## Planning and scheduling

The planner establishes shared interfaces early and separates work that can proceed independently. Each task can declare `estimatedMinutes`, repository-relative `writePaths`, and `resources` (`cpus` and `memoryGiB`). A `dependsOn` edge means the prerequisite must be integrated before the task starts. Overlapping write scopes are scheduling constraints rather than extra functional dependencies.

The scheduler prioritizes ready tasks by the longest estimated remaining dependency chain. It respects the goal's worker ceiling, compatible online devices, each device's worker slots and declared CPU/memory reservations. Tasks with overlapping declared write scopes wait for each other. These estimates guide scheduling; they do not impose container CPU/memory quotas or prevent an agent from editing other files. Isolated workspaces and checked integration remain the acceptance boundary.

Legacy tasks without scheduling metadata continue to work. Missing duration estimates use a unit weight; missing resource estimates reserve one CPU and one GiB when the device advertises a resource budget. Unknown device budgets retain slot-based placement.

## Device capacity

Open **Devices → Worker capacity** on each device. Automatic capacity allows one worker per two CPUs and two GiB, capped at 32, with a minimum of one when resources are known. A manual limit can be set from 1 to 32. Lowering a limit stops new placement until usage falls below it; it does not cancel running work.

Mac resource budgets reflect the private runtime's allocation. Linux budgets reflect the host resources available to its private rootless engine. A paused or unavailable runtime advertises no worker slots. A stopped runtime can still accept work and start its owned engine.

## Recovery

Diagnosis and repair can continue while unrelated branches run. A repair replan replaces the failed task and its affected descendants, preserves unrelated attempts and their original execution contracts, and keeps completed work. Explicit changes to the goal's requirements can still require a full replan.

Unknown execution outcomes and unacknowledged cancellation retain their reservations. The same task cannot be dispatched twice. Known write scopes block overlapping work; an uncertain attempt without a reliable scope conservatively reserves the whole repository. The factory reconciles the owner before retrying work with uncertain effects.

## Inspecting the plan

Open a goal and choose **Graph** beside Board and List. The graph shows dependencies, task state, device ownership and estimated remaining paths. Select a task to inspect its contract, prerequisites, dependents, scheduling reason, conversation and attempt evidence. Zoom and Fit control the graph without changing the plan.

Authors run in separate Git or ArtifactFS workspaces. Candidate acceptance remains serialized per repository, with checks against the combined result before the target changes. Increasing parallelism does not bypass integration or goal completion criteria.
