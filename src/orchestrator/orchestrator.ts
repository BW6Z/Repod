import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import type { Preset, RepodConfig, Tier } from "../config/schema.ts";
import { LedgerWriteError } from "../gateway/gateway.ts";
import type { LedgerWriter } from "../gateway/ledger.ts";
import type { FailureKind, ModelRequest, ModelResult, Role } from "../gateway/types.ts";
import { VISIBLE_TESTS, runCheck as defaultRunCheck, type CheckResult, type CheckSpec } from "../verifier/verifier.ts";
import { PathRejectedError, isProtected, normalizeRelativePath, resolveAllowedPath } from "../workspace/paths.ts";
import { renderRepoSummary, summarizeRepo } from "../workspace/summary.ts";
import {
  OutputRejectedError,
  WorkspaceTaintedError,
  applyExecutorOutput,
  captureSnapshot,
  diffAgainstBaseline,
  listFiles,
  markTainted,
  snapshotManifest,
  type RunWorkspace,
} from "../workspace/workspace.ts";
import { groupTestPaths, type CheckGroup } from "./check-groups.ts";
import { buildExecutorInput, readContextFiles, type PreviousAttempt } from "./context.ts";
import { validatePlan, type PlanIssue } from "./plan-validation.ts";
import { systemPrompt, type PromptKind } from "./prompts.ts";
import { applyCapabilityFloor, executorModels, reviewRequirement, type CheckKind, type FloorDecision } from "./routing.ts";
import {
  ExecutorOutput,
  PlanResponse,
  ReviewOutput,
  RunSummary,
  TriageDecision,
  type ClarifyingQuestion,
  type PlannedTask,
  type ReviewFinding,
} from "./schemas.ts";
import { COST_PHASES, type CostPhase, type RunReport, type TaskOutcome } from "./state.ts";

/** The gateway as the pipeline sees it; tests pass a scripted fake. */
export interface ModelCaller {
  call<T>(request: ModelRequest<T>): Promise<ModelResult<T>>;
}

export type PlanReview = { approve: true } | { approve: false; feedback: string };

/**
 * The only points where the user takes part. Everything before execution is
 * the conversation with Meta; once execution starts there are no hooks.
 */
export interface PipelineHooks {
  answerQuestions(questions: ClarifyingQuestion[], message: string): Promise<Record<string, string>>;
  reviewPlan(plan: PlanResponse, decisions: FloorDecision[], warnings: PlanIssue[]): Promise<PlanReview>;
}

/** Experiment runs: default answers and automatic approval, so runs are repeatable. */
export const experimentHooks: PipelineHooks = {
  async answerQuestions(questions) {
    return Object.fromEntries(questions.map((q) => [q.id, q.default]));
  },
  async reviewPlan() {
    return { approve: true };
  },
};

export interface PipelineOptions {
  request: string;
  config: RepodConfig;
  preset: Preset;
  gateway: ModelCaller;
  ledger: LedgerWriter;
  workspace: RunWorkspace;
  contract: string; // interface conventions of the repository being changed
  devChecks: CheckSpec[]; // run after every attempt and once more on the final result
  holdoutChecks: CheckSpec[]; // run once after freezing; never shown to a model
  checkGroups: CheckGroup[]; // visible test groups, added to test/ as their tasks run
  // Tests in the baseline's own test files. With it and every group's
  // expectedTests, each visible test run must execute at least that many.
  baselineTests?: number;
  visibleTestsDir: string | null; // folder holding the groups' test files
  availableChecks: ReadonlySet<CheckKind>;
  remainingBudgetUsd: number; // for the plan's budget warning
  hooks: PipelineHooks;
  runCheck?: (spec: CheckSpec) => Promise<CheckResult>; // injectable for tests
  // Experiment arm A: no coordinator. This one task is the whole plan and
  // runs on the model it names. Failed attempts are repaired without triage
  // (no guidance) until the run's rework limit; there is no review and no
  // closing summary. Everything else (checks, write scope, limits, freeze,
  // holdout) is the same as in a coordinated run.
  singleModelTask?: PlannedTask;
}

/**
 * Runs one request end to end:
 *   1. prepare    repository summary for planning
 *   2. plan       Meta asks clarifying questions or returns a plan (validated)
 *   3. approve    the user approves, or sends the plan back once
 *   4. execute    tasks in dependency order, one writer at a time; checks after
 *                 every attempt; Meta triages failures within fixed limits
 *   5. review     a strong model reviews tasks that require it
 *   6. freeze     re-check the integrated result, hash every file, run holdout
 *                 checks once without feedback
 *   7. summarize  Meta writes the closing message; the program owns all figures
 */
