import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExecutorOutput } from "../orchestrator/schemas.ts";
import { runCheck, standardChecks } from "../verifier/verifier.ts";
import {
  OutputRejectedError,
  applyExecutorOutput,
  createRunWorkspace,
  diffAgainstBaseline,
  gitEnvironment,
  snapshotManifest,
  type RunWorkspace,
} from "./workspace.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const limits = { maxFilesPerOutput: 8, maxFileBytes: 65536 };

// The baseline's tsconfig covers src only: its tests import node:test, whose
// types are not installed in the temporary folder.
const BASELINE: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "es2024", module: "nodenext", moduleResolution: "nodenext", strict: true,
      noEmit: true, allowImportingTsExtensions: true, types: [],
    },
    include: ["src"],
  }),
  "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "test/math.test.ts":
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/math.ts';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
};

// A space in the folder name mirrors the real project path on this machine.
let base: string;
let workspace: RunWorkspace;

function output(files: ExecutorOutput["files"], overrides: Partial<ExecutorOutput> = {}): ExecutorOutput {
  return { task_id: "T1", context_version: "v1", files, need_files: [], notes: "", ...overrides };
}
const expected = { taskId: "T1", contextVersion: "v1" };

async function checks() {
  const specs = standardChecks({ workspaceRoot: workspace.root, tscEntry, timeoutMs: 60_000, maxOutputBytes: 100_000 });
  return Promise.all(specs.map((spec) => runCheck(spec)));
}

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "repod workspace "));
  const baselineDir = path.join(base, "baseline repo");
  for (const [file, content] of Object.entries(BASELINE)) {
    await mkdir(path.dirname(path.join(baselineDir, file)), { recursive: true });
    await writeFile(path.join(baselineDir, file), content);
  }
  workspace = await createRunWorkspace(baselineDir, path.join(base, "runs"), "run-1");
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("createRunWorkspace", () => {
  test("copies the baseline and records a baseline commit", async () => {
    assert.match(workspace.baselineCommit, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(path.join(workspace.root, "src", "math.ts"), "utf8"), BASELINE["src/math.ts"]);
  });

  test("rejects unsafe or reused run ids", async () => {
    await assert.rejects(createRunWorkspace(base, path.join(base, "runs"), "../escape"));
    await assert.rejects(createRunWorkspace(base, path.join(base, "runs"), "run-1"));
  });
});

describe("checks in a workspace whose path contains spaces", () => {
  test("type check and visible tests pass on the baseline", async () => {
    const [typecheck, tests] = await checks();
    assert.equal(typecheck?.passed, true, typecheck?.output);
    assert.equal(tests?.passed, true, tests?.output);
    assert.equal(tests?.testsRun, 1);
  });
});

describe("applyExecutorOutput", () => {
  test("rejects the whole output when any file is invalid and writes nothing", async () => {
    const bad = output([
      { path: "src/ok.ts", content: "export const ok = 1;\n" },
      { path: "tsconfig.json", content: "{}" },
    ]);
    await assert.rejects(applyExecutorOutput(workspace, bad, expected, limits), OutputRejectedError);
    await assert.rejects(readFile(path.join(workspace.root, "src", "ok.ts")));
  });

  test("rejects stale context versions, wrong task ids and duplicate paths", async () => {
    const file = { path: "src/x.ts", content: "export {};\n" };
    await assert.rejects(applyExecutorOutput(workspace, output([file], { context_version: "old" }), expected, limits), OutputRejectedError);
    await assert.rejects(applyExecutorOutput(workspace, output([file], { task_id: "T9" }), expected, limits), OutputRejectedError);
    await assert.rejects(
      applyExecutorOutput(workspace, output([file, { path: "SRC/X.ts", content: "" }]), expected, limits),
      OutputRejectedError,
    );
  });

  test("rejects too many files and oversized files", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.ts`, content: "" }));
    await assert.rejects(applyExecutorOutput(workspace, output(many), expected, limits), OutputRejectedError);
    const big = { path: "src/big.ts", content: "x".repeat(limits.maxFileBytes + 1) };
    await assert.rejects(applyExecutorOutput(workspace, output([big]), expected, limits), OutputRejectedError);
  });

  test("writes valid output with LF line endings and the diff includes new files", async () => {
    const written = await applyExecutorOutput(
      workspace,
      output([
        { path: "src/math.ts", content: "export function add(a: number, b: number): number {\r\n  return b + a;\r\n}\r\n" },
        { path: "src/extra/util.ts", content: "export const twice = (n: number): number => n * 2;\n" },
      ]),
      expected,
      limits,
    );
    assert.deepEqual(written, ["src/math.ts", "src/extra/util.ts"]);
    assert.doesNotMatch(await readFile(path.join(workspace.root, "src", "math.ts"), "utf8"), /\r/);

    const diff = await diffAgainstBaseline(workspace);
    assert.match(diff, /src\/extra\/util\.ts/);
    assert.match(diff, /\+  return b \+ a;/);

    const manifest = await snapshotManifest(workspace);
    assert.ok("src/extra/util.ts" in manifest);
    assert.ok(!Object.keys(manifest).some((key) => key.startsWith(".git/")));
  });

  test("a failed write restores files already written", async () => {
    const lockedPath = path.join(workspace.root, "src", "locked.ts");
    await writeFile(lockedPath, "export const locked = true;\n");
    await chmod(lockedPath, 0o444); // read-only: the second write fails on Windows and POSIX
    const mathBefore = await readFile(path.join(workspace.root, "src", "math.ts"), "utf8");
    try {
      await assert.rejects(
        applyExecutorOutput(
          workspace,
          output([
            { path: "src/math.ts", content: "// overwritten\n" },
            { path: "src/locked.ts", content: "// cannot write\n" },
          ]),
          expected,
          limits,
        ),
      );
      assert.equal(await readFile(path.join(workspace.root, "src", "math.ts"), "utf8"), mathBefore);
    } finally {
      await chmod(lockedPath, 0o644);
      await rm(lockedPath);
    }
  });

  test("a type error written by an executor makes the type check fail", async () => {
    await applyExecutorOutput(
      workspace,
      output([{ path: "src/broken.ts", content: "export const n: number = 'not a number';\n" }]),
      expected,
      limits,
    );
    const [typecheck] = await checks();
    assert.equal(typecheck?.passed, false);
    assert.equal(typecheck?.failure, "exit_code");
    assert.match(typecheck?.output ?? "", /broken\.ts/);
  });
});

describe("git isolation in the run workspace", () => {
  test("git gets no API keys and ignores system and global config", () => {
    const env = gitEnvironment({ Path: "/bin", MODEL_API_KEY: "secret", ANTHROPIC_API_KEY: "secret" });
    assert.equal(env.MODEL_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.ok(env.GIT_CONFIG_GLOBAL);
  });

  test("a core.fsmonitor command planted in the workspace config never runs", async () => {
    // Model-written code could edit .git/config while tests run; git must
    // not execute what it planted when the diff is taken.
    const marker = path.join(base, "fsmonitor-ran.txt");
    const hook = path.join(base, "hook.cjs");
    await writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${hook.replaceAll("\\", "/")}"`;
    execFileSync("git", ["config", "core.fsmonitor", command], { cwd: workspace.root });

    await diffAgainstBaseline(workspace);
    await assert.rejects(stat(marker), /ENOENT/);
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: workspace.root });
  });
});
