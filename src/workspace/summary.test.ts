import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractExports, renderRepoSummary, summarizeRepo } from "./summary.ts";

test("extractExports finds declarations, export lists and default exports", () => {
  const source = [
    "export function planOrder() {}",
    "export async function load() {}",
    "export const VERSION = 1;",
    "export interface TaskSpec {}",
    "export type Id = string;",
    "export class PlanError extends Error {}",
    "export { helper, internal as publicName };",
    "export type { Hidden };",
    "export default { x: 1 };",
    "const notExported = 2;",
    "  export const indented = 3; // not top level",
  ].join("\n");
  assert.deepEqual(extractExports(source), [
    "planOrder", "load", "VERSION", "TaskSpec", "Id", "PlanError", "helper", "publicName", "Hidden", "default",
  ]);
});

test("summarizeRepo lists files with sizes, exports and notes, skipping .git and node_modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repod summary "));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export function a() {}\n");
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".git", "HEAD"), "ref");
    await writeFile(path.join(root, "node_modules", "x", "i.js"), "export const y = 1;");

    const files = await summarizeRepo(root, { "src/index.ts": "Library entry point." });
    assert.deepEqual(files.map((f) => f.path), ["README.md", "src/index.ts"]);
    assert.deepEqual(files[1]?.exports, ["a"]);
    assert.equal(
      renderRepoSummary(files),
      "README.md (7 B)\nsrc/index.ts (23 B) | exports: a | Library entry point.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
