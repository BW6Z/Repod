import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { FAILURE_KINDS, ROLES, type Usage } from "./types.ts";

// Ledger entries are validated at runtime when read back: a well-formed JSON
// line with a missing or non-numeric amount would otherwise turn total spend
// into NaN, and NaN silently passes every budget comparison.
const Money = z.number().finite().nonnegative();
const Count = z.number().int().nonnegative();

const UsageRecord = z.object({
  inputTokens: Count,
  outputTokens: Count,
  cachedInputTokens: Count,
  reasoningTokens: Count.nullable(),
  raw: z.unknown(),
});

/**
 * The usage, if it is one the ledger can record (non-negative integer
 * counts); otherwise null, which the gateway bills as unknown at the full
 * reservation. Adapters normalize usage already; this keeps one bad adapter
 * from writing a line that blocks every later spend total.
 */
export function recordableUsage(usage: Usage | null): Usage | null {
  return usage !== null && UsageRecord.safeParse(usage).success ? usage : null;
}

const base = {
  runId: z.string().min(1),
  seq: z.number().int().positive(), // strictly increasing per run, without gaps: a reader polling the ledger can tell where it stopped
  ts: z.string().min(1), // ISO timestamp
};
const attemptId = z.string().min(1);
const taskId = z.string().nullable();

/**
 * Every model call writes a start event before the request and an end event
 * after it. A start without a matching end marks a call that was interrupted
 * and may still have been billed, so it must never be silently dropped.
 * The end event's outcome reflects output validation too: a reply that
 * arrived but failed the schema is recorded as "format", not "ok".
 */
const LedgerEventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run_started"), preset: z.string(), request: z.string(),
    // Origin of the model API, such as https://api.meta.ai; absent in ledgers written before it was recorded.
    endpoint: z.string().optional(),
    // A name the user gave the run when starting it; absent when none was given.
    name: z.string().optional() }),
  z.object({ ...base, type: z.literal("call_start"), role: z.enum(ROLES), model: z.string(), taskId, attemptId, reservedUsd: Money }),
  z.object({
    ...base,
    type: z.literal("call_refused"),
    role: z.enum(ROLES),
    model: z.string(),
    taskId,
    attemptId,
    reservedUsd: Money,
    reason: z.string(),
    // Which budget refused it; absent in ledgers written before it existed.
    scope: z.enum(["run", "total"]).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("call_end"),
    attemptId,
    outcome: z.enum(["ok", ...FAILURE_KINDS]),
    usage: UsageRecord.nullable(),
    costUsd: Money.nullable(),
    durationMs: Count,
  }),
  // The conversation between the user and Meta before execution: Meta's
  // questions and proposed plans, the user's answers, approval or feedback.
  z.object({
    ...base,
    type: z.literal("conversation"),
    from: z.enum(["user", "meta"]),
    kind: z.enum(["questions", "answers", "plan", "approval", "feedback"]),
    text: z.string(),
    questions: z.array(z.object({ id: z.string(), question: z.string(), why: z.string(), default: z.string() })).optional(),
  }),
  // The plan as approved, with the model each task will really run on, so
  // a viewer can show it while the run is still going.
  z.object({
    ...base,
    type: z.literal("plan_approved"),
    message: z.string(),
    tasks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        type: z.string(),
        complexity: z.string(),
        impact: z.string(),
        model: z.string(), // after the capability floor
        requestedModel: z.string(), // the coordinator's choice
        floorReason: z.string().nullable(),
        reason: z.string(),
        dependsOn: z.array(z.string()),
        writeFiles: z.array(z.string()),
        checkGroups: z.array(z.string()),
      }),
    ),
  }),
  z.object({ ...base, type: z.literal("task_status"), taskId: z.string(), status: z.string(), detail: z.string().nullable() }),
  z.object({ ...base, type: z.literal("check_result"), taskId, check: z.string(), passed: z.boolean(), testsRun: Count.nullable() }),
  // What happens to a task after a failed attempt, and who decided it: Meta
  // (triage) or the program (limits, fallbacks, the single-model arm). Absent
  // in ledgers written before it existed; readers must not require it.
  z.object({
    ...base,
    type: z.literal("task_decision"),
    taskId: z.string(),
    attempt: z.number().int().positive(), // the failed attempt this decision follows
    failure: z.string(),
    decision: z.enum(["repair", "escalate", "stop"]),
    by: z.enum(["meta", "program"]),
    // Meta's own choice when the program replaced it with an allowed one.
    requested: z.enum(["repair", "escalate", "stop"]).nullable(),
    reason: z.string(),
    fromModel: z.string(),
    toModel: z.string().nullable(), // null when the task stops
  }),
  z.object({ ...base, type: z.literal("run_finished"), status: z.enum(["completed", "incomplete", "interrupted"]), summary: z.string().nullable() }),
]);
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/** Raised when a ledger cannot be trusted for spend accounting. */
export class LedgerCorruptError extends Error {
  constructor(file: string, detail: string) {
    super(`Ledger ${file} cannot be trusted (${detail}); refusing to guess its spend`);
    this.name = "LedgerCorruptError";
  }
}

