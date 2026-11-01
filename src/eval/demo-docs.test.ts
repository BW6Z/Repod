import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Runs the shipped README code-block check (eval/demo/visible/docs.test.ts)
 * against a README of our choosing. The fixture mirrors a run workspace: the
 * baseline sample-repo sources, the visible test under test/, and a link to
 * this repository's node_modules so the check finds the compiler the way it
 * does inside a run.
 */
describe("demo docs check: README code blocks", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "repod-docs-check-"));
    await cp(path.join(repoRoot, "sample-repo", "src"), path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, "test"));
    await cp(path.join(repoRoot, "eval", "demo", "visible", "docs.test.ts"), path.join(workspace, "test", "docs.test.ts"));
    // "junction" needs no extra rights on Windows and is ignored elsewhere.
    await symlink(path.join(repoRoot, "node_modules"), path.join(workspace, "node_modules"), "junction");
  });

  after(async () => {
    // Remove the link first so a recursive delete can never follow it.
    await rm(path.join(workspace, "node_modules"), { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  async function blockCheckPasses(readme: string): Promise<{ passed: boolean; output: string }> {
    await writeFile(path.join(workspace, "README.md"), readme);
    // Inherited NODE_TEST_CONTEXT makes a nested `node --test` skip its files.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-name-pattern=every ts code block", path.join("test", "docs.test.ts")],
      { cwd: workspace, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const output = `${result.stdout}${result.stderr}`;
    // Guards against a vacuous pass: the check must really have run.
    assert.match(output, /every ts code block type-checks on its own/);
    return { passed: result.status === 0, output };
  }

  const block = (code: string) => `# Sample\n\n\`\`\`ts\n${code}\n\`\`\`\n`;

  test("accepts single- and double-quoted imports of the public entry", async () => {
    const readme =
      block(`import { parseTasks } from './src/index.ts';\nconsole.log(parseTasks([]).length);`) +
      block(`import { parseTasks } from "./src/index.ts";\nconsole.log(parseTasks([]).length);`);
    const { passed, output } = await blockCheckPasses(readme);
    assert.ok(passed, output);
  });

  test("ignores import-like text in comments", async () => {
    const { passed, output } = await blockCheckPasses(block(`// see import { x } from './src/missing.ts'\nimport { parseTasks } from './src/index.ts';\nparseTasks([]);`));
    assert.ok(passed, output);
  });

  test("accepts a README without ts blocks, as SPEC.md requires none", async () => {
    const { passed, output } = await blockCheckPasses("# Sample\n\nNo code here.\n");
    assert.ok(passed, output);
  });

  test("still rejects blocks with real problems", async () => {
    for (const [code, reason] of [
      [`import { parseTasks } from './src/index.ts';\nparseTasks([], 1);`, /error TS2554/], // wrong arity
      [`import { notExported } from './src/index.ts';\nnotExported();`, /error TS2305/], // missing export
      [`import { parseTasks } from './src/tasks.ts';\nparseTasks([]);`, /imports "\.\/src\/tasks\.ts"/], // not the public entry
      [`import { parseTasks } from './src/nowhere.ts';\nparseTasks([]);`, /error TS2307/], // wrong path
    ] as const) {
      const { passed, output } = await blockCheckPasses(block(code));
      assert.equal(passed, false, `should be rejected:\n${code}`);
      assert.match(output, reason);
    }
  });

  test("leaves nothing behind in the workspace", async () => {
    await blockCheckPasses(block(`import { parseTasks } from './src/index.ts';\nparseTasks([]);`));
    assert.deepEqual((await readdir(workspace)).sort(), ["README.md", "node_modules", "src", "test"]);
  });
});
