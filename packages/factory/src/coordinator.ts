import { createHash, randomUUID } from "node:crypto";
import type { Attempt, Decision, FactoryTask, Goal, Project } from "@enoughfactory/contracts";
import type {
  AttemptDetail, CandidateRef, ConfigureGoalInput, ControlRecord, ControllerRecordRequirement, CoordinatorOptions, CreateGoalInput,
  EvaluationRecord, ExecutionResult, GoalCheckRecord, PlanRecord, PlannedTask, RepositoryEvidence, TaskDetail,
} from "./types.js";
import { UI_QUALITY_CHECK_COMMAND } from "./types.js";
import { readCheckCommands, readEvaluation, readJsonObject, readPlan, readTasks, validateDependencies, validateTaskExecution } from "./protocol.js";
import { FactoryOperationError, FactoryDecisionError, FactoryControllerError, FactoryCapacityError, FactoryVerificationWaitError } from "./errors.js";
import { activeExecutionTasks, descendants, deviceExecutionTargets, placementConstraint, selectExecutionTarget, sortReadyTasks, taskSchedulingBlocker, taskCheckInputBlocker, taskCapabilityBlocker, verificationOnlyReservation, effectiveTaskExecution } from "./scheduler.js";
import { ControllerEvidence, controllerPrompt } from "./controller-evidence.js";

const TABLE = {
  goals: "goals", tasks: "tasks", attempts: "attempts", decisions: "decisions",
  plans: "factory-plans", control: "factory-control", taskDetails: "factory-task-details",
  attemptDetails: "factory-attempt-details", evaluations: "factory-evaluations", goalChecks: "factory-goal-checks",
  inspectionEvents: "factory-inspection-events",
} as const;
const terminalGoals = new Set<Goal["status"]>(["completed", "canceled", "failed"]);
const activeAttempts = new Set<Attempt["status"]>(["created", "running", "unknown"]);
const controllerRetryDelays = [30_000, 120_000, 300_000];

/** Durable, single-authority coordinator. A turn ending is an input, never completion. */
export class FactoryCoordinator {
  private readonly options: CoordinatorOptions;
  private readonly pending = new Set<Promise<void>>();
  private readonly busyGoals = new Set<string>();
  private readonly busyAttempts = new Set<string>();
  private readonly reconciling = new Set<string>();
  private readonly lastObservation = new Map<string, number>();
  private readonly operationControllers = new Map<string, AbortController>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private enabled = false;
  private queued = false;
  private ticking = false;
  private shuttingDown = false;

  constructor(options: CoordinatorOptions) { this.options = options; }

