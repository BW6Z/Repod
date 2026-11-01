import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../config/load.ts";
import { validatePlan } from "../orchestrator/plan-validation.ts";
import { applyCapabilityFloor } from "../orchestrator/routing.ts";
import { listFiles } from "../workspace/workspace.ts";
import { singleModelTask } from "./experiment.ts";
import { loadDemoKit, prepareHoldout } from "./kit.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("the shipped demo kit is complete and consistent", async () => {
  const kit = await loadDemoKit(path.join(repoRoot, "eval", "demo"));
  assert.match(kit.request, /planOrder/);
  assert.match(kit.contract, /SPEC\.md/);
  assert.deepEqual(kit.checkGroups.map((g) => g.name), ["planner", "cli", "docs"]);
  assert.ok(kit.availableChecks.has("doc-examples") && kit.availableChecks.has("doc-references"));
});

test("arm A's shipped task is a valid plan for the sample repository", async () => {
  const kit = await loadDemoKit(path.join(repoRoot, "eval", "demo"));
  const config = await loadConfig(path.join(repoRoot, "config"));
  const preset = config.presets.get("saving")!;
  // Its write scope may only name files the public SPEC or contract names.
  const publicText = kit.contract + (await readFile(path.join(repoRoot, "sample-repo", "SPEC.md"), "utf8"));
  for (const file of kit.singleModel.writeFiles) assert.ok(publicText.includes(file), `${file} is not named in SPEC.md or the contract`);

  const files = (await listFiles(path.join(repoRoot, "sample-repo"))).filter((f) => !f.startsWith("node_modules/"));
  const task = singleModelTask(kit, preset, files);
  const issues = validatePlan({ kind: "plan", message: "", questions: [], tasks: [task] }, {
    knownFiles: new Set(files), preset, limits: config.limits, pricing: config.pricing, remainingBudgetUsd: 100, checkGroups: kit.checkGroups,
  });
  assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  assert.equal(applyCapabilityFloor(task, preset).raised, false);
});

test("holdout tests are copied next to the workspace and run from there", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "repod-holdout-"));
  try {
    const source = path.join(base, "source");
    await mkdir(source);
    await writeFile(path.join(source, "a.test.ts"), "");
    await writeFile(path.join(source, "notes.md"), "");
    const [spec] = await prepareHoldout(path.join(base, "run"), source, 1000, 1000);
    assert.equal(spec?.cwd, path.join(base, "run", "holdout"));
    assert.deepEqual(await readdir(path.join(base, "run", "holdout")), ["a.test.ts"]);
    assert.equal(spec?.expectTests, true);
    await assert.rejects(prepareHoldout(path.join(base, "run2"), path.join(base, "run", "missing-source"), 1000, 1000));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
