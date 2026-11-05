import assert from "node:assert/strict";
import { test } from "node:test";
import type { PipelineHooks, PlanReview } from "../orchestrator/orchestrator.ts";
import type { PlanResponse } from "../orchestrator/schemas.ts";
import { InteractiveSession, SessionConflictError, type InteractiveRunner } from "./session.ts";

const question = { id: "q1", question: "YAML too?", why: "parser task", default: "No" };
const plan: PlanResponse = {
  kind: "plan", message: "Two tasks.", questions: [],
  tasks: [{
    id: "T1", type: "implement", title: "Planner", description: "", complexity: "complex", impact: "high", capabilities: ["code"],
    acceptance: ["tests pass"], context_files: [], write_files: ["src/planner.ts"], check_groups: [], depends_on: [],
    model: "muse-spark-1.3", reason: "core", escalate_if: "",
  }],
};

/** A runner that plays the pipeline's side: ask, then review the plan (twice if sent back). */
function scriptedRunner(record: { answers?: Record<string, string>; reviews: PlanReview[]; request?: string | null }, failBeforeStart = false): InteractiveRunner {
  return {
    request: "Add planOrder.",
    presets: ["saving", "quality"],
    async start(_preset, request, hooks: PipelineHooks, onStarted) {
      record.request = request;
      if (failBeforeStart) throw new Error("MODEL_API_KEY is not set");
      onStarted("run-1");
      record.answers = await hooks.answerQuestions([question], "One question.");
      const decisions = [{ model: "muse-wonder-1.0", raised: true, reason: "T1 needs strong" }];
      let review = await hooks.reviewPlan(plan, decisions, [], true);
      record.reviews.push(review);
      if (!review.approve && review.feedback !== null) {
        review = await hooks.reviewPlan(plan, decisions, [], false);
        record.reviews.push(review);
      }
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a run goes from questions to the plan, with defaults for empty answers and the floor's model shown", async () => {
  const record: { answers?: Record<string, string>; reviews: PlanReview[] } = { reviews: [] };
  const session = new InteractiveSession(scriptedRunner(record));
  assert.equal(await session.start("saving"), "run-1");
  await tick();
  assert.equal(session.snapshot().state, "waiting");
  assert.equal(session.snapshot().pending?.kind, "questions");

  session.answer({ q1: "   " });
  await tick();
  assert.deepEqual(record.answers, { q1: "No" }, "an empty answer takes the default");
  const pending = session.snapshot().pending;
  assert.ok(pending?.kind === "plan");
  assert.equal(pending.tasks[0]?.model, "muse-wonder-1.0");
  assert.equal(pending.tasks[0]?.requestedModel, "muse-spark-1.3");
  assert.equal(pending.canRevise, true);

  session.review("revise", "cheaper please");
  await tick();
  assert.equal(session.snapshot().pending?.kind, "plan", "the revised plan is pending");
  assert.throws(() => session.review("revise", "again"), SessionConflictError, "only one revision");
  session.review("approve");
  await tick();
  assert.deepEqual(record.reviews, [{ approve: false, feedback: "cheaper please" }, { approve: true }]);
  assert.equal(session.snapshot().state, "finished");
});

test("the demo request is the default and a free-form request is passed to the runner", async () => {
  const record: { reviews: PlanReview[]; request?: string | null } = { reviews: [] };
  const demo = new InteractiveSession(scriptedRunner(record));
  await demo.start("saving");
  assert.equal(record.request, null);

  const own = new InteractiveSession(scriptedRunner(record));
  await own.start("saving", "Add a --version flag.");
  assert.equal(record.request, "Add a --version flag.");
});

test("stopping at the plan ends the run without a revision", async () => {
  const record = { reviews: [] as PlanReview[] };
  const session = new InteractiveSession(scriptedRunner(record));
  await session.start("saving");
  await tick();
  session.answer({});
  await tick();
  session.review("stop");
  await tick();
  assert.deepEqual(record.reviews, [{ approve: false, feedback: null }]);
});

test("actions out of turn, empty feedback, unknown presets and a second run are refused", async () => {
  const session = new InteractiveSession(scriptedRunner({ reviews: [] }));
  assert.throws(() => session.answer({}), SessionConflictError);
  await assert.rejects(session.start("nonexistent"), SessionConflictError);
  await session.start("saving");
  await tick();
  assert.throws(() => session.review("approve"), SessionConflictError, "Meta is asking questions, not showing a plan");
  await assert.rejects(session.start("saving"), /still in progress/);
  session.answer({});
  await tick();
  assert.throws(() => session.review("revise", "  "), /what should change/);
});

test("a failure before the run starts is reported to the caller and the session can start again", async () => {
  const session = new InteractiveSession(scriptedRunner({ reviews: [] }, true));
  await assert.rejects(session.start("saving"), /MODEL_API_KEY/);
  assert.equal(session.snapshot().state, "failed");
  assert.match(session.snapshot().error ?? "", /MODEL_API_KEY/);
  await assert.rejects(session.start("saving"), /MODEL_API_KEY/, "not refused as still in progress");
});