  create(input: CreateGoalInput): Goal {
    const project = this.options.project(input.projectId);
    if (!project) throw new Error("Choose an existing project for the goal.");
    if (!input.objective.trim()) throw new Error("A goal needs an objective.");
    if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 32)) throw new Error("Concurrency must be between 1 and 32.");
    if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) throw new Error("Attempt budget must be a positive integer.");
    if (input.maxDurationMs !== undefined && (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0)) throw new Error("Time budget must be positive.");
    const at = this.now(), autonomy = input.autonomy ?? "autonomous";
    const execution = validateTaskExecution(input.execution);
    const goal: Goal = {
      id: randomUUID(), projectId: input.projectId, coordinatorId: this.options.deviceId,
      title: input.title?.trim() || input.objective.trim().split("\n")[0]!.slice(0, 96),
      objective: input.objective.trim(), criteria: [...new Set((input.criteria ?? []).map(value => value.trim()).filter(Boolean))],
      status: autonomy === "manual" ? "draft" : "planning", autonomy,
      approvalMode: input.approvalMode ?? project.approvalMode ?? "approve-all", runtime: input.runtime ?? project.runtime,
      createdAt: at, updatedAt: at, revision: 1,
      nextAction: autonomy === "manual" ? "Plan when requested" : "Plan the goal and its completion criteria",
      concurrency: Math.max(1, Math.min(32, Math.floor(input.concurrency ?? 8))),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      ...(execution === undefined ? {} : { execution }),
    };
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.goals, goal);
      this.options.store.set<ControlRecord>(TABLE.control, {
        id: goal.id, stage: "plan", startedAt: at, steering: [],
        ...(input.maxDurationMs === undefined ? {} : { maxDurationMs: input.maxDurationMs }),
      });
      this.decision(goal.id, "goal-created", `Goal created in ${autonomy} mode with ${goal.approvalMode} policy.`);
    });
    this.changed(); return goal;
  }

  /** Call once when the service starts. Previous live handles are not presumed dead. */
  async start(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.shuttingDown = false;
    this.options.store.transaction(() => {
      for (const goal of this.goals()) {
        if (goal.coordinatorId !== this.options.deviceId || terminalGoals.has(goal.status)) continue;
        const control = this.control(goal.id);
        if (control.operation) {
          this.options.store.set(TABLE.control, { ...control, operation: undefined });
          this.decision(goal.id, "controller-recovered", "An interrupted controller decision will be recomputed from current records.");
        }
        for (const attempt of this.attempts(goal.id).filter(item => this.isCurrent(item) && (activeAttempts.has(item.status) || (item.status === "succeeded" && this.task(item.taskId).status === "review")))) {
          const detail = this.attemptDetail(attempt.id);
          if (detail.capacityWait || (attempt.status === "succeeded" && detail.verificationWait && detail.candidate && detail.phase === "checking")) continue;
          this.options.store.set(TABLE.attempts, { ...attempt, status: "unknown" as const });
          this.decision(goal.id, "attempt-recovered", "Execution status is unknown after service recovery; reconcile with its owner before continuing.", { attemptId: attempt.id });
        }
      }
    });
    this.timer = setInterval(() => { void this.tick(); }, 10_000);
    this.timer.unref();
    await this.tick();
  }

  /** Stop observing on service shutdown; running owners keep their journaled work. */
  stop(): void {
    this.enabled = false;
    this.shuttingDown = true;
    for (const controller of this.operationControllers.values()) controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  serviceActivity():{controllers:number;attempts:number;reconciliation:number;pending:number} {
    return {controllers:this.busyGoals.size,attempts:this.busyAttempts.size,reconciliation:this.reconciling.size,pending:this.pending.size};
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const observedAt = Date.parse(this.now());
      for (const attempt of this.options.store.list<Attempt>(TABLE.attempts)) {
        if (attempt.status !== "retired" || this.options.store.get<AttemptDetail>(TABLE.attemptDetails, attempt.id)?.cancellation !== "requested" || this.cancellations.has(attempt.id)) continue;
        if (!this.options.devices().some(device => device.id === attempt.deviceId && device.online) || this.reconciling.has(attempt.id)) continue;
        if (this.enabled && observedAt - (this.lastObservation.get(attempt.id) ?? 0) < 10_000) continue;
        this.lastObservation.set(attempt.id, observedAt);
        this.reconciling.add(attempt.id);
        this.track(this.acknowledgeCancel(attempt).finally(() => this.reconciling.delete(attempt.id)));
      }
      for (const goal of this.goals()) {
        if (goal.coordinatorId !== this.options.deviceId || terminalGoals.has(goal.status)) continue;
        for (const attempt of this.attempts(goal.id)) {
          if (activeAttempts.has(attempt.status) && !this.busyAttempts.has(attempt.id) && !this.reconciling.has(attempt.id) && (!this.enabled || observedAt - (this.lastObservation.get(attempt.id) ?? 0) >= 10_000)) {
            if (this.attemptDetail(attempt.id).capacityWait) {
              if (["paused", "waiting", "draft"].includes(this.goal(goal.id).status) || this.checkBudget(this.goal(goal.id)) || !this.admit(goal.id)) continue;
              this.busyAttempts.add(attempt.id);
              this.track(this.execute(attempt).finally(() => this.busyAttempts.delete(attempt.id)));
              continue;
            }
            this.lastObservation.set(attempt.id, observedAt);
            this.reconciling.add(attempt.id);
            this.track(this.reconcileAttempt(attempt).finally(() => this.reconciling.delete(attempt.id)));
          }
        }
        this.recoverCompletedWork(goal);
        if (goal.status === "paused") continue;
        if (this.busyGoals.has(goal.id)) {
          const control = this.control(goal.id);
          if (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length)) this.dispatch(this.goal(goal.id), false);
          continue;
        }
        let current = this.goal(goal.id), control = this.control(goal.id);
        // Localized repair keeps unrelated work running, so its timed wait is not
        // represented by goal.status === "waiting".
        if (control.waitingFor === "controller-retry" && control.wakeAt && Date.parse(control.wakeAt) <= Date.parse(this.now())) {
          this.wake(current.id, "Retry the controller after its preparation backoff.");
          current = this.goal(goal.id); control = this.control(goal.id);
        }
        if (current.status === "waiting") {
          if (control.waitingFor === "budget-changed") {
            const reason = this.limitReason(current);
            if (reason) { this.wait(current.id, reason, "budget-changed"); continue; }
            this.wake(current.id, "No configured execution limit is currently reached; continuing work.");
          } else if (control.waitingFor === "host-disk-space" && this.options.admission && !this.options.admission(current)) this.wake(current.id, "Host disk space is available; continuing work.");
          else if (control.waitingFor === "device-online" && this.hasAvailableDevice(current)) this.wake(current.id, "A worker device is available.");
          else if (control.wakeAt && Date.parse(control.wakeAt) <= Date.parse(this.now())) this.wake(current.id, "The configured wait has elapsed.");
          else continue;
          current = this.goal(goal.id); control = this.control(goal.id);
        }
        if (current.status === "draft" && !control.manualAction && !this.tasks(current.id).some(task => this.taskDetail(task.id).selected)) continue;
        if (this.checkBudget(current)) continue;
        if (!this.options.project(current.projectId)) { this.wait(current.id, "The goal's project is unavailable.", "project-available"); continue; }
        if (!this.admit(current.id)) continue;
        if (control.waitingFor && (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length))) {
          this.dispatch(current, false); continue;
        }
        if (control.stage === "plan" && (current.autonomy !== "manual" || control.manualAction === "plan")) {
          if (control.replanTaskIds?.length) this.dispatch(current, false);
          this.scheduleGoal(current.id, () => this.plan(this.goal(current.id)));
        } else if (control.stage === "diagnose") {
          this.dispatch(current, false);
          this.scheduleGoal(current.id, () => this.diagnose(this.goal(current.id)));
        }
        else if (control.stage === "dispatch") this.dispatch(current);
        else if (control.stage === "evaluate" && (current.autonomy !== "manual" || control.manualAction === "evaluate")) this.scheduleGoal(current.id, () => this.evaluate(current));
      }
    } finally { this.ticking = false; }
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  pause(goalId: string): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) return;
    this.options.store.transaction(() => {
      this.writeGoal(goalId, { status: "paused", nextAction: "Paused; already dispatched work may finish" });
      this.decision(goalId, "paused", "New dispatch and integration are paused. Worker execution remains observable.");
    });
    this.operationControllers.get(goalId)?.abort();
    this.changed();
  }

  resume(goalId: string): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("A terminal goal cannot be resumed. Create a new goal to continue it.");
    const control = this.control(goalId);
    const inspectionWaiting = control.waitingFor === "inspection-evidence" || this.tasks(goalId).some(task => {
      if (task.status !== "review" || !task.currentAttemptId) return false;
      const attempt = this.attempt(task.currentAttemptId), detail = this.attemptDetail(attempt.id);
      return attempt.status === "succeeded" && this.isCurrent(attempt) && !!detail.candidate && detail.phase === "checking" && detail.verificationWait?.condition === "inspection-evidence";
    });
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...control, waitingFor: undefined, waitReason: undefined, wakeAt: undefined, controllerFailures: undefined, stage: control.stage === "wait" ? this.nextStage(goalId) : control.stage });
      this.writeGoal(goalId, { status: control.stage === "plan" ? "planning" : "running", error: undefined, nextAction: "Resume from current durable state" });
      this.decision(goalId, "resumed", "Coordination resumed from its retained plan and attempts.");
    });
    for (const attempt of this.attempts(goalId)) {
      this.lastObservation.delete(attempt.id);
      const detail = this.attemptDetail(attempt.id);
      if (detail.recoveryObservation) this.options.store.set(TABLE.attemptDetails, { ...detail, recoveryObservation: undefined });
    }
    // Explicit resume retries settled inspection preparation against the retained
    // source. Restart alone remains quiescent and never reopens an author.
    if (inspectionWaiting) this.notifyCondition("inspection-evidence", goalId);
    else this.changed();
  }

  requestPlan(goalId: string): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    if (this.attempts(goalId).some(attempt => activeAttempts.has(attempt.status)) || this.tasks(goalId).some(task => task.status === "review")) throw new Error("Work is active or awaiting integration. Use goal steering to revise and revoke it explicitly.");
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...this.control(goalId), stage: "plan", manualAction: "plan", operation: undefined, replanReason: "A fresh plan was requested.", replanInstructions: undefined, replanTaskIds: undefined, decisionFailures: undefined, waitingFor: undefined, waitReason: undefined, wakeAt: undefined, controllerFailures: undefined });
      this.writeGoal(goalId, { revision: goal.revision + 1, status: goal.status === "paused" ? "paused" : "planning", nextAction: "Plan the requested work" });
      for (const task of this.tasks(goalId).filter(task => task.status !== "completed")) this.writeTask(task.id, { status: "canceled" });
      this.decision(goalId, "plan-requested", "A new plan was requested from current accepted work; pending proposals were replaced.");
    });
    this.operationControllers.get(goalId)?.abort(); this.changed();
  }

  configure(goalId: string, input: ConfigureGoalInput): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    if (input.maxDurationMs !== undefined && input.maxDurationMs !== null && (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0)) throw new Error("maxDurationMs must be positive or null.");
    if (input.maxAttempts !== undefined && input.maxAttempts !== null && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) throw new Error("Attempt budget must be a positive integer or null.");
    if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 32)) throw new Error("Concurrency must be between 1 and 32.");
    const execution = validateTaskExecution(input.execution);
    this.options.store.transaction(() => {
      this.writeGoal(goalId, {
        ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts ?? undefined }),
        ...(execution === undefined ? {} : { execution }),
      });
      if (input.maxDurationMs !== undefined) this.options.store.set(TABLE.control, { ...this.control(goalId), maxDurationMs: input.maxDurationMs ?? undefined });
      if (input.autonomy && input.autonomy !== "manual" && goal.status === "draft") this.writeGoal(goalId, { status: this.control(goalId).stage === "plan" ? "planning" : "running" });
      this.decision(goalId, "configuration", "Goal execution settings updated. Approval changes apply to subsequently started turns.", {
        autonomy: input.autonomy, approvalMode: input.approvalMode, runtime: input.runtime, concurrency: input.concurrency,
        maxAttempts: input.maxAttempts, maxDurationMs: input.maxDurationMs, execution,
      });
      if (this.control(goalId).waitingFor === "budget-changed") this.wake(goalId, "Execution budget was updated.");
      else if (input.runtime && this.control(goalId).waitingFor === "runtime-available") this.wake(goalId, "The goal runtime was updated.");
      else if (execution && this.control(goalId).waitingFor === "execution-capability") this.wake(goalId, "Execution requirements were updated.");
    });
    this.changed();
  }

  requestEvaluation(goalId: string): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    if (this.busyGoals.has(goalId)) throw new Error("A controller decision is still running. Pause or steer it before requesting a different decision.");
    if (this.tasks(goalId).some(task => !["completed", "canceled"].includes(task.status))) throw new Error("Complete or retire outstanding work before evaluating the full goal.");
    this.options.store.set(TABLE.control, { ...this.control(goalId), stage: "evaluate", manualAction: "evaluate", waitingFor: undefined, waitReason: undefined, wakeAt: undefined, controllerFailures: undefined });
    this.writeGoal(goalId, { status: "running", nextAction: "Evaluate current completion evidence" }); this.changed();
  }

  selectTasks(goalId: string, taskIds: string[], options: { preserveController?: boolean; additive?: boolean } = {}): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    const ids = new Set(taskIds);
    for (const id of ids) if (!this.tasks(goalId).some(task => task.id === id)) throw new Error("Selected task does not belong to this goal.");
    this.options.store.transaction(() => {
      for (const task of this.tasks(goalId)) this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(task.id), selected: ids.has(task.id) || (!!options.additive && this.taskDetail(task.id).selected) });
      const control = this.control(goalId);
      const preserving = options.preserveController && (control.stage === "diagnose" || (control.stage === "plan" && !!control.replanTaskIds?.length));
      if (!preserving) this.options.store.set(TABLE.control, { ...control, stage: "dispatch", manualAction: undefined });
      this.writeGoal(goalId, { ...(preserving ? {} : { status: "running" as const }), nextAction: "Execute the selected work" });
      this.decision(goalId, "work-selected", `${ids.size} task${ids.size === 1 ? "" : "s"} selected for execution.`, { taskIds });
    });
    this.changed();
  }

  async steer(goalId: string, input: { objective?: string; context?: string; criteria?: string[]; autonomy?: Goal["autonomy"]; approvalMode?: Goal["approvalMode"]; execution?: Goal["execution"] }): Promise<void> {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    if (input.objective !== undefined && !input.objective.trim()) throw new Error("The objective cannot be empty.");
    const execution = validateTaskExecution(input.execution);
    const attempts = this.attempts(goalId).filter(attempt => activeAttempts.has(attempt.status));
    this.options.store.transaction(() => {
      const control = this.control(goalId);
      this.options.store.set(TABLE.control, { ...control, stage: "plan", operation: undefined, steering: input.context ? [...control.steering, input.context.trim()] : control.steering, replanReason: "User steering changed the goal context.", replanInstructions: undefined, replanTaskIds: undefined, decisionFailures: undefined, waitingFor: undefined, waitReason: undefined, wakeAt: undefined, controllerFailures: undefined });
      this.writeGoal(goalId, {
        revision: goal.revision + 1, status: goal.status === "paused" ? "paused" : "planning", nextAction: "Revise the plan for the updated goal",
        ...(input.objective === undefined ? {} : { objective: input.objective.trim() }),
        ...(input.criteria === undefined ? {} : { criteria: [...new Set(input.criteria.map(value => value.trim()).filter(Boolean))] }),
        ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
        ...(execution === undefined ? {} : { execution }),
      });
      for (const task of this.tasks(goalId).filter(task => task.status !== "completed" && task.status !== "canceled")) this.writeTask(task.id, { status: "canceled" });
      for (const attempt of attempts) this.revoke(attempt);
      this.decision(goalId, "steering", input.context?.trim() || "The goal definition or policy was updated; outstanding authority was revoked.", input);
    });
    this.operationControllers.get(goalId)?.abort();
    this.changed(); await Promise.allSettled(attempts.map(attempt => this.acknowledgeCancel(attempt)));
  }

  async cancel(goalId: string): Promise<void> {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) return;
    const attempts = this.attempts(goalId).filter(attempt => activeAttempts.has(attempt.status));
    this.options.store.transaction(() => {
      this.writeGoal(goalId, { revision: goal.revision + 1, status: "canceled", nextAction: "Canceled; inspect termination acknowledgments for remote work" });
      this.options.store.set(TABLE.control, { ...this.control(goalId), stage: "done", operation: undefined });
      for (const task of this.tasks(goalId).filter(task => task.status !== "completed")) this.writeTask(task.id, { status: "canceled" });
      for (const attempt of attempts) this.revoke(attempt);
      this.decision(goalId, "canceled", "New work and integration are revoked. Cancellation is requested from each owning device.");
    });
    this.operationControllers.get(goalId)?.abort();
    this.changed(); await Promise.allSettled(attempts.map(attempt => this.acknowledgeCancel(attempt)));
  }

  async retireAttempt(attemptId: string, options: { preserveController?: boolean; expectedGoalRevision?: number; repairInstructions?: string } = {}): Promise<void> {
    const attempt = this.attempt(attemptId), task = this.task(attempt.taskId), goal = this.goal(task.goalId);
    if (terminalGoals.has(goal.status) || task.status === "completed") throw new Error("Integrated or terminal work cannot be retired as a live attempt.");
    if (!this.isCurrent(attempt) || (options.expectedGoalRevision !== undefined && goal.revision !== options.expectedGoalRevision)) throw new FactoryOperationError("stale", "This attempt no longer owns its task's execution authority.");
    if (attempt.status === "failed") await this.retainFailedWork(attempt);
    if (!this.isCurrent(attempt) || (options.expectedGoalRevision !== undefined && this.goal(goal.id).revision !== options.expectedGoalRevision)) throw new FactoryOperationError("stale", "This attempt changed while its partial work was being retained.");
    this.options.store.transaction(() => {
      this.revoke(attempt); this.writeTask(task.id, { status: "queued", currentAttemptId: undefined });
      if (options.repairInstructions !== undefined) {
        const repairInstructions = options.repairInstructions.trim();
        this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(task.id), repairInstructions: repairInstructions || undefined });
        this.decision(goal.id, "task-retry-instructions", repairInstructions ? "The user supplied repair instructions for the next isolated task attempt." : "The user cleared repair instructions for the next isolated task attempt.", { taskId: task.id, previousAttemptId: attempt.id, repairInstructions });
      }
      this.decision(goal.id, "attempt-retired", "Attempt authority was retired explicitly. A new isolated attempt may now be placed; external effects still require reconciliation.", { attemptId });
      this.writeGoal(goal.id, { nextAction: "Place a replacement for the explicitly retired attempt" });
      const control = this.control(goal.id);
      const preserving = options.preserveController && (control.stage === "diagnose" || (control.stage === "plan" && !!control.replanTaskIds?.length));
      if (!preserving) this.options.store.set(TABLE.control, { ...control, stage: "dispatch", waitingFor: undefined, waitReason: undefined });
    });
    this.changed(); await this.acknowledgeCancel(attempt);
  }

  notifyCondition(condition: string, goalId?: string): void {
    // A receipt can arrive while its pending check is returning. Retain the event
    // before walking waits so that the result handler cannot park behind it.
    if (condition === "inspection-evidence") for (const goal of this.goals()) {
      if ((goalId && goal.id !== goalId) || terminalGoals.has(goal.status)) continue;
      this.options.store.set(TABLE.inspectionEvents, { id: goal.id, revision: this.inspectionEventRevision(goal.id) + 1 });
    }
    for (const task of this.options.store.list<FactoryTask>(TABLE.tasks)) {
      if (goalId && task.goalId !== goalId) continue;
      const goal = this.goal(task.goalId), detail = this.taskDetail(task.id);
      const attempt = task.currentAttemptId ? this.options.store.get<Attempt>(TABLE.attempts, task.currentAttemptId) : undefined;
      const attemptDetail = attempt && this.options.store.get<AttemptDetail>(TABLE.attemptDetails, attempt.id);
      if (!terminalGoals.has(goal.status) && task.status === "review" && attempt?.status === "succeeded" && this.isCurrent(attempt) && attemptDetail?.candidate && attemptDetail.phase === "checking" && attemptDetail.verificationWait?.condition === condition) {
        this.options.store.set(TABLE.attemptDetails, { ...attemptDetail, verificationWait: undefined });
        this.decision(goal.id, "verification-woken", `Inspection evidence changed for ${task.title}; continue the same retained author attempt.`, { taskId: task.id, attemptId: attempt.id, condition });
      }
      if (condition === "inspection-evidence" || terminalGoals.has(goal.status) || detail.waitingFor !== condition || task.status !== "failed") continue;
      if (taskCheckInputBlocker(detail) || taskCapabilityBlocker(effectiveTaskExecution(task, goal), this.options.devices(), undefined, goal.workspaceProvider ?? "git", goal.runtime)) continue;
      this.options.store.transaction(() => {
        this.writeTask(task.id, { status: "queued", currentAttemptId: undefined });
        this.options.store.set(TABLE.taskDetails, { ...detail, waitingFor: undefined, waitReason: undefined, waitSince: undefined });
        this.decision(goal.id, "task-woken", `Condition satisfied for ${task.title}: ${condition}`, { taskId: task.id });
      });
    }
    for (const goal of this.goals()) {
      if (goalId && goal.id !== goalId) continue;
      const control = this.control(goal.id);
      if (control.waitingFor !== condition || terminalGoals.has(goal.status)) continue;
      if (goal.status === "waiting") this.wake(goal.id, `Condition satisfied: ${condition}`);
      else if (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length)) {
        this.options.store.set(TABLE.control, { ...control, waitingFor: undefined, waitReason: undefined, wakeAt: undefined });
        this.decision(goal.id, "controller-woken", `Repair controller condition satisfied: ${condition}`);
      }
    }
    this.changed();
  }

  /** Include settled failures in the same repair, without revoking unrelated execution. */
  private expandRepairScope(goalId: string): string[] | undefined {
    const control = this.control(goalId);
    if (!control.replanTaskIds?.length) return control.replanTaskIds;
    const tasks = this.tasks(goalId), scope = new Set(control.replanTaskIds);
    const reserved = new Set(this.activeWork().map(task => task.id));
    const attempts = this.attempts(goalId), added: string[] = [];
    for (const failed of tasks.filter(task => task.status === "failed" && !scope.has(task.id))) {
      const branch = new Set([failed.id, ...descendants(tasks, [failed.id])]);
      const additional = tasks.filter(task => branch.has(task.id) && task.status !== "completed" && !scope.has(task.id));
      if (additional.some(task => reserved.has(task.id) || task.status === "running" || task.status === "review" || this.taskDetail(task.id).waitingFor)) continue;
      const ids = new Set(additional.map(task => task.id));
      if (attempts.some(attempt => {
        if (!ids.has(attempt.taskId)) return false;
        const detail = this.options.store.get<AttemptDetail>(TABLE.attemptDetails, attempt.id);
        const needsRetention = detail?.workspace && !detail.candidate && tasks.some(task => task.id === attempt.taskId && task.currentAttemptId === attempt.id) && (attempt.status === "failed" || detail.result?.status === "failed");
        return !detail || needsRetention || activeAttempts.has(attempt.status) || detail.cancellation === "requested" || this.busyAttempts.has(attempt.id) || this.reconciling.has(attempt.id);
      })) continue;
      for (const task of additional) { scope.add(task.id); added.push(task.id); }
    }
    if (!added.length) return control.replanTaskIds;
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...this.control(goalId), replanTaskIds: [...scope], decisionFailures: undefined });
      for (const id of added) this.writeTask(id, { status: "canceled" });
      this.decision(goalId, "repair-scope-expanded", "The repair also includes settled failed work and its pending dependents; unrelated execution and accepted work remain preserved.", { taskIds: added });
    });
    return [...scope];
  }

  private async plan(goal: Goal): Promise<void> {
    const scope = this.expandRepairScope(goal.id);
    const operation = this.beginOperation(goal, "planner"), project = this.project(goal);
    const completed = this.tasks(goal.id).filter(task => task.status === "completed");
    const preserved = scope ? this.tasks(goal.id).filter(task => !scope.includes(task.id) && task.status !== "canceled") : completed;
    try {
      const recordRequirements: ControllerRecordRequirement[] = [];
      const prompt = controllerPrompt(evidence => {
        // Prioritize current failures before allocating excerpts to historical accepted work.
        const retained = this.tasks(goal.id).filter(task => task.status !== "completed" && (!scope || scope.includes(task.id))).map(task => {
          const detail = this.taskDetail(task.id);
          return { ...evidence.task(task, detail), failure: evidence.text(detail.lastError, `${TABLE.taskDetails}/${task.id}.lastError`, 8192),
            candidate: evidence.candidate(detail.lastCandidate), priorRepairGuidance: { planRevision: detail.planRevision, instructions: detail.repairInstructions } };
        });
        const context = this.context(goal, evidence);
        const integrated = completed.map(task => ({ ...evidence.task(task, this.taskDetail(task.id)),
          attempt: evidence.attempt(this.options.store.get<Attempt>(TABLE.attempts, task.currentAttemptId ?? ""),
            this.options.store.get<AttemptDetail>(TABLE.attemptDetails, task.currentAttemptId ?? "")) }));
        return [
          "You are the EnoughFactory planner. Build the entire objective, preserving all explicit requirements. Make routine implementation decisions yourself.",
          "Return one JSON object: {summary,criteria:string[],checks:string[],tasks:[{key,title,description,kind:'feature'|'unit'|'architecture'|'test',acceptanceCriteria:string[],expectedOutputs:string[],dependsOn:string[],checks:string[],requiredCheckEnvironment?:string[],execution?:{target?:'auto'|'container'|'host-macos',requiredCapabilities?:string[],delegatedCapabilities?:string[]},quality?:{platforms:('web'|'macos'|'ios-simulator')[],workflows:[{id,platform}],referenceIds:string[]},estimatedMinutes?:number,writePaths?:string[],resources?:{cpus?:number,memoryGiB?:number},deviceId?:string}]}. Stable task keys must be unique, dependencies acyclic, checks focused and executable on the configured target.",
          "For material UI implementation or final UI delivery, declare explicit quality platforms, representative workflow identities and supplied referenceIds. Keep unrelated architecture/backend-only work independent; legacy absence does not acquire a global UI gate. Use execution.requiredCapabilities for requirements local to the author, and execution.delegatedCapabilities for browser or native tools another device can supply. Supported capabilities are linux-shell, mac-shell, chromium-inspection, apple-compilation, macos-app-inspection and ios-simulator-inspection. A Mac device running Linux containers is not a Mac-shell executor. Omitted task execution inherits the goal's explicit execution default; otherwise it preserves container execution. An explicit task execution replaces that default. Auto may select a configured Mac host for local Mac requirements. Plan only against the advertised inventory, and keep missing genuine capabilities explicit rather than substitute passing portable tests for native/visual verification.",
          "If a task requires independently supplied verification inputs, declare their names in requiredCheckEnvironment. Supported names are ENOUGH_EVIDENCE_ROOT, ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR, ENOUGH_NATIVE_INDEX_SHA256 and ENOUGH_ACCEPTANCE_INDEX_SHA256. The coordinator will wait before dispatch until its authenticated check-input configuration contains every named value. Plan descriptions and checks cannot provision these values. Existing task-local external waits survive a stable-key replan; changing a plan is not evidence that their prerequisites arrived.",
          "Choose task kinds by outcome: feature delivers observable product behavior; unit implements a bounded component or change; architecture resolves a structural decision and preserves its rationale and handoff; test supplies focused verification for an identified uncertainty. Give each task concrete acceptance criteria and expected deliverables. Do not invent extra architecture/test tasks or mandatory reviews when the work does not need them.",
          "Every ordinary checks entry is a shell command, never an instruction or explanation. A structured validation profile explicitly advertised by the runtime is also a valid check; preserve its exact prefix and JSON rather than wrapping it in a shell command. For example use 'sh scripts/check-foundation.sh', not 'Run scripts/check-foundation.sh to validate the foundation'. Task checks verify only outputs available when that task and its actual prerequisites finish. An architecture or interface task should verify its deliverables without requiring the future application, packages or tests to exist. Plan-level checks are final whole-goal checks, run once on the integrated result after all tasks finish; do not copy them into every task or require expensive full-product verification at every layer. Empty task checks are acceptable when concrete deliverable evidence is the appropriate verification.",
          "Maximize useful parallel work: establish shared interfaces/contracts in small prerequisite tasks, then give independent implementations disjoint ownership. DependsOn is for actual required outputs, not preferred chronology or artificial phases. Avoid making every task depend on a broad setup task. Declare repository-relative writePaths (files, directories or globs) for likely writes, estimatedMinutes for effort and resources for meaningful CPU/memory needs. Estimates guide scheduling; do not invent precision. Keep verification proportionate; do not require human approval or ceremonies unless the goal's actual policy requires them.",
          "Do not claim implementation or completion. A task may include configured release/deployment actions. Recorded goal completion criteria are authoritative: return their exact text unchanged, including criteria added through user steering. Derive explicit observable goal criteria only when none are recorded. Put implementation-specific requirements in task acceptanceCriteria; routine replanning must not add paraphrased or duplicate goal criteria.",
          context,
          `Current whole-goal check contract: ${JSON.stringify({ revision: this.planRecord(goal.id)?.revision, checks: this.planRecord(goal.id)?.checks ?? [] })}`,
          `Already integrated work: ${JSON.stringify(integrated)}`,
          `Retained unfinished work: ${JSON.stringify(retained)}`,
          "Prior repair guidance belongs to its recorded plan revision. Carry applicable requirements into the new task contracts, resolving obsolete instructions against the current diagnosis and latest retained candidate. Do not replace already accepted implementations merely because an older handoff reported them missing.",
          ...(scope ? [`This is a localized repair. Replace only the affected work above. Preserve these unrelated tasks exactly; their keys may be dependencies but must not be repeated: ${JSON.stringify(preserved.map(task => ({ key: this.taskDetail(task.id).key, title: task.title, status: task.status, dependsOn: task.dependsOn.map(id => this.taskDetail(id).key) })))}`] : []),
          "Do not repeat completed tasks. Their keys may be referenced as dependencies.",
          "Reuse a retained unfinished task's stable key when continuing the same work. Its isolated candidate can seed a replacement workspace; use a new key when the task's purpose changes.",
        ];
      }, { recordReferences: this.options.runtime.controllerRecordReferences, recordRequirements });
      const response = await this.options.runtime.complete({ goal, role: "planner", prompt, project, signal: this.operationControllers.get(goal.id)?.signal, recordRequirements });
      if (!this.operationCurrent(goal.id, operation)) return;
      const plan = readPlan(response.text);
      const preservedKeys = new Set(preserved.map(task => this.taskDetail(task.id).key));
      validateDependencies(plan.tasks, preservedKeys);
      if (plan.tasks.some(task => preservedKeys.has(task.key))) throw new FactoryDecisionError("The planner repeated a preserved task key. Use a new key for improvement work and leave unrelated work unchanged.");
      this.options.store.transaction(() => {
        this.applyTasks(goal.id, plan.tasks, plan.summary, plan.checks, new Set(preserved.map(task => task.id)), this.control(goal.id).replanInstructions);
        const recordedCriteria = this.goal(goal.id).criteria;
        this.writeGoal(goal.id, { criteria: recordedCriteria.length ? recordedCriteria : [...new Set(plan.criteria)], status: "running", error: undefined, nextAction: plan.tasks.length ? "Dispatch work whose dependencies are complete" : "Evaluate existing product evidence" });
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: plan.tasks.length || preserved.some(task => task.status !== "completed") ? "dispatch" : "evaluate", operation: undefined, manualAction: undefined, decisionFailures: undefined, controllerFailures: undefined, replanTaskIds: undefined, replanInstructions: undefined });
        this.decision(goal.id, "plan", plan.summary, { chatId: response.chatId, taskCount: plan.tasks.length, revision: this.goal(goal.id).revision });
      });
      this.changed();
    } catch (error) { this.operationFailed(goal.id, operation, error); }
  }

  private recoverCompletedWork(goal: Goal): void {
    for (const task of this.tasks(goal.id).filter(task => task.status === "review")) {
      if (!task.currentAttemptId || this.busyAttempts.has(task.currentAttemptId) || this.reconciling.has(task.currentAttemptId)) continue;
      const attempt = this.attempt(task.currentAttemptId);
      // Unknown capture/integration effects use the bounded reconciliation lane.
      // Scheduling them here bypasses that lane and creates a microtask retry loop.
      if (attempt.status !== "succeeded") continue;
      if (this.attemptDetail(attempt.id).verificationWait) continue;
      if (goal.status === "paused" && this.attemptDetail(attempt.id).candidate) continue;
      this.busyAttempts.add(attempt.id);
      this.track(this.processResult(attempt, this.attemptDetail(attempt.id).result ?? { status: "succeeded", text: "Recovered retained candidate." }).finally(() => this.busyAttempts.delete(attempt.id)));
    }
  }

  private dispatch(goal: Goal, manageController = true): void {
    if (!this.admit(goal.id)) return;
    const tasks = this.tasks(goal.id).filter(task => task.status !== "canceled").map(task => effectiveTaskExecution(task, goal));
    const failed = tasks.find(task => task.status === "failed" && !this.taskDetail(task.id).waitingFor);
    if (failed && manageController) {
      if (goal.autonomy === "autonomous" || this.taskDetail(failed.id).selected) {
        this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "diagnose", diagnosisTaskId: failed.id });
        this.writeGoal(goal.id, { nextAction: `Diagnose and repair ${failed.title}` }); this.changed();
      }
    }
    if (manageController && !failed && tasks.every(task => task.status === "completed")) {
      this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "evaluate" });
      this.writeGoal(goal.id, { nextAction: goal.autonomy === "manual" ? "Evaluate completion when requested" : "Evaluate the complete goal against current evidence" });
      if (goal.autonomy !== "manual") this.scheduleGoal(goal.id, () => this.evaluate(this.goal(goal.id)));
      this.changed(); return;
    }
    const running = this.activeWork().filter(task => task.goalId === goal.id && !verificationOnlyReservation(task)).length;
    let capacity = Math.max(0, goal.concurrency - running);
    let eligible = 0, placed = 0;
    const verificationWaits: string[] = [], capabilityWaits: string[] = [];
    const stableKeys = new Map(tasks.map(task => [task.id, this.taskDetail(task.id).key]));
    for (const task of sortReadyTasks(tasks, stableKeys)) {
      if (capacity === 0) break;
      // The previous execution can synchronously acquire a setup reservation.
      // Recheck before allocating the next attempt against the same host space.
      if (!this.admit(goal.id)) break;
      const detail = this.taskDetail(task.id);
      if (goal.autonomy !== "autonomous" && !detail.selected) continue;
      if (this.control(goal.id).replanTaskIds?.includes(task.id)) continue;
      if (detail.waitingFor) continue;
      const inputBlocker = taskCheckInputBlocker(detail);
      if (inputBlocker) { verificationWaits.push(task.title); continue; }
      const active = this.activeWork();
      const repository = this.options.project(goal.projectId)?.path ?? goal.projectId;
      const conflicts = active.filter(other => {
        const projectId = this.options.store.get<Goal>(TABLE.goals, other.goalId)?.projectId;
        return projectId !== undefined && (this.options.project(projectId)?.path ?? projectId) === repository;
      });
      const blocker = taskSchedulingBlocker(task, goal, tasks, active, conflicts, this.options.devices());
      if (blocker) {
        if (blocker.kind === "execution-capability") capabilityWaits.push(blocker.reason);
        if (["device-unavailable", "device-capacity", "resource"].includes(blocker.kind)) eligible++;
        continue;
      }
      eligible++;
      const device = this.place(task);
      if (!device) continue;
      const target = selectExecutionTarget(task, device, goal.workspaceProvider ?? "git", goal.runtime);
      if (!target) continue;
      if (this.checkBudget(this.goal(goal.id))) return;
      const attempts = this.options.store.list<Attempt>(TABLE.attempts).filter(item => item.taskId === task.id);
      const attempt: Attempt = { id: randomUUID(), taskId: task.id, generation: Math.max(0, ...attempts.map(item => item.generation)) + 1, deviceId: device.id, executionTargetId: target.id, executionTargetKind: target.kind, status: "created", startedAt: this.now() };
      this.options.store.transaction(() => {
        this.options.store.set(TABLE.attempts, attempt);
        this.options.store.set<AttemptDetail>(TABLE.attemptDetails, { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, assignmentGoalRevision: goal.revision, cancellation: "none", phase: "preparing",
          contract: { title: task.title, description: task.description, kind: task.kind, acceptanceCriteria: task.acceptanceCriteria, expectedOutputs: task.expectedOutputs, estimatedMinutes: task.estimatedMinutes, writePaths: task.writePaths, resources: task.resources, execution: task.execution, quality: task.quality, dependsOn: [...task.dependsOn], checks: this.taskChecks(task.id), planRevision: detail.planRevision } });
        this.writeTask(task.id, { status: "running", currentAttemptId: attempt.id, deviceId: device.id });
        this.decision(goal.id, "dispatch", `Dispatched ${task.title} to ${device.name}.`, { taskId: task.id, attemptId: attempt.id, generation: attempt.generation, deviceId: device.id, executionTargetId: target.id, executionTargetKind: target.kind });
      });
      capacity--; placed++; this.busyAttempts.add(attempt.id);
      this.track(this.execute(attempt).finally(() => this.busyAttempts.delete(attempt.id)));
    }
    if (placed) this.changed();
    else if (capabilityWaits.length && !running && !failed && manageController && !tasks.some(task => task.currentAttemptId && this.attemptDetail(task.currentAttemptId).verificationWait)) this.wait(goal.id, [...new Set(capabilityWaits)].join(" "), "execution-capability");
    else if (verificationWaits.length && !running && !failed) {
      const reason = `Waiting for verification evidence from the coordinator for ${verificationWaits.join("; ")}.`;
      if (this.goal(goal.id).nextAction !== reason) { this.writeGoal(goal.id, { nextAction: reason }); this.changed(); }
    }
    else if (!running && !failed && tasks.some(task => task.currentAttemptId && this.attemptDetail(task.currentAttemptId).verificationWait)) {
      const reason = "Waiting for inspection evidence; successful source authoring remains retained.";
      if (this.goal(goal.id).nextAction !== reason) { this.writeGoal(goal.id, { nextAction: reason }); this.changed(); }
    }
    else if (manageController && !failed && eligible && !running) this.wait(goal.id, goal.workspaceProvider === "artifactfs" ? "Waiting for an online worker with ArtifactFS support and capacity." : "Waiting for an online worker with capacity.", "device-online");
    else if (!running && goal.autonomy !== "autonomous") this.writeGoal(goal.id, { nextAction: "Select the next tasks to execute" });
  }

  private async execute(attempt: Attempt): Promise<void> {
    let executing = false;
    const currentTask = this.task(attempt.taskId), goal = this.goal(currentTask.goalId), project = this.project(goal);
    const frozenContract = this.attemptDetail(attempt.id).contract;
    const task = frozenContract ? { ...currentTask, execution: frozenContract.execution } : currentTask;
    try {
      const retained = this.attemptDetail(attempt.id);
      const workspace = retained.capacityWait === "executing" && retained.workspace ? retained.workspace
        : await this.options.workspaces.prepare({ goal, task, attempt, project, previousCandidate: this.taskDetail(task.id).lastCandidate });
      if (!this.isCurrent(attempt)) return;
      this.options.store.transaction(() => {
        this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), workspace, phase: "executing" as const, capacityWait: undefined });
        this.writeAttempt(attempt.id, { status: "running", baseCommit: workspace.baseCommit, ...(workspace.sessionId ? { sessionId: workspace.sessionId } : {}) });
      });
      executing = true;
      const result = await this.options.runtime.execute({ goal: this.goal(goal.id), task, attempt: this.attempt(attempt.id), workspace, project, prompt: this.executionPrompt(goal, task), assignmentGoalRevision: this.attemptDetail(attempt.id).assignmentGoalRevision ?? this.attemptDetail(attempt.id).goalRevision });
      if (!this.isCurrent(attempt)) return;
      await this.processResult(attempt, result);
    } catch (error) {
      if (!this.isCurrent(attempt)) return;
      if (error instanceof FactoryCapacityError) this.deferExecution(attempt, error.message, executing ? "executing" : "preparing");
      else if (executing) this.markUnknown(attempt, error);
      else this.failAttempt(attempt, error);
    }
    this.changed();
  }

  private async processResult(attemptInput: Attempt, result: ExecutionResult): Promise<void> {
    if (!this.isCurrent(attemptInput)) return;
    // An older owning device may still include its obsolete monetary field.
    const { spend: _legacySpend, ...currentResult } = result as ExecutionResult & { spend?: unknown };
    result = currentResult;
    const attempt = this.attempt(attemptInput.id), task = this.task(attempt.taskId), goal = this.goal(task.goalId), project = this.project(goal);
    const inspectionEventRevision = this.inspectionEventRevision(goal.id);
    if (result.status === "waiting" && result.agentStarted === false && result.wakeCondition === "host-disk-space") {
      this.deferExecution(attempt, result.waitReason || "Waiting for host disk space before provider setup.", "executing"); return;
    }
    this.options.store.transaction(() => {
      const saved = this.attemptDetail(attempt.id);
      this.options.store.set(TABLE.attemptDetails, { ...saved, result });
      this.writeAttempt(attempt.id, { ...(result.chatId ? { chatId: result.chatId } : {}), ...(result.sessionId ? { sessionId: result.sessionId } : {}) });
      if (result.sessionId) this.writeTask(task.id, { sessionId: result.sessionId });
    });
    if (result.status === "unknown") { this.markUnknown(attempt, result.error || "Execution owner could not confirm the result."); return; }
    if (result.status === "waiting") {
      this.writeAttempt(attempt.id, { status: "unknown", error: result.waitReason });
      this.wait(goal.id, result.waitReason || "Worker is waiting for an external condition.", result.wakeCondition || "runtime-available"); return;
    }
    if (result.status === "failed") {
      const retained = this.attemptDetail(attempt.id);
      if (retained.workspace && !retained.candidate) {
        try {
          await this.retainFailedWork(attempt);
        } catch (error) {
          if (!this.isCurrent(attempt)) return;
          this.decision(goal.id, "partial-work-unavailable", "The failed attempt's environment remains preserved, but its candidate could not be captured.", { attemptId: attempt.id, error: this.error(error) });
        }
      }
      if (!this.isCurrent(attempt)) return;
      this.failAttempt(attempt, result.error || result.text || "The runtime reported failure."); return;
    }
    this.writeAttempt(attempt.id, { status: "succeeded", endedAt: attempt.endedAt ?? this.now() });
    this.writeTask(task.id, { status: "review" });
    const detail = this.attemptDetail(attempt.id);
    if (!detail.workspace) { this.markUnknown(attempt, "The recovered execution has no retained workspace reference."); return; }
    try {
      let candidate = detail.candidate;
      if (!candidate) {
        this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), phase: "capturing" as const });
        candidate = await this.options.workspaces.capture(detail.workspace, { goal, task, attempt: this.attempt(attempt.id) });
        if (!this.isCurrent(attempt)) return;
        this.options.store.transaction(() => {
          this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), candidate, phase: "checking" as const });
          this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(task.id), lastCandidate: candidate });
          this.writeAttempt(attempt.id, { candidate: candidate!.commit });
        });
      }
      if (this.goal(goal.id).status === "paused") { this.writeGoal(goal.id, { nextAction: "Candidate retained; integration waits for resume" }); this.changed(); return; }
      const frozenContract = this.attemptDetail(attempt.id).contract;
      const quality = frozenContract ? frozenContract.quality : task.quality;
      if (quality && !this.options.workspaces.qualityChecks) throw new Error("Configured UI acceptance requires the factory's verified inspection adapter. Source is retained; UI acceptance cannot be replaced by shell check success.");
      const checks = [...new Set([...(frozenContract?.checks ?? this.taskChecks(task.id)), ...(quality ? [UI_QUALITY_CHECK_COMMAND] : [])])];
      const verification = { goal: this.goal(goal.id), task: this.task(task.id), attempt: this.attempt(attempt.id), quality };
      let checkResults = this.attemptDetail(attempt.id).checks;
      if (!checkResults) {
        checkResults = await this.options.workspaces.check(project, candidate, checks, verification);
        if (!this.isCurrent(attempt)) return;
        if (checkResults.some(check => check.candidateCommit !== candidate!.commit)) throw new Error("Verification returned evidence for a different candidate.");
        // A real failed check needs repair even when a separate visual receipt is
        // still pending; missing evidence cannot conceal an observed defect.
        const pending = checkResults.every(check => check.passed || check.recovery?.condition === "inspection-evidence")
          ? checkResults.find(check => !check.passed && check.recovery?.condition === "inspection-evidence") : undefined;
        if (pending?.recovery) throw new FactoryVerificationWaitError(pending.recovery.reason);
        this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), checks: checkResults });
      }
      if (checkResults.some(check => !check.passed)) throw new Error(`Candidate checks failed:\n${checkResults.filter(check => !check.passed).map(check => `${check.command}\n${check.output}`).join("\n")}`);
      if (checks.some(command => !checkResults!.some(check => check.command === command))) throw new Error("Verification omitted a configured check.");
      if (quality && !checkResults.some(check => check.command === UI_QUALITY_CHECK_COMMAND && check.passed && check.checkedCommit === candidate.commit)) throw new Error("UI acceptance did not verify the exact saved candidate.");
      if (!this.integrationAllowed(attempt)) { this.changed(); return; }
      this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), phase: "integrating" as const });
      const integration = await this.options.workspaces.integrate(project, candidate, { checks, isCurrent: () => this.integrationAllowed(attempt), verification });
      if (!this.isCurrent(attempt)) return;
      if (integration.candidateCommit !== candidate.commit) throw new Error("Integration reported a different candidate.");
      if (integration.checks.some(check => !check.passed)) throw new Error("The combined repository did not pass its integration checks.");
      if (checks.some(command => !integration.checks.some(check => check.command === command && check.passed))) throw new Error("Integration omitted a required combined-result check.");
      if (quality && !integration.checks.some(check => check.command === UI_QUALITY_CHECK_COMMAND && check.passed && check.candidateCommit === candidate.commit && check.checkedCommit === integration.commit)) throw new Error("UI acceptance did not verify the actual combined integration source.");
      this.options.store.transaction(() => {
        this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), integration, phase: "done" as const, recoveryObservation: undefined });
        this.writeTask(task.id, { status: "completed" });
        this.writeAttempt(attempt.id, { status: "succeeded", endedAt: this.now(), error: undefined });
        this.decision(goal.id, "integrated", `${task.title} integrated at ${integration.commit.slice(0, 12)}.`, { taskId: task.id, attemptId: attempt.id, candidate: candidate.commit, commit: integration.commit, checks: integration.checks });
      });
      if (this.options.workspaces.release) await this.options.workspaces.release(detail.workspace).catch(() => undefined);
    } catch (error) {
      if (this.isCurrent(attempt)) {
        if (error instanceof FactoryVerificationWaitError) {
          const retained = this.attemptDetail(attempt.id);
          const receiptArrived = this.inspectionEventRevision(goal.id) !== inspectionEventRevision;
          this.options.store.set(TABLE.attemptDetails, { ...retained, phase: "checking" as const,
            verificationWait: receiptArrived ? undefined : { condition: "inspection-evidence" as const, reason: error.message, since: retained.verificationWait?.since ?? this.now() } });
          this.writeAttempt(attempt.id, { status: "succeeded", error: undefined });
          this.writeTask(task.id, { status: "review" });
          this.decision(goal.id, receiptArrived ? "verification-recheck" : "verification-waiting", receiptArrived ? "Inspection evidence changed while the check returned; recheck this retained source once." : error.message, { taskId: task.id, attemptId: attempt.id, candidateId: retained.candidate?.id });
        } else if (error instanceof FactoryCapacityError) {
          this.writeTask(task.id, { status: "review" });
          this.capacityWait(goal.id, error.message);
        } else if (this.goal(goal.id).status === "paused") {
          this.writeTask(task.id, { status: "review" });
          this.writeGoal(goal.id, { nextAction: "Candidate retained; integration waits for resume" });
        } else if (["capturing", "integrating"].includes(this.attemptDetail(attempt.id).phase) && !(error instanceof FactoryOperationError)) this.markUnknown(attempt, error);
        else this.failAttempt(attempt, error);
      }
    }
    this.changed();
  }

  private async reconcileAttempt(attempt: Attempt): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    const storedTask = this.task(attempt.taskId), goal = this.goal(storedTask.goalId), detail = this.attemptDetail(attempt.id);
    const task = detail.contract ? { ...storedTask, execution: detail.contract.execution } : storedTask;
    if (!this.options.devices().some(device => device.id === attempt.deviceId && device.online)) {
      if (attempt.status !== "unknown") this.markUnknown(attempt, "The owning device is offline; termination is not known.");
      return;
    }
    try {
      if (detail.phase === "integrating" && detail.candidate && this.options.workspaces.reconcileIntegration) {
        const integrated = await this.options.workspaces.reconcileIntegration(this.project(goal), detail.candidate);
        if (!this.isCurrent(attempt)) return;
        if (integrated) {
          const quality = detail.contract ? detail.contract.quality : task.quality;
          if (quality && (!this.options.workspaces.qualityChecks || !integrated.checks.some(check => check.command === UI_QUALITY_CHECK_COMMAND && check.passed && check.candidateCommit === detail.candidate!.commit && check.checkedCommit === integrated.commit))) throw new Error("Recovered integration has no verified UI acceptance for its actual source. Preserve the outcome and reconcile its evidence before accepting the task.");
          this.options.store.transaction(() => {
            this.options.store.set(TABLE.attemptDetails, { ...detail, integration: integrated, phase: "done" as const, recoveryObservation: undefined });
            this.writeAttempt(attempt.id, { status: "succeeded", endedAt: this.now() });
            this.writeTask(task.id, { status: "completed" });
            this.decision(goal.id, "integration-recovered", "The exact candidate was already integrated before the coordinator restarted.", { attemptId: attempt.id, commit: integrated.commit });
          });
          this.changed(); return;
        }
      }
      if (["capturing", "checking", "integrating"].includes(detail.phase) && detail.result?.status === "succeeded") {
        if (detail.recoveryObservation?.phase === detail.phase && Date.parse(detail.recoveryObservation.retryAt) > Date.parse(this.now())) return;
        await this.processResult(attempt, detail.result); return;
      }
      const report = await this.options.runtime.reconcile(attempt);
      if (!this.isCurrent(attempt)) return;
      if (report.status === "unknown") {
        if (attempt.status !== "unknown") this.markUnknown(attempt, "The owner has not confirmed the execution outcome."); return;
      }
      if (report.status === "running") {
        if (detail.recoveryObservation) this.options.store.set(TABLE.attemptDetails, { ...detail, recoveryObservation: undefined });
        this.writeAttempt(attempt.id, { status: "running", error: undefined });
        this.recoveredExecutionProgress(attempt, task);
        if (attempt.status !== "running") this.changed();
        return;
      }
      if (report.status === "prepared") {
        const workspace = report.workspace ?? detail.workspace;
        if (!workspace) { this.markUnknown(attempt, "The owner reports preparation but has not returned its workspace reference."); return; }
        const currentGoal = this.goal(goal.id);
        const suspended = ["paused", "waiting", "draft"].includes(currentGoal.status) || this.checkBudget(currentGoal);
        this.options.store.transaction(() => {
          this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), workspace, phase: suspended ? "preparing" as const : "executing" as const });
          this.writeAttempt(attempt.id, { status: suspended ? "created" : "running", baseCommit: workspace.baseCommit, ...(workspace.sessionId ? { sessionId: workspace.sessionId } : {}) });
          if (!detail.workspace || !suspended) this.decision(goal.id, "preparation-recovered", suspended ? "The owner confirmed a prepared workspace. It remains retained until goal execution resumes." : "The owner confirmed a prepared workspace without prior execution. Continue the same attempt and generation.", { attemptId: attempt.id });
        });
        if (suspended) { this.changed(); return; }
        this.recoveredExecutionProgress(attempt, task);
        this.changed();
        const result = await this.options.runtime.execute({ goal: this.goal(goal.id), task, attempt: this.attempt(attempt.id), workspace, project: this.project(goal), prompt: this.executionPrompt(goal, task), assignmentGoalRevision: this.attemptDetail(attempt.id).assignmentGoalRevision ?? this.attemptDetail(attempt.id).goalRevision });
        if (this.isCurrent(attempt)) await this.processResult(attempt, result);
        return;
      }
      if (report.status === "succeeded" && !report.result) {
        this.markUnknown(attempt, "The owner confirmed termination but has not returned its journaled result."); return;
      }
      await this.processResult(attempt, report.result ?? { status: "failed", text: "The owning device confirmed execution failure." });
    } catch (error) {
      // An observation error never authorizes replacement. A recovered start can also lose its acknowledgement.
      if (this.isCurrent(attempt) && this.attempt(attempt.id).status !== "unknown") this.markUnknown(attempt, error);
    }
    this.changed();
  }

  private recoveredExecutionProgress(attempt: Attempt, task: FactoryTask): void {
    const goal = this.goal(task.goalId);
    if (attempt.status !== "unknown" && !goal.nextAction?.startsWith("Reconcile ")) return;
    if (goal.status !== "running" || this.control(goal.id).stage !== "dispatch") return;
    if (this.attempts(goal.id).some(other => other.status === "unknown")) return;
    this.writeGoal(goal.id, { nextAction: `Executing ${task.title}` });
    this.changed();
  }

  private async diagnose(goal: Goal): Promise<void> {
    const operation = this.beginOperation(goal, "diagnosis"), control = this.control(goal.id);
    const taskId = control.diagnosisTaskId;
    if (!taskId) { this.operationFailed(goal.id, operation, new Error("Diagnosis has no task reference.")); return; }
    const task = this.task(taskId), attempt = task.currentAttemptId ? this.attempt(task.currentAttemptId) : undefined;
    const diagnosisCurrent = () => this.operationCurrent(goal.id, operation) && (!attempt || (this.isCurrent(attempt) && this.attempt(attempt.id).status === "failed"));
    try {
      if (attempt && attempt.status !== "failed") throw new FactoryControllerError("The attempt's failure is not confirmed. Reconcile its owner before preparing recovery.", "controller-retry-required");
      if (attempt) await this.retainFailedWork(attempt, diagnosisCurrent);
      if (!diagnosisCurrent()) return;
      const detail = this.taskDetail(taskId);
      const repeated = detail.failureSignatures.length >= 3 && new Set(detail.failureSignatures.slice(-3)).size === 1;
      const recordRequirements: ControllerRecordRequirement[] = [];
      const prompt = controllerPrompt(evidence => [
        "You are the EnoughFactory repair supervisor. Decide the next concrete action after a confirmed failure. Return JSON {action:'retry'|'replan'|'wait',reason:string,instructions?:string,waitReason?:string,wakeCondition?:string}.",
        "Retry must change the implementation approach or address the observed failure. Replan changes task decomposition or dependencies. Wait only for an identified external condition; do not ask for human permission already granted by project policy.",
        "If a configured check is prose rather than an executable command, or requires future task outputs unrelated to this task's contract, replan to correct the verification scope. Do not make a worker fabricate missing future application layers or repeat unchanged invalid commands. Retain useful candidate work and keep checks proportionate to the task's actual deliverables.",
        repeated ? "Three equivalent failures occurred. Choose a changed decomposition or external wait rather than repeating the same attempt." : "Make a proportionate repair decision and continue.",
        this.context(goal, evidence), `Failed task: ${JSON.stringify(evidence.task(task, detail))}`, `Failure: ${JSON.stringify(evidence.text(detail.lastError, `${TABLE.taskDetails}/${task.id}.lastError`, 8192))}`, `Retained work: ${JSON.stringify(evidence.candidate(detail.lastCandidate))}`, `Attempt evidence: ${JSON.stringify(evidence.attempt(attempt, attempt ? this.attemptDetail(attempt.id) : undefined))}`,
      ], { recordReferences: this.options.runtime.controllerRecordReferences, recordRequirements });
      const response = await this.options.runtime.complete({ goal, role: "diagnosis", prompt, project: this.project(goal), signal: this.operationControllers.get(goal.id)?.signal, recordRequirements });
      if (!diagnosisCurrent()) return;
      const decision = readJsonObject(response.text);
      if (!["retry", "replan", "wait"].includes(String(decision.action)) || typeof decision.reason !== "string" || !decision.reason.trim()) throw new FactoryDecisionError("Repair decision must specify retry, replan or wait and a reason.");
      if (repeated && decision.action === "retry") decision.action = "replan";
      this.options.store.set(TABLE.control, { ...this.control(goal.id), decisionFailures: undefined, controllerFailures: undefined });
      this.decision(goal.id, "repair", decision.reason, { action: decision.action, taskId, chatId: response.chatId, ...(typeof decision.instructions === "string" ? { instructions: decision.instructions } : {}) });
      if (decision.action === "wait") {
        this.options.store.transaction(() => {
          this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(taskId), waitingFor: typeof decision.wakeCondition === "string" ? decision.wakeCondition : "external-condition", waitReason: typeof decision.waitReason === "string" ? decision.waitReason : decision.reason, waitSince: this.now() });
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "dispatch", operation: undefined, diagnosisTaskId: undefined });
          this.writeGoal(goal.id, { nextAction: `Waiting for ${task.title}; independent work can continue` });
        });
      } else if (decision.action === "replan") {
        await this.replan(goal.id, decision.reason, taskId, typeof decision.instructions === "string" ? decision.instructions : undefined);
      } else {
        this.options.store.transaction(() => {
          this.writeTask(taskId, { status: "queued", currentAttemptId: undefined });
          this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(taskId), repairInstructions: typeof decision.instructions === "string" ? decision.instructions : decision.reason });
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "dispatch", operation: undefined, diagnosisTaskId: undefined });
          this.writeGoal(goal.id, { status: "running", error: undefined, nextAction: `Run the revised approach for ${task.title}` });
        });
      }
      this.changed();
    } catch (error) { this.operationFailed(goal.id, operation, error); }
  }

  /** Retention is evidence of source only; a confirmed failure stays failed and unchecked. */
  private async retainFailedWork(attempt: Attempt, canRetain = () => this.isCurrent(attempt)): Promise<void> {
    if (!canRetain()) return;
    const detail = this.attemptDetail(attempt.id), current = this.attempt(attempt.id);
    if (!detail.workspace || detail.candidate || (current.status !== "failed" && detail.result?.status !== "failed")) return;
    const task = this.task(attempt.taskId), goal = this.goal(task.goalId);
    let candidate: CandidateRef;
    try { candidate = await this.options.workspaces.capture(detail.workspace, { goal, task, attempt: current }); }
    catch (error) {
      throw new FactoryControllerError(`The failed attempt's partial work could not be saved. Its original environment is preserved. Resolve the storage or runtime problem, then retry recovery. ${this.error(error)}`, "controller-retry-required", { cause: error });
    }
    if (!canRetain() || this.attemptDetail(attempt.id).candidate) return;
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), candidate });
      this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(task.id), lastCandidate: candidate });
      this.writeAttempt(attempt.id, { candidate: candidate.commit });
      this.decision(goal.id, "partial-work-retained", "Useful source from the confirmed failed turn was retained for its repair attempt.", { attemptId: attempt.id, candidate: candidate.commit });
    });
  }

  private async evaluate(goal: Goal): Promise<void> {
    if (this.tasks(goal.id).some(task => !["completed", "canceled"].includes(task.status))) return;
    const operation = this.beginOperation(goal, "evaluator"), project = this.project(goal);
    try {
      const repository = await this.options.workspaces.inspect(project);
      if (!this.operationCurrent(goal.id, operation)) return;
      let commands: string[];
      try { commands = readCheckCommands(this.planRecord(goal.id)?.checks, "Goal checks"); }
      catch (error) {
        if (!(error instanceof FactoryDecisionError)) throw error;
        await this.replan(goal.id, `Correct the goal verification contract. ${this.error(error)}`);
        return;
      }
      let goalChecks: GoalCheckRecord | undefined;
      if (commands.length) {
        const receiptId = this.goalCheckReceiptId(goal, repository, commands);
        goalChecks = repository.fingerprint ? this.options.store.get<GoalCheckRecord>(TABLE.goalChecks, receiptId) : undefined;
        if (!goalChecks) {
          if (!this.options.workspaces.checkGoal) throw new Error("This workspace provider cannot verify the final goal snapshot. Configure goal verification before accepting completion.");
          this.writeGoal(goal.id, { nextAction: "Verify the integrated goal result" }); this.changed();
          const report = await this.options.workspaces.checkGoal(project, commands, goal);
          if (!this.operationCurrent(goal.id, operation)) return;
          if (report.checks.every(check => check.passed) && commands.some(command => !report.checks.some(check => check.command === command))) throw new Error("Goal verification omitted a configured executable check.");
          goalChecks = { id: this.goalCheckReceiptId(goal, report.repository, commands), goalId: goal.id, revision: goal.revision, at: this.now(), repository: report.repository, commands, checks: report.checks };
          this.options.store.set(TABLE.goalChecks, goalChecks);
          this.decision(goal.id, "goal-checks", report.checks.every(check => check.passed) ? "The integrated goal snapshot passed its configured checks." : "The integrated goal snapshot failed a configured check; evaluate the retained failure evidence and repair the goal.", { receiptId: goalChecks.id, head: report.repository.head, checks: report.checks });
        }
        const afterChecks = await this.options.workspaces.inspect(project);
        if (!this.operationCurrent(goal.id, operation)) return;
        if (!this.sameRepository(repository, goalChecks.repository) || !this.sameRepository(repository, afterChecks)) {
          this.options.store.set(TABLE.control, { ...this.control(goal.id), operation: undefined, stage: "evaluate" });
          this.decision(goal.id, "goal-checks-stale", "The repository inputs changed during goal verification. Verify the current snapshot before accepting completion.");
          this.changed(); return;
        }
      }
      const goalChecksPassed = !goalChecks || goalChecks.checks.every(check => check.passed);
      const recordRequirements: ControllerRecordRequirement[] = [];
      const prompt = controllerPrompt(evidence => [
        "You are the EnoughFactory completion evaluator. Audit the entire original objective against the actual repository and retained execution evidence. A worker's final response, green unrelated tests or partial implementation do not prove completion.",
        "Inspect/run only meaningful checks needed for uncertain criteria. Return JSON {complete:boolean,summary:string,criteria:[{criterion:string,satisfied:boolean,evidence:string[]}],additionalTasks?:[{key,title,description,kind:'feature'|'unit'|'architecture'|'test',acceptanceCriteria:string[],expectedOutputs:string[],dependsOn:string[],checks:string[],requiredCheckEnvironment?:string[],execution?:{target?:'auto'|'container'|'host-macos',requiredCapabilities?:string[],delegatedCapabilities?:string[]},quality?:{platforms:('web'|'macos'|'ios-simulator')[],workflows:[{id,platform}],referenceIds:string[]}}],waitReason?:string,wakeCondition?:string}. Use task kinds for concrete delivery outcomes, not mandatory role ceremonies. Tasks needing independently supplied verification inputs must declare the supported requiredCheckEnvironment names; a prose prerequisite does not gate dispatch. Select author requirements and delegated tools from the execution inventory; absence of native or visual support cannot be replaced by portable test success.",
        "Use each criterion's exact original text. Every satisfied criterion requires concrete current-state evidence such as files, runtime outcomes, exact commit check records or published URLs. If something remains, add actionable tasks. Never weaken the objective to declare completion. No mandatory human gate applies to autonomous plus approve-all.",
        "Also inspect the accepted tasks' acceptance criteria and expected deliverables. Integration records prove accepted source, not that every requested behavior or deliverable exists. Add concrete follow-up work for any unmet contract that matters to the original objective.",
        "The current integrated primary repository and attached current project folders are the sources for the final product audit. Historical candidate IDs and CAS references identify retained source; their bodies are optional evidence and are not automatically transferred for evaluation. Use the mounted manifest to determine actual available files. Never claim to have inspected a historical candidate body merely from its identity or integration record.",
        "Configured whole-goal checks have already run against the exact integrated snapshot. Do not repeat them merely to restate the evidence. A failed configured check prevents completion: use its concrete command/output to propose focused repair tasks. Checks on a future repaired snapshot will run once after that work integrates. Every additional task check must be an executable shell command scoped to outputs available at that task's completion, never prose or an unrelated whole-product gate.",
        `Whole-goal check evidence: ${JSON.stringify(evidence.goalChecks(goalChecks))}`,
        this.context(goal, evidence), `Repository snapshot: ${JSON.stringify(evidence.repository(repository, `goal/${goal.id}/repository/${repository.head}`))}`,
        `Integrated work and check records: ${JSON.stringify(this.tasks(goal.id).filter(task => task.status === "completed").map(task => ({
          ...evidence.task(task, this.taskDetail(task.id)), attempt: evidence.attempt(this.options.store.get<Attempt>(TABLE.attempts, task.currentAttemptId ?? ""), task.currentAttemptId ? this.attemptDetail(task.currentAttemptId) : undefined),
        })))}`,
      ], { recordReferences: this.options.runtime.controllerRecordReferences, recordRequirements });
      const response = await this.options.runtime.complete({ goal, role: "evaluator", prompt, project, signal: this.operationControllers.get(goal.id)?.signal, recordRequirements });
      if (!this.operationCurrent(goal.id, operation)) return;
      const evaluation = readEvaluation(response.text);
      const after = await this.options.workspaces.inspect(project);
      if (!this.operationCurrent(goal.id, operation)) return;
      if (after.head !== repository.head || after.status !== repository.status || after.fingerprint !== repository.fingerprint || after.diff !== repository.diff) {
        this.options.store.set(TABLE.control, { ...this.control(goal.id), operation: undefined, stage: "evaluate" });
        this.decision(goal.id, "evaluation-stale", "The repository changed during evaluation. Evaluate the current result before accepting completion.");
        this.changed(); return;
      }
      const record: EvaluationRecord = { id: randomUUID(), goalId: goal.id, revision: goal.revision, at: this.now(), head: after.head, evaluation, ...(goalChecks ? { goalChecks } : {}) };
      this.options.store.set(TABLE.evaluations, record);
      const required = this.goal(goal.id).criteria;
      const allSatisfied = required.length > 0 && required.every(criterion => {
        const entry = evaluation.criteria.find(item => item.criterion === criterion);
        return entry?.satisfied && entry.evidence.length > 0;
      });
      const extra = evaluation.additionalTasks ?? [];
      if (extra.length) {
        const completedKeys = new Set(this.tasks(goal.id).filter(task => task.status === "completed").map(task => this.taskDetail(task.id).key));
        validateDependencies(extra, completedKeys);
        if (extra.some(task => completedKeys.has(task.key))) throw new FactoryDecisionError("Evaluation reused a completed task key for unfinished work.");
      }
      this.options.store.set(TABLE.control, { ...this.control(goal.id), decisionFailures: undefined, controllerFailures: undefined });
      if (evaluation.complete && allSatisfied && goalChecksPassed && !extra.length && !this.tasks(goal.id).some(task => !["completed", "canceled"].includes(task.status))) {
        this.options.store.transaction(() => {
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "done", operation: undefined, manualAction: undefined });
          this.writeGoal(goal.id, { status: "completed", nextAction: "Completion criteria satisfied", error: undefined });
          this.decision(goal.id, "completed", evaluation.summary, { evaluationId: record.id, head: after.head, criteria: evaluation.criteria });
        });
      } else if (extra.length) {
        this.options.store.transaction(() => {
          this.writeGoal(goal.id, { revision: this.goal(goal.id).revision + 1, status: "running", nextAction: "Address the remaining acceptance work" });
          this.applyTasks(goal.id, extra, evaluation.summary, this.planRecord(goal.id)?.checks ?? []);
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "dispatch", operation: undefined, manualAction: undefined });
          this.decision(goal.id, "evaluation-follow-up", evaluation.summary, { evaluationId: record.id, tasks: extra.map(task => task.key) });
        });
      } else if (evaluation.waitReason) {
        this.options.store.set(TABLE.control, { ...this.control(goal.id), operation: undefined });
        this.wait(goal.id, evaluation.waitReason, evaluation.wakeCondition ?? "external-condition");
      } else {
        this.decision(goal.id, "evaluation-incomplete", evaluation.summary || "Completion lacked evidence for all criteria.", { evaluationId: record.id, required });
        const failedChecks = goalChecksPassed ? "" : `Failed goal checks (all receipt outcomes retained for exact record indexes):\n${JSON.stringify(new ControllerEvidence().goalChecks(goalChecks))}`;
        await this.replan(goal.id, `Completion remains unproven. ${evaluation.summary}\nUnsatisfied criteria: ${required.filter(criterion => !evaluation.criteria.some(item => item.criterion === criterion && item.satisfied && item.evidence.length)).join("; ")}\n${failedChecks}`);
      }
      this.changed();
    } catch (error) { this.operationFailed(goal.id, operation, error); }
  }

  private applyTasks(goalId: string, tasks: PlannedTask[], summary: string, checks: string[], preserveTaskIds = new Set<string>(), replanInstructions?: string): void {
    const goal = this.goal(goalId), at = this.now(), all = this.tasks(goalId);
    const existing = all.filter(task => task.status === "completed" || preserveTaskIds.has(task.id));
    const previousPlan = this.planRecord(goalId), previousPlanChecks = previousPlan?.checkScope === "goal" ? [] : previousPlan?.checks ?? [];
    for (const task of existing) {
      const detail = this.taskDetail(task.id);
      if (detail.planChecks === undefined) this.options.store.set(TABLE.taskDetails, { ...detail, planChecks: previousPlanChecks });
    }
    const retained = new Map(all.filter(task => task.status !== "completed").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map(task => [this.taskDetail(task.id).key, task]));
    const taskKeys = Object.fromEntries(existing.map(task => [this.taskDetail(task.id).key, task.id]));
    for (const task of tasks) taskKeys[task.key] = retained.get(task.key)?.id ?? randomUUID();
    for (const task of tasks) {
      const id = taskKeys[task.key]!, previous = retained.get(task.key), previousDetail = previous ? this.taskDetail(previous.id) : undefined;
      const waiting = !!previousDetail?.waitingFor;
      const supersededRepair = previousDetail?.repairInstructions && previousDetail.planRevision !== goal.revision;
      const priorRepairInstructions = supersededRepair ? [...previousDetail.priorRepairInstructions ?? [], {
        instructions: previousDetail.repairInstructions!, planRevision: previousDetail.planRevision,
        ...(previousDetail.lastCandidate ? { retainedCandidateId: previousDetail.lastCandidate.id, retainedCandidateCommit: previousDetail.lastCandidate.commit } : {}),
      }] : previousDetail?.priorRepairInstructions;
      this.options.store.set<FactoryTask>(TABLE.tasks, { id, goalId, title: task.title, description: task.description, dependsOn: task.dependsOn.map(key => taskKeys[key]!), status: waiting ? "failed" : "queued", createdAt: previous?.createdAt ?? at, updatedAt: at, ...(task.deviceId ? { deviceId: task.deviceId } : {}),
        ...(waiting && previous ? { currentAttemptId: previous.currentAttemptId, sessionId: previous.sessionId, deviceId: previous.deviceId } : {}),
        ...(task.kind ?? previous?.kind ? { kind: task.kind ?? previous?.kind } : {}),
        ...(task.acceptanceCriteria ?? previous?.acceptanceCriteria ? { acceptanceCriteria: task.acceptanceCriteria ?? previous?.acceptanceCriteria } : {}),
        ...(task.expectedOutputs ?? previous?.expectedOutputs ? { expectedOutputs: task.expectedOutputs ?? previous?.expectedOutputs } : {}),
        ...(task.estimatedMinutes ?? previous?.estimatedMinutes ? { estimatedMinutes: task.estimatedMinutes ?? previous?.estimatedMinutes } : {}),
        ...(task.writePaths ?? previous?.writePaths ? { writePaths: task.writePaths ?? previous?.writePaths } : {}),
        ...(task.resources ?? previous?.resources ? { resources: task.resources ?? previous?.resources } : {}),
        ...(task.execution ?? previous?.execution ? { execution: task.execution ?? previous?.execution } : {}),
        ...(task.quality ?? previous?.quality ? { quality: task.quality ?? previous?.quality } : {}) });
      this.options.store.set<TaskDetail>(TABLE.taskDetails, { ...previousDetail, id, key: task.key, checks: task.checks, planChecks: [], planRevision: goal.revision, waitingFor: waiting ? previousDetail.waitingFor : undefined, waitReason: waiting ? previousDetail.waitReason : undefined, waitSince: waiting ? previousDetail.waitSince : undefined,
        requiredCheckEnvironment: task.requiredCheckEnvironment ?? previousDetail?.requiredCheckEnvironment,
        repairInstructions: supersededRepair ? undefined : previousDetail?.repairInstructions, priorRepairInstructions, replanInstructions, selected: goal.autonomy === "autonomous", failureSignatures: previousDetail?.failureSignatures ?? [] });
    }
    this.options.store.set<PlanRecord>(TABLE.plans, { id: goalId, goalId, revision: goal.revision, summary, checks, checkScope: "goal", taskKeys, createdAt: at });
  }

  private async replan(goalId: string, reason: string, failedTaskId?: string, instructions?: string): Promise<void> {
    const goal = this.goal(goalId), tasks = this.tasks(goalId);
    const scope = failedTaskId ? new Set([failedTaskId, ...descendants(tasks, [failedTaskId])]) : undefined;
    const affected = tasks.filter(task => task.status !== "completed" && (!scope || scope.has(task.id)));
    const attempts = this.attempts(goalId).filter(attempt => (activeAttempts.has(attempt.status) || this.task(attempt.taskId).status === "review") && (!scope || scope.has(attempt.taskId)));
    this.options.store.transaction(() => {
      this.writeGoal(goalId, { revision: goal.revision + 1, status: "planning", nextAction: "Revise the plan from retained evidence" });
      this.options.store.set(TABLE.control, { ...this.control(goalId), stage: "plan", operation: undefined, replanReason: reason, replanInstructions: instructions?.trim() || undefined, diagnosisTaskId: undefined, replanTaskIds: scope ? affected.map(task => task.id) : undefined, waitingFor: undefined, waitReason: undefined, wakeAt: undefined, controllerFailures: undefined });
      for (const task of affected) this.writeTask(task.id, { status: "canceled" });
      for (const attempt of attempts) this.revoke(attempt);
      if (scope) {
        for (const attempt of this.attempts(goalId).filter(attempt => !scope.has(attempt.taskId) && this.task(attempt.taskId).currentAttemptId === attempt.id && attempt.status !== "retired")) {
          const detail = this.attemptDetail(attempt.id);
          this.options.store.set(TABLE.attemptDetails, { ...detail, assignmentGoalRevision: detail.assignmentGoalRevision ?? detail.goalRevision, goalRevision: goal.revision + 1 });
        }
      }
      this.decision(goalId, "replan", reason, { taskIds: affected.map(task => task.id), preservedTaskIds: scope ? tasks.filter(task => !scope.has(task.id) && task.status !== "canceled").map(task => task.id) : [] });
    });
    this.operationControllers.get(goalId)?.abort();
    this.changed(); await Promise.allSettled(attempts.map(attempt => this.acknowledgeCancel(attempt)));
  }

  private beginOperation(goal: Goal, kind: "planner" | "evaluator" | "diagnosis"): string {
    const id = randomUUID();
    this.operationControllers.get(goal.id)?.abort();
    this.operationControllers.set(goal.id, new AbortController());
    this.options.store.set(TABLE.control, { ...this.control(goal.id), operation: { id, revision: goal.revision, kind, inspectionEventRevision: this.inspectionEventRevision(goal.id) } });
    return id;
  }
  private operationCurrent(goalId: string, id: string): boolean {
    const goal = this.goal(goalId), operation = this.control(goalId).operation;
    return !this.shuttingDown && !!operation && operation.id === id && operation.revision === goal.revision && !terminalGoals.has(goal.status) && goal.status !== "paused";
  }
  private operationFailed(goalId: string, id: string, error: unknown): void {
    if (!this.operationCurrent(goalId, id)) return;
    this.options.store.transaction(() => {
      const control = this.control(goalId);
      if (error instanceof FactoryControllerError && error.recovery === "inspection-evidence") {
        const receiptArrived = control.operation?.inspectionEventRevision !== undefined && control.operation.inspectionEventRevision !== this.inspectionEventRevision(goalId);
        this.options.store.set(TABLE.control, { ...control, operation: undefined, wakeAt: undefined,
          waitingFor: receiptArrived ? undefined : "inspection-evidence", waitReason: receiptArrived ? undefined : this.error(error) });
        if (receiptArrived) {
          this.writeGoal(goalId, { status: control.stage === "plan" ? "planning" : "running", error: undefined, nextAction: "Inspection evidence changed; continue the retained controller review" });
          this.decision(goalId, "controller-inspection-recheck", "Inspection evidence changed while its controller wait was returning; continue the same review.");
        } else if (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length)) {
          this.writeGoal(goalId, { status: "running", nextAction: "Controller review waits for inspection evidence; independent work can continue" });
          this.decision(goalId, "controller-inspection-waiting", this.error(error));
        } else {
          // Let wait() persist the visible state while preserving stage/manualAction
          // and the unchanged preparation-failure budget.
          this.wait(goalId, this.error(error), "inspection-evidence");
        }
        this.changed(); return;
      }
      if (error instanceof FactoryDecisionError) {
        const signature = createHash("sha256").update(this.error(error)).digest("hex");
        const count = (control.decisionFailures?.count ?? 0) + 1;
        this.options.store.set(TABLE.control, { ...control, operation: undefined, decisionFailures: { signature, count }, replanReason: `${control.replanReason ?? ""}\nThe previous structured decision was rejected: ${this.error(error)}\nReturn the requested JSON schema exactly and correct that failure.` });
        this.decision(goalId, "decision-repair", `The factory is correcting an invalid structured decision: ${this.error(error)}`, { count });
        if (count < 3) { this.writeGoal(goalId, { nextAction: "Correct the structured factory decision", error: undefined }); this.changed(); return; }
      }
      const operation = control.operation!;
      const previous = control.controllerFailures;
      const count = (previous?.revision === operation.revision && previous.kind === operation.kind ? previous.count : 0) + 1;
      const delay = error instanceof FactoryControllerError && error.recovery === "retry" ? controllerRetryDelays[count - 1] : undefined;
      const condition = delay !== undefined ? "controller-retry" : error instanceof FactoryCapacityError ? error.condition : error instanceof FactoryControllerError && error.recovery !== "retry" ? error.recovery : "controller-retry-required";
      const reason = delay !== undefined ? `${this.error(error)} Retry ${count}/${controllerRetryDelays.length} is scheduled after preparation backoff.` : this.error(error);
      this.options.store.set(TABLE.control, { ...this.control(goalId), operation: undefined,
        controllerFailures: { revision: operation.revision, kind: operation.kind, count },
        wakeAt: delay === undefined ? undefined : new Date(Date.parse(this.now()) + delay).toISOString(),
      });
      this.decision(goalId, "controller-error", this.error(error));
      if (delay !== undefined) this.decision(goalId, "controller-retry-scheduled", reason, { count, wakeAt: this.control(goalId).wakeAt });
      if (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length)) {
        this.options.store.set(TABLE.control, { ...this.control(goalId), waitingFor: condition, waitReason: reason });
        this.writeGoal(goalId, { status: "running", nextAction: delay !== undefined ? "Repair controller will retry preparation; independent work can continue" : "Repair controller is waiting; independent work can continue" });
        this.changed();
      } else this.wait(goalId, reason, condition, this.control(goalId).wakeAt);
    });
  }
  private isCurrent(attempt: Attempt): boolean {
    const stored = this.options.store.get<Attempt>(TABLE.attempts, attempt.id), task = this.options.store.get<FactoryTask>(TABLE.tasks, attempt.taskId);
    if (!stored || !task || task.currentAttemptId !== attempt.id || stored.generation !== attempt.generation || stored.status === "retired") return false;
    const goal = this.options.store.get<Goal>(TABLE.goals, task.goalId), detail = this.options.store.get<AttemptDetail>(TABLE.attemptDetails, attempt.id);
    return !!goal && !!detail && detail.goalRevision === goal.revision && !terminalGoals.has(goal.status) && task.status !== "canceled";
  }
  private integrationAllowed(attempt: Attempt): boolean { return this.isCurrent(attempt) && this.goal(this.task(attempt.taskId).goalId).status !== "paused"; }
  private revoke(attempt: Attempt): void {
    this.writeAttempt(attempt.id, { status: "retired" });
    this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), cancellation: "requested" as const });
  }
  private async acknowledgeCancel(attempt: Attempt): Promise<void> {
    const existing = this.cancellations.get(attempt.id);
    if (existing) return existing;
    const operation = this.observeCancellation(attempt).finally(() => this.cancellations.delete(attempt.id));
    this.cancellations.set(attempt.id, operation);
    await operation;
  }
  private async observeCancellation(attempt: Attempt): Promise<void> {
    const goalId = this.task(attempt.taskId).goalId;
    try {
      await this.options.runtime.cancel(attempt);
      this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), cancellation: "acknowledged" as const });
      this.writeAttempt(attempt.id, { endedAt: this.now() });
      this.decision(goalId, "cancellation-acknowledged", "The owning runtime acknowledged termination.", { attemptId: attempt.id });
    } catch (error) {
      this.decision(goalId, "cancellation-unconfirmed", "Authority is revoked; runtime termination remains unconfirmed.", { attemptId: attempt.id, error: this.error(error) });
    }
    this.changed();
  }
  private markUnknown(attempt: Attempt, error: unknown): void {
    const reason = this.error(error), detail = this.attemptDetail(attempt.id), prior = detail.recoveryObservation;
    const repeated = prior?.phase === detail.phase && prior.reason === reason;
    const failures = repeated ? prior.failures + 1 : 1;
    this.options.store.set(TABLE.attemptDetails, { ...detail, recoveryObservation: { phase: detail.phase, reason, failures,
      retryAt: new Date(Date.parse(this.now()) + controllerRetryDelays[Math.min(failures - 1, controllerRetryDelays.length - 1)]!).toISOString() } });
    this.lastObservation.set(attempt.id, Date.parse(this.now()));
    this.writeAttempt(attempt.id, { status: "unknown", error: reason });
    const goalId = this.task(attempt.taskId).goalId;
    this.writeGoal(goalId, { nextAction: "Reconcile the owner and its effect journal before retrying" });
    if (!repeated) this.decision(goalId, "execution-unknown", reason, { attemptId: attempt.id });
    this.changed();
  }
  private failAttempt(attempt: Attempt, error: unknown): void {
    const task = this.task(attempt.taskId), detail = this.taskDetail(task.id), text = this.error(error);
    const signature = createHash("sha256").update(text.replace(/[a-f0-9]{12,}/gi, "<id>").replace(/\d+/g, "<n>")).digest("hex");
    this.options.store.transaction(() => {
      this.writeAttempt(attempt.id, { status: "failed", error: text, endedAt: this.now() });
      this.writeTask(task.id, { status: "failed" });
      this.options.store.set(TABLE.taskDetails, { ...detail, lastError: text, failureSignatures: [...detail.failureSignatures, signature] });
      this.decision(task.goalId, "attempt-failed", text, { attemptId: attempt.id, taskId: task.id });
      this.writeGoal(task.goalId, { nextAction: `Diagnose the confirmed failure in ${task.title}` });
    }); this.changed();
  }
  private place(task: FactoryTask) {
    task = effectiveTaskExecution(task, this.goal(task.goalId));
    const load = this.activeWork();
    const provider = this.goal(task.goalId).workspaceProvider ?? 'git';
    const runtime = this.goal(task.goalId).runtime;
    const devices = this.options.devices();
    if (taskCapabilityBlocker(task, devices, undefined, provider, runtime)) return undefined;
    const utilization = (device: typeof devices[number]) => {
      const target = selectExecutionTarget(task, device, provider, runtime)!;
      const active = load.filter(item => !verificationOnlyReservation(item) && item.deviceId === device.id && ((item as FactoryTask & Pick<Attempt, "executionTargetKind">).executionTargetKind ?? "container") === target.kind).length;
      return active / Math.max(1, target.capacity ?? (target.kind === "container" ? device.capacity ?? 2 : 1));
    };
    return devices.filter(device => device.online && (!task.deviceId || task.deviceId === device.id) && !placementConstraint(task, device, load, provider, runtime))
      .sort((a, b) => utilization(a) - utilization(b) || Number(b.local) - Number(a.local) || a.id.localeCompare(b.id))[0];
  }
  private activeWork(): FactoryTask[] {
    const attempts = this.options.store.list<Attempt>(TABLE.attempts);
    const details = new Map(attempts.map(attempt => [attempt.id, this.options.store.get<AttemptDetail>(TABLE.attemptDetails, attempt.id)]));
    const unconfirmed = new Set(attempts.filter(attempt => attempt.status === "retired" && details.get(attempt.id)?.cancellation === "requested").map(attempt => attempt.id));
    const verificationWaits = new Set(attempts.filter(attempt => details.get(attempt.id)?.verificationWait).map(attempt => attempt.id));
    return activeExecutionTasks(this.options.store.list<FactoryTask>(TABLE.tasks), attempts, unconfirmed, new Map(attempts.map(attempt => [attempt.id, details.get(attempt.id)?.contract])), verificationWaits);
  }
  private hasAvailableDevice(goal: Goal): boolean {
    return this.tasks(goal.id).filter(task => ["queued", "ready"].includes(task.status)).some(task => !!this.place(task));
  }
  private limitReason(goal: Goal): string | undefined {
    const control = this.control(goal.id), attempts = this.attempts(goal.id).length;
    return goal.maxAttempts !== undefined && attempts >= goal.maxAttempts && this.tasks(goal.id).some(task => ["queued", "ready", "failed"].includes(task.status)) ? `Configured attempt budget reached (${attempts}).` :
      control.maxDurationMs !== undefined && Date.parse(this.now()) - Date.parse(control.startedAt) >= control.maxDurationMs ? "Configured time budget reached." : undefined;
  }
  private checkBudget(goal: Goal): boolean {
    const reason = this.limitReason(goal);
    if (!reason) return false;
    this.wait(goal.id, reason, "budget-changed"); return true;
  }
  private nextStage(goalId: string): ControlRecord["stage"] {
    if (!this.planRecord(goalId) || this.control(goalId).replanTaskIds?.length) return "plan";
    // Dispatch chooses a current nonwaiting failed task and persists its diagnosis identity.
    // A branch waiting on its own condition must not stop the other branches when a device returns.
    if (this.tasks(goalId).some(task => !["completed", "canceled"].includes(task.status))) return "dispatch";
    return "evaluate";
  }
  private wait(goalId: string, reason: string, condition: string, wakeAt?: string): void {
    if (terminalGoals.has(this.goal(goalId).status) || this.goal(goalId).status === "paused") return;
    const current = this.control(goalId);
    if (this.goal(goalId).status === "waiting" && current.waitingFor === condition && current.waitReason === reason && current.wakeAt === wakeAt) return;
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...this.control(goalId), waitingFor: condition, waitReason: reason, wakeAt, operation: undefined });
      this.writeGoal(goalId, { status: "waiting", error: reason, nextAction: reason });
      this.decision(goalId, "waiting", reason, { condition });
    }); this.changed();
  }
  private wake(goalId: string, reason: string): void {
    const goal = this.goal(goalId), control = this.control(goalId);
    const stage = ["host-disk-space", "inspection-evidence"].includes(control.waitingFor ?? "") || control.controllerFailures && ["plan", "diagnose", "evaluate"].includes(control.stage) ? control.stage : this.nextStage(goalId);
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...this.control(goalId), stage, waitingFor: undefined, waitReason: undefined, wakeAt: undefined });
      this.writeGoal(goalId, { status: stage === "plan" ? "planning" : "running", error: undefined, nextAction: reason });
      this.decision(goal.id, "woken", reason);
    });
  }

  private admit(goalId: string): boolean {
    const blocker = this.options.admission?.(this.goal(goalId));
    if (!blocker) return true;
    // A localized repair may already have a live controller. Capacity admission
    // must not revoke its authority or pretend that its provider turn ended.
    this.capacityWait(goalId, blocker.reason);
    return false;
  }

  private deferExecution(attempt: Attempt, reason: string, phase: "preparing" | "executing"): void {
    const task = this.task(attempt.taskId);
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), capacityWait: phase, phase: "preparing" as const });
      this.writeAttempt(attempt.id, { status: "created", error: reason });
      this.writeTask(task.id, { status: "running" });
      this.capacityWait(task.goalId, reason);
    });
    this.changed();
  }

  private capacityWait(goalId: string, reason: string): void {
    if (this.busyGoals.has(goalId) || this.control(goalId).operation) {
      if (this.goal(goalId).nextAction !== reason) { this.writeGoal(goalId, { nextAction: reason }); this.changed(); }
    } else this.wait(goalId, reason, "host-disk-space");
  }
  private context(goal: Goal, evidence?: ControllerEvidence): string {
    const control = this.control(goal.id);
    // Older services embedded complete failed check logs here. Keep requirements/steering/handoff exact,
    // while treating the diagnostic reason like the other retained failure text.
    const reason = control.replanReason && evidence ? evidence.text(control.replanReason, `${TABLE.control}/${goal.id}.replanReason`, 8192) : undefined;
    const devices = this.options.devices();
    const executionInventory = { devices: [...devices].sort((left, right) => Number(right.online) - Number(left.online) || Number(right.local) - Number(left.local) || left.id.localeCompare(right.id)).slice(0, 32).map(device => ({
      id: device.id, name: device.name.slice(0, 128), online: device.online, targets: deviceExecutionTargets(device).slice(0, 4).map(target => ({
        id: target.id, kind: target.kind, protocolVersion: target.protocolVersion, readiness: target.readiness, capacity: target.capacity, resources: target.resources, workspaceProviders: target.workspaceProviders, runtimes: target.runtimes,
        reason: target.reason?.slice(0, 256), capabilities: target.capabilities.slice(0, 6).map(capability => ({ kind: capability.kind, readiness: capability.readiness, version: capability.version?.slice(0, 128), reason: capability.reason?.slice(0, 256) })),
      })),
    })), omittedDevices: Math.max(0, devices.length - 32) };
    return `Original objective:\n${goal.objective}\n\nRequired completion criteria:\n${goal.criteria.map(value => `- ${value}`).join("\n")}\n\nAutonomy: ${goal.autonomy}; approvals: ${goal.approvalMode}.\n\nGoal execution default:\n${JSON.stringify(goal.execution ?? { target: "container" })}\n\nExecution inventory:\n${JSON.stringify(executionInventory)}\n\nSteering context:\n${control.steering.join("\n")}\n\nReplanning reason:\n${reason?.omittedCharacters ? JSON.stringify(reason) : control.replanReason ?? "Initial plan"}${control.replanInstructions ? `\n\nCurrent diagnosis handoff:\n${control.replanInstructions}` : ""}`;
  }
  private executionPrompt(goal: Goal, task: FactoryTask): string {
    const detail = this.executionTaskDetail(task);
    const attempt = task.currentAttemptId ? this.options.store.get<Attempt>(TABLE.attempts, task.currentAttemptId) : undefined;
    const target = attempt?.executionTargetKind ?? "container";
    const guidance = {
      feature: "Feature contract: deliver the observable product behavior across the necessary layers. Account for the acceptance scenarios, including relevant failure or loading behavior. Report concrete behavior and evidence rather than only implementation details.",
      unit: "Unit contract: complete the bounded component or change described by this task. Preserve surrounding interfaces and integrate with its callers. Verify the relevant behavior without expanding into unrelated work.",
      architecture: "Architecture contract: resolve the structural decision against the actual source and requirements. Preserve the chosen design, rationale, tradeoffs and actionable handoff in repository deliverables. Implement a technical foundation only when the task asks for it; a conversational proposal alone is not a deliverable.",
      test: "Test contract: address the identified verification uncertainty with meaningful checks or product scenarios. Record actual results and limitations, and preserve reusable verification where requested. Do not add tests that merely mirror implementation or claim evidence from checks you did not run.",
    };
    return [`You are executing an EnoughFactory task ${target === "host-macos" ? "on the configured Mac host in its private project workspace" : "inside its isolated full-permission container"}. Make routine decisions and deliver the requested outcome. Run focused relevant checks, preserve useful work, and finish with evidence of what actually changed. Do not stop at a proposal.`, this.context(goal), `Task: ${task.title}\n${task.description}`, task.kind ? guidance[task.kind] : "Generic task contract: complete the described work and provide concrete evidence of its outcome.",
      `Execution requirements: ${JSON.stringify(task.execution ?? { target: "container" })}. Delegated tools are separate from the author runtime; use only configured capabilities and retain their actual observations and results.`,
      ...(task.quality ? [`Required UI acceptance: ${JSON.stringify(task.quality)}. Use real inspection tools, view the actual screenshot images, exercise the named workflows and compare the configured references. Submit the authenticated current-source quality report through the factory's quality tool; passing a build or writing a report alone does not satisfy this acceptance contract.`] : []),
      `Task acceptance criteria:\n${task.acceptanceCriteria?.map(value => `- ${value}`).join("\n") || "Use the task description and goal criteria."}`,
      `Expected deliverables:\n${task.expectedOutputs?.map(value => `- ${value}`).join("\n") || "Preserved changes and a factual outcome summary."}`,
      "A few passing scenarios do not complete this task. Continue in-scope work until its acceptance criteria and expected deliverables are satisfied and relevant checks pass. Investigate and repair your own check failures before ending. If a genuine dependency outside this task's scope prevents progress, preserve useful work and identify the exact missing API or behavior and its owner; do not leave unrelated in-scope work unfinished.",
      `Planned write paths: ${JSON.stringify(task.writePaths ?? "Not declared on this legacy task")}. Other independent work may run in parallel. Preserve shared interfaces, keep changes focused on this task and report any necessary changes outside its declared scope. These paths coordinate ownership; ${target === "host-macos" ? "host execution follows the configured project/device access scope" : "your container retains full permissions"}.`,
      ...(detail.lastCandidate ? [`Latest retained source input: ${JSON.stringify({ id: detail.lastCandidate.id, commit: detail.lastCandidate.commit })}. This candidate seeds the prepared workspace. Preserve its useful work and accepted changes; older restoration references do not supersede this source input.`] : []),
      ...(detail.replanInstructions ? [`Current diagnosis handoff for this replacement plan:\n${detail.replanInstructions}\nApply it within this task's current contract and dependencies.`] : []),
      `Repair instructions: ${detail.repairInstructions ?? "None"}`, `Configured checks: ${JSON.stringify(detail.checks)}`, "The factory will capture and integrate the exact candidate. Do not merge into another attempt's workspace. Project-configured deployment capabilities are authorized according to the goal policy; report any uncertain external effects explicitly."].join("\n\n");
  }
  /** Old services carried retry text into replacement plans without recording its revision. */
  private executionTaskDetail(task: FactoryTask): TaskDetail {
    const detail = this.taskDetail(task.id), plan = this.planRecord(task.goalId);
    if (!detail.repairInstructions || !plan || plan.revision !== detail.planRevision) return detail;
    const instructions = detail.repairInstructions;
    const issued = this.options.store.list<Decision>(TABLE.decisions).filter(decision => {
      const data = decision.data && typeof decision.data === "object" && !Array.isArray(decision.data) ? decision.data as Record<string, unknown> : undefined;
      if (decision.goalId !== task.goalId || !data || data.taskId !== task.id) return false;
      if (decision.kind === "task-retry-instructions") return data.repairInstructions === instructions;
      return decision.kind === "repair" && data.action === "retry" && (data.instructions === instructions || (data.instructions === undefined && decision.text === instructions));
    }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    // Only durable, strictly older evidence justifies upgrading legacy guidance to history.
    // An unbound legacy record stays intact; fresh explicit retry instructions remain current.
    if (!issued || !(Date.parse(issued.at) < Date.parse(plan.createdAt))) return detail;
    const updated: TaskDetail = { ...detail, repairInstructions: undefined, priorRepairInstructions: [...detail.priorRepairInstructions ?? [], {
      instructions, recordedAt: issued.at,
      ...(detail.lastCandidate ? { retainedCandidateId: detail.lastCandidate.id, retainedCandidateCommit: detail.lastCandidate.commit } : {}),
    }] };
    this.options.store.set(TABLE.taskDetails, updated);
    return updated;
  }
  private goals(): Goal[] { return this.options.store.list<Goal>(TABLE.goals); }
  private goal(id: string): Goal { const value = this.options.store.get<Goal>(TABLE.goals, id); if (!value) throw new Error("Goal not found."); return value; }
  private tasks(goalId: string): FactoryTask[] { return this.options.store.list<FactoryTask>(TABLE.tasks).filter(task => task.goalId === goalId); }
  private task(id: string): FactoryTask { const value = this.options.store.get<FactoryTask>(TABLE.tasks, id); if (!value) throw new Error("Task not found."); return value; }
  private attempts(goalId: string): Attempt[] { const ids = new Set(this.tasks(goalId).map(task => task.id)); return this.options.store.list<Attempt>(TABLE.attempts).filter(attempt => ids.has(attempt.taskId)); }
  private attempt(id: string): Attempt { const value = this.options.store.get<Attempt>(TABLE.attempts, id); if (!value) throw new Error("Attempt not found."); return value; }
  private control(id: string): ControlRecord { const value = this.options.store.get<ControlRecord>(TABLE.control, id); if (!value) throw new Error("Factory control record missing."); return value; }
  private taskDetail(id: string): TaskDetail {
    const value = this.options.store.get<TaskDetail>(TABLE.taskDetails, id);
    if (value) return value;
    // Legacy accepted work may predate task-detail records. Project its retained
    // contract for audits without inventing a new execution/check history.
    const task = this.options.store.get<FactoryTask>(TABLE.tasks, id);
    if (task?.status === "completed") {
      const contract = task.currentAttemptId ? this.options.store.get<AttemptDetail>(TABLE.attemptDetails, task.currentAttemptId)?.contract : undefined;
      const plan = this.planRecord(task.goalId);
      return { id, key: Object.entries(plan?.taskKeys ?? {}).find(([, taskId]) => taskId === id)?.[0] ?? id,
        checks: contract?.checks ?? [], planChecks: [], planRevision: contract?.planRevision ?? plan?.revision ?? 0, selected: false, failureSignatures: [] };
    }
    throw new Error("Task details missing.");
  }
  private attemptDetail(id: string): AttemptDetail { const value = this.options.store.get<AttemptDetail>(TABLE.attemptDetails, id); if (!value) throw new Error("Attempt details missing."); return value; }
  private inspectionEventRevision(goalId: string): number { return this.options.store.get<{ id: string; revision: number }>(TABLE.inspectionEvents, goalId)?.revision ?? 0; }
  private planRecord(id: string): PlanRecord | undefined { return this.options.store.get<PlanRecord>(TABLE.plans, id); }
  private taskChecks(taskId: string): string[] {
    const task = this.task(taskId), detail = this.taskDetail(taskId), plan = this.planRecord(task.goalId);
    const inherited = detail.planChecks ?? (plan?.checkScope === "goal" ? [] : plan?.checks ?? []);
    return [...new Set([...inherited, ...detail.checks])];
  }
  private sameRepository(left: RepositoryEvidence, right: RepositoryEvidence): boolean {
    return left.head === right.head && left.status === right.status && left.diff === right.diff && left.fingerprint === right.fingerprint;
  }
  private goalCheckReceiptId(goal: Goal, repository: RepositoryEvidence, commands: string[]): string {
    return createHash("sha256").update(JSON.stringify({ goalId: goal.id, revision: goal.revision, head: repository.head, status: repository.status, diff: repository.diff, fingerprint: repository.fingerprint, commands })).digest("hex");
  }
  private project(goal: Goal): Project { const project = this.options.project(goal.projectId); if (!project) throw new Error("The goal's project is unavailable."); return project; }
  private writeGoal(id: string, patch: Partial<Goal>): void { this.options.store.set(TABLE.goals, { ...this.goal(id), ...patch, updatedAt: this.now() }); }
  private writeTask(id: string, patch: Partial<FactoryTask>): void { this.options.store.set(TABLE.tasks, { ...this.task(id), ...patch, updatedAt: this.now() }); }
  private writeAttempt(id: string, patch: Partial<Attempt>): void { this.options.store.set(TABLE.attempts, { ...this.attempt(id), ...patch }); }
  private decision(goalId: string, kind: string, text: string, data?: unknown): void { this.options.store.set<Decision>(TABLE.decisions, { id: randomUUID(), goalId, at: this.now(), kind, text, ...(data === undefined ? {} : { data }) }); }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private scheduleGoal(id: string, operation: () => Promise<void>): void {
    this.busyGoals.add(id); this.track(operation().finally(() => { this.busyGoals.delete(id); this.operationControllers.delete(id); }));
  }
  private track(operation: Promise<void>): void {
    const guarded = operation.catch(error => {
      this.options.onChange?.();
      // The operation's own authority-aware handler records errors. Never create replacements here.
      if (process.env.ENOUGHFACTORY_DEBUG) console.error("Factory observation failed:", this.error(error));
    }).finally(() => { this.pending.delete(guarded); this.kick(); });
    this.pending.add(guarded);
  }
  private changed(): void { this.options.onChange?.(); this.kick(); }
  private kick(): void {
    if (!this.enabled || this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; void this.tick(); });
  }
}