export async function runPipeline(options: PipelineOptions): Promise<RunReport> {
  return new Run(options).execute();
}

/**
 * Why a retryable attempt failed, which decides what may follow it:
 *   - check:           the code was written and a check failed; repair, or
 *                      escalate to a stronger model
 *   - rejected-output: the reply broke the program's rules (write scope, a
 *                      stale version, no files, a bad file request); the
 *                      reason can be stated, so it may be repaired, but a
 *                      stronger model is no answer to a broken rule
 * A reply that still fails the schema after the gateway's one format repair
 * is not retried at all (repod-plan.md 4.3: repair the format once, never
 * escalate for it); it stops the task.
 */
type RetryCategory = "check" | "rejected-output";

type AttemptResult =
  | { kind: "passed" }
  | { kind: "retry"; category: RetryCategory; reason: string; evidence: string }
  | { kind: "stop-task"; reason: string } // more attempts on this task cannot help
  | { kind: "stop-run"; reason: string }; // the environment or budget is broken: stop everything

// Failures of a model call that end the whole run: retrying or escalating
// cannot fix a spent budget, a billing problem or a rejected request.
const RUN_STOPPING: ReadonlySet<FailureKind> = new Set(["budget", "quota", "rejected", "network", "rate_limited"]);

// Check failures that point at the environment rather than the code, so a
// stronger model would not help. A timeout is not among them: an infinite
// loop written by an executor is a code problem worth repairing.
const ENVIRONMENT_FAILURES = new Set(["spawn_error", "no_tests"]);

const MAX_EVIDENCE_CHARS = 8000;

class Run {
  private readonly o: PipelineOptions;
  private readonly runCheck: (spec: CheckSpec) => Promise<CheckResult>;
  private readonly problems: string[] = [];
  private stopReason: string | null = null;
  private reworks = 0;
  private callCounter = 0;
  // Task results as they finish, kept on the run rather than in a local, so
  // an exception later in the run cannot lose results already obtained.
  private readonly outcomes = new Map<string, TaskOutcome>();
  private runningTask: string | null = null;
  // Check groups whose test files are in the workspace right now.
  private readonly presentGroups = new Set<string>();
  // null once any call in the phase had an unknown cost.
  private readonly phaseCost: Record<CostPhase, number | null> = { coordination: 0, execution: 0, rework: 0, review: 0 };

  constructor(options: PipelineOptions) {
    this.o = options;
    this.runCheck = options.runCheck ?? ((spec) => defaultRunCheck(spec));
  }

  async execute(): Promise<RunReport> {
    const single = this.o.singleModelTask ?? null;
    const report: RunReport = {
      mode: single ? "single-model" : "coordinated",
      status: "incomplete",
      plan: null,
      tasks: [],
      pendingCheckGroups: [],
      findings: [],
      finalChecks: [],
      holdout: [],
      manifest: null,
      frozenIntact: null,
      problems: this.problems,
      summary: null,
      costUsd: null,
      costByPhase: this.phaseCost,
    };
    await this.o.ledger.append({ type: "run_started", preset: this.o.preset.name, request: this.o.request });

    try {
      const knownFiles = await listFiles(this.o.workspace.root);
      const repoSummary = renderRepoSummary(await summarizeRepo(this.o.workspace.root));
      report.plan = single
        ? await this.singleModelPlan(single, new Set(knownFiles))
        : await this.planAndApprove(repoSummary, new Set(knownFiles));

      if (report.plan) {
        report.tasks = await this.executeTasks(report.plan);
        if (!single) report.findings = await this.review(report.plan, report.tasks);
        if (!this.stopReason && report.tasks.every((t) => t.status === "passed")) {
          await this.freeze(report);
        }
        if (!single) report.summary = await this.summarize(report);
      }
    } catch (error) {
      // Ledger faults and other unexpected errors end the run; the report
      // still says what was done before it.
      const message = error instanceof LedgerWriteError ? error.message : `unexpected error: ${(error as Error).message}`;
      this.stop(message);
    }
    // Every planned task appears, in plan order, whether or not the run got
    // that far: finished tasks with their results, the task that was running
    // when the run stopped as stopped, the rest as skipped.
    if (report.plan) report.tasks = report.plan.map((t) => this.outcomes.get(t.id) ?? this.notRun(t, t.id === this.runningTask ? "stopped" : "skipped"));

    if (this.stopReason) this.problems.unshift(`run stopped: ${this.stopReason}`);
    for (const task of report.tasks) {
      if (task.status !== "passed") this.problems.push(`${task.taskId} ${task.status}: ${task.reason ?? "no reason recorded"}`);
    }
    // A group counts as checked only when the task that owns it passed.
    const passed = new Set(report.tasks.filter((t) => t.status === "passed").map((t) => t.taskId));
    report.pendingCheckGroups = this.o.checkGroups
      .filter((g) => !report.plan?.some((t) => t.check_groups.includes(g.name) && passed.has(t.id)))
      .map((g) => g.name);
    report.status = report.plan !== null && this.problems.length === 0 ? "completed" : "incomplete";
    const costs = COST_PHASES.map((phase) => this.phaseCost[phase]);
    report.costUsd = costs.includes(null) ? null : costs.reduce<number>((sum, cost) => sum + cost!, 0);

    await this.o.ledger
      .append({ type: "run_finished", status: report.status, summary: report.summary?.message ?? null })
      .catch(() => {}); // the report is still returned if this last write fails
    return report;
  }

