import type { Limits, Preset } from "../config/schema.ts";
import { NotImplementedError } from "../shared/errors.ts";
import type { PlanResponse } from "./schemas.ts";

export interface PlanIssue {
  taskId: string | null;
  message: string;
}

export interface PlanContext {
  knownFiles: Set<string>; // files in the run workspace, relative paths
  preset: Preset;
  limits: Limits;
}

/**
 * Checks what a schema cannot express. Runs after every planning call,
 * including the plan revised from user feedback:
 *   - kind "plan" has tasks, kind "questions" has 1..maxClarifyingQuestions
 *   - task ids are unique and depends_on references exist
 *   - the dependency graph has no cycles
 *   - context_files exist and are inside the allowed paths
 *   - every model is declared in the preset
 *   - the plan's worst-case cost fits the remaining budget
 */
export function validatePlan(_plan: PlanResponse, _context: PlanContext): PlanIssue[] {
  // TODO: Implement each check with a unit test. Deferred to the planning
  // milestone (11/1).
  throw new NotImplementedError("validatePlan");
}
