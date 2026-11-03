import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import type { RepodConfig } from "../config/schema.ts";
import { exportReplay, scrubPaths } from "./replay.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let base: string;
let runsDir: string;
let config: RepodConfig;

const line = (event: Record<string, unknown>) => JSON.stringify({ runId: "r", seq: 1, ts: "2026-11-01T10:00:00.000Z", ...event }) + "\n";

async function addRun(id: string, events: Array<Record<string, unknown>>, report?: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(runsDir, id), { recursive: true });
  await writeFile(path.join(runsDir, id, "events.jsonl"), events.map(line).join(""));
  if (report) await writeFile(path.join(runsDir, id, "report.json"), JSON.stringify(report));
}

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "repod-replay-"));
  runsDir = path.join(base, "runs");
  config = await loadConfig(path.join(repoRoot, "config"));
  const started = { type: "run_started", preset: "saving", request: "Add planOrder." };
  const finished = { type: "run_finished", status: "completed", summary: null };
  // A check whose output names a file in the run's workspace, as a stack trace would.
  await addRun("run-a", [started, { type: "check_result", check: "tests", passed: false, output: `at ${path.join(runsDir, "run-a", "workspace", "src", "plan.ts")}:3` }, finished], {
    mode: "coordinated",
    costUsd: 0.1,
    holdout: [{ name: "holdout-tests", passed: true, testsRun: 2, testsPassed: 2, output: "ok 1 - a private holdout test name" }],
  });
  await addRun("exp-1-a1", [started, finished], { mode: "single-model", costUsd: 0.3 });
  await addRun("run-going", [started]);
  await addRun("probe-1", [{ type: "call_start" }]);
  await mkdir(path.join(runsDir, "experiments"));
  await writeFile(path.join(runsDir, "experiments", "exp-1.json"),
    JSON.stringify({ experimentId: "exp-1", startedAt: "2026-11-01T12:00:00Z", runs: [{ runId: "exp-1-a1", arm: "A" }] }));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

const read = async (dir: string, rel: string) => readFile(path.join(dir, rel), "utf8");

test("scrubPaths replaces a path in every spelling JSON text may hold", () => {
  const roots = [["C:\\Users\\me\\repo", "<repo>"], ["C:\\Users\\me\\repo\\runs", "<runs>"]] as const;
  const text = JSON.stringify({ a: "C:\\Users\\me\\repo\\runs\\r1\\x.ts", b: "c:/users/me/repo/src", c: "/c/Users/me/repo/runs/r2" });
  assert.equal(scrubPaths(text, roots), JSON.stringify({ a: "<runs>\\r1\\x.ts", b: "<repo>/src", c: "<runs>/r2" }));
});

test("a replay holds finished runs and experiments, without local paths, holdout output or the session", async () => {
  const out = path.join(base, "replay-all");
  const summary = await exportReplay({ webDir: path.join(repoRoot, "web"), runsDir, repoRoot, config, outDir: out, include: [] });
  assert.deepEqual(summary.runs.sort(), ["exp-1-a1", "run-a"]);
  assert.deepEqual(summary.experiments, ["exp-1"]);

  assert.deepEqual((await readdir(out)).sort(), ["app.js", "data", "index.html", "style.css"]);
  assert.deepEqual(JSON.parse(await read(out, "data/source.json")).source, "replay");
  assert.deepEqual(JSON.parse(await read(out, "data/session.json")), { enabled: false });
  assert.deepEqual(JSON.parse(await read(out, "data/runs.json")).map((r: { id: string }) => r.id).sort(), ["exp-1-a1", "run-a"]);
  assert.ok(Object.keys(JSON.parse(await read(out, "data/models.json"))).length > 0);

  const events = await read(out, "data/runs/run-a/events.jsonl");
  assert.ok(!events.includes(base.replace(/\\/g, "\\\\")) && !events.includes(homedir().replace(/\\/g, "\\\\")), "no local path");
  assert.match(events, /<runs>/);
  const report = JSON.parse(await read(out, "data/runs/run-a/report.json"));
  assert.deepEqual(report.holdout, [{ name: "holdout-tests", passed: true, testsRun: 2, testsPassed: 2, output: null }]);
  await assert.rejects(read(out, "data/runs/run-going/events.jsonl"));
});

test("an included experiment brings its runs, and unknown ids are refused", async () => {
  const out = path.join(base, "replay-exp");
  const summary = await exportReplay({ webDir: path.join(repoRoot, "web"), runsDir, repoRoot, config, outDir: out, include: ["exp-1"] });
  assert.deepEqual(summary, { runs: ["exp-1-a1"], experiments: ["exp-1"] });

  const fresh = path.join(base, "replay-bad");
  await assert.rejects(exportReplay({ webDir: path.join(repoRoot, "web"), runsDir, repoRoot, config, outDir: fresh, include: ["run-going"] }), /Not a finished run/);
});

test("an export never writes into a folder that has files", async () => {
  const out = path.join(base, "replay-used");
  await mkdir(out);
  await writeFile(path.join(out, "keep.txt"), "mine");
  await assert.rejects(exportReplay({ webDir: path.join(repoRoot, "web"), runsDir, repoRoot, config, outDir: out, include: [] }), /not empty/);
  assert.equal(await read(out, "keep.txt"), "mine");
});