  private stop(reason: string): void {
    this.stopReason ??= reason;
  }

  // ---- model calls -------------------------------------------------------

  private async callModel<T>(
    phase: CostPhase,
    role: Role,
    model: string,
    prompt: PromptKind,
    schema: ZodType<T>,
    schemaName: string,
    input: string,
    taskId: string | null,
  ): Promise<ModelResult<T>> {
    const maxOutputTokens = this.o.config.limits.maxOutputTokens[role];
    const addCost = (costUsd: number | null) => {
      const spent = this.phaseCost[phase];
      this.phaseCost[phase] = spent === null || costUsd === null ? null : spent + costUsd;
    };
    let result: ModelResult<T>;
    try {
      result = await this.o.gateway.call({
        role,
        model,
        system: systemPrompt(prompt),
        input,
        schema,
        schemaName,
        maxOutputTokens,
        taskId,
        attemptId: `${taskId ?? "run"}-${prompt}-${++this.callCounter}`,
      });
    } catch (error) {
      // The call may have been paid for before its ledger write failed; the
      // run stops on this error, but its report must not understate cost.
      if (error instanceof LedgerWriteError) addCost(error.costUsd);
      throw error;
    }
    addCost(result.costUsd);
    if (!result.ok && RUN_STOPPING.has(result.failure)) this.stop(`${prompt} call failed (${result.failure}): ${result.detail}`);
    return result;
  }

  private callCoordinator<T>(phase: CostPhase, prompt: PromptKind, schema: ZodType<T>, schemaName: string, input: string) {
    return this.callModel(phase, "coordinator", this.o.preset.coordinator, prompt, schema, schemaName, input, null);
  }

  // ---- 2 and 3: plan and approve ------------------------------------------

  private planInput(repoSummary: string): string {
    const { preset, config } = this.o;
    const models = [...executorModels(preset)].map((id) => {
      const tier = preset.models.find((m) => m.id === id)?.tier;
      const price = config.pricing.prices.find((p) => p.model === id);
      const cost = price ? `$${price.inputPerMTok} in / $${price.outputPerMTok} out per million tokens` : "price unknown";
      return `- ${id}: ${tier} tier, ${cost}`;
    });
    return [
      "# User request",
      this.o.request,
      "# Repository summary",
      repoSummary,
      "# Executor models",
      models.join("\n"),
      ...(this.o.checkGroups.length > 0
        ? [
            "# Check groups (assign every group to exactly one task in check_groups)",
            this.o.checkGroups
              .map((g) => `- ${g.name}: ${g.description}${g.requires.length ? ` (requires: ${g.requires.join(", ")})` : ""}`)
              .join("\n"),
          ]
        : []),
      "# Limits",
      `At most ${config.limits.maxClarifyingQuestions} clarifying questions, asked once.`,
    ].join("\n\n");
  }

  private async validate(plan: PlanResponse, knownFiles: Set<string>): Promise<PlanIssue[]> {
    const { config, preset, remainingBudgetUsd, checkGroups } = this.o;
    const issues = validatePlan(plan, { knownFiles, preset, limits: config.limits, pricing: config.pricing, remainingBudgetUsd, checkGroups });
    return [...issues, ...(await this.writePathIssues(plan))];
  }

