import type { CheckResult } from "../verifier/verifier.ts";
import type { PlannedTask, ReviewFinding, RunSummary } from "./schemas.ts";

/**
 * Final state of one planned task.
 *   - passed:  its checks passed on the last attempt
 *   - failed:  attempts or the coordinator's triage ended it
 *   - stopped: the run stopped while it ran, or it was not allowed to run
 *   - skipped: a dependency did not pass, or the run had already stopped
 */
export type TaskStatus = "passed" | "failed" | "stopped" | "skipped";

export interface TaskOutcome {
  taskId: string;
  status: TaskStatus;
  model: string; // the model of the last attempt
  attempts: number;
  escalated: boolean;
  floorReason: string | null; // why the program overrode Meta's model choice, if it did
  reason: string | null; // why the task did not pass
  reviewRequired: boolean;
}

/**
 * What a run produced. The program, not the coordinator, owns this report;
 * Meta's closing message is included but every status and figure here comes
 * from checks and the ledger.
 */
/**
 * Where a call's cost is counted, for the experiment's cost breakdown:
 *   - coordination: planning, plan revision and the closing summary
 *   - execution:    executor calls of each task's first attempt
 *   - rework:       repair and escalation attempts, and the triage before them
 *   - review:       reviewer calls
 */
export const COST_PHASES = ["coordination", "execution", "rework", "review"] as const;
export type CostPhase = (typeof COST_PHASES)[number];

export interface RunReport {
  // "coordinated": Meta plans and coordinates (arms B and C).
  // "single-model": one model does the whole request, no coordinator (arm A).
  mode: "coordinated" | "single-model";
  status: "completed" | "incomplete";
  plan: PlannedTask[] | null;
  tasks: TaskOutcome[];
  // Check groups whose owning task did not pass: not verified, never "passed".
  pendingCheckGroups: string[];
  findings: Array<ReviewFinding & { taskId: string }>;
  finalChecks: CheckResult[]; // dev checks re-run on the integrated result
  holdout: CheckResult[];
  manifest: Record<string, string> | null; // content hashes at freeze time
  problems: string[]; // every reason the run is not completed
  summary: RunSummary | null;
  costUsd: number | null; // list-price cost of all calls; null if any cost is unknown
  costByPhase: Record<CostPhase, number | null>; // the same cost split by phase; null if any cost in it is unknown
}
