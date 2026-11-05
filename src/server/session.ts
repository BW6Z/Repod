import type { PipelineHooks, PlanReview } from "../orchestrator/orchestrator.ts";
import type { ClarifyingQuestion } from "../orchestrator/schemas.ts";

/**
 * Starts one paid demo run with the given hooks; resolves when the run ends.
 * onStarted receives the run id once the run's folder exists. Provided by
 * the CLI, so the page starts runs exactly the way `run` does.
 */
export interface InteractiveRunner {
  request: string; // the demo request, shown on the page
  presets: string[];
  // request null runs the demo request; a string runs that free-form request instead.
  start(preset: string, request: string | null, hooks: PipelineHooks, onStarted: (runId: string) => void): Promise<unknown>;
}

export interface PendingTask {
  id: string;
  title: string;
  complexity: string;
  impact: string;
  model: string; // after the capability floor
  requestedModel: string;
  floorReason: string | null;
  reason: string;
  dependsOn: string[];
  writeFiles: string[];
}

/** What the run is waiting for from the user, if anything. */
export type Pending =
  | { kind: "questions"; message: string; questions: ClarifyingQuestion[] }
  | { kind: "plan"; message: string; tasks: PendingTask[]; warnings: string[]; canRevise: boolean };

export type SessionState = "idle" | "starting" | "running" | "waiting" | "finished" | "failed";

export interface SessionSnapshot {
  state: SessionState;
  runId: string | null;
  pending: Pending | null;
  error: string | null;
}

/** Raised for requests that do not fit the session's current state. */
export class SessionConflictError extends Error {}

/**
 * The page's side of the conversation with Meta for one run at a time.
 *
 * The pipeline calls the hooks and waits; the page reads what is pending
 * and answers through the server, which resolves the waiting hook. Only
 * the questions Meta asked are answered, and a plan can only be approved,
 * sent back while a revision is allowed, or stopped.
 */
export class InteractiveSession {
  private readonly runner: InteractiveRunner;
  private state: SessionState = "idle";
  private runId: string | null = null;
  private pending: Pending | null = null;
  private error: string | null = null;
  private answerQuestions: ((answers: Record<string, string>) => void) | null = null;
  private answerPlan: ((review: PlanReview) => void) | null = null;

  constructor(runner: InteractiveRunner) {
    this.runner = runner;
  }

  get request(): string {
    return this.runner.request;
  }

  get presets(): string[] {
    return this.runner.presets;
  }

  snapshot(): SessionSnapshot {
    return { state: this.state, runId: this.runId, pending: this.pending, error: this.error };
  }

  /** Starts a run and resolves with its id; rejects if one is going or it fails before starting. */
  start(preset: string, request: string | null = null): Promise<string> {
    if (this.state === "starting" || this.state === "running" || this.state === "waiting") {
      return Promise.reject(new SessionConflictError("A run started from this page is still in progress."));
    }
    if (!this.runner.presets.includes(preset)) return Promise.reject(new SessionConflictError(`Unknown preset "${preset}".`));
    this.state = "starting";
    this.runId = null;
    this.pending = null;
    this.error = null;

    const hooks: PipelineHooks = {
      answerQuestions: (questions, message) => {
        this.wait({ kind: "questions", message, questions });
        return new Promise((resolve) => (this.answerQuestions = resolve));
      },
      reviewPlan: (plan, decisions, warnings, canRevise) => {
        this.wait({
          kind: "plan",
          message: plan.message,
          canRevise,
          warnings: warnings.map((w) => w.message),
          tasks: plan.tasks.map((t, i) => ({
            id: t.id, title: t.title, complexity: t.complexity, impact: t.impact,
            model: decisions[i]?.model ?? t.model, requestedModel: t.model, floorReason: decisions[i]?.reason ?? null,
            reason: t.reason, dependsOn: t.depends_on, writeFiles: t.write_files,
          })),
        });
        return new Promise((resolve) => (this.answerPlan = resolve));
      },
    };

    return new Promise((resolve, reject) => {
      let started = false;
      this.runner
        .start(preset, request, hooks, (runId) => {
          started = true;
          this.runId = runId;
          this.state = "running";
          resolve(runId);
        })
        .then(() => this.end("finished", null))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.end("failed", message);
          if (!started) reject(error);
        });
    });
  }

  /** Answers Meta's questions; an empty or missing answer takes the question's default. */
  answer(answers: Record<string, string>): void {
    const pending = this.pending;
    if (this.state !== "waiting" || pending?.kind !== "questions" || !this.answerQuestions) {
      throw new SessionConflictError("The run is not waiting for answers.");
    }
    const resolved = Object.fromEntries(pending.questions.map((q) => [q.id, answers[q.id]?.trim() || q.default]));
    const resolve = this.answerQuestions;
    this.answerQuestions = null;
    this.resume();
    resolve(resolved);
  }

  /** Approves the pending plan, sends it back with feedback, or stops the run. */
  review(action: "approve" | "revise" | "stop", feedback = ""): void {
    const pending = this.pending;
    if (this.state !== "waiting" || pending?.kind !== "plan" || !this.answerPlan) {
      throw new SessionConflictError("The run is not waiting for a plan decision.");
    }
    if (action === "revise" && !pending.canRevise) throw new SessionConflictError("The plan can no longer be sent back; approve it or stop.");
    if (action === "revise" && feedback.trim() === "") throw new SessionConflictError("Say what should change in the plan.");
    const review: PlanReview =
      action === "approve" ? { approve: true } : { approve: false, feedback: action === "revise" ? feedback.trim() : null };
    const resolve = this.answerPlan;
    this.answerPlan = null;
    this.resume();
    resolve(review);
  }

  private wait(pending: Pending): void {
    this.pending = pending;
    this.state = "waiting";
  }

  private resume(): void {
    this.pending = null;
    this.state = "running";
  }

  private end(state: "finished" | "failed", error: string | null): void {
    this.state = state;
    this.error = error;
    this.pending = null;
    this.answerQuestions = null;
    this.answerPlan = null;
  }
}