  /**
   * What validatePlan cannot see without the file system: a write path that
   * is an existing folder, or lies below an existing file, cannot be
   * written. Caught here it costs a re-plan instead of stopping the run.
   * Paths that already fail the text checks are reported by validatePlan.
   */
  private async writePathIssues(plan: PlanResponse): Promise<PlanIssue[]> {
    const issues: PlanIssue[] = [];
    for (const task of plan.tasks) {
      for (const file of task.write_files) {
        try {
          if (isProtected(normalizeRelativePath(file))) continue;
        } catch {
          continue;
        }
        try {
          await resolveAllowedPath(this.o.workspace.root, file);
        } catch (error) {
          if (!(error instanceof PathRejectedError)) throw error;
          issues.push({ severity: "error", taskId: task.id, message: error.message });
        }
      }
    }
    return issues;
  }

  private async requestPlan(prompt: PromptKind, input: string, knownFiles: Set<string>, mustBePlan: boolean): Promise<PlanResponse | null> {
    let result = await this.callCoordinator("coordination", prompt, PlanResponse, "plan_response", input);
    if (!result.ok) {
      this.stop(`planning failed (${result.failure}): ${result.detail}`);
      return null;
    }
    let errors = (await this.validate(result.data, knownFiles)).filter((i) => i.severity === "error");
    if (mustBePlan && result.data.kind !== "plan") errors.push({ severity: "error", taskId: null, message: "a plan was required" });

    if (errors.length > 0) {
      // One chance to fix a rejected plan, then the run stops.
      const fixInput = `${input}\n\n# Your previous reply was rejected\n${JSON.stringify(result.data)}\n\nProblems:\n${errors.map((e) => `- ${e.taskId ?? "plan"}: ${e.message}`).join("\n")}`;
      result = await this.callCoordinator("coordination", prompt, PlanResponse, "plan_response", fixInput);
      if (!result.ok) {
        this.stop(`planning failed (${result.failure}): ${result.detail}`);
        return null;
      }
      errors = (await this.validate(result.data, knownFiles)).filter((i) => i.severity === "error");
      if (mustBePlan && result.data.kind !== "plan") errors.push({ severity: "error", taskId: null, message: "a plan was required" });
      if (errors.length > 0) {
        this.stop(`the plan is still invalid: ${errors.map((e) => e.message).join("; ")}`);
        return null;
      }
    }
    return result.data;
  }

  /**
   * Arm A's fixed plan. It comes from trusted configuration, but it is
   * validated like any plan, so a mistake in it (a protected write, an
   * unknown model) stops the run instead of running something else.
   */
  private async singleModelPlan(task: PlannedTask, knownFiles: Set<string>): Promise<PlannedTask[] | null> {
    const plan: PlanResponse = { kind: "plan", message: "", questions: [], tasks: [task] };
    const errors = (await this.validate(plan, knownFiles)).filter((i) => i.severity === "error");
    if (errors.length > 0) {
      this.stop(`the single-model task is invalid: ${errors.map((e) => e.message).join("; ")}`);
      return null;
    }
    return plan.tasks;
  }

  private async planAndApprove(repoSummary: string, knownFiles: Set<string>): Promise<PlannedTask[] | null> {
    const base = this.planInput(repoSummary);
    let plan = await this.requestPlan("plan", base, knownFiles, false);
    if (!plan) return null;

    let planInput = base;
    if (plan.kind === "questions") {
      const answers = await this.o.hooks.answerQuestions(plan.questions, plan.message);
      const answered = plan.questions.map((q) => `- ${q.question}\n  Answer: ${answers[q.id] ?? q.default}`).join("\n");
      planInput = `${base}\n\n# Answers to your questions\n${answered}\n\nReturn kind "plan" now; do not ask more questions.`;
      plan = await this.requestPlan("plan", planInput, knownFiles, true);
      if (!plan) return null;
    }

    const warnings = async (p: PlanResponse) => (await this.validate(p, knownFiles)).filter((i) => i.severity === "warning");
    const decisions = (p: PlanResponse) => p.tasks.map((t) => applyCapabilityFloor(t, this.o.preset));

    let review = await this.o.hooks.reviewPlan(plan, decisions(plan), await warnings(plan));
    if (!review.approve) {
      if (this.o.config.limits.maxPlanRevisions < 1) {
        this.stop("the plan was not approved");
        return null;
      }
      const reviseInput = `${planInput}\n\n# Your plan\n${JSON.stringify(plan)}\n\n# User feedback\n${review.feedback}`;
      const revised = await this.requestPlan("revise_plan", reviseInput, knownFiles, true);
      if (!revised) return null;
      plan = revised;
      // The revised plan can only be approved; there is no second revision.
      review = await this.o.hooks.reviewPlan(plan, decisions(plan), await warnings(plan));
      if (!review.approve) {
        this.stop("the revised plan was not approved");
        return null;
      }
    }
    return plan.tasks;
  }

