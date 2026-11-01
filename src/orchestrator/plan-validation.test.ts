import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import type { RepodConfig } from "../config/schema.ts";
import { findCycle, validatePlan, type PlanContext } from "./plan-validation.ts";
import type { PlanResponse, PlannedTask } from "./schemas.ts";

let config: RepodConfig;
let context: PlanContext;

before(async () => {
  config = await loadConfig(path.resolve(import.meta.dirname, "../../config"));
  context = {
    knownFiles: new Set(["src/index.ts", "README.md"]),
    preset: config.presets.get("saving")!,
    limits: config.limits,
    pricing: config.pricing,
    remainingBudgetUsd: 100,
  };
});

function task(id: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id,
    type: "implement",
    title: id,
    description: "",
    complexity: "simple",
    impact: "low",
    capabilities: ["code"],
    acceptance: ["tsc passes"],
    context_files: ["src/index.ts"],
    write_files: ["src/index.ts"],
    depends_on: [],
    model: "muse-spark-1.3",
    reason: "",
    escalate_if: "",
    ...overrides,
  };
}

const plan = (tasks: PlannedTask[]): PlanResponse => ({ kind: "plan", message: "", questions: [], tasks });
const errors = (p: PlanResponse, c: PlanContext) => validatePlan(p, c).filter((i) => i.severity === "error").map((i) => i.message);

describe("validatePlan: plans", () => {
  test("a well-formed plan has no issues", () => {
    const p = plan([task("T1"), task("T2", { depends_on: ["T1"], context_files: ["readme.md"] })]);
    assert.deepEqual(validatePlan(p, context), []);
  });

  test("rejects empty plans, duplicate ids and missing acceptance criteria", () => {
    assert.match(errors(plan([]), context).join(), /no tasks/);
    assert.match(errors(plan([task("T1"), task("T1")]), context).join(), /duplicate task id/);
    assert.match(errors(plan([task("T1", { acceptance: [] })]), context).join(), /no acceptance criteria/);
  });

  test("rejects unknown dependencies, self-dependencies and cycles", () => {
    assert.match(errors(plan([task("T1", { depends_on: ["T9"] })]), context).join(), /unknown task "T9"/);
    assert.match(errors(plan([task("T1", { depends_on: ["T1"] })]), context).join(), /depends on itself/);
    const cyclic = plan([task("A", { depends_on: ["C"] }), task("B", { depends_on: ["A"] }), task("C", { depends_on: ["B"] })]);
    assert.match(errors(cyclic, context).join(), /dependency cycle/);
  });

  test("rejects missing or unsafe context files and undeclared models", () => {
    assert.match(errors(plan([task("T1", { context_files: ["src/missing.ts"] })]), context).join(), /does not exist/);
    assert.match(errors(plan([task("T1", { context_files: ["../secret.txt"] })]), context).join(), /Rejected path/);
    assert.match(errors(plan([task("T1", { model: "gpt-x" })]), context).join(), /not in preset/);
  });

  test("rejects a missing, protected, unsafe or duplicated write scope", () => {
    assert.match(errors(plan([task("T1", { write_files: [] })]), context).join(), /no write_files/);
    assert.match(errors(plan([task("T1", { write_files: ["test/a.test.ts"] })]), context).join(), /is protected/);
    assert.match(errors(plan([task("T1", { write_files: ["node_modules/x.js"] })]), context).join(), /Rejected path/);
    assert.match(errors(plan([task("T1", { write_files: ["src/a.ts", "SRC/A.ts"] })]), context).join(), /listed twice/);
    // New files may be listed: they do not have to exist yet.
    assert.deepEqual(errors(plan([task("T1", { write_files: ["src/new-module.ts"] })]), context), []);
  });

  test("warns, without blocking, when the worst case exceeds the remaining budget", () => {
    const issues = validatePlan(plan([task("T1", { complexity: "complex", model: "muse-wonder-1.0" })]), { ...context, remainingBudgetUsd: 0.5 });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.severity, "warning");
  });

  test("the estimate prices the model the floor will actually use", () => {
    // Complex work assigned to the cheap model runs on Wonder (2 attempts x
    // 32k output tokens x $20/M = $1.28), so $1 must trigger the warning even
    // though Spark alone would have looked affordable.
    const issues = validatePlan(plan([task("T1", { complexity: "complex", model: "muse-spark-1.3" })]), { ...context, remainingBudgetUsd: 1 });
    assert.equal(issues.filter((i) => i.severity === "warning").length, 1);
  });
});

describe("validatePlan: clarifying questions", () => {
  const q = (id: string, def = "table") => ({ id, question: "?", why: "", default: def });

  test("accepts up to the configured number of questions with defaults", () => {
    const p: PlanResponse = { kind: "questions", message: "", questions: [q("Q1"), q("Q2")], tasks: [] };
    assert.deepEqual(validatePlan(p, context), []);
  });

  test("rejects too many questions, missing defaults and mixed responses", () => {
    const tooMany: PlanResponse = { kind: "questions", message: "", questions: [q("1"), q("2"), q("3"), q("4")], tasks: [] };
    assert.match(errors(tooMany, context).join(), /exceed the limit/);
    const noDefault: PlanResponse = { kind: "questions", message: "", questions: [q("Q1", " ")], tasks: [] };
    assert.match(errors(noDefault, context).join(), /no default answer/);
    const mixed: PlanResponse = { kind: "questions", message: "", questions: [q("Q1")], tasks: [task("T1")] };
    assert.match(errors(mixed, context).join(), /must not contain tasks/);
  });
});

describe("findCycle", () => {
  test("returns the cycle path or null", () => {
    assert.deepEqual(findCycle([task("A", { depends_on: ["B"] }), task("B", { depends_on: ["A"] })]), ["A", "B", "A"]);
    assert.equal(findCycle([task("A"), task("B", { depends_on: ["A"] })]), null);
  });
});
