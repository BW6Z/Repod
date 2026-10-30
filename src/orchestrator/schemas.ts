import { z } from "zod";

// These schemas define what models must return. They are written to stay
// inside the strict structured-output subset that providers accept: every key
// is required (use empty arrays or null instead of optional keys), objects are
// closed, and there is no oneOf/allOf at the root. Cross-field rules (such as
// "a plan must contain tasks") are enforced by the program after parsing.

export const Complexity = z.enum(["simple", "medium", "complex"]);
export const Impact = z.enum(["low", "medium", "high"]);
export const TaskType = z.enum(["implement", "fix", "test", "docs"]);
export const Capability = z.enum(["code", "analysis", "writing"]);

export const ClarifyingQuestion = z.strictObject({
  id: z.string(),
  question: z.string(),
  why: z.string(), // which part of the plan depends on the answer
  default: z.string(), // used when the user skips, and always in experiment mode
});
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestion>;

export const PlannedTask = z.strictObject({
  id: z.string(),
  type: TaskType,
  title: z.string(),
  description: z.string(),
  complexity: Complexity,
  impact: Impact,
  capabilities: z.array(Capability),
  acceptance: z.array(z.string()),
  context_files: z.array(z.string()),
  depends_on: z.array(z.string()),
  model: z.string(),
  reason: z.string(), // shown to the user next to the model choice
  escalate_if: z.string(),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

/**
 * Output of the planning call. Clarification and planning share one call so a
 * clear request costs no extra round trip: Meta either asks questions or
 * returns the plan, and `message` is what the user reads in the conversation.
 */
export const PlanResponse = z.strictObject({
  kind: z.enum(["questions", "plan"]),
  message: z.string(),
  questions: z.array(ClarifyingQuestion),
  tasks: z.array(PlannedTask),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export const ExecutorOutput = z.strictObject({
  task_id: z.string(),
  context_version: z.string(), // must match the version the program sent, or the output is stale
  files: z.array(z.strictObject({ path: z.string(), content: z.string() })), // whole-file replacements
  need_files: z.array(z.string()), // non-empty means "retry me with these files"; allowed once
  notes: z.string(),
});
export type ExecutorOutput = z.infer<typeof ExecutorOutput>;

export const TriageDecision = z.strictObject({
  decision: z.enum(["repair", "escalate", "stop"]),
  reason: z.string(),
  instructions: z.string(), // guidance passed to the next attempt
});
export type TriageDecision = z.infer<typeof TriageDecision>;

export const ReviewFinding = z.strictObject({
  file: z.string(),
  snippet: z.string(), // anchors the finding; line numbers drift after edits
  severity: z.enum(["blocking", "major_unverifiable", "minor"]),
  evidence: z.string(),
  suggested_check: z.string(), // how to confirm the issue with a test or command
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewOutput = z.strictObject({
  findings: z.array(ReviewFinding),
  summary: z.string(),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** Meta's closing message. Numbers (cost, tokens, test counts) are filled in by the program. */
export const RunSummary = z.strictObject({
  message: z.string(),
  completed: z.array(z.string()),
  unresolved: z.array(z.string()),
});
export type RunSummary = z.infer<typeof RunSummary>;