  // ---- 4: execute -----------------------------------------------------------

  /** The outcome of a task that did not get to run its own attempts. */
  private notRun(task: PlannedTask, status: "skipped" | "stopped" | "failed", reason?: string): TaskOutcome {
    return {
      taskId: task.id, status,
      // The model it would have run on (after the floor), not Meta's raw choice.
      model: applyCapabilityFloor(task, this.o.preset).model,
      attempts: 0, escalated: false, floorReason: null,
      reason: reason ?? (status === "stopped" ? "the run stopped while this task was running" : "the run had stopped"),
      reviewRequired: false,
    };
  }

  private async executeTasks(tasks: PlannedTask[]): Promise<TaskOutcome[]> {
    for (const task of dependencyOrder(tasks)) {
      const failedDependency = task.depends_on.find((dep) => this.outcomes.get(dep)?.status !== "passed");
      let outcome: TaskOutcome;
      if (this.stopReason) outcome = this.notRun(task, "skipped");
      else if (failedDependency) outcome = this.notRun(task, "skipped", `dependency ${failedDependency} did not pass`);
      else {
        this.runningTask = task.id;
        outcome = await this.executeTaskWithGroups(task);
        this.runningTask = null;
      }
      // Recorded before the ledger write, so a failing write cannot lose it.
      this.outcomes.set(task.id, outcome);
      await this.o.ledger.append({ type: "task_status", taskId: task.id, status: outcome.status, detail: outcome.reason });
    }
    return tasks.map((t) => this.outcomes.get(t.id)!);
  }

