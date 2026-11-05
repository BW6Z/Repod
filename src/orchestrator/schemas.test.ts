import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanResponse } from "./schemas.ts";

const task = {
  id: "T1",
  type: "implement",
  title: "Dependency ordering",
  description: "Add planOrder() with cycle detection.",
  complexity: "complex",
  impact: "high",
  capabilities: ["code", "analysis"],
  acceptance: ["tsc passes", "visible planner tests pass"],
  context_files: ["src/index.ts"],
  write_files: ["src/index.ts"],
  check_groups: [],
  depends_on: [],
  model: "claude-opus-5-5",
  reason: "Core ordering logic; errors affect every caller.",
  escalate_if: "Visible tests still fail after one repair.",
};

test("a plan response with tasks parses", () => {
  const result = PlanResponse.safeParse({ kind: "plan", message: "Here is the plan.", questions: [], tasks: [task] });
  assert.equal(result.success, true);
});

test("a clarifying response with questions parses", () => {
  const result = PlanResponse.safeParse({
    kind: "questions",
    message: "One detail decides the CLI task.",
    questions: [{ id: "Q1", question: "Table or JSON output?", why: "Changes CLI acceptance.", default: "table" }],
    tasks: [],
  });
  assert.equal(result.success, true);
});

test("unexpected keys are rejected so model output cannot smuggle fields", () => {
  const result = PlanResponse.safeParse({ kind: "plan", message: "", questions: [], tasks: [{ ...task, extra: true }] });
  assert.equal(result.success, false);
});
