import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PathRejectedError } from "../workspace/paths.ts";
import { buildExecutorInput, contextVersion, readContextFiles, type ExecutorInputParts } from "./context.ts";
import type { PlannedTask } from "./schemas.ts";

const task: PlannedTask = {
  id: "T1",
  type: "implement",
  title: "Add planOrder",
  description: "Order tasks so dependencies come first.",
  complexity: "complex",
  impact: "high",
  capabilities: ["code"],
  acceptance: ["tsc passes", "visible tests pass"],
  context_files: ["src/index.ts"],
  write_files: ["src/index.ts"],
  check_groups: [],
  depends_on: [],
  model: "muse-wonder-1.0",
  reason: "",
  escalate_if: "",
};

const parts: ExecutorInputParts = {
  task,
  files: [
    { path: "src/index.ts", content: "export interface TaskSpec {}\n" },
    { path: "src/util.ts", content: "export {};\n" },
  ],
  contract: "Errors extend PlanError.",
  previous: null,
  guidance: null,
  needFilesAllowed: true,
};

test("contextVersion ignores file order", () => {
  assert.equal(contextVersion(parts), contextVersion({ ...parts, files: [...parts.files].reverse() }));
});

test("contextVersion changes when anything that shapes the request changes", () => {
  const base = contextVersion(parts);
  const variants: Array<[string, ExecutorInputParts]> = [
    ["file content", { ...parts, files: [{ ...parts.files[0]!, content: "changed" }, parts.files[1]!] }],
    ["task id", { ...parts, task: { ...task, id: "T2" } }],
    ["description", { ...parts, task: { ...task, description: "Different requirement." } }],
    ["acceptance", { ...parts, task: { ...task, acceptance: ["tsc passes"] } }],
    ["contract", { ...parts, contract: "Errors are plain strings." }],
    ["guidance", { ...parts, guidance: "Keep the public API." }],
    ["previous attempt", { ...parts, previous: { model: "m", diff: "+x", failure: "boom" } }],
  ];
  for (const [label, variant] of variants) {
    assert.notEqual(contextVersion(variant), base, label);
  }
});

test("a first attempt contains the task, criteria, contract, files and reply rules", () => {
  const { input, contextVersion: version } = buildExecutorInput(parts);
  assert.match(input, /# Task T1: Add planOrder/);
  assert.match(input, /- visible tests pass/);
  assert.match(input, /Errors extend PlanError\./);
  assert.match(input, /=== FILE: src\/index\.ts ===\nexport interface TaskSpec \{\}/);
  assert.ok(input.includes(`context_version to "${version}"`));
  assert.doesNotMatch(input, /Previous attempt/);
});

test("reply rules list every protected path and follow the need_files allowance", () => {
  const { input } = buildExecutorInput(parts);
  for (const protectedPath of ["package.json", "package-lock.json", "tsconfig.json", ".gitattributes", "test/"]) {
    assert.ok(input.includes(protectedPath), protectedPath);
  }
  assert.match(input, /You may only change or create these files: src\/index\.ts\./);
  assert.match(input, /list their paths in `need_files`/);
  assert.match(buildExecutorInput({ ...parts, needFilesAllowed: false }).input, /Leave `need_files` empty/);
});

test("an escalation carries the previous diff, failure evidence and guidance", () => {
  const { input } = buildExecutorInput({
    ...parts,
    previous: { model: "muse-spark-1.3", diff: "+export function planOrder() {}", failure: "x".repeat(9000) },
    guidance: "Fix cycle detection; keep the public API.",
  });
  assert.match(input, /## Previous attempt \(muse-spark-1\.3\)/);
  assert.match(input, /\+export function planOrder/);
  assert.match(input, /\[\.\.\. output truncated \.\.\.\]/);
  assert.match(input, /Fix cycle detection/);
});

test("readContextFiles reads protected files but still rejects escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repod context "));
  try {
    await mkdir(path.join(root, "test"));
    await writeFile(path.join(root, "test", "a.test.ts"), "// visible test\n");
    const read = await readContextFiles(root, ["test\\a.test.ts"]);
    assert.deepEqual(read, [{ path: "test/a.test.ts", content: "// visible test\n" }]);
    await assert.rejects(readContextFiles(root, ["../outside.ts"]), PathRejectedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
