import { appendFile, readFile } from "node:fs/promises";
import type { FailureKind, Role, Usage } from "./types.ts";

interface EventBase {
  runId: string;
  seq: number; // strictly increasing per run; lets readers resume from an offset
  ts: string; // ISO timestamp
}

/**
 * Every model call writes a start event before the request and an end event
 * after it. A start without a matching end marks a call that was interrupted
 * and may still have been billed, so it must never be silently dropped.
 */
export type LedgerEvent = EventBase &
  (
    | { type: "run_started"; preset: string; request: string }
    | { type: "call_start"; role: Role; model: string; taskId: string | null; attemptId: string; reservedUsd: number }
    | {
        type: "call_end";
        attemptId: string;
        outcome: "ok" | FailureKind;
        usage: Usage | null;
        costUsd: number | null;
        durationMs: number;
      }
    | { type: "task_status"; taskId: string; status: string; detail: string | null }
    | { type: "check_result"; taskId: string | null; check: string; passed: boolean; testsRun: number | null }
    | { type: "run_finished"; status: "completed" | "incomplete" | "interrupted"; summary: string | null }
  );

/** Appends one event as a single JSON line. */
export async function appendEvent(file: string, event: LedgerEvent): Promise<void> {
  await appendFile(file, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Reads all complete events from a JSONL ledger.
 *
 * A reader can run while the writer is mid-append, so the final line may be
 * partial. Only newline-terminated lines are parsed; the trailing fragment is
 * ignored and will be read on the next poll once it is complete.
 */
export async function readEvents(file: string): Promise<LedgerEvent[]> {
  const text = await readFile(file, "utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return [];
  return text
    .slice(0, lastNewline)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LedgerEvent);
}
