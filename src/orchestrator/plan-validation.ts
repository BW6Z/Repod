import type { Limits, Preset, PricingTable } from "../config/schema.ts";
import { PathRejectedError, isProtected, normalizeRelativePath } from "../workspace/paths.ts";
import { applyCapabilityFloor, requiredTier } from "./routing.ts";
import type { PlanResponse, PlannedTask } from "./schemas.ts";

export interface PlanIssue {
  // Errors make the plan unusable: Meta is asked to re-plan, or the run stops.
  // Warnings are shown to the user next to the plan but do not block it.
  severity: "error" | "warning";
  taskId: string | null;
  message: string;
}

export interface PlanContext {
  knownFiles: Set<string>; // workspace files, POSIX relative paths
  preset: Preset;
  limits: Limits;
  pricing: PricingTable;
  remainingBudgetUsd: number;
}

/**
 * Checks what a schema cannot express. Runs after every planning call,
 * including a plan revised from user feedback.
 */
export function validatePlan(plan: PlanResponse, context: PlanContext): PlanIssue[] {
  return plan.kind === "questions" ? validateQuestions(plan, context) : validateTasks(plan, context);
}

function validateQuestions(plan: PlanResponse, context: PlanContext): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", taskId: null, message });
  const max = context.limits.maxClarifyingQuestions;

  if (plan.questions.length === 0) error("kind is 'questions' but no questions were asked");
  if (plan.questions.length > max) error(`${plan.questions.length} questions exceed the limit of ${max}`);
  if (plan.tasks.length > 0) error("a clarifying response must not contain tasks");
  if (new Set(plan.questions.map((q) => q.id)).size !== plan.questions.length) error("question ids must be unique");
  for (const q of plan.questions) {
    // The default is what experiment runs and skipped questions use.
    if (q.default.trim() === "") error(`question ${q.id} has no default answer`);
  }
  return issues;
}

function validateTasks(plan: PlanResponse, context: PlanContext): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const error = (taskId: string | null, message: string) => issues.push({ severity: "error", taskId, message });

  if (plan.tasks.length === 0) error(null, "kind is 'plan' but the plan has no tasks");
  if (plan.questions.length > 0) error(null, "a plan must not also ask questions");

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (task.id.trim() === "") error(null, "a task has an empty id");
    else if (ids.has(task.id)) error(task.id, "duplicate task id");
    ids.add(task.id);
  }

  const knownLower = new Set([...context.knownFiles].map((f) => f.toLowerCase()));
  const declaredModels = new Set(context.preset.models.map((m) => m.id));

  for (const task of plan.tasks) {
    if (task.acceptance.length === 0) error(task.id, "task has no acceptance criteria");
    if (!declaredModels.has(task.model)) error(task.id, `model "${task.model}" is not in preset "${context.preset.name}"`);

    for (const dep of task.depends_on) {
      if (dep === task.id) error(task.id, "task depends on itself");
      else if (!ids.has(dep)) error(task.id, `depends on unknown task "${dep}"`);
    }

    for (const file of task.context_files) {
      try {
        // Case-insensitive lookup, matching how Windows resolves the path.
        if (!knownLower.has(normalizeRelativePath(file).toLowerCase())) {
          error(task.id, `context file "${file}" does not exist in the workspace`);
        }
      } catch (e) {
        if (!(e instanceof PathRejectedError)) throw e;
        error(task.id, e.message);
      }
    }

    // The write scope is checked when the plan is made, so a bad scope costs
    // a re-plan rather than a wasted executor call.
    if (task.write_files.length === 0) error(task.id, "task has no write_files");
    const writes = new Set<string>();
    for (const file of task.write_files) {
      try {
        const normalized = normalizeRelativePath(file);
        if (isProtected(normalized)) error(task.id, `write file "${file}" is protected`);
        if (writes.has(normalized.toLowerCase())) error(task.id, `write file "${file}" is listed twice`);
        writes.add(normalized.toLowerCase());
      } catch (e) {
        if (!(e instanceof PathRejectedError)) throw e;
        error(task.id, e.message);
      }
    }
  }

  const cycle = findCycle(plan.tasks);
  if (cycle) error(cycle[0] ?? null, `dependency cycle: ${cycle.join(" -> ")}`);

  const { totalUsd: worstCase, unpriced } = worstCaseCostUsd(plan.tasks, context);
  for (const model of unpriced) {
    issues.push({ severity: "warning", taskId: null, message: `no price for "${model}"; its cost is left out of the budget estimate` });
  }
  if (worstCase > context.remainingBudgetUsd) {
    issues.push({
      severity: "warning",
      taskId: null,
      message:
        `if every task used all its attempts, executor output alone could cost $${worstCase.toFixed(2)}, ` +
        `more than the remaining $${context.remainingBudgetUsd.toFixed(2)}; the run stops when the budget runs out`,
    });
  }
  return issues;
}

/** Returns one dependency cycle as a list of task ids (first id repeated at the end), or null. */
export function findCycle(tasks: PlannedTask[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue; // unknown ids are reported separately
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return null;
}

/**
 * Rough upper bound on executor output cost: every attempt, plus the allowed
 * escalations to the critical model, uses the full output limit. Each task is
 * priced on the model it will actually run on (after the capability floor),
 * not on Meta's raw choice. Input is left out because its size is unknown
 * before the context is assembled, which is why this only produces a warning.
 */
function worstCaseCostUsd(tasks: PlannedTask[], context: PlanContext): { totalUsd: number; unpriced: Set<string> } {
  const { limits, preset, pricing } = context;
  const unpriced = new Set<string>();
  const perAttempt = (model: string) => {
    const price = pricing.prices.find((p) => p.model === model);
    if (!price) {
      unpriced.add(model);
      return 0;
    }
    return (limits.maxOutputTokens.executor * price.outputPerMTok) / 1_000_000;
  };

  let totalUsd = 0;
  for (const task of tasks) {
    const model = applyCapabilityFloor(task, preset).model;
    if (requiredTier(task) === "strong") {
      totalUsd += limits.strongAttemptsPerTask * perAttempt(model);
    } else {
      totalUsd += limits.cheapAttemptsPerTask * perAttempt(model);
      totalUsd += limits.maxEscalationsPerTask * limits.strongAttemptsPerTask * perAttempt(preset.roles.critical);
    }
  }
  return { totalUsd, unpriced };
}
