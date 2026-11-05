import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendEvent, readEvents } from "./ledger.ts";

test("readEvents returns complete lines and ignores a partial trailing line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "repod-ledger-"));
  try {
    const file = path.join(dir, "events.jsonl");
    await appendEvent(file, { runId: "r1", seq: 1, ts: "2026-10-30T00:00:00Z", type: "run_started", preset: "saving", request: "demo" });
    // Simulate a writer that has not finished its line yet.
    await appendFile(file, '{"runId":"r1","seq":2', "utf8");

    const events = await readEvents(file);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "run_started");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
