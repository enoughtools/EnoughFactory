import { createHash, randomUUID } from "node:crypto";
import type { Attempt, Decision, FactoryTask, Goal, Project } from "@enoughfactory/contracts";
import type {
  AttemptDetail, CandidateRef, ConfigureGoalInput, ControlRecord, CoordinatorOptions, CreateGoalInput,
  EvaluationRecord, ExecutionResult, GoalCheckRecord, PlanRecord, PlannedTask, RepositoryEvidence, TaskDetail,
} from "./types.js";
import { readCheckCommands, readEvaluation, readJsonObject, readPlan, readTasks, validateDependencies } from "./protocol.js";
import { FactoryOperationError, FactoryDecisionError } from "./errors.js";
import { activeExecutionTasks, descendants, placementConstraint, sortReadyTasks, taskSchedulingBlocker } from "./scheduler.js";

const TABLE = {
  goals: "goals", tasks: "tasks", attempts: "attempts", decisions: "decisions",
  plans: "factory-plans", control: "factory-control", taskDetails: "factory-task-details",
  attemptDetails: "factory-attempt-details", evaluations: "factory-evaluations", goalChecks: "factory-goal-checks",
} as const;
const terminalGoals = new Set<Goal["status"]>(["completed", "canceled", "failed"]);
const activeAttempts = new Set<Attempt["status"]>(["created", "running", "unknown"]);

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
    if (input.maxSpend !== undefined && (!Number.isFinite(input.maxSpend) || input.maxSpend <= 0)) throw new Error("Spend budget must be positive.");
    if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) throw new Error("Attempt budget must be a positive integer.");
    if (input.maxDurationMs !== undefined && (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0)) throw new Error("Time budget must be positive.");
    const at = this.now(), autonomy = input.autonomy ?? "autonomous";
    const goal: Goal = {
      id: randomUUID(), projectId: input.projectId, coordinatorId: this.options.deviceId,
      title: input.title?.trim() || input.objective.trim().split("\n")[0]!.slice(0, 96),
      objective: input.objective.trim(), criteria: [...new Set((input.criteria ?? []).map(value => value.trim()).filter(Boolean))],
      status: autonomy === "manual" ? "draft" : "planning", autonomy,
      approvalMode: input.approvalMode ?? project.approvalMode ?? "approve-all", runtime: input.runtime ?? project.runtime,
      createdAt: at, updatedAt: at, revision: 1,
      nextAction: autonomy === "manual" ? "Plan when requested" : "Plan the goal and its completion criteria",
      concurrency: Math.max(1, Math.min(32, Math.floor(input.concurrency ?? 8))),
      ...(input.maxSpend === undefined ? {} : { maxSpend: input.maxSpend }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    };
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.goals, goal);
      this.options.store.set<ControlRecord>(TABLE.control, {
        id: goal.id, stage: "plan", spent: 0, startedAt: at, steering: [],
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
      for (const attempt of this.options.store.list<Attempt>(TABLE.attempts)) {
        if (attempt.status !== "retired" || this.options.store.get<AttemptDetail>(TABLE.attemptDetails, attempt.id)?.cancellation !== "requested" || this.cancellations.has(attempt.id)) continue;
        if (!this.options.devices().some(device => device.id === attempt.deviceId && device.online) || this.reconciling.has(attempt.id)) continue;
        if (this.enabled && Date.now() - (this.lastObservation.get(attempt.id) ?? 0) < 10_000) continue;
        this.lastObservation.set(attempt.id, Date.now());
        this.reconciling.add(attempt.id);
        this.track(this.acknowledgeCancel(attempt).finally(() => this.reconciling.delete(attempt.id)));
      }
      for (const goal of this.goals()) {
        if (goal.coordinatorId !== this.options.deviceId || terminalGoals.has(goal.status)) continue;
        for (const attempt of this.attempts(goal.id)) {
          if (activeAttempts.has(attempt.status) && !this.busyAttempts.has(attempt.id) && !this.reconciling.has(attempt.id) && (!this.enabled || Date.now() - (this.lastObservation.get(attempt.id) ?? 0) >= 10_000)) {
            this.lastObservation.set(attempt.id, Date.now());
            this.reconciling.add(attempt.id);
            this.track(this.reconcileAttempt(attempt).finally(() => this.reconciling.delete(attempt.id)));
          }
        }
        if (goal.status === "paused") continue;
        if (this.busyGoals.has(goal.id)) {
          const control = this.control(goal.id);
          if (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length)) this.dispatch(this.goal(goal.id), false);
          continue;
        }
        let current = this.goal(goal.id), control = this.control(goal.id);
        if (current.status === "waiting") {
          if (control.waitingFor === "device-online" && this.hasAvailableDevice(current)) this.wake(current.id, "A worker device is available.");
          else if (control.wakeAt && Date.parse(control.wakeAt) <= Date.parse(this.now())) this.wake(current.id, "The configured wait has elapsed.");
          else continue;
          current = this.goal(goal.id); control = this.control(goal.id);
        }
        if (current.status === "draft" && !control.manualAction && !this.tasks(current.id).some(task => this.taskDetail(task.id).selected)) continue;
        if (this.checkBudget(current)) continue;
        if (!this.options.project(current.projectId)) { this.wait(current.id, "The goal's project is unavailable.", "project-available"); continue; }
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
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...control, waitingFor: undefined, waitReason: undefined, wakeAt: undefined, stage: control.stage === "wait" ? this.nextStage(goalId) : control.stage });
      this.writeGoal(goalId, { status: control.stage === "plan" ? "planning" : "running", error: undefined, nextAction: "Resume from current durable state" });
      this.decision(goalId, "resumed", "Coordination resumed from its retained plan and attempts.");
    });
    for (const attempt of this.attempts(goalId)) this.lastObservation.delete(attempt.id);
    this.changed();
  }

  requestPlan(goalId: string): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    if (this.attempts(goalId).some(attempt => activeAttempts.has(attempt.status)) || this.tasks(goalId).some(task => task.status === "review")) throw new Error("Work is active or awaiting integration. Use goal steering to revise and revoke it explicitly.");
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...this.control(goalId), stage: "plan", manualAction: "plan", operation: undefined, replanReason: "A fresh plan was requested.", waitingFor: undefined, waitReason: undefined });
      this.writeGoal(goalId, { revision: goal.revision + 1, status: goal.status === "paused" ? "paused" : "planning", nextAction: "Plan the requested work" });
      for (const task of this.tasks(goalId).filter(task => task.status !== "completed")) this.writeTask(task.id, { status: "canceled" });
      this.decision(goalId, "plan-requested", "A new plan was requested from current accepted work; pending proposals were replaced.");
    });
    this.operationControllers.get(goalId)?.abort(); this.changed();
  }

  configure(goalId: string, input: ConfigureGoalInput): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    for (const name of ["maxSpend", "maxDurationMs"] as const) if (input[name] !== undefined && input[name] !== null && (!Number.isFinite(input[name]) || input[name]! <= 0)) throw new Error(`${name} must be positive or null.`);
    if (input.maxAttempts !== undefined && input.maxAttempts !== null && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) throw new Error("Attempt budget must be a positive integer or null.");
    if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 32)) throw new Error("Concurrency must be between 1 and 32.");
    this.options.store.transaction(() => {
      this.writeGoal(goalId, {
        ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        ...(input.maxSpend === undefined ? {} : { maxSpend: input.maxSpend ?? undefined }),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts ?? undefined }),
      });
      if (input.maxDurationMs !== undefined) this.options.store.set(TABLE.control, { ...this.control(goalId), maxDurationMs: input.maxDurationMs ?? undefined });
      if (input.autonomy && input.autonomy !== "manual" && goal.status === "draft") this.writeGoal(goalId, { status: this.control(goalId).stage === "plan" ? "planning" : "running" });
      this.decision(goalId, "configuration", "Goal execution settings updated. Approval changes apply to subsequently started turns.", input);
      if (this.control(goalId).waitingFor === "budget-changed") this.wake(goalId, "Execution budget was updated.");
      else if (input.runtime && this.control(goalId).waitingFor === "runtime-available") this.wake(goalId, "The goal runtime was updated.");
    });
    this.changed();
  }

  requestEvaluation(goalId: string): void {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    if (this.busyGoals.has(goalId)) throw new Error("A controller decision is still running. Pause or steer it before requesting a different decision.");
    if (this.tasks(goalId).some(task => !["completed", "canceled"].includes(task.status))) throw new Error("Complete or retire outstanding work before evaluating the full goal.");
    this.options.store.set(TABLE.control, { ...this.control(goalId), stage: "evaluate", manualAction: "evaluate" });
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

  async steer(goalId: string, input: { objective?: string; context?: string; criteria?: string[]; autonomy?: Goal["autonomy"]; approvalMode?: Goal["approvalMode"] }): Promise<void> {
    const goal = this.goal(goalId);
    if (terminalGoals.has(goal.status)) throw new Error("The goal is terminal.");
    if (input.objective !== undefined && !input.objective.trim()) throw new Error("The objective cannot be empty.");
    const attempts = this.attempts(goalId).filter(attempt => activeAttempts.has(attempt.status));
    this.options.store.transaction(() => {
      const control = this.control(goalId);
      this.options.store.set(TABLE.control, { ...control, stage: "plan", operation: undefined, steering: input.context ? [...control.steering, input.context.trim()] : control.steering, replanReason: "User steering changed the goal context.", waitingFor: undefined, waitReason: undefined });
      this.writeGoal(goalId, {
        revision: goal.revision + 1, status: goal.status === "paused" ? "paused" : "planning", nextAction: "Revise the plan for the updated goal",
        ...(input.objective === undefined ? {} : { objective: input.objective.trim() }),
        ...(input.criteria === undefined ? {} : { criteria: [...new Set(input.criteria.map(value => value.trim()).filter(Boolean))] }),
        ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
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

  async retireAttempt(attemptId: string, options: { preserveController?: boolean } = {}): Promise<void> {
    const attempt = this.attempt(attemptId), task = this.task(attempt.taskId), goal = this.goal(task.goalId);
    if (terminalGoals.has(goal.status) || task.status === "completed") throw new Error("Integrated or terminal work cannot be retired as a live attempt.");
    if (!this.isCurrent(attempt)) throw new FactoryOperationError("stale", "This attempt no longer owns its task's execution authority.");
    this.options.store.transaction(() => {
      this.revoke(attempt); this.writeTask(task.id, { status: "queued", currentAttemptId: undefined });
      this.decision(goal.id, "attempt-retired", "Attempt authority was retired explicitly. A new isolated attempt may now be placed; external effects still require reconciliation.", { attemptId });
      this.writeGoal(goal.id, { nextAction: "Place a replacement for the explicitly retired attempt" });
      const control = this.control(goal.id);
      const preserving = options.preserveController && (control.stage === "diagnose" || (control.stage === "plan" && !!control.replanTaskIds?.length));
      if (!preserving) this.options.store.set(TABLE.control, { ...control, stage: "dispatch", waitingFor: undefined, waitReason: undefined });
    });
    this.changed(); await this.acknowledgeCancel(attempt);
  }

  notifyCondition(condition: string, goalId?: string): void {
    for (const task of this.options.store.list<FactoryTask>(TABLE.tasks)) {
      if (goalId && task.goalId !== goalId) continue;
      const goal = this.goal(task.goalId), detail = this.taskDetail(task.id);
      if (terminalGoals.has(goal.status) || detail.waitingFor !== condition || task.status !== "failed") continue;
      this.options.store.transaction(() => {
        this.writeTask(task.id, { status: "queued", currentAttemptId: undefined });
        this.options.store.set(TABLE.taskDetails, { ...detail, waitingFor: undefined, waitReason: undefined });
        this.decision(goal.id, "task-woken", `Condition satisfied for ${task.title}: ${condition}`, { taskId: task.id });
      });
    }
    for (const goal of this.goals()) {
      if (goalId && goal.id !== goalId) continue;
      const control = this.control(goal.id);
      if (control.waitingFor !== condition || terminalGoals.has(goal.status)) continue;
      if (goal.status === "waiting") this.wake(goal.id, `Condition satisfied: ${condition}`);
      else if (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length)) {
        this.options.store.set(TABLE.control, { ...control, waitingFor: undefined, waitReason: undefined });
        this.decision(goal.id, "controller-woken", `Repair controller condition satisfied: ${condition}`);
      }
    }
    this.changed();
  }

  private async plan(goal: Goal): Promise<void> {
    const operation = this.beginOperation(goal, "planner"), project = this.project(goal);
    const completed = this.tasks(goal.id).filter(task => task.status === "completed");
    const scope = this.control(goal.id).replanTaskIds;
    const preserved = scope ? this.tasks(goal.id).filter(task => !scope.includes(task.id) && task.status !== "canceled") : completed;
    const prompt = [
      "You are the EnoughFactory planner. Build the entire objective, preserving all explicit requirements. Make routine implementation decisions yourself.",
      "Return one JSON object: {summary,criteria:string[],checks:string[],tasks:[{key,title,description,kind:'feature'|'unit'|'architecture'|'test',acceptanceCriteria:string[],expectedOutputs:string[],dependsOn:string[],checks:string[],estimatedMinutes?:number,writePaths?:string[],resources?:{cpus?:number,memoryGiB?:number},deviceId?:string}]}. Stable task keys must be unique, dependencies acyclic, checks focused and executable inside the isolated runtime.",
      "Choose task kinds by outcome: feature delivers observable product behavior; unit implements a bounded component or change; architecture resolves a structural decision and preserves its rationale and handoff; test supplies focused verification for an identified uncertainty. Give each task concrete acceptance criteria and expected deliverables. Do not invent extra architecture/test tasks or mandatory reviews when the work does not need them.",
      "Every checks entry is a shell command, never an instruction or explanation. For example use 'sh scripts/check-foundation.sh', not 'Run scripts/check-foundation.sh to validate the foundation'. Task checks verify only outputs available when that task and its actual prerequisites finish. An architecture or interface task should verify its deliverables without requiring the future application, packages or tests to exist. Plan-level checks are final whole-goal checks, run once on the integrated result after all tasks finish; do not copy them into every task or require expensive full-product verification at every layer. Empty task checks are acceptable when concrete deliverable evidence is the appropriate verification.",
      "Maximize useful parallel work: establish shared interfaces/contracts in small prerequisite tasks, then give independent implementations disjoint ownership. DependsOn is for actual required outputs, not preferred chronology or artificial phases. Avoid making every task depend on a broad setup task. Declare repository-relative writePaths (files, directories or globs) for likely writes, estimatedMinutes for effort and resources for meaningful CPU/memory needs. Estimates guide scheduling; do not invent precision. Keep verification proportionate; do not require human approval or ceremonies unless the goal's actual policy requires them.",
      "Do not claim implementation or completion. A task may include configured release/deployment actions. Derive explicit observable criteria when the user omitted them.",
      this.context(goal),
      `Devices: ${JSON.stringify(this.options.devices())}`,
      `Already integrated work: ${JSON.stringify(completed.map(task => ({ key: this.taskDetail(task.id).key, title: task.title, description: task.description, attempt: this.options.store.get(TABLE.attemptDetails, task.currentAttemptId ?? "") })))}`,
      `Retained unfinished work: ${JSON.stringify(this.tasks(goal.id).filter(task => task.status !== "completed" && (!scope || scope.includes(task.id))).map(task => ({ key: this.taskDetail(task.id).key, title: task.title, description: task.description, failure: this.taskDetail(task.id).lastError, candidate: this.taskDetail(task.id).lastCandidate, repairInstructions: this.taskDetail(task.id).repairInstructions })))}`,
      ...(scope ? [`This is a localized repair. Replace only the affected work above. Preserve these unrelated tasks exactly; their keys may be dependencies but must not be repeated: ${JSON.stringify(preserved.map(task => ({ key: this.taskDetail(task.id).key, title: task.title, status: task.status, dependsOn: task.dependsOn.map(id => this.taskDetail(id).key) })))}`] : []),
      "Do not repeat completed tasks. Their keys may be referenced as dependencies.",
      "Reuse a retained unfinished task's stable key when continuing the same work. Its isolated candidate can seed a replacement workspace; use a new key when the task's purpose changes.",
    ].join("\n\n");
    try {
      const response = await this.options.runtime.complete({ goal, role: "planner", prompt, project, signal: this.operationControllers.get(goal.id)?.signal });
      if (!this.operationCurrent(goal.id, operation)) return;
      this.recordSpend(goal.id, response.spend);
      const plan = readPlan(response.text);
      const preservedKeys = new Set(preserved.map(task => this.taskDetail(task.id).key));
      validateDependencies(plan.tasks, preservedKeys);
      if (plan.tasks.some(task => preservedKeys.has(task.key))) throw new FactoryDecisionError("The planner repeated a preserved task key. Use a new key for improvement work and leave unrelated work unchanged.");
      this.options.store.transaction(() => {
        this.applyTasks(goal.id, plan.tasks, plan.summary, plan.checks, new Set(preserved.map(task => task.id)));
        this.writeGoal(goal.id, { criteria: [...new Set([...this.goal(goal.id).criteria, ...plan.criteria])], status: "running", error: undefined, nextAction: plan.tasks.length ? "Dispatch work whose dependencies are complete" : "Evaluate existing product evidence" });
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: plan.tasks.length || preserved.some(task => task.status !== "completed") ? "dispatch" : "evaluate", operation: undefined, manualAction: undefined, decisionFailures: undefined, replanTaskIds: undefined });
        this.decision(goal.id, "plan", plan.summary, { chatId: response.chatId, taskCount: plan.tasks.length, revision: this.goal(goal.id).revision });
      });
      this.changed();
    } catch (error) { this.operationFailed(goal.id, operation, error); }
  }

  private dispatch(goal: Goal, manageController = true): void {
    const tasks = this.tasks(goal.id).filter(task => task.status !== "canceled");
    for (const task of tasks.filter(task => task.status === "review")) {
      if (!task.currentAttemptId || this.busyAttempts.has(task.currentAttemptId) || this.reconciling.has(task.currentAttemptId)) continue;
      const attempt = this.attempt(task.currentAttemptId);
      this.busyAttempts.add(attempt.id);
      this.track(this.processResult(attempt, this.attemptDetail(attempt.id).result ?? { status: "succeeded", text: "Recovered retained candidate." }).finally(() => this.busyAttempts.delete(attempt.id)));
    }
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
    const running = this.activeWork().filter(task => task.goalId === goal.id).length;
    let capacity = Math.max(0, goal.concurrency - running);
    let eligible = 0, placed = 0;
    const stableKeys = new Map(tasks.map(task => [task.id, this.taskDetail(task.id).key]));
    for (const task of sortReadyTasks(tasks, stableKeys)) {
      if (capacity === 0) break;
      const detail = this.taskDetail(task.id);
      if (goal.autonomy !== "autonomous" && !detail.selected) continue;
      if (this.control(goal.id).replanTaskIds?.includes(task.id)) continue;
      const active = this.activeWork();
      const repository = this.options.project(goal.projectId)?.path ?? goal.projectId;
      const conflicts = active.filter(other => {
        const projectId = this.options.store.get<Goal>(TABLE.goals, other.goalId)?.projectId;
        return projectId !== undefined && (this.options.project(projectId)?.path ?? projectId) === repository;
      });
      const blocker = taskSchedulingBlocker(task, goal, tasks, active, conflicts, this.options.devices());
      if (blocker) {
        if (["device-unavailable", "device-capacity", "resource"].includes(blocker.kind)) eligible++;
        continue;
      }
      eligible++;
      const device = this.place(task);
      if (!device) continue;
      if (this.checkBudget(this.goal(goal.id))) return;
      const attempts = this.options.store.list<Attempt>(TABLE.attempts).filter(item => item.taskId === task.id);
      const attempt: Attempt = { id: randomUUID(), taskId: task.id, generation: Math.max(0, ...attempts.map(item => item.generation)) + 1, deviceId: device.id, status: "created", startedAt: this.now() };
      this.options.store.transaction(() => {
        this.options.store.set(TABLE.attempts, attempt);
        this.options.store.set<AttemptDetail>(TABLE.attemptDetails, { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, assignmentGoalRevision: goal.revision, cancellation: "none", phase: "preparing",
          contract: { title: task.title, description: task.description, kind: task.kind, acceptanceCriteria: task.acceptanceCriteria, expectedOutputs: task.expectedOutputs, estimatedMinutes: task.estimatedMinutes, writePaths: task.writePaths, resources: task.resources, dependsOn: [...task.dependsOn], checks: this.taskChecks(task.id), planRevision: detail.planRevision } });
        this.writeTask(task.id, { status: "running", currentAttemptId: attempt.id, deviceId: device.id });
        this.decision(goal.id, "dispatch", `Dispatched ${task.title} to ${device.name}.`, { taskId: task.id, attemptId: attempt.id, generation: attempt.generation, deviceId: device.id });
      });
      capacity--; placed++; this.busyAttempts.add(attempt.id);
      this.track(this.execute(attempt).finally(() => this.busyAttempts.delete(attempt.id)));
    }
    if (placed) this.changed();
    else if (manageController && !failed && eligible && !running) this.wait(goal.id, goal.workspaceProvider === "artifactfs" ? "Waiting for an online worker with ArtifactFS support and capacity." : "Waiting for an online worker with capacity.", "device-online");
    else if (!running && goal.autonomy !== "autonomous") this.writeGoal(goal.id, { nextAction: "Select the next tasks to execute" });
  }

  private async execute(attempt: Attempt): Promise<void> {
    let executing = false;
    const task = this.task(attempt.taskId), goal = this.goal(task.goalId), project = this.project(goal);
    try {
      const workspace = await this.options.workspaces.prepare({ goal, task, attempt, project, previousCandidate: this.taskDetail(task.id).lastCandidate });
      if (!this.isCurrent(attempt)) return;
      this.options.store.transaction(() => {
        this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), workspace, phase: "executing" as const });
        this.writeAttempt(attempt.id, { status: "running", baseCommit: workspace.baseCommit, ...(workspace.sessionId ? { sessionId: workspace.sessionId } : {}) });
      });
      executing = true;
      const result = await this.options.runtime.execute({ goal: this.goal(goal.id), task: this.task(task.id), attempt: this.attempt(attempt.id), workspace, project, prompt: this.executionPrompt(goal, task), assignmentGoalRevision: this.attemptDetail(attempt.id).assignmentGoalRevision ?? this.attemptDetail(attempt.id).goalRevision });
      if (!this.isCurrent(attempt)) return;
      await this.processResult(attempt, result);
    } catch (error) {
      if (!this.isCurrent(attempt)) return;
      if (executing) this.markUnknown(attempt, error);
      else this.failAttempt(attempt, error);
    }
    this.changed();
  }

  private async processResult(attemptInput: Attempt, result: ExecutionResult): Promise<void> {
    if (!this.isCurrent(attemptInput)) return;
    const attempt = this.attempt(attemptInput.id), task = this.task(attempt.taskId), goal = this.goal(task.goalId), project = this.project(goal);
    this.options.store.transaction(() => {
      const saved = this.attemptDetail(attempt.id);
      if (!saved.usageAccounted) this.recordSpend(goal.id, result.spend);
      else if (result.spend !== undefined && Number.isFinite(result.spend) && result.spend > (saved.accountedSpend ?? 0)) this.recordSpend(goal.id, result.spend - (saved.accountedSpend ?? 0));
      this.options.store.set(TABLE.attemptDetails, { ...saved, result, usageAccounted: true, accountedSpend: result.spend ?? saved.accountedSpend });
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
          const partial = await this.options.workspaces.capture(retained.workspace, { goal, task, attempt: this.attempt(attempt.id) });
          if (!this.isCurrent(attempt)) return;
          this.options.store.transaction(() => {
            this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), candidate: partial });
            this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(task.id), lastCandidate: partial });
            this.writeAttempt(attempt.id, { candidate: partial.commit });
            this.decision(goal.id, "partial-work-retained", "Useful source from the confirmed failed turn was retained for its repair attempt.", { attemptId: attempt.id, candidate: partial.commit });
          });
        } catch (error) {
          if (!this.isCurrent(attempt)) return;
          this.decision(goal.id, "partial-work-unavailable", "The failed attempt's environment remains preserved, but its candidate could not be captured.", { attemptId: attempt.id, error: this.error(error) });
        }
      }
      this.failAttempt(attempt, result.error || result.text || "The runtime reported failure."); return;
    }
    this.writeAttempt(attempt.id, { status: "succeeded", endedAt: this.now() });
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
      const checks = this.attemptDetail(attempt.id).contract?.checks ?? this.taskChecks(task.id);
      let checkResults = this.attemptDetail(attempt.id).checks;
      if (!checkResults) {
        checkResults = await this.options.workspaces.check(project, candidate, checks);
        if (!this.isCurrent(attempt)) return;
        if (checkResults.some(check => check.candidateCommit !== candidate!.commit)) throw new Error("Verification returned evidence for a different candidate.");
        this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), checks: checkResults });
      }
      if (checkResults.some(check => !check.passed)) throw new Error(`Candidate checks failed:\n${checkResults.filter(check => !check.passed).map(check => `${check.command}\n${check.output}`).join("\n")}`);
      if (checks.some(command => !checkResults!.some(check => check.command === command))) throw new Error("Verification omitted a configured check.");
      if (!this.integrationAllowed(attempt)) { this.changed(); return; }
      this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), phase: "integrating" as const });
      const integration = await this.options.workspaces.integrate(project, candidate, { checks, isCurrent: () => this.integrationAllowed(attempt) });
      if (!this.isCurrent(attempt)) return;
      if (integration.candidateCommit !== candidate.commit) throw new Error("Integration reported a different candidate.");
      if (integration.checks.some(check => !check.passed)) throw new Error("The combined repository did not pass its integration checks.");
      if (checks.some(command => !integration.checks.some(check => check.command === command && check.passed))) throw new Error("Integration omitted a required combined-result check.");
      this.options.store.transaction(() => {
        this.options.store.set(TABLE.attemptDetails, { ...this.attemptDetail(attempt.id), integration, phase: "done" as const });
        this.writeTask(task.id, { status: "completed" });
        this.writeAttempt(attempt.id, { status: "succeeded", endedAt: this.now(), error: undefined });
        this.decision(goal.id, "integrated", `${task.title} integrated at ${integration.commit.slice(0, 12)}.`, { taskId: task.id, attemptId: attempt.id, candidate: candidate.commit, commit: integration.commit, checks: integration.checks });
      });
      if (this.options.workspaces.release) await this.options.workspaces.release(detail.workspace).catch(() => undefined);
    } catch (error) {
      if (this.isCurrent(attempt)) {
        if (this.goal(goal.id).status === "paused") {
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
    const task = this.task(attempt.taskId), goal = this.goal(task.goalId), detail = this.attemptDetail(attempt.id);
    if (!this.options.devices().some(device => device.id === attempt.deviceId && device.online)) {
      if (attempt.status !== "unknown") this.markUnknown(attempt, "The owning device is offline; termination is not known.");
      return;
    }
    try {
      if (detail.phase === "integrating" && detail.candidate && this.options.workspaces.reconcileIntegration) {
        const integrated = await this.options.workspaces.reconcileIntegration(this.project(goal), detail.candidate);
        if (!this.isCurrent(attempt)) return;
        if (integrated) {
          this.options.store.transaction(() => {
            this.options.store.set(TABLE.attemptDetails, { ...detail, integration: integrated, phase: "done" as const });
            this.writeAttempt(attempt.id, { status: "succeeded", endedAt: this.now() });
            this.writeTask(task.id, { status: "completed" });
            this.decision(goal.id, "integration-recovered", "The exact candidate was already integrated before the coordinator restarted.", { attemptId: attempt.id, commit: integrated.commit });
          });
          this.changed(); return;
        }
      }
      if (["capturing", "checking", "integrating"].includes(detail.phase) && detail.result?.status === "succeeded") {
        await this.processResult(attempt, { ...detail.result, spend: undefined }); return;
      }
      const report = await this.options.runtime.reconcile(attempt);
      if (!this.isCurrent(attempt)) return;
      if (report.status === "unknown") {
        if (attempt.status !== "unknown") this.markUnknown(attempt, "The owner has not confirmed the execution outcome."); return;
      }
      if (report.status === "running") {
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
        const result = await this.options.runtime.execute({ goal: this.goal(goal.id), task: this.task(task.id), attempt: this.attempt(attempt.id), workspace, project: this.project(goal), prompt: this.executionPrompt(goal, task), assignmentGoalRevision: this.attemptDetail(attempt.id).assignmentGoalRevision ?? this.attemptDetail(attempt.id).goalRevision });
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
    const task = this.task(taskId), detail = this.taskDetail(taskId), attempt = task.currentAttemptId ? this.attempt(task.currentAttemptId) : undefined;
    const repeated = detail.failureSignatures.length >= 3 && new Set(detail.failureSignatures.slice(-3)).size === 1;
    const prompt = [
      "You are the EnoughFactory repair supervisor. Decide the next concrete action after a confirmed failure. Return JSON {action:'retry'|'replan'|'wait',reason:string,instructions?:string,waitReason?:string,wakeCondition?:string}.",
      "Retry must change the implementation approach or address the observed failure. Replan changes task decomposition or dependencies. Wait only for an identified external condition; do not ask for human permission already granted by project policy.",
      "If a configured check is prose rather than an executable command, or requires future task outputs unrelated to this task's contract, replan to correct the verification scope. Do not make a worker fabricate missing future application layers or repeat unchanged invalid commands. Retain useful candidate work and keep checks proportionate to the task's actual deliverables.",
      repeated ? "Three equivalent failures occurred. Choose a changed decomposition or external wait rather than repeating the same attempt." : "Make a proportionate repair decision and continue.",
      this.context(goal), `Failed task: ${JSON.stringify(task)}`, `Failure: ${detail.lastError}`, `Retained work: ${JSON.stringify(detail.lastCandidate)}`, `Attempt evidence: ${JSON.stringify(attempt ? this.attemptDetail(attempt.id) : {})}`,
    ].join("\n\n");
    try {
      const response = await this.options.runtime.complete({ goal, role: "diagnosis", prompt, project: this.project(goal), signal: this.operationControllers.get(goal.id)?.signal });
      if (!this.operationCurrent(goal.id, operation)) return;
      this.recordSpend(goal.id, response.spend);
      const decision = readJsonObject(response.text);
      if (!["retry", "replan", "wait"].includes(String(decision.action)) || typeof decision.reason !== "string" || !decision.reason.trim()) throw new FactoryDecisionError("Repair decision must specify retry, replan or wait and a reason.");
      if (repeated && decision.action === "retry") decision.action = "replan";
      this.options.store.set(TABLE.control, { ...this.control(goal.id), decisionFailures: undefined });
      this.decision(goal.id, "repair", decision.reason, { action: decision.action, taskId, chatId: response.chatId });
      if (decision.action === "wait") {
        this.options.store.transaction(() => {
          this.options.store.set(TABLE.taskDetails, { ...this.taskDetail(taskId), waitingFor: typeof decision.wakeCondition === "string" ? decision.wakeCondition : "external-condition", waitReason: typeof decision.waitReason === "string" ? decision.waitReason : decision.reason });
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "dispatch", operation: undefined, diagnosisTaskId: undefined });
          this.writeGoal(goal.id, { nextAction: `Waiting for ${task.title}; independent work can continue` });
        });
      } else if (decision.action === "replan") {
        await this.replan(goal.id, decision.reason, taskId);
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
          const report = await this.options.workspaces.checkGoal(project, commands);
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
      const evidence = this.tasks(goal.id).filter(task => task.status === "completed").map(task => ({ task, attempt: task.currentAttemptId ? this.attemptDetail(task.currentAttemptId) : undefined }));
      const prompt = [
        "You are the EnoughFactory completion evaluator. Audit the entire original objective against the actual repository and retained execution evidence. A worker's final response, green unrelated tests or partial implementation do not prove completion.",
        "Inspect/run only meaningful checks needed for uncertain criteria. Return JSON {complete:boolean,summary:string,criteria:[{criterion:string,satisfied:boolean,evidence:string[]}],additionalTasks?:[{key,title,description,kind:'feature'|'unit'|'architecture'|'test',acceptanceCriteria:string[],expectedOutputs:string[],dependsOn:string[],checks:string[]}],waitReason?:string,wakeCondition?:string}. Use task kinds for concrete delivery outcomes, not mandatory role ceremonies.",
        "Use each criterion's exact original text. Every satisfied criterion requires concrete current-state evidence such as files, runtime outcomes, exact commit check records or published URLs. If something remains, add actionable tasks. Never weaken the objective to declare completion. No mandatory human gate applies to autonomous plus approve-all.",
        "Also inspect the accepted tasks' acceptance criteria and expected deliverables. Integration records prove accepted source, not that every requested behavior or deliverable exists. Add concrete follow-up work for any unmet contract that matters to the original objective.",
        "Configured whole-goal checks have already run against the exact integrated snapshot. Do not repeat them merely to restate the evidence. A failed configured check prevents completion: use its concrete command/output to propose focused repair tasks. Checks on a future repaired snapshot will run once after that work integrates. Every additional task check must be an executable shell command scoped to outputs available at that task's completion, never prose or an unrelated whole-product gate.",
        `Whole-goal check evidence: ${JSON.stringify(goalChecks ?? { commands: [], checks: [] })}`,
        this.context(goal), `Repository snapshot: ${JSON.stringify(repository)}`, `Integrated work and check records: ${JSON.stringify(evidence)}`,
      ].join("\n\n");
      const response = await this.options.runtime.complete({ goal, role: "evaluator", prompt, project, signal: this.operationControllers.get(goal.id)?.signal });
      if (!this.operationCurrent(goal.id, operation)) return;
      this.recordSpend(goal.id, response.spend);
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
      this.options.store.set(TABLE.control, { ...this.control(goal.id), decisionFailures: undefined });
      if (evaluation.complete && allSatisfied && goalChecksPassed && !extra.length && !this.tasks(goal.id).some(task => !["completed", "canceled"].includes(task.status))) {
        this.options.store.transaction(() => {
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "done", operation: undefined, manualAction: undefined });
          this.writeGoal(goal.id, { status: "completed", nextAction: "Completion criteria satisfied", error: undefined });
          this.decision(goal.id, "completed", evaluation.summary, { evaluationId: record.id, head: after.head, criteria: evaluation.criteria });
        });
      } else if (evaluation.waitReason) {
        this.options.store.set(TABLE.control, { ...this.control(goal.id), operation: undefined });
        this.wait(goal.id, evaluation.waitReason, evaluation.wakeCondition ?? "external-condition");
      } else if (extra.length) {
        this.options.store.transaction(() => {
          this.writeGoal(goal.id, { revision: this.goal(goal.id).revision + 1, status: "running", nextAction: "Address the remaining acceptance work" });
          this.applyTasks(goal.id, extra, evaluation.summary, this.planRecord(goal.id)?.checks ?? []);
          this.options.store.set(TABLE.control, { ...this.control(goal.id), stage: "dispatch", operation: undefined, manualAction: undefined });
          this.decision(goal.id, "evaluation-follow-up", evaluation.summary, { evaluationId: record.id, tasks: extra.map(task => task.key) });
        });
      } else {
        this.decision(goal.id, "evaluation-incomplete", evaluation.summary || "Completion lacked evidence for all criteria.", { evaluationId: record.id, required });
        await this.replan(goal.id, `Completion remains unproven. ${evaluation.summary}\nUnsatisfied criteria: ${required.filter(criterion => !evaluation.criteria.some(item => item.criterion === criterion && item.satisfied && item.evidence.length)).join("; ")}\n${goalChecksPassed ? "" : `Failed goal checks:\n${goalChecks!.checks.filter(check => !check.passed).map(check => `${check.command}\n${check.output}`).join("\n")}`}`);
      }
      this.changed();
    } catch (error) { this.operationFailed(goal.id, operation, error); }
  }

  private applyTasks(goalId: string, tasks: PlannedTask[], summary: string, checks: string[], preserveTaskIds = new Set<string>()): void {
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
      this.options.store.set<FactoryTask>(TABLE.tasks, { id, goalId, title: task.title, description: task.description, dependsOn: task.dependsOn.map(key => taskKeys[key]!), status: "queued", createdAt: previous?.createdAt ?? at, updatedAt: at, ...(task.deviceId ? { deviceId: task.deviceId } : {}),
        ...(task.kind ?? previous?.kind ? { kind: task.kind ?? previous?.kind } : {}),
        ...(task.acceptanceCriteria ?? previous?.acceptanceCriteria ? { acceptanceCriteria: task.acceptanceCriteria ?? previous?.acceptanceCriteria } : {}),
        ...(task.expectedOutputs ?? previous?.expectedOutputs ? { expectedOutputs: task.expectedOutputs ?? previous?.expectedOutputs } : {}),
        ...(task.estimatedMinutes ?? previous?.estimatedMinutes ? { estimatedMinutes: task.estimatedMinutes ?? previous?.estimatedMinutes } : {}),
        ...(task.writePaths ?? previous?.writePaths ? { writePaths: task.writePaths ?? previous?.writePaths } : {}),
        ...(task.resources ?? previous?.resources ? { resources: task.resources ?? previous?.resources } : {}) });
      this.options.store.set<TaskDetail>(TABLE.taskDetails, { ...previousDetail, id, key: task.key, checks: task.checks, planChecks: [], planRevision: goal.revision, waitingFor: undefined, waitReason: undefined, selected: goal.autonomy === "autonomous", failureSignatures: previousDetail?.failureSignatures ?? [] });
    }
    this.options.store.set<PlanRecord>(TABLE.plans, { id: goalId, goalId, revision: goal.revision, summary, checks, checkScope: "goal", taskKeys, createdAt: at });
  }

  private async replan(goalId: string, reason: string, failedTaskId?: string): Promise<void> {
    const goal = this.goal(goalId), tasks = this.tasks(goalId);
    const scope = failedTaskId ? new Set([failedTaskId, ...descendants(tasks, [failedTaskId])]) : undefined;
    const affected = tasks.filter(task => task.status !== "completed" && (!scope || scope.has(task.id)));
    const attempts = this.attempts(goalId).filter(attempt => (activeAttempts.has(attempt.status) || this.task(attempt.taskId).status === "review") && (!scope || scope.has(attempt.taskId)));
    this.options.store.transaction(() => {
      this.writeGoal(goalId, { revision: goal.revision + 1, status: "planning", nextAction: "Revise the plan from retained evidence" });
      this.options.store.set(TABLE.control, { ...this.control(goalId), stage: "plan", operation: undefined, replanReason: reason, diagnosisTaskId: undefined, replanTaskIds: scope ? affected.map(task => task.id) : undefined });
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
    this.options.store.set(TABLE.control, { ...this.control(goal.id), operation: { id, revision: goal.revision, kind } });
    return id;
  }
  private operationCurrent(goalId: string, id: string): boolean {
    const goal = this.goal(goalId), operation = this.control(goalId).operation;
    return !this.shuttingDown && !!operation && operation.id === id && operation.revision === goal.revision && !terminalGoals.has(goal.status) && goal.status !== "paused";
  }
  private operationFailed(goalId: string, id: string, error: unknown): void {
    if (!this.operationCurrent(goalId, id)) return;
    const control = this.control(goalId);
    if (error instanceof FactoryDecisionError) {
      const signature = createHash("sha256").update(this.error(error)).digest("hex");
      const count = (control.decisionFailures?.count ?? 0) + 1;
      this.options.store.set(TABLE.control, { ...control, operation: undefined, decisionFailures: { signature, count }, replanReason: `${control.replanReason ?? ""}\nThe previous structured decision was rejected: ${this.error(error)}\nReturn the requested JSON schema exactly and correct that failure.` });
      this.decision(goalId, "decision-repair", `The factory is correcting an invalid structured decision: ${this.error(error)}`, { count });
      if (count < 3) { this.writeGoal(goalId, { nextAction: "Correct the structured factory decision", error: undefined }); this.changed(); return; }
    }
    this.options.store.set(TABLE.control, { ...this.control(goalId), operation: undefined });
    this.decision(goalId, "controller-error", this.error(error));
    if (control.stage === "diagnose" || (control.stage === "plan" && control.replanTaskIds?.length)) {
      this.options.store.set(TABLE.control, { ...this.control(goalId), waitingFor: "runtime-available", waitReason: this.error(error) });
      this.writeGoal(goalId, { status: "running", nextAction: "Repair controller is waiting; independent work can continue" });
      this.changed();
    } else this.wait(goalId, this.error(error), "runtime-available");
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
    this.writeAttempt(attempt.id, { status: "unknown", error: this.error(error) });
    const goalId = this.task(attempt.taskId).goalId;
    this.writeGoal(goalId, { nextAction: "Reconcile the owner and its effect journal before retrying" });
    this.decision(goalId, "execution-unknown", this.error(error), { attemptId: attempt.id }); this.changed();
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
    const load = this.activeWork();
    const provider = this.goal(task.goalId).workspaceProvider ?? 'git';
    return this.options.devices().filter(device => device.online && (provider === 'git' || device.workspaceProviders?.includes(provider)) && (!task.deviceId || task.deviceId === device.id) && !placementConstraint(task, device, load))
      .sort((a, b) => load.filter(item => item.deviceId === a.id).length / (a.capacity ?? 2) - load.filter(item => item.deviceId === b.id).length / (b.capacity ?? 2) || Number(b.local) - Number(a.local) || a.id.localeCompare(b.id))[0];
  }
  private activeWork(): FactoryTask[] {
    const attempts = this.options.store.list<Attempt>(TABLE.attempts);
    const details = new Map(attempts.map(attempt => [attempt.id, this.options.store.get<AttemptDetail>(TABLE.attemptDetails, attempt.id)]));
    const unconfirmed = new Set(attempts.filter(attempt => attempt.status === "retired" && details.get(attempt.id)?.cancellation === "requested").map(attempt => attempt.id));
    return activeExecutionTasks(this.options.store.list<FactoryTask>(TABLE.tasks), attempts, unconfirmed, new Map(attempts.map(attempt => [attempt.id, details.get(attempt.id)?.contract])));
  }
  private hasAvailableDevice(goal: Goal): boolean {
    return this.tasks(goal.id).filter(task => ["queued", "ready"].includes(task.status)).some(task => !!this.place(task));
  }
  private checkBudget(goal: Goal): boolean {
    const control = this.control(goal.id), attempts = this.attempts(goal.id).length;
    const reason = goal.maxSpend !== undefined && control.spent >= goal.maxSpend ? `Configured spend budget reached (${control.spent}).` :
      goal.maxAttempts !== undefined && attempts >= goal.maxAttempts && this.tasks(goal.id).some(task => ["queued", "ready", "failed"].includes(task.status)) ? `Configured attempt budget reached (${attempts}).` :
      control.maxDurationMs !== undefined && Date.parse(this.now()) - Date.parse(control.startedAt) >= control.maxDurationMs ? "Configured time budget reached." : undefined;
    if (!reason) return false;
    this.wait(goal.id, reason, "budget-changed"); return true;
  }
  private recordSpend(goalId: string, spend?: number): void {
    const control = this.control(goalId);
    if (spend === undefined || !Number.isFinite(spend) || spend < 0) {
      this.options.store.set(TABLE.control, { ...control, unpricedTurns: (control.unpricedTurns ?? 0) + 1 }); return;
    }
    this.options.store.set(TABLE.control, { ...control, spent: control.spent + spend });
  }
  private nextStage(goalId: string): ControlRecord["stage"] {
    if (!this.planRecord(goalId) || this.control(goalId).replanTaskIds?.length) return "plan";
    // Dispatch chooses a current nonwaiting failed task and persists its diagnosis identity.
    // A branch waiting on its own condition must not stop the other branches when a device returns.
    if (this.tasks(goalId).some(task => !["completed", "canceled"].includes(task.status))) return "dispatch";
    return "evaluate";
  }
  private wait(goalId: string, reason: string, condition: string): void {
    if (terminalGoals.has(this.goal(goalId).status) || this.goal(goalId).status === "paused") return;
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...this.control(goalId), waitingFor: condition, waitReason: reason, operation: undefined });
      this.writeGoal(goalId, { status: "waiting", error: reason, nextAction: reason });
      this.decision(goalId, "waiting", reason, { condition });
    }); this.changed();
  }
  private wake(goalId: string, reason: string): void {
    const goal = this.goal(goalId), stage = this.nextStage(goalId);
    this.options.store.transaction(() => {
      this.options.store.set(TABLE.control, { ...this.control(goalId), stage, waitingFor: undefined, waitReason: undefined, wakeAt: undefined });
      this.writeGoal(goalId, { status: stage === "plan" ? "planning" : "running", error: undefined, nextAction: reason });
      this.decision(goal.id, "woken", reason);
    });
  }
  private context(goal: Goal): string {
    const control = this.control(goal.id);
    return `Original objective:\n${goal.objective}\n\nRequired completion criteria:\n${goal.criteria.map(value => `- ${value}`).join("\n")}\n\nAutonomy: ${goal.autonomy}; approvals: ${goal.approvalMode}.\n\nSteering context:\n${control.steering.join("\n")}\n\nReplanning reason:\n${control.replanReason ?? "Initial plan"}`;
  }
  private executionPrompt(goal: Goal, task: FactoryTask): string {
    const guidance = {
      feature: "Feature contract: deliver the observable product behavior across the necessary layers. Account for the acceptance scenarios, including relevant failure or loading behavior. Report concrete behavior and evidence rather than only implementation details.",
      unit: "Unit contract: complete the bounded component or change described by this task. Preserve surrounding interfaces and integrate with its callers. Verify the relevant behavior without expanding into unrelated work.",
      architecture: "Architecture contract: resolve the structural decision against the actual source and requirements. Preserve the chosen design, rationale, tradeoffs and actionable handoff in repository deliverables. Implement a technical foundation only when the task asks for it; a conversational proposal alone is not a deliverable.",
      test: "Test contract: address the identified verification uncertainty with meaningful checks or product scenarios. Record actual results and limitations, and preserve reusable verification where requested. Do not add tests that merely mirror implementation or claim evidence from checks you did not run.",
    };
    return ["You are executing an EnoughFactory task inside its isolated full-permission container. Make routine decisions and deliver the requested outcome. Run focused relevant checks, preserve useful work, and finish with evidence of what actually changed. Do not stop at a proposal.", this.context(goal), `Task: ${task.title}\n${task.description}`, task.kind ? guidance[task.kind] : "Generic task contract: complete the described work and provide concrete evidence of its outcome.",
      `Task acceptance criteria:\n${task.acceptanceCriteria?.map(value => `- ${value}`).join("\n") || "Use the task description and goal criteria."}`,
      `Expected deliverables:\n${task.expectedOutputs?.map(value => `- ${value}`).join("\n") || "Preserved changes and a factual outcome summary."}`,
      `Planned write paths: ${JSON.stringify(task.writePaths ?? "Not declared on this legacy task")}. Other independent work may run in parallel. Preserve shared interfaces, keep changes focused on this task and report any necessary changes outside its declared scope. These paths coordinate ownership; your container retains full permissions.`,
      `Repair instructions: ${this.taskDetail(task.id).repairInstructions ?? "None"}`, `Configured checks: ${JSON.stringify(this.taskDetail(task.id).checks)}`, "The factory will capture and integrate the exact candidate. Do not merge into another attempt's workspace. Project-configured deployment capabilities are authorized according to the goal policy; report any uncertain external effects explicitly."].join("\n\n");
  }
  private goals(): Goal[] { return this.options.store.list<Goal>(TABLE.goals); }
  private goal(id: string): Goal { const value = this.options.store.get<Goal>(TABLE.goals, id); if (!value) throw new Error("Goal not found."); return value; }
  private tasks(goalId: string): FactoryTask[] { return this.options.store.list<FactoryTask>(TABLE.tasks).filter(task => task.goalId === goalId); }
  private task(id: string): FactoryTask { const value = this.options.store.get<FactoryTask>(TABLE.tasks, id); if (!value) throw new Error("Task not found."); return value; }
  private attempts(goalId: string): Attempt[] { const ids = new Set(this.tasks(goalId).map(task => task.id)); return this.options.store.list<Attempt>(TABLE.attempts).filter(attempt => ids.has(attempt.taskId)); }
  private attempt(id: string): Attempt { const value = this.options.store.get<Attempt>(TABLE.attempts, id); if (!value) throw new Error("Attempt not found."); return value; }
  private control(id: string): ControlRecord { const value = this.options.store.get<ControlRecord>(TABLE.control, id); if (!value) throw new Error("Factory control record missing."); return value; }
  private taskDetail(id: string): TaskDetail { const value = this.options.store.get<TaskDetail>(TABLE.taskDetails, id); if (!value) throw new Error("Task details missing."); return value; }
  private attemptDetail(id: string): AttemptDetail { const value = this.options.store.get<AttemptDetail>(TABLE.attemptDetails, id); if (!value) throw new Error("Attempt details missing."); return value; }
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
