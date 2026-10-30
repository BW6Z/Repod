import type { PlannedTask } from "./schemas.ts";

/**
 * Run phases. Everything before "executing" is the conversation between the
 * user and Meta; once execution starts the user no longer talks to Meta and
 * progress comes from program events.
 */
export type RunPhase =
  | "planning"
  | "awaiting_answers" // Meta asked clarifying questions
  | "awaiting_approval" // plan shown; user may approve or send it back once
  | "executing"
  | "reviewing"
  | "frozen" // candidate locked by content hashes; holdout checks run now
  | "finished"
  | "interrupted"; // process stopped mid-run; never shown as completed

export type TaskStatus = "pending" | "running" | "checking" | "passed" | "failed" | "stopped";

export interface TaskState {
  task: PlannedTask;
  status: TaskStatus;
  model: string; // may differ from task.model after the capability floor or an escalation
  attempts: number;
  escalated: boolean;
  needFilesUsed: boolean;
}

/** The program, not the coordinator, owns this state; Meta only sees summaries of it. */
export interface RunState {
  runId: string;
  preset: string;
  request: string;
  phase: RunPhase;
  planRevisionsUsed: number;
  totalReworks: number;
  tasks: TaskState[];
  frozenManifest: Record<string, string> | null; // path -> content hash at freeze time
}
