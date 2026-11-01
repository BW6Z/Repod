import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { LedgerCorruptError, LedgerWriter, ledgerPath, readEvents } from "./ledger.ts";
import { SpendTracker, totalSpentUsd } from "./spend.ts";

const start = { role: "executor", model: "m", taskId: null } as const;

async function withRuns(fn: (runsDir: string, ledger: LedgerWriter) => Promise<void>): Promise<void> {
  const runsDir = await mkdtemp(path.join(tmpdir(), "repod-spend-"));
  try {
    await mkdir(path.join(runsDir, "r1"));
    await fn(runsDir, new LedgerWriter(ledgerPath(path.join(runsDir, "r1")), "r1"));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
}

describe("totalSpentUsd", () => {
  test("counts known costs, unknown costs and interrupted calls pessimistically", async () => {
    await withRuns(async (runsDir, ledger) => {
      // Known cost: 0.10
      await ledger.append({ type: "call_start", ...start, attemptId: "a", reservedUsd: 0.5 });
      await ledger.append({ type: "call_end", attemptId: "a", outcome: "ok", usage: null, costUsd: 0.1, durationMs: 1 });
      // Unknown cost: counts the 0.25 reservation
      await ledger.append({ type: "call_start", ...start, attemptId: "b", reservedUsd: 0.25 });
      await ledger.append({ type: "call_end", attemptId: "b", outcome: "network", usage: null, costUsd: null, durationMs: 1 });
      // Interrupted: counts the 0.4 reservation
      await ledger.append({ type: "call_start", ...start, attemptId: "c", reservedUsd: 0.4 });
      // A half-written final line is ignored, as the writer may still be busy.
      await appendFile(ledger.file, '{"type":"call_st', "utf8");

      assert.ok(Math.abs((await totalSpentUsd(runsDir)) - 0.75) < 1e-9);
    });
  });

  test("a corrupt complete line fails closed instead of counting as zero", async () => {
    await withRuns(async (runsDir, ledger) => {
      await ledger.append({ type: "call_start", ...start, attemptId: "a", reservedUsd: 2 });
      await appendFile(ledger.file, "{not json}\n", "utf8");
      await assert.rejects(totalSpentUsd(runsDir), LedgerCorruptError);
    });
  });

  test("well-formed JSON with invalid or missing amounts fails closed instead of producing NaN", async () => {
    const bad = [
      '{"runId":"r1","seq":1,"ts":"t","type":"call_start","attemptId":"a"}', // reservedUsd missing
      '{"runId":"r1","seq":1,"ts":"t","type":"call_start","role":"executor","model":"m","taskId":null,"attemptId":"a","reservedUsd":"0.5"}',
      '{"runId":"r1","seq":1,"ts":"t","type":"call_start","role":"executor","model":"m","taskId":null,"attemptId":"a","reservedUsd":null}',
      '{"runId":"r1","seq":1,"ts":"t","type":"call_start","role":"executor","model":"m","taskId":null,"attemptId":"a","reservedUsd":-1}',
      '{"runId":"r1","seq":1,"ts":"t","type":"call_end","attemptId":"a","outcome":"ok","usage":null,"costUsd":"x","durationMs":1}',
      '{"runId":"r1","seq":1,"ts":"t","type":"call_end","attemptId":"a","outcome":"maybe","usage":null,"costUsd":0.1,"durationMs":1}',
    ];
    for (const line of bad) {
      await withRuns(async (runsDir, ledger) => {
        await appendFile(ledger.file, line + "\n", "utf8");
        await assert.rejects(totalSpentUsd(runsDir), LedgerCorruptError, line);
      });
    }
  });

  test("an end event with no cost and no matching start fails closed", async () => {
    await withRuns(async (runsDir, ledger) => {
      await ledger.append({ type: "call_end", attemptId: "orphan", outcome: "network", usage: null, costUsd: null, durationMs: 1 });
      await assert.rejects(totalSpentUsd(runsDir), /no cost and no matching call_start/);
    });
  });

  test("a missing runs directory or ledger means nothing was spent", async () => {
    assert.equal(await totalSpentUsd(path.join(tmpdir(), "repod-does-not-exist")), 0);
    await withRuns(async (runsDir) => {
      assert.equal(await totalSpentUsd(runsDir), 0); // r1 exists but has no ledger yet
    });
  });
});

describe("LedgerWriter", () => {
  test("concurrent appends keep sequence order", async () => {
    await withRuns(async (_runsDir, ledger) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => ledger.append({ type: "task_status", taskId: `T${i}`, status: "pending", detail: null })),
      );
      assert.deepEqual((await readEvents(ledger.file)).map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 1));
    });
  });

  test("an event the reader would reject is never written and takes no sequence number", async () => {
    await withRuns(async (runsDir, ledger) => {
      await assert.rejects(
        ledger.append({ type: "call_end", attemptId: "a", outcome: "ok", usage: null, costUsd: 0.1, durationMs: -5 }),
        /refusing to write an invalid call_end event: durationMs/,
      );
      await assert.rejects(ledger.append({ type: "call_start", ...start, attemptId: "b", reservedUsd: Number.NaN }), /reservedUsd/);
      await ledger.append({ type: "task_status", taskId: "T1", status: "x", detail: null });
      assert.deepEqual((await readEvents(ledger.file)).map((e) => [e.type, e.seq]), [["task_status", 1]]);
      assert.equal(await totalSpentUsd(runsDir), 0);
    });
  });

  test("a failed append does not block later appends", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "repod-ledger-"));
    try {
      const runDir = path.join(base, "not-yet-created");
      const ledger = new LedgerWriter(ledgerPath(runDir), "r");
      await assert.rejects(ledger.append({ type: "task_status", taskId: "T1", status: "x", detail: null }));
      await mkdir(runDir);
      await ledger.append({ type: "task_status", taskId: "T2", status: "x", detail: null });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("SpendTracker", () => {
  test("enforces both the run and the total budget", () => {
    assert.equal(new SpendTracker(1, 10, 9.5).tryReserve(0.4).ok, true);
    assert.equal(new SpendTracker(1, 10, 9.5).tryReserve(0.6).ok, false); // total: 9.5 + 0.6 > 10
  });

  test("held reservations count until settled", () => {
    const tracker = new SpendTracker(1, 10, 0);
    const first = tracker.tryReserve(0.6);
    assert.equal(first.ok, true);
    assert.equal(tracker.tryReserve(0.6).ok, false); // 0.6 held + 0.6 > 1
    if (first.ok) tracker.settle(first.reservation, 0.1);
    assert.equal(tracker.tryReserve(0.6).ok, true); // 0.1 spent + 0.6 <= 1
    assert.ok(Math.abs(tracker.runSpent - 0.1) < 1e-9);
  });

  test("a reservation cannot be settled or released twice", () => {
    const tracker = new SpendTracker(1, 10, 0);
    const r = tracker.tryReserve(0.1);
    assert.ok(r.ok);
    tracker.settle(r.reservation, 0.1);
    assert.throws(() => tracker.settle(r.reservation, 0.1));
    assert.throws(() => tracker.release(r.reservation));
  });

  test("a released reservation frees its budget without recording spend", () => {
    const tracker = new SpendTracker(1, 10, 0);
    const r = tracker.tryReserve(0.9);
    assert.ok(r.ok);
    tracker.release(r.reservation);
    assert.equal(tracker.runSpent, 0);
    assert.equal(tracker.tryReserve(0.9).ok, true);
  });

  test("invalid numbers are rejected instead of disabling the budget checks", () => {
    assert.throws(() => new SpendTracker(1, 1, Number.NaN), RangeError);
    assert.throws(() => new SpendTracker(1, Number.POSITIVE_INFINITY, 0), RangeError);
    assert.throws(() => new SpendTracker(0, 1, 0), RangeError);
    assert.throws(() => new SpendTracker(1, 1, -0.5), RangeError);
    const tracker = new SpendTracker(1, 1, 0);
    assert.throws(() => tracker.tryReserve(Number.NaN), RangeError);
    const r = tracker.tryReserve(0.1);
    assert.ok(r.ok);
    assert.throws(() => tracker.settle(r.reservation, -1), RangeError);
  });

  test("an invalid cost still settles, at the full reservation, so no hold is left open", () => {
    const tracker = new SpendTracker(1, 10, 0);
    const r = tracker.tryReserve(0.3);
    assert.ok(r.ok);
    assert.throws(() => tracker.settle(r.reservation, Number.NaN), RangeError);
    assert.ok(Math.abs(tracker.runSpent - 0.3) < 1e-9, "billed at the reservation, not zero");
    assert.throws(() => tracker.settle(r.reservation, 0.1), /already/);
    assert.equal(tracker.tryReserve(0.7).ok, true, "0.3 spent + 0.7 fits the run budget: nothing is held");
  });
});
