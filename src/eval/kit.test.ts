import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadDemoKit, prepareHoldout } from "./kit.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("the shipped demo kit is complete and consistent", async () => {
  const kit = await loadDemoKit(path.join(repoRoot, "eval", "demo"));
  assert.match(kit.request, /planOrder/);
  assert.match(kit.contract, /SPEC\.md/);
  assert.deepEqual(kit.checkGroups.map((g) => g.name), ["planner", "cli", "docs"]);
  assert.ok(kit.availableChecks.has("doc-examples") && kit.availableChecks.has("doc-references"));
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
