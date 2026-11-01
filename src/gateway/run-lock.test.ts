import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { PAID_RUN_LOCK, PaidRunLockedError, acquirePaidRunLock } from "./run-lock.ts";
import { totalSpentUsd } from "./spend.ts";

let base: string;
let counter = 0;
const freshRunsDir = () => path.join(base, `runs-${++counter}`);

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "repod-lock-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

test("a second paid command is refused while the first holds the lock, and admitted after release", async () => {
  const runsDir = freshRunsDir();
  const release = await acquirePaidRunLock(runsDir, "run");
  await assert.rejects(acquirePaidRunLock(runsDir, "probe"), (error: unknown) => {
    assert.ok(error instanceof PaidRunLockedError);
    assert.match(error.message, /"run" \(process \d+/);
    return true;
  });
  await release();
  await release(); // a second release is harmless
  const again = await acquirePaidRunLock(runsDir, "probe");
  await again();
});

test("of several commands starting at once, exactly one gets the lock", async () => {
  const runsDir = freshRunsDir();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => acquirePaidRunLock(runsDir, `run ${i}`)));
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1);
  assert.ok(results.every((r) => r.status === "fulfilled" || r.reason instanceof PaidRunLockedError));
  await won[0]!.value();
});

test("the lock file is not mistaken for a run by the spend total", async () => {
  const runsDir = freshRunsDir();
  const release = await acquirePaidRunLock(runsDir, "run");
  assert.equal(await totalSpentUsd(runsDir), 0);
  await release();
});

test("a lock held by another process blocks this one, and stays when that process dies", async () => {
  const runsDir = freshRunsDir();
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "run-lock.ts")).href;
  const script =
    `const { acquirePaidRunLock } = await import(${JSON.stringify(moduleUrl)});\n` +
    `await acquirePaidRunLock(${JSON.stringify(runsDir)}, "run");\n` +
    `console.log("locked");\n` +
    `setInterval(() => {}, 1000);\n`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
    assert.match(chunk.toString(), /locked/);

    await assert.rejects(acquirePaidRunLock(runsDir, "probe"), PaidRunLockedError);

    // A killed owner cannot release its lock. It is never removed
    // automatically: the error points at the manual check instead.
    child.kill();
    await once(child, "exit");
    await assert.rejects(acquirePaidRunLock(runsDir, "probe"), (error: unknown) => {
      assert.ok(error instanceof PaidRunLockedError);
      assert.match(error.message, /no longer running/);
      assert.match(error.message, /delete the lock file/);
      return true;
    });
    await access(path.join(runsDir, PAID_RUN_LOCK));
  } finally {
    child.kill();
  }
});

test("an unreadable lock file still blocks", async () => {
  const runsDir = freshRunsDir();
  const release = await acquirePaidRunLock(runsDir, "run");
  await writeFile(path.join(runsDir, PAID_RUN_LOCK), "garbage");
  await assert.rejects(acquirePaidRunLock(runsDir, "probe"), /unknown owner/);
  // The owner's release leaves a lock it no longer recognizes as its own.
  await release();
  await access(path.join(runsDir, PAID_RUN_LOCK));
});
