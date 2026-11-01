// Visible checks for the "docs" group (SPEC.md section 4). These are the
// documentation checks: the example's real output, README names that are
// really exported, README code blocks that type-check, and the changelog.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import * as library from "../src/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");

/** Finds an installed file by walking up from this directory, the way Node resolves packages. */
function findUp(relative: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`${relative} not found above ${root}`);
  }
}

describe("example", () => {
  test("examples/basic.ts prints the plan of the tasks in SPEC.md", () => {
    const result = spawnSync(process.execPath, [path.join(root, "examples", "basic.ts")], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.replaceAll("\r\n", "\n"), [
      "Stage 1: docs, compile",
      "Stage 2: test",
      "Stage 3: package",
      "Order: docs, compile, test, package",
      "",
    ].join("\n"));
  });
});

describe("README", () => {
  const readme = read("README.md");
  const planning = /^## Planning\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(readme)?.[1] ?? "";

  test("has a Planning section naming the exported API, the command and the example", () => {
    assert.ok(planning, "README.md needs a '## Planning' section");
    for (const name of ["planOrder", "DuplicateTaskError", "UnknownDependencyError", "CycleError"]) {
      assert.ok(planning.includes(name), `Planning section should mention ${name}`);
      assert.equal(typeof (library as Record<string, unknown>)[name], "function", `${name} must really be exported`);
    }
    assert.ok(planning.includes("node src/cli.ts plan"), "Planning section should show the plan command");
    assert.ok(planning.includes("examples/basic.ts"), "Planning section should point to the example");
  });

  // SPEC section 4 does not require any ts block; it only rules on the ones present.
  test("every ts code block type-checks on its own", () => {
    const blocks = [...readme.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);
    const tsc = findUp(path.join("node_modules", "typescript", "bin", "tsc"));
    const typeRoots = findUp(path.join("node_modules", "@types"));
    const posix = (p: string) => p.replaceAll("\\", "/");
    const dir = mkdtempSync(path.join(tmpdir(), "readme-blocks-"));
    try {
      blocks.forEach((block, i) => {
        // Each block is checked outside the repository (nothing is written
        // next to the README), but rootDirs merges the temporary folder with
        // the repository root, so its relative imports resolve exactly as
        // they would from README.md, whatever quote style they use.
        // traceResolution lists the imports the compiler itself found, so
        // comments and strings that merely look like imports are ignored.
        const name = `block-${i}.mts`;
        writeFileSync(path.join(dir, name), block);
        writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
          compilerOptions: {
            noEmit: true, strict: true, target: "es2024", module: "nodenext", moduleResolution: "nodenext",
            allowImportingTsExtensions: true, skipLibCheck: true, types: ["node"], typeRoots: [posix(typeRoots)],
            rootDirs: [posix(dir), posix(root)], traceResolution: true,
          },
          files: [name],
        }));
        // The trace includes @types/node and runs to about a megabyte.
        const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        const trace = result.stdout ?? "";
        const errors = trace.split("\n").filter((line) => /error TS\d+/.test(line)).join("\n");
        assert.equal(result.status, 0, `README code block ${i + 1} does not type-check:\n${errors || trace.slice(-4000)}${result.stderr}`);
        const imports = [...trace.matchAll(/^======== Resolving module '(.+)' from '(.+)'\. ========\r?$/gm)]
          .filter((m) => path.basename(m[2]!) === name)
          .map((m) => m[1]!);
        for (const specifier of imports) {
          assert.equal(specifier, "./src/index.ts", `README code block ${i + 1} imports "${specifier}"; blocks import only from ./src/index.ts`);
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CHANGELOG", () => {
  test("has an Unreleased entry mentioning planOrder", () => {
    const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(read("CHANGELOG.md"))?.[1] ?? "";
    assert.match(unreleased, /planOrder/);
  });
});