  /**
   * Runs a task between two pieces of bookkeeping.
   *
   * Before: the task's check groups are added to the workspace's test folder,
   * so its checks include its own tests and those of finished tasks, but
   * never tests for work that comes later; and the current content of its
   * write scope is recorded.
   *
   * After a task that did not pass: its files are restored and its tests are
   * removed, so a failed task leaves nothing behind that could fail unrelated
   * later tasks. The report lists its groups as pending.
   */
  private async executeTaskWithGroups(task: PlannedTask): Promise<TaskOutcome> {
    const root = this.o.workspace.root;
    const tests = groupTestPaths(this.o.checkGroups, task.check_groups);
    if (tests.length > 0 && this.o.visibleTestsDir === null) throw new Error("check groups are configured without a visible tests folder");
    const target = (file: string) => path.join(root, ...file.split("/"));

    const original = new Map<string, Buffer | null>();
    for (const file of task.write_files) {
      let resolved: string;
      try {
        resolved = await resolveAllowedPath(root, file);
      } catch (error) {
        // Checked at planning time; an earlier task can still have made the
        // path unusable. Nothing has been changed for this task yet.
        if (!(error instanceof PathRejectedError)) throw error;
        return this.notRun(task, "failed", `cannot write ${file}: ${error.message}`);
      }
      original.set(resolved, await readFile(resolved).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }));
    }
    await mkdir(path.join(root, "test"), { recursive: true });
    for (const file of tests) {
      await copyFile(path.join(this.o.visibleTestsDir!, path.basename(file)), target(file));
    }
    for (const name of task.check_groups) this.presentGroups.add(name);

    const outcome = await this.executeTask(task);

    if (outcome.status !== "passed" && !this.o.workspace.tainted) {
      for (const [file, content] of original) {
        if (content === null) await rm(file, { force: true });
        else await writeFile(file, content);
      }
      for (const file of tests) await rm(target(file), { force: true });
      for (const name of task.check_groups) this.presentGroups.delete(name);
    }
    return outcome;
  }

  private tierOf(model: string): Tier | undefined {
    return this.o.preset.models.find((m) => m.id === model)?.tier;
  }

  private async executeTask(task: PlannedTask): Promise<TaskOutcome> {
    const { preset, config, availableChecks } = this.o;
    const limits = config.limits;
    const floor = applyCapabilityFloor(task, preset);
    const requirement = reviewRequirement(task, availableChecks);

    let model = floor.model;
    let escalated = false;
    let tierAttempts = 0;
    let attempts = 0;
    let previous: PreviousAttempt | null = null;
    let guidance: string | null = null;
    const finish = (status: TaskOutcome["status"], reason: string | null): TaskOutcome => ({
      taskId: task.id, status, model, attempts, escalated, floorReason: floor.reason, reason,
      reviewRequired: requirement.reviewRequired,
    });

    if (!requirement.allowed) return finish("stopped", requirement.reasons.join("; "));
    await this.o.ledger.append({ type: "task_status", taskId: task.id, status: "running", detail: floor.reason });

    for (;;) {
      const attempt = await this.attempt(task, model, previous, guidance);
      attempts++;
      tierAttempts++;
      if (attempt.kind === "passed") return finish("passed", null);
      if (attempt.kind === "stop-run") {
        this.stop(attempt.reason);
        return finish("stopped", attempt.reason);
      }
      if (attempt.kind === "stop-task") return finish("failed", attempt.reason);

      // A retryable failure: the program decides what is allowed, Meta picks.
      this.reworks++;
      if (this.reworks > limits.maxTotalReworks) return finish("failed", `rework limit reached: ${attempt.reason}`);
      if (this.o.singleModelTask) {
        // No coordinator to triage: the one task keeps repairing, without
        // guidance, until the run-wide rework limit above ends it. That
        // limit bounds a coordinated run's total repairs in the same way.
        previous = { model, diff: await diffAgainstBaseline(this.o.workspace, task.write_files), failure: attempt.evidence };
        guidance = null;
        continue;
      }
      const maxForTier = this.tierOf(model) === "strong" ? limits.strongAttemptsPerTask : limits.cheapAttemptsPerTask;
      const canRepair = tierAttempts < maxForTier;
      const canEscalate = attempt.category === "check" && !escalated && limits.maxEscalationsPerTask > 0 && this.tierOf(model) !== "strong";
      if (!canRepair && !canEscalate) return finish("failed", `attempts exhausted: ${attempt.reason}`);

      const decision = await this.triage(task, model, attempt, canRepair, canEscalate);
      if (this.stopReason) return finish("stopped", this.stopReason);
      let next = decision.decision;
      if (next === "repair" && !canRepair) next = canEscalate ? "escalate" : "stop";
      if (next === "escalate" && !canEscalate) next = canRepair ? "repair" : "stop";
      if (next === "stop") return finish("failed", `coordinator stopped the task: ${decision.reason}`);

      // The next attempt continues from the current changes rather than
      // starting over, so it needs the diff and the failure evidence.
      previous = { model, diff: await diffAgainstBaseline(this.o.workspace, task.write_files), failure: attempt.evidence };
      guidance = decision.instructions;
      if (next === "escalate") {
        model = preset.roles.critical;
        escalated = true;
        tierAttempts = 0;
      }
    }
  }

  private async triage(
    task: PlannedTask,
    model: string,
    attempt: Extract<AttemptResult, { kind: "retry" }>,
    canRepair: boolean,
    canEscalate: boolean,
  ): Promise<TriageDecision> {
    const allowed = [canRepair && "repair", canEscalate && "escalate", "stop"].filter(Boolean).join(", ");
    const input = [
      `# Task ${task.id}: ${task.title}`,
      task.description,
      `Model of the failed attempt: ${model}`,
      `# Failure (${attempt.category})\n${attempt.reason}\n\n${attempt.evidence.slice(0, MAX_EVIDENCE_CHARS)}`,
      `# Allowed decisions\n${allowed}`,
    ].join("\n\n");
    const result = await this.callCoordinator("rework", "triage", TriageDecision, "triage_decision", input);
    if (result.ok) return result.data;
    // Without a usable triage reply the program falls back to its own rule:
    // repair while attempts remain, then escalate.
    return {
      decision: canRepair ? "repair" : "escalate",
      reason: `triage unavailable (${result.failure}); program default`,
      instructions: "",
    };
  }

  private async attempt(
    task: PlannedTask,
    model: string,
    previous: PreviousAttempt | null,
    guidance: string | null,
  ): Promise<AttemptResult> {
    const { workspace, config, contract } = this.o;
    const limits = config.limits;
    let needFilesUsed = false;
    let extraFiles: string[] = [];

    for (;;) {
      const existing = new Set((await listFiles(workspace.root)).map((f) => f.toLowerCase()));
      const exists = (file: string) => existing.has(normalizeRelativePath(file).toLowerCase());
      // The plan may name a file a dependency was going to create. If it was
      // not created, stop here instead of calling the executor without it.
      const missing = task.context_files.filter((f) => !exists(f));
      if (missing.length > 0) {
        return { kind: "stop-task", reason: `context file(s) missing before execution, not created by the tasks it depends on: ${missing.join(", ")}` };
      }
      // The task's own visible tests are always shown: they define "done".
      const ownTests = groupTestPaths(this.o.checkGroups, task.check_groups);
      const readPaths = unique([...task.context_files, ...task.write_files.filter(exists), ...ownTests, ...extraFiles]);
      let files: Awaited<ReturnType<typeof readContextFiles>>;
      let snapshot: Awaited<ReturnType<typeof captureSnapshot>>;
      try {
        files = await readContextFiles(workspace.root, readPaths);
        // Taken now and compared right before writing (see applyExecutorOutput).
        snapshot = await captureSnapshot(workspace, unique([...readPaths, ...task.write_files]));
      } catch (error) {
        // The plan was checked against the baseline; an earlier task can
        // still have made a path unusable (a file where a folder is needed).
        if (!(error instanceof PathRejectedError)) throw error;
        return { kind: "stop-task", reason: `cannot prepare the task's files: ${error.message}` };
      }
      const needFilesAllowed = !needFilesUsed && limits.maxNeedFilesRequests > 0;
      const { input, contextVersion } = buildExecutorInput({ task, files, contract, previous, guidance, needFilesAllowed });

      const phase = previous === null ? "execution" : "rework";
      const result = await this.callModel(phase, "executor", model, "execute", ExecutorOutput, "executor_output", input, task.id);
      if (!result.ok) {
        if (RUN_STOPPING.has(result.failure)) return { kind: "stop-run", reason: `executor call failed (${result.failure}): ${result.detail}` };
        if (result.failure === "format") {
          return { kind: "stop-task", reason: `executor output still did not match the schema after the format repair: ${result.detail}` };
        }
        return { kind: "stop-task", reason: `executor ${result.failure}: ${result.detail}` };
      }

      const output = result.data;
      if (output.need_files.length > 0 && output.files.length === 0) {
        const rejected = (reason: string, evidence: string): AttemptResult => ({ kind: "retry", category: "rejected-output", reason, evidence });
        if (!needFilesAllowed) return rejected("asked for more files after the allowance was used", output.notes);
        try {
          const missing = output.need_files.filter((f) => !exists(f));
          if (missing.length > 0) return rejected("asked for files that do not exist", missing.join(", "));
        } catch (error) {
          if (!(error instanceof PathRejectedError)) throw error;
          return rejected("asked for an invalid path", error.message);
        }
        needFilesUsed = true;
        extraFiles = output.need_files;
        continue;
      }

      // An output that changes nothing would pass any task whose checks
      // already pass at the start; it is not a result.
      if (output.files.length === 0) {
        return { kind: "retry", category: "rejected-output", reason: "no files returned", evidence: output.notes };
      }
      try {
        await applyExecutorOutput(workspace, output, { taskId: task.id, contextVersion, allowedWrites: task.write_files, snapshot }, limits);
      } catch (error) {
        if (error instanceof OutputRejectedError) {
          return { kind: "retry", category: "rejected-output", reason: "executor output was rejected", evidence: error.reasons.join("\n") };
        }
        if (error instanceof WorkspaceTaintedError) return { kind: "stop-run", reason: error.message };
        throw error;
      }
      return this.check(task.id, this.o.devChecks);
    }
  }

  /**
   * How many tests the visible test run must execute now: the baseline's
   * plus those of the groups whose files are in the workspace. null when
   * the configuration does not declare every count.
   */
  private expectedVisibleTests(): number | null {
    if (this.o.baselineTests === undefined) return null;
    let total = this.o.baselineTests;
    for (const name of this.presentGroups) {
      const count = this.o.checkGroups.find((g) => g.name === name)?.expectedTests;
      if (count === undefined) return null;
      total += count;
    }
    return total;
  }

  /** Runs checks in order; every result is logged. */
  private async check(taskId: string | null, specs: CheckSpec[], results: CheckResult[] = []): Promise<AttemptResult> {
    const failures: string[] = [];
    const expected = this.expectedVisibleTests();
    for (const configured of specs) {
      const spec = configured.name === VISIBLE_TESTS && expected !== null ? { ...configured, expectedTests: expected } : configured;
      const result = await this.runCheck(spec);
      results.push(result);
      await this.o.ledger.append({ type: "check_result", taskId, check: result.name, passed: result.passed, testsRun: result.testsRun });
      if (!result.processExited) {
        markTainted(this.o.workspace, `${result.name} did not exit after its timeout`);
        return { kind: "stop-run", reason: `${result.name} could not be stopped; the workspace is no longer usable` };
      }
      if (result.failure && ENVIRONMENT_FAILURES.has(result.failure)) {
        return { kind: "stop-run", reason: `environment problem in ${result.name}: ${result.failure}` };
      }
      const missing = result.failure === "missing_tests" ? `only ${result.testsRun ?? 0} of ${spec.expectedTests} tests ran; a test file crashed or the process exited early\n` : "";
      if (!result.passed) failures.push(`## ${result.name} (${result.failure})\n${missing}${result.output.slice(0, MAX_EVIDENCE_CHARS)}`);
    }
    return failures.length === 0
      ? { kind: "passed" }
      : { kind: "retry", category: "check", reason: `${failures.length} of ${specs.length} checks failed`, evidence: failures.join("\n\n") };
  }

  // ---- 5: review ------------------------------------------------------------

  private async review(plan: PlannedTask[], outcomes: TaskOutcome[]): Promise<Array<ReviewFinding & { taskId: string }>> {
    const findings: Array<ReviewFinding & { taskId: string }> = [];
    const toReview = outcomes.filter((o) => o.status === "passed" && o.reviewRequired);
    if (toReview.length === 0 || this.stopReason) return findings;

    for (const outcome of toReview) {
      const task = plan.find((t) => t.id === outcome.taskId)!;
      // Only this task's files: other tasks' changes and the copied visible
      // tests would cost tokens and invite findings against the wrong task.
      const diff = await diffAgainstBaseline(this.o.workspace, task.write_files);
      const input = [
        `# Task ${task.id}: ${task.title}`,
        task.description,
        `# Acceptance criteria\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`,
        `# Files this task changed\n${task.write_files.join(", ")}`,
        `# Diff of these files against the baseline\n\`\`\`diff\n${diff}\n\`\`\``,
      ].join("\n\n");
      const result = await this.callModel("review", "reviewer", this.o.preset.roles.review, "review", ReviewOutput, "review_output", input, task.id);
      if (!result.ok) {
        this.problems.push(`${task.id}: required review could not run (${result.failure})`);
        if (this.stopReason) break;
        continue;
      }
      for (const finding of result.data.findings) {
        findings.push({ ...finding, taskId: task.id });
        // Contest scope: findings are triaged, not fixed automatically.
        if (finding.severity === "blocking") this.problems.push(`${task.id}: blocking review finding in ${finding.file}: ${finding.evidence}`);
        if (finding.severity === "major_unverifiable") this.problems.push(`${task.id}: needs a human decision (${finding.file}): ${finding.evidence}`);
      }
    }
    return findings;
  }

  // ---- 6: freeze --------------------------------------------------------------

  private async freeze(report: RunReport): Promise<void> {
    // Each task passed on its own; the combination must pass too.
    const integrated = await this.check(null, this.o.devChecks, report.finalChecks);
    if (integrated.kind === "stop-run") {
      this.stop(integrated.reason);
      return;
    }
    if (integrated.kind !== "passed") {
      this.problems.push(`checks on the integrated result failed: ${integrated.reason}`);
      return;
    }
    report.manifest = await snapshotManifest(this.o.workspace);

    // Holdout checks run exactly once and their output never reaches a model.
    const holdout = await this.check(null, this.o.holdoutChecks, report.holdout);
    if (holdout.kind === "stop-run") this.stop(holdout.reason);
    else if (holdout.kind === "retry") this.problems.push(`holdout checks failed: ${holdout.reason}`);

    // Results are bound to the frozen content; any change since invalidates them.
    const after = await snapshotManifest(this.o.workspace);
    report.frozenIntact = JSON.stringify(after) === JSON.stringify(report.manifest);
    if (!report.frozenIntact) {
      this.problems.push("the workspace changed while holdout checks ran; results are not valid for the frozen version");
    }
  }

  // ---- 7: summarize -------------------------------------------------------------

  private async summarize(report: RunReport): Promise<RunSummary | null> {
    if (this.stopReason && /budget|quota/.test(this.stopReason)) return null; // no money for another call
    const input = JSON.stringify({
      request: this.o.request,
      tasks: report.tasks.map((t) => ({ id: t.taskId, status: t.status, reason: t.reason })),
      problems: [...(this.stopReason ? [`run stopped: ${this.stopReason}`] : []), ...this.problems],
    });
    const result = await this.callCoordinator("coordination", "summarize", RunSummary, "run_summary", input);
    return result.ok ? result.data : null;
  }
}

/** Plan order, adjusted so every task comes after its dependencies. The plan is validated as acyclic. */
function dependencyOrder(tasks: PlannedTask[]): PlannedTask[] {
  const done = new Set<string>();
  const ordered: PlannedTask[] = [];
  const pending = [...tasks];
  while (pending.length > 0) {
    const index = pending.findIndex((t) => t.depends_on.every((d) => done.has(d)));
    const [next] = pending.splice(index === -1 ? 0 : index, 1);
    ordered.push(next!);
    done.add(next!.id);
  }
  return ordered;
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = normalizeRelativePath(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
