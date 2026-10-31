import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "./load.ts";
import { Preset } from "./schema.ts";

const configDir = path.resolve(import.meta.dirname, "../../config");

// A valid preset; each test changes one thing so a rejection can only come
// from the rule under test.
const valid = {
  name: "test",
  description: "",
  coordinator: "spark",
  roles: { critical: "wonder", routine: "spark", review: "wonder", docs: "spark" },
  allowFreeModels: false,
  models: [
    { id: "spark", provider: "meta", tier: "cheap" },
    { id: "wonder", provider: "meta", tier: "strong" },
  ],
};

function issues(preset: unknown): string[] {
  const result = Preset.safeParse(preset);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

test("shipped config files are valid and every preset model is priced", async () => {
  const config = await loadConfig(configDir);
  assert.ok(config.presets.has("saving"));
  assert.ok(config.presets.has("quality"));
});

test("the base preset used by these tests is valid", () => {
  assert.deepEqual(issues(valid), []);
});

test("a preset that references an undeclared model is rejected", () => {
  assert.match(issues({ ...valid, roles: { ...valid.roles, docs: "missing" } }).join(), /not declared/);
});

test("a non-Meta coordinator is rejected", () => {
  const preset = {
    ...valid,
    coordinator: "claude",
    models: [...valid.models, { id: "claude", provider: "anthropic", tier: "strong" }],
  };
  assert.match(issues(preset).join(), /must be a Meta model/);
});

test("critical and review roles need a strong model; routine needs at least cheap", () => {
  assert.match(issues({ ...valid, roles: { ...valid.roles, critical: "spark" } }).join(), /"critical" needs a strong/);
  assert.match(issues({ ...valid, roles: { ...valid.roles, review: "spark" } }).join(), /"review" needs a strong/);
  const withFree = {
    ...valid,
    allowFreeModels: true,
    roles: { ...valid.roles, routine: "gemini" },
    models: [...valid.models, { id: "gemini", provider: "meta", tier: "free" }],
  };
  assert.match(issues(withFree).join(), /"routine" needs a cheap/);
});

test("free-tier models require allowFreeModels", () => {
  const docsOnFree = {
    ...valid,
    roles: { ...valid.roles, docs: "gemini" },
    models: [...valid.models, { id: "gemini", provider: "meta", tier: "free" }],
  };
  assert.match(issues(docsOnFree).join(), /allowFreeModels is false/);
  assert.deepEqual(issues({ ...docsOnFree, allowFreeModels: true }), []);
});
