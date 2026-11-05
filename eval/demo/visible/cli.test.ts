// Visible checks for the "cli" group. They cover the basic cases of
// SPEC.md section 3; edge cases are covered by holdout tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
const dir = mkdtempSync(path.join(tmpdir(), "planner-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
}

function file(name: string, content: unknown): string {
  writeFileSync(path.join(dir, name), JSON.stringify(content));
  return name;
}

const lines = (text: string) => text.replaceAll("\r\n", "\n").split("\n");

describe("plan command", () => {
  const tasks = file("tasks.json", [{ id: "c", dependsOn: ["a"] }, { id: "a" }, { id: "b" }]);

  test("prints stages counted from 1, then the order", () => {
    const result = run(["plan", tasks]);
    assert.equal(result.status, 0, result.stderr);
    // c comes before b in the input, so once a is placed c wins the tie (SPEC R1).
    assert.deepEqual(lines(result.stdout), ["Stage 1: a, b", "Stage 2: c", "Order: a, c, b", ""]);
    assert.equal(result.stderr, "");
  });

  test("prints JSON with --json", () => {
    const result = run(["plan", tasks, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { order: ["a", "c", "b"], stages: [["a", "b"], ["c"]] });
  });

  test("reports library errors with exit code 1", () => {
    const result = run(["plan", file("unknown.json", [{ id: "a", dependsOn: ["ghost"] }])]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^error UNKNOWN_DEPENDENCY: /);
  });

  test("a missing file argument is a usage error with exit code 2", () => {
    const result = run(["plan"]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  });
});
