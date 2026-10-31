import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { PathRejectedError, isProtected, normalizeRelativePath, resolveAllowedPath } from "./paths.ts";

describe("normalizeRelativePath", () => {
  test("accepts ordinary relative paths and normalizes separators", () => {
    assert.equal(normalizeRelativePath("src/index.ts"), "src/index.ts");
    assert.equal(normalizeRelativePath("src\\cli\\main.ts"), "src/cli/main.ts");
  });

  const rejected: Array<[string, string]> = [
    ["", "empty"],
    ["/etc/passwd", "POSIX absolute"],
    ["C:\\Windows\\win.ini", "Windows absolute"],
    ["C:foo.ts", "drive-relative"],
    ["\\\\server\\share\\a.ts", "UNC"],
    ["\\\\?\\C:\\a.ts", "device namespace"],
    ["../outside.ts", "parent segment"],
    ["src/../../outside.ts", "nested parent segment"],
    ["src//a.ts", "empty segment"],
    ["./a.ts", "dot segment"],
    ["src/nul.ts", "reserved device name with extension"],
    ["CON", "reserved device name"],
    ["src/a.ts:stream", "alternate data stream"],
    ["src/a.ts.", "trailing dot"],
    ["src/a.ts ", "trailing space"],
    [".git/config", "git internals"],
    ["src/.GIT/hooks/pre-commit", "git internals, mixed case"],
    ["src/a\u0000.ts", "NUL character"],
  ];
  for (const [input, label] of rejected) {
    test(`rejects ${label}`, () => {
      assert.throws(() => normalizeRelativePath(input), PathRejectedError);
    });
  }
});

describe("isProtected", () => {
  test("matches exact files and directory patterns case-insensitively", () => {
    assert.equal(isProtected("package.json"), true);
    assert.equal(isProtected("Package.JSON"), true);
    assert.equal(isProtected("test/order.test.ts"), true);
    assert.equal(isProtected("TEST/deep/x.ts"), true);
    assert.equal(isProtected("src/package.json"), false);
    assert.equal(isProtected("tests/x.ts"), false);
  });
});

describe("resolveAllowedPath", () => {
  // A space in the folder name mirrors the real project path on this machine.
  let base: string;
  let root: string;
  let outside: string;

  before(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "repod paths ")));
    root = path.join(base, "workspace");
    outside = path.join(base, "outside");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, "src", "a.ts"), "export {};\n");
    // "junction" needs no admin rights on Windows and is ignored on POSIX,
    // where a normal directory symlink is created instead.
    await symlink(outside, path.join(root, "escape"), "junction");
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("resolves existing and new files inside the workspace", async () => {
    assert.equal(await resolveAllowedPath(root, "src/a.ts"), path.join(root, "src", "a.ts"));
    assert.equal(await resolveAllowedPath(root, "src/new/dir/b.ts"), path.join(root, "src", "new", "dir", "b.ts"));
  });

  test("rejects paths that escape through a junction or symlink", async () => {
    await assert.rejects(resolveAllowedPath(root, "escape/evil.ts"), PathRejectedError);
    await assert.rejects(resolveAllowedPath(root, "escape/nested/evil.ts"), PathRejectedError);
  });

  test("rejects a link as the target itself", async () => {
    await assert.rejects(resolveAllowedPath(root, "escape"), PathRejectedError);
  });

  test("rejects directories and protected files", async () => {
    await assert.rejects(resolveAllowedPath(root, "src"), PathRejectedError);
    await assert.rejects(resolveAllowedPath(root, "tsconfig.json"), PathRejectedError);
    await assert.rejects(resolveAllowedPath(root, "test/new.test.ts"), PathRejectedError);
  });
});
