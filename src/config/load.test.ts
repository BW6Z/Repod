import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "./load.ts";
import { Preset } from "./schema.ts";

const configDir = path.resolve(import.meta.dirname, "../../config");

test("shipped config files are valid and every preset model is priced", async () => {
  const config = await loadConfig(configDir);
  assert.ok(config.presets.has("saving"));
  assert.ok(config.presets.has("quality"));
});

test("a preset that references an undeclared model is rejected", () => {
  const result = Preset.safeParse({
    name: "broken",
    description: "",
    coordinator: "muse-spark-1.3",
    roles: { critical: "missing-model", routine: "muse-spark-1.3", review: "muse-spark-1.3", docs: "muse-spark-1.3" },
    models: [{ id: "muse-spark-1.3", provider: "meta", tier: "cheap" }],
  });
  assert.equal(result.success, false);
});

test("a non-Meta coordinator is rejected", () => {
  const result = Preset.safeParse({
    name: "broken",
    description: "",
    coordinator: "claude-opus-5-5",
    roles: { critical: "claude-opus-5-5", routine: "claude-opus-5-5", review: "claude-opus-5-5", docs: "claude-opus-5-5" },
    models: [{ id: "claude-opus-5-5", provider: "anthropic", tier: "strong" }],
  });
  assert.equal(result.success, false);
});