/** Where a run's event ledger lives inside its run directory. */
export function ledgerPath(runDir: string): string {
  return path.join(runDir, "events.jsonl");
}

/** Appends one event as a single JSON line. */
export async function appendEvent(file: string, event: LedgerEvent): Promise<void> {
  await appendFile(file, JSON.stringify(event) + "\n", "utf8");
}

type EventBody<E> = E extends unknown ? Omit<E, "runId" | "seq" | "ts"> : never;
type LedgerEventBody = EventBody<LedgerEvent>;

/**
 * Writes the events of one run, stamping run id, sequence number and time.
 * Appends are serialized so concurrent callers cannot interleave or reorder
 * sequence numbers. A failed append rejects only its own promise; later
 * appends still run, so one transient error cannot silently stop all
 * accounting for the rest of the run.
 *
 * Every event is checked against the same schema readEvents applies, before
 * it is written. A line the reader would reject makes every later spend
 * total fail (by design), so it must never reach the file: the append is
 * rejected instead, and nothing is written.
 */
export class LedgerWriter {
  readonly file: string;
  readonly runId: string;
  private seq: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(file: string, runId: string) {
    this.file = file;
    this.runId = runId;
    this.seq = 0;
  }

  append(body: LedgerEventBody): Promise<void> {
    const event = { runId: this.runId, seq: this.seq + 1, ts: new Date().toISOString(), ...body };
    const parsed = LedgerEventSchema.safeParse(event);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return Promise.reject(new Error(`refusing to write an invalid ${body.type} event: ${issue?.path.join(".") || "event"} ${issue?.message ?? "is invalid"}`));
    }
    this.seq++; // only valid events take a sequence number, so there are no gaps
    const write = this.tail.catch(() => {}).then(() => appendEvent(this.file, parsed.data));
    this.tail = write;
    return write;
  }
}

/**
 * Reads all complete events from a JSONL ledger.
 *
 * A reader can run while the writer is mid-append, so the final line may be
 * partial. Only newline-terminated lines are parsed; the trailing fragment is
 * ignored and will be read on the next poll once it is complete. A complete
 * line that is not valid JSON, or valid JSON that is not a well-formed event,
 * throws LedgerCorruptError: spend accounting must never treat damaged
 * history as "nothing happened".
 */
export async function readEvents(file: string): Promise<LedgerEvent[]> {
  const text = await readFile(file, "utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return [];
  const events: LedgerEvent[] = [];
  text
    .slice(0, lastNewline)
    .split("\n")
    .forEach((line, index) => {
      if (line.trim() === "") return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new LedgerCorruptError(file, `line ${index + 1} is not valid JSON`);
      }
      const parsed = LedgerEventSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new LedgerCorruptError(file, `line ${index + 1}: ${issue?.path.join(".") || "event"} ${issue?.message ?? "is invalid"}`);
      }
      events.push(parsed.data);
    });
  return events;
}
