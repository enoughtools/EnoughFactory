# EnoughFactory coordinator

The device service constructs `FactoryCoordinator` with a transactional store, an agent runtime port and an immutable workspace port. `start()` restores nonterminal goals and keeps the factory loop running independently of client windows. `stop()` stops coordination during service shutdown without claiming remote execution was terminated.

The loop stores planning, dispatch, candidate capture, checks, serialized integration, completion evaluation and failure diagnosis as separate durable transitions. Planning and review are real agent invocations supplied by the device adapter. A worker turn finishing cannot complete a goal: all live task work must be integrated and a separate evaluation must supply evidence for every retained completion criterion at the evaluated repository head. A changed head invalidates that evaluation.

An attempt has one task, owner and generation. The current task pointer plus goal revision fences acceptance, policy routing and repository integration. Interrupted observation becomes `unknown`; the coordinator queries the owner's journal and never dispatches a replacement based on an offline flag alone. Explicit retirement revokes authority and permits replacement; unconfirmed remote termination remains visible in the attempt detail and decision history. Integration adapters must check the supplied live `isCurrent` closure immediately before their canonical ref write.

`create`, `pause`, `resume`, `cancel`, `steer`, `requestPlan`, `requestEvaluation`, `selectTasks`, `retireAttempt`, `configure` and `notifyCondition` provide the application controls. Manual and assisted modes select work independently of approval policy. Autonomous mode continues through diagnosis, changed attempts, replanning and evaluation without requiring a person to advance the loop. Explicit waiting conditions suspend inference until a device, provider, configured external event or changed budget wakes the goal.

Spend limits use amounts actually reported by runtime adapters. Missing monetary usage is recorded as `unpricedTurns`, rather than treated as proof of zero cost. Time and attempt budgets remain available for runtimes without prices. Updating a budget never reports completion.

Tables `goals`, `tasks`, `attempts` and `decisions` are shared application records. `factory-control`, `factory-plans`, `factory-task-details`, `factory-attempt-details` and `factory-evaluations` store transition context and evidence separately from device-local transcripts. Do not synchronize SQLite files across owners or instantiate two coordinators for the same authority.

Run `pnpm --filter @enoughfactory/factory test` for the focused authority, recovery, acceptance and continuation scenarios.
