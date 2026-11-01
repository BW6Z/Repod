import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExecutorOutput } from "../orchestrator/schemas.ts";
import { runCheck, standardChecks } from "../verifier/verifier.ts";
import {
  OutputRejectedError,
  WorkspaceTaintedError,
  applyExecutorOutput,
  captureSnapshot,
  createRunWorkspace,
  diffAgainstBaseline,
  gitEnvironment,
  markTainted,
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
let baselineDir: string;
let workspace: RunWorkspace;

function output(files: ExecutorOutput["files"], overrides: Partial<ExecutorOutput> = {}): ExecutorOutput {
  return { task_id: "T1", context_version: "v1", files, need_files: [], notes: "", ...overrides };
}
// A broad write scope and no snapshot, so these tests exercise one rule at a
// time; the scope and snapshot rules have their own tests below.
const expected = {
  taskId: "T1",
  contextVersion: "v1",
  allowedWrites: [
    "src/ok.ts", "tsconfig.json", "src/x.ts", "src/big.ts", "src/math.ts", "src/extra/util.ts",
    "src/locked.ts", "src/broken.ts", ...Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`),
  ],
  snapshot: {},
};

async function checks() {
  const specs = standardChecks({ workspaceRoot: workspace.root, tscEntry, timeoutMs: 60_000, maxOutputBytes: 100_000 });
  return Promise.all(specs.map((spec) => runCheck(spec)));
}

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "repod workspace "));
  baselineDir = path.join(base, "baseline repo");
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

describe("write scope, freshness and taint", () => {
  const scoped = (snapshot: Record<string, string | null>, allowedWrites = ["src/math.ts", "src/fresh.ts"]) => ({
    taskId: "T1",
    contextVersion: "v1",
    allowedWrites,
    snapshot,
  });

  test("a path inside another path of the same output is rejected in either order, and nothing is written", async () => {
    const scope = ["src/nest", "src/nest/inner.ts"];
    for (const files of [scope, [...scope].reverse()]) {
      const error = await applyExecutorOutput(workspace, output(files.map((p) => ({ path: p, content: "export {};\n" }))), scoped({}, scope), limits)
        .catch((e: unknown) => e);
      assert.ok(error instanceof OutputRejectedError, "a clear rejection, not a file-system error");
      assert.match(error.reasons.join("\n"), /lies inside "src\/nest"/);
      await assert.rejects(lstat(path.join(workspace.root, "src", "nest")), "nothing was created");
    }
  });

  test("a new file is created under the plan's spelling, whatever case the executor used", async () => {
    const written = await applyExecutorOutput(workspace, output([{ path: "SRC/NewCase.ts", content: "export {};\n" }]), scoped({}, ["src/newcase.ts"]), limits);
    assert.deepEqual(written, ["src/newcase.ts"]);
    const names = await readdir(path.join(workspace.root, "src"));
    assert.ok(names.includes("newcase.ts"), names.join(", "));
    assert.ok(!names.includes("NewCase.ts"));
  });

  test("a file outside the write scope rejects the whole output", async () => {
    await assert.rejects(
      applyExecutorOutput(workspace, output([{ path: "src/other.ts", content: "export {};\n" }]), scoped({}), limits),
      /outside the task's write scope/,
    );
    await assert.rejects(readFile(path.join(workspace.root, "src", "other.ts")));
  });

  test("output is rejected when a file changed after the input was assembled", async () => {
    const mathPath = path.join(workspace.root, "src", "math.ts");
    const snapshot = await captureSnapshot(workspace, ["src/math.ts"]);
    const before = await readFile(mathPath, "utf8");
    await writeFile(mathPath, before + "// changed by someone else\n");
    try {
      await assert.rejects(
        applyExecutorOutput(workspace, output([{ path: "src/math.ts", content: "// stale\n" }]), scoped(snapshot), limits),
        /changed after the task input was assembled/,
      );
      assert.match(await readFile(mathPath, "utf8"), /changed by someone else/);
    } finally {
      await writeFile(mathPath, before);
    }
  });

  test("a file expected to be new must still not exist", async () => {
    const freshPath = path.join(workspace.root, "src", "fresh.ts");
    const snapshot = await captureSnapshot(workspace, ["src/fresh.ts"]);
    assert.deepEqual(snapshot, { "src/fresh.ts": null });
    await writeFile(freshPath, "// created by someone else\n");
    try {
      await assert.rejects(
        applyExecutorOutput(workspace, output([{ path: "src/fresh.ts", content: "// mine\n" }]), scoped(snapshot), limits),
        /expected not to exist yet/,
      );
    } finally {
      await rm(freshPath);
    }
  });

  test("an unchanged snapshot lets the output through", async () => {
    const snapshot = await captureSnapshot(workspace, ["src/fresh.ts"]);
    const written = await applyExecutorOutput(workspace, output([{ path: "src/fresh.ts", content: "export {};\n" }]), scoped(snapshot), limits);
    assert.deepEqual(written, ["src/fresh.ts"]);
    await rm(path.join(workspace.root, "src", "fresh.ts"));
  });

  test("a tainted workspace refuses every write", async () => {
    const other = await createRunWorkspace(baselineDir, path.join(base, "runs"), "run-tainted");
    markTainted(other, "check process did not exit");
    await assert.rejects(
      applyExecutorOutput(other, output([{ path: "src/math.ts", content: "// x\n" }]), scoped({}), limits),
      WorkspaceTaintedError,
    );
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

  test("the user's own git ignore and attributes files change neither the baseline nor the diff", async () => {
    const home = path.join(base, "home with git config");
    await mkdir(path.join(home, ".config", "git"), { recursive: true });
    await writeFile(path.join(home, ".config", "git", "ignore"), "*.md\n");
    await writeFile(path.join(home, ".config", "git", "attributes"), "*.ts -diff\n");
    const source = path.join(base, "baseline with readme");
    for (const [file, content] of Object.entries({ ...BASELINE, "README.md": "# Readme\n" })) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), content);
    }
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const ws = await createRunWorkspace(source, path.join(base, "runs"), "run-user-git");
      assert.match(execFileSync("git", ["ls-files"], { cwd: ws.root, encoding: "utf8" }), /^README\.md$/m);
      await writeFile(path.join(ws.root, "src", "math.ts"), "export const changed = 1;\n");
      await writeFile(path.join(ws.root, "NOTES.md"), "new\n");
      const diff = await diffAgainstBaseline(ws);
      assert.doesNotMatch(diff, /Binary files/);
      assert.match(diff, /\+export const changed = 1;/);
      assert.match(diff, /b\/NOTES\.md/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("attributes and ignore files inside the workspace cannot hide changes from the diff", async () => {
    const ws = await createRunWorkspace(baselineDir, path.join(base, "runs"), "run-hidden");
    // What model-written code could create while its tests run.
    await writeFile(path.join(ws.root, "src", ".gitattributes"), "* -diff\n");
    await writeFile(path.join(ws.root, ".gitignore"), "src/extra.ts\n");
    await writeFile(path.join(ws.root, "src", "math.ts"), "export const changed = 1;\n");
    await writeFile(path.join(ws.root, "src", "extra.ts"), "export const extra = 1;\n");
    const diff = await diffAgainstBaseline(ws);
    assert.doesNotMatch(diff, /Binary files/);
    assert.match(diff, /\+export const changed = 1;/);
    assert.match(diff, /\+export const extra = 1;/);
  });

  test("a diff limited to a task's files leaves out everything else, by real spelling and literally", async () => {
    const ws = await createRunWorkspace(baselineDir, path.join(base, "runs"), "run-scoped-diff");
    await writeFile(path.join(ws.root, "src", "math.ts"), "export const changed = 1;\n");
    await writeFile(path.join(ws.root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(ws.root, "src", "[ab].ts"), "export const bracket = 1;\n");
    await writeFile(path.join(ws.root, "test", "copied.test.ts"), "// a visible test copied in\n");

    const own = await diffAgainstBaseline(ws, ["SRC/Math.ts"]); // the plan's spelling may differ in case
    assert.match(own, /\+export const changed = 1;/);
    assert.doesNotMatch(own, /src\/a\.ts|copied\.test|bracket/);

    const literal = await diffAgainstBaseline(ws, ["src/[ab].ts"]); // not a glob matching src/a.ts
    assert.match(literal, /\+export const bracket = 1;/);
    assert.doesNotMatch(literal, /export const a = 1/);

    assert.equal(await diffAgainstBaseline(ws, []), "", "no paths means no diff, not the whole workspace");
    assert.equal(await diffAgainstBaseline(ws, ["../outside.ts"]), "");
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
