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
    ["PACKAG~1.JSO", "8.3 short name of package.json"],
    ["GIT~1/config", "8.3 short name of .git"],
    ["src/CONIN$", "console input device"],
    ["src/com¹.ts", "superscript COM device"],
    ["node_modules/x/index.js", "node_modules"],
    ["src/Node_Modules/x.js", "nested node_modules, mixed case"],
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
    // Folders that are protected or not writable, plus links into them from
    // inside the workspace (the case reported as N2 in the re-review).
    for (const dir of ["test", ".git", "node_modules"]) await mkdir(path.join(root, dir));
    // "junction" needs no admin rights on Windows and is ignored on POSIX,
    // where a normal directory symlink is created instead.
    await symlink(outside, path.join(root, "escape"), "junction");
    await symlink(path.join(root, "test"), path.join(root, "alias-test"), "junction");
    await symlink(path.join(root, ".git"), path.join(root, "alias-git"), "junction");
    await symlink(path.join(root, "node_modules"), path.join(root, "alias-nm"), "junction");
    await symlink(path.join(root, "src"), path.join(root, "alias-src"), "junction");
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

  test("rejects new files that land in a protected folder through an internal link", async () => {
    await assert.rejects(resolveAllowedPath(root, "alias-test/new.test.ts"), /really resolves to "test\/new\.test\.ts"/);
    await assert.rejects(resolveAllowedPath(root, "alias-git/hooks/pre-commit"), /really resolves to "\.git\//);
    await assert.rejects(resolveAllowedPath(root, "alias-nm/pkg/deep/index.js"), /really resolves to "node_modules\//);
  });

  test("an internal link to an allowed folder resolves to the real location", async () => {
    assert.equal(await resolveAllowedPath(root, "alias-src/new.ts"), path.join(root, "src", "new.ts"));
    assert.equal(await resolveAllowedPath(root, "alias-src/a.ts"), path.join(root, "src", "a.ts"));
  });

  test("rejects a link as the target itself", async () => {
    await assert.rejects(resolveAllowedPath(root, "escape"), PathRejectedError);
  });

  test("rejects a path whose parent is a file", async () => {
    await assert.rejects(resolveAllowedPath(root, "src/a.ts/inner.ts"), /parent path is a file/);
  });

  test("rejects directories and protected files", async () => {
    await assert.rejects(resolveAllowedPath(root, "src"), PathRejectedError);
    await assert.rejects(resolveAllowedPath(root, "tsconfig.json"), PathRejectedError);
    await assert.rejects(resolveAllowedPath(root, "test/new.test.ts"), PathRejectedError);
  });
});
