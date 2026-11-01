import { tierAtLeast, type Preset, type Tier } from "../config/schema.ts";
import type { PlannedTask } from "./schemas.ts";

export interface FloorDecision {
  model: string;
  raised: boolean; // true when the program overrode Meta's choice
  reason: string | null; // recorded as an event and shown to the user when raised
}

/**
 * The lowest tier a task may run on, from Meta's own complexity and impact
 * labels:
 *   - high impact or complex      -> strong
 *   - medium impact or medium     -> cheap
 *   - simple and low impact       -> free (reading, writing, small edits)
 * There is deliberately no quota that pushes work onto cheaper tiers;
 * assigning everything to the strong model is always allowed.
 */
export function requiredTier(task: PlannedTask): Tier {
  if (task.impact === "high" || task.complexity === "complex") return "strong";
  if (task.impact === "medium" || task.complexity === "medium") return "cheap";
  return "free";
}

/**
 * Models a preset allows as executors: those assigned to an executor role.
 * The coordinator's model is declared in a preset too, but it is not an
 * executor option unless a role also uses it; otherwise a quality-first
 * preset could still run tasks on its cheap coordinator.
 */
export function executorModels(preset: Preset): Set<string> {
  return new Set(Object.values(preset.roles));
}

/**
 * Enforces the preset and the capability floor on Meta's model choice. Meta
 * chooses freely among the preset's executor models at or above the floor;
 * otherwise the program substitutes the preset's role model for that floor,
 * so neither cost pressure nor a stray choice can route work outside what
 * the user configured.
 */
export function applyCapabilityFloor(task: PlannedTask, preset: Preset): FloorDecision {
  let floor = requiredTier(task);
  // Free models are opt-in per project; without consent the floor is cheap.
  if (floor === "free" && !preset.allowFreeModels) floor = "cheap";

  const allowed = executorModels(preset);
  const chosen = allowed.has(task.model) ? preset.models.find((m) => m.id === task.model) : undefined;
  if (chosen && tierAtLeast(chosen.tier, floor)) {
    return { model: chosen.id, raised: false, reason: null };
  }

  // Preset validation guarantees critical is strong and routine is at least cheap.
  const replacement = floor === "strong" ? preset.roles.critical : preset.roles.routine;
  const reason = chosen
    ? `${task.id} is ${task.complexity}/${task.impact}-impact and needs a ${floor}-tier model; ` +
      `"${chosen.id}" is ${chosen.tier}-tier, so "${replacement}" is used instead`
    : `${task.id} named "${task.model}", which is not an executor model in preset "${preset.name}"; "${replacement}" is used instead`;
  return { model: replacement, raised: true, reason };
}

/** Checks the program can run for a task, decided before the task executes. */
export type CheckKind = "typecheck" | "visible-tests" | "doc-examples" | "doc-references";

export interface ReviewRequirement {
  allowed: boolean; // false: the task must not run at all
  reviewRequired: boolean;
  reasons: string[];
}

const CODE_TASKS = new Set<PlannedTask["type"]>(["implement", "fix", "test"]);

/**
 * Decision 13 of the plan: checks decide how much a task's result can be
 * trusted without a second look.
 *   - Core code tasks must have a type check and visible tests; without them
 *     the task does not run.
 *   - Docs tasks may use free or cheap models, but if any docs check (examples
 *     compile, referenced exports and commands exist) cannot run, a review is
 *     scheduled.
 *   - Complex or high-impact tasks are always reviewed.
 *
 * TODO: Docs checks (examples compile, referenced exports exist) are not
 * built yet, so the pipeline never lists them as available and every docs
 * task is reviewed. Add them with the sample repository's docs.
 */
export function reviewRequirement(task: PlannedTask, available: ReadonlySet<CheckKind>): ReviewRequirement {
  const reasons: string[] = [];
  let allowed = true;
  let reviewRequired = false;

  if (CODE_TASKS.has(task.type)) {
    const missing = (["typecheck", "visible-tests"] as const).filter((check) => !available.has(check));
    if (missing.length > 0) {
      allowed = false;
      reasons.push(`code task without automated tests (missing: ${missing.join(", ")})`);
    }
  } else if (task.type === "docs") {
    const missing = (["doc-examples", "doc-references"] as const).filter((check) => !available.has(check));
    if (missing.length > 0) {
      reviewRequired = true;
      reasons.push(`docs checks cannot run (missing: ${missing.join(", ")}), so a review is scheduled`);
    }
  }

  if (task.complexity === "complex" || task.impact === "high") {
    reviewRequired = true;
    reasons.push("complex or high-impact tasks are always reviewed");
  }
  return { allowed, reviewRequired, reasons };
}
