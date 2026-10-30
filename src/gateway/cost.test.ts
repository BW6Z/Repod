import assert from "node:assert/strict";
import { test } from "node:test";
import type { Price } from "../config/schema.ts";
import { reservationUsd, standardizedCostUsd } from "./cost.ts";
import type { Usage } from "./types.ts";

const price: Price = {
  model: "test-model",
  inputPerMTok: 2,
  outputPerMTok: 10,
  cachedInputPerMTok: 0.2,
  source: "https://example.com/pricing",
  checkedOn: "2026-10-30",
  verified: false,
};

function usage(partial: Partial<Usage>): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: null, raw: null, ...partial };
}

test("cost adds uncached input, cached input and output at their own rates", () => {
  const cost = standardizedCostUsd(usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 100_000 }), price);
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - (2 + 0.2 + 1)) < 1e-9);
});

test("cost is unknown when cached tokens were used but no cached rate exists", () => {
  const cost = standardizedCostUsd(usage({ inputTokens: 10, cachedInputTokens: 5 }), { ...price, cachedInputPerMTok: null });
  assert.equal(cost, null);
});

test("reservation assumes uncached input and the full output limit", () => {
  assert.ok(Math.abs(reservationUsd(500_000, 100_000, price) - (1 + 1)) < 1e-9);
});
