import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import type { Preset } from "../config/schema.ts";
import { applyCapabilityFloor, requiredTier, reviewRequirement, type CheckKind } from "./routing.ts";
import type { PlannedTask } from "./schemas.ts";

const preset: Preset = {
  name: "test",
  description: "",
  coordinator: "spark",
  roles: { critical: "wonder", routine: "spark", review: "wonder", docs: "gemini" },
  allowFreeModels: true,
  models: [
    { id: "gemini", provider: "meta", tier: "free" },
    { id: "spark", provider: "meta", tier: "cheap" },
    { id: "wonder", provider: "meta", tier: "strong" },
  ],
};

function task(overrides: Partial<PlannedTask>): PlannedTask {
  return {
    id: "T1",
    type: "implement",
    title: "",
    description: "",
    complexity: "simple",
    impact: "low",
    capabilities: ["code"],
    acceptance: ["tsc passes"],
    context_files: [],
    write_files: ["src/a.ts"],
    check_groups: [],
    depends_on: [],
    model: "gemini",
    reason: "",
    escalate_if: "",
    ...overrides,
  };
}

describe("requiredTier", () => {
  test("maps complexity and impact to a floor", () => {
    assert.equal(requiredTier(task({ complexity: "complex", impact: "low" })), "strong");
    assert.equal(requiredTier(task({ complexity: "simple", impact: "high" })), "strong");
    assert.equal(requiredTier(task({ complexity: "medium", impact: "low" })), "cheap");
    assert.equal(requiredTier(task({ complexity: "simple", impact: "medium" })), "cheap");
    assert.equal(requiredTier(task({ complexity: "simple", impact: "low" })), "free");
  });
});

describe("applyCapabilityFloor", () => {
  test("keeps Meta's choice when it meets the floor", () => {
    assert.deepEqual(applyCapabilityFloor(task({}), preset), { model: "gemini", raised: false, reason: null });
    // Choosing a stronger model than needed is always allowed.
    assert.equal(applyCapabilityFloor(task({ model: "wonder" }), preset).raised, false);
  });

  test("raises complex or high-impact work to the critical model", () => {
    const decision = applyCapabilityFloor(task({ complexity: "complex", model: "spark" }), preset);
    assert.equal(decision.model, "wonder");
    assert.equal(decision.raised, true);
    assert.match(decision.reason ?? "", /strong-tier/);
  });

  test("raises medium work on a free model to the routine model", () => {
    const decision = applyCapabilityFloor(task({ complexity: "medium", model: "gemini" }), preset);
    assert.equal(decision.model, "spark");
    assert.equal(decision.raised, true);
  });

  test("never uses a free model when the project has not opted in", () => {
    const decision = applyCapabilityFloor(task({ model: "gemini" }), { ...preset, allowFreeModels: false });
    assert.equal(decision.model, "spark");
    assert.equal(decision.raised, true);
  });

  test("replaces an unknown model", () => {
    const decision = applyCapabilityFloor(task({ model: "made-up" }), preset);
    assert.equal(decision.model, "spark");
    assert.match(decision.reason ?? "", /not an executor model/);
  });

  test("the shipped quality preset runs every task on its strong model", async () => {
    const config = await loadConfig(path.resolve(import.meta.dirname, "../../config"));
    const quality = config.presets.get("quality")!;
    for (const complexity of ["simple", "medium", "complex"] as const) {
      // Meta picks the cheap coordinator model, which quality declares but
      // does not assign to any executor role.
      const decision = applyCapabilityFloor(task({ complexity, model: "muse-spark-1.3" }), quality);
      assert.equal(decision.model, "muse-wonder-1.0", complexity);
    }
    // The saving preset keeps its freedom to use the cheap model.
    const saving = config.presets.get("saving")!;
    assert.equal(applyCapabilityFloor(task({ model: "muse-spark-1.3" }), saving).model, "muse-spark-1.3");
  });
});

describe("reviewRequirement", () => {
  const all = new Set<CheckKind>(["typecheck", "visible-tests", "doc-examples", "doc-references"]);

  test("code tasks without tests are not allowed to run", () => {
    const result = reviewRequirement(task({ type: "implement" }), new Set(["typecheck"]));
    assert.equal(result.allowed, false);
    assert.match(result.reasons.join(), /visible-tests/);
    assert.equal(reviewRequirement(task({ type: "fix" }), all).allowed, true);
  });

  test("docs tasks need a review when a docs check cannot run", () => {
    const docs = task({ type: "docs" });
    assert.equal(reviewRequirement(docs, all).reviewRequired, false);
    const missing = reviewRequirement(docs, new Set(["doc-examples"]));
    assert.equal(missing.reviewRequired, true);
    assert.match(missing.reasons.join(), /doc-references/);
  });

  test("complex or high-impact tasks are always reviewed", () => {
    assert.equal(reviewRequirement(task({ complexity: "complex" }), all).reviewRequired, true);
    assert.equal(reviewRequirement(task({ impact: "high" }), all).reviewRequired, true);
  });
});
