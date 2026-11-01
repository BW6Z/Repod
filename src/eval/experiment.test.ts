import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import type { RepodConfig } from "../config/schema.ts";
import type { LedgerWriter } from "../gateway/ledger.ts";
import { totalSpentUsd } from "../gateway/spend.ts";
import type { ModelRequest, ModelResult } from "../gateway/types.ts";
import type { ModelCaller } from "../orchestrator/orchestrator.ts";
import type { ExecutorOutput, PlanResponse } from "../orchestrator/schemas.ts";
import {
  fingerprintDirs,
  renderSummary,
  runExperiment,
  singleModelTask,
  stat,
  summarizeArms,
  type ExperimentOptions,
  type ExperimentResult,
  type RunMetrics,
} from "./experiment.ts";
import type { DemoKit } from "./kit.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const MUL = "export function mul(a: number, b: number): number {\n  return a * b;\n}\n";
const DIV = "export function div(a: number, b: number): number {\n  return a / b;\n}\n";
const BASELINE: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "es2024", module: "nodenext", moduleResolution: "nodenext", strict: true,
      noEmit: true, allowImportingTsExtensions: true, types: [],
    },
    include: ["src"],
  }),
  "src/math.ts": MATH,
  "test/math.test.ts":
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/math.ts';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
};
// Holdout tests sit next to the workspace and import it as ../workspace.
// A namespace import keeps one missing function from failing the whole file.
const HOLDOUT =
  "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport * as m from '../workspace/src/math.ts';\n" +
  "const lib = m as Record<string, ((a: number, b: number) => number) | undefined>;\n" +
  "test('mul', () => assert.equal(lib.mul?.(2, 3), 6));\ntest('div', () => assert.equal(lib.div?.(6, 3), 2));\n";

let config: RepodConfig;
let base: string;
let baselineDir: string;
let holdoutDir: string;
let kit: DemoKit;
let counter = 0;

before(async () => {
  config = await loadConfig(path.join(repoRoot, "config"));
  base = await mkdtemp(path.join(tmpdir(), "repod experiment "));
  baselineDir = path.join(base, "baseline");
  for (const [file, content] of Object.entries(BASELINE)) {
    await mkdir(path.dirname(path.join(baselineDir, file)), { recursive: true });
    await writeFile(path.join(baselineDir, file), content);
  }
  holdoutDir = path.join(base, "holdout");
  await mkdir(holdoutDir);
  await writeFile(path.join(holdoutDir, "math.test.ts"), HOLDOUT);
  await writeFile(path.join(holdoutDir, "expected-tests.json"), JSON.stringify({ expectedTests: 2 }));
  kit = {
    request: "Add mul and div.",
    contract: "Functions take and return numbers.",
    availableChecks: new Set(["typecheck", "visible-tests"]),
    checkGroups: [],
    visibleTestsDir: path.join(base, "no-visible-tests"),
    baselineTests: null,
    singleModel: { title: "Complete the request", acceptance: ["visible tests pass"], writeFiles: ["src/math.ts"] },
  };
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * Replies from per-schema queues and records each call in the run's ledger
 * the way the real gateway does, so the call count comes from the ledger.
 */
function scripted(ledger: LedgerWriter, queues: Record<string, unknown[]>, refuse = false): ModelCaller {
  return {
    async call<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      const base = { role: request.role, model: request.model, taskId: request.taskId, attemptId: request.attemptId, reservedUsd: 0.5 };
      if (refuse) {
        await ledger.append({ type: "call_refused", ...base, reason: "total budget $10 across runs would be exceeded", scope: "total" });
        return { ok: false, failure: "budget", detail: "refused", usage: null, costUsd: 0 };
      }
      await ledger.append({ type: "call_start", ...base });
      const reply = queues[request.schemaName]?.shift();
      if (reply === undefined) throw new Error(`no scripted reply left for ${request.schemaName}`);
      const data = typeof reply === "function" ? (reply as (r: ModelRequest<T>) => unknown)(request) : reply;
      await ledger.append({ type: "call_end", attemptId: request.attemptId, outcome: "ok", usage: null, costUsd: 0.01, durationMs: 1 });
      return { ok: true, data: request.schema.parse(data), usage: null, costUsd: 0.01 };
    },
  };
}

const writes = (content: string) => (request: ModelRequest<unknown>): ExecutorOutput => ({
  task_id: request.taskId!,
  context_version: /context_version to "([0-9a-f]+)"/.exec(request.input)![1]!,
  files: [{ path: "src/math.ts", content }],
  need_files: [],
  notes: "",
});
const plan: PlanResponse = {
  kind: "plan", message: "Plan.", questions: [],
  tasks: [{
    id: "T1", type: "implement", title: "mul", description: "Add mul.", complexity: "simple", impact: "low",
    capabilities: ["code"], acceptance: ["tests pass"], context_files: ["src/math.ts"], write_files: ["src/math.ts"],
    check_groups: [], depends_on: [], model: "muse-spark-1.3", reason: "", escalate_if: "",
  }],
};

function options(overrides: Partial<ExperimentOptions>): ExperimentOptions {
  const runsDir = path.join(base, `runs-${++counter}`);
  return {
    experimentId: `exp-test-${counter}`,
    label: "test",
    arms: ["A", "C"],
    runsPerArm: 1,
    config,
    kit,
    baselineDir,
    runsDir,
    holdoutDir,
    tscEntry: path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    spentUsd: () => totalSpentUsd(runsDir),
    gatewayFor: () => {
      throw new Error("gatewayFor not scripted");
    },
    ...overrides,
  };
}

describe("runExperiment", () => {
  test("runs each arm on a fresh workspace and measures holdout, cost and calls", async () => {
    const spentSeen: number[] = [];
    const o = options({
      // A writes both functions; C's single task only adds mul.
      gatewayFor: (_preset, ledger, spentBefore) => {
        spentSeen.push(spentBefore);
        return scripted(ledger, {
          plan_response: [plan],
          executor_output: [writes(MATH + MUL + (spentSeen.length === 1 ? DIV : ""))],
          run_summary: [{ message: "Done.", completed: [], unresolved: [] }],
        });
      },
    });
    const result = await runExperiment(o);

    assert.equal(result.stoppedEarly, null);
    // C's frozen result fails one holdout test, which leaves its run incomplete.
    assert.deepEqual(result.runs.map((r) => [r.arm, r.status]), [["A", "completed"], ["C", "incomplete"]]);
    const [a, c] = result.runs;
    assert.match(c?.problems.join("\n") ?? "", /holdout checks failed/);
    assert.equal(a?.model, "muse-wonder-1.0");
    assert.deepEqual([a?.holdoutTestsPassed, a?.holdoutTestsExpected, a?.holdoutPassRate, a?.holdoutCheckPassed, a?.frozenIntact], [2, 2, 1, true, true]);
    assert.deepEqual([c?.holdoutTestsPassed, c?.holdoutTestsExpected, c?.holdoutPassRate, c?.holdoutCheckPassed], [1, 2, 0.5, false]);
    assert.equal(a?.calls, 1, "arm A makes one executor call and no coordinator calls");
    assert.equal(c?.calls, 3, "plan, executor, summary");
    assert.equal(c?.costByPhase.coordination?.toFixed(2), "0.02");
    // The second run sees the first run's spend.
    assert.deepEqual(spentSeen.map((s) => s.toFixed(2)), ["0.00", "0.01"]);

    assert.deepEqual(result.arms.map((s) => [s.arm, s.runs, s.completed, s.holdoutAllPassed]), [["A", 1, 1, 1], ["C", 1, 0, 0]]);
    const report = JSON.parse(await readFile(path.join(o.runsDir, a!.runId, "report.json"), "utf8"));
    assert.equal(report.mode, "single-model");
    assert.match(renderSummary(result), /^A \| 1 \| 1 \| 1 \| 100% \(100%-100%\)/m);
  });

  test("stops once a run reaches the cumulative budget", async () => {
    const o = options({
      runsPerArm: 2,
      gatewayFor: (_preset, ledger) => scripted(ledger, {}, true),
    });
    const result = await runExperiment(o);

    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0]?.holdoutRan, false);
    assert.equal(result.runs[0]?.holdoutPassRate, 0);
    assert.match(result.stoppedEarly ?? "", /cumulative budget/);
  });

  test("a run-budget refusal does not stop the experiment; only the cumulative budget does", async () => {
    const refuseRun = (ledger: LedgerWriter): ModelCaller => ({
      async call<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
        await ledger.append({
          type: "call_refused", role: request.role, model: request.model, taskId: request.taskId, attemptId: request.attemptId,
          reservedUsd: 0.5, reason: "run budget $3 would be exceeded", scope: "run",
        });
        return { ok: false, failure: "budget", detail: "refused", usage: null, costUsd: 0 };
      },
    });
    const result = await runExperiment(options({ arms: ["C"], runsPerArm: 2, gatewayFor: (_preset, ledger) => refuseRun(ledger) }));
    assert.equal(result.runs.length, 2);
    assert.equal(result.stoppedEarly, null);
  });

  test("an experiment without the holdout's expected test count is refused before anything runs", async () => {
    const bare = path.join(base, "holdout without count");
    await mkdir(bare);
    await writeFile(path.join(bare, "math.test.ts"), HOLDOUT);
    const o = options({ holdoutDir: bare });
    await assert.rejects(runExperiment(o), /expected-tests\.json is missing/);
    await assert.rejects(readdir(o.runsDir), "no run folder was created");
  });

  test("a failure outside a run's pipeline stops the experiment but keeps and saves the results so far", async () => {
    const saved: ExperimentResult[] = [];
    let calls = 0;
    const o = options({
      arms: ["A"],
      runsPerArm: 3,
      gatewayFor: (_preset, ledger) => {
        if (++calls === 2) throw new Error("adapter could not be created");
        return scripted(ledger, { executor_output: [writes(MATH + MUL + DIV)] });
      },
      save: async (partial) => {
        saved.push(structuredClone(partial));
      },
    });
    const result = await runExperiment(o);
    assert.equal(result.runs.length, 1);
    assert.match(result.stoppedEarly ?? "", /a2 could not be completed: adapter could not be created/);
    assert.equal(saved.at(-1)?.runs.length, 1, "the last save has the finished run");
    assert.ok(saved.length >= 2, "saved after the first run already");
  });

  test("inputs that change mid-experiment stop it before the next run", async () => {
    let version = 0;
    const o = options({
      arms: ["A"],
      runsPerArm: 3,
      gatewayFor: (_preset, ledger) => {
        version++; // as if someone edited the sample repository during run 1
        return scripted(ledger, { executor_output: [writes(MATH + MUL + DIV)] });
      },
      fingerprint: async () => ({ baseline: `v${Math.min(version, 1)}`, config: "same" }),
    });
    const result = await runExperiment(o);
    assert.equal(result.runs.length, 1);
    assert.deepEqual(result.inputs, { baseline: "v0", config: "same" });
    assert.match(result.stoppedEarly ?? "", /inputs changed before run .*-a2 \(baseline\)/);
  });
});

test("a holdout counts as fully passed only if the check passed, every expected test passed and the freeze held", () => {
  const run = (overrides: Partial<RunMetrics>): RunMetrics => ({
    arm: "A", round: 1, runId: "r", preset: "saving", model: null, status: "completed",
    holdoutRan: true, holdoutCheckPassed: true, holdoutFailure: null, holdoutTestsExpected: 4, holdoutTestsRun: 4,
    holdoutTestsPassed: 4, frozenIntact: true, holdoutPassRate: 1, costUsd: 0, wallMs: 1, calls: 1, escalations: 0,
    costByPhase: { coordination: 0, execution: 0, rework: 0, review: 0 }, problems: [],
    ...overrides,
  });
  const [summary] = summarizeArms([
    run({}),
    run({ holdoutCheckPassed: false, holdoutFailure: "exit_code" }), // counts equal, but the process failed
    run({ frozenIntact: false }), // the workspace changed while the holdout ran
    run({ holdoutTestsRun: 3, holdoutTestsPassed: 3, holdoutPassRate: 0.75, holdoutCheckPassed: false, holdoutFailure: "missing_tests" }),
  ], ["A"]);
  assert.equal(summary?.holdoutAllPassed, 1);
});

test("fingerprints change when any file under a directory changes", async () => {
  const dir = path.join(base, "fingerprint");
  await mkdir(path.join(dir, "sub"), { recursive: true });
  await writeFile(path.join(dir, "sub", "a.txt"), "one");
  const first = await fingerprintDirs({ d: dir });
  assert.deepEqual(await fingerprintDirs({ d: dir }), first);
  await writeFile(path.join(dir, "sub", "a.txt"), "two");
  assert.notDeepEqual(await fingerprintDirs({ d: dir }), first);
});

test("arm A's task uses the critical model, every baseline file and every check group", () => {
  const preset = config.presets.get("saving")!;
  const withGroups: DemoKit = { ...kit, checkGroups: [{ name: "g", description: "g", tests: ["g.test.ts"], requires: [] }] };
  const task = singleModelTask(withGroups, preset, ["src/math.ts", "README.md"]);
  assert.equal(task.model, preset.roles.critical);
  assert.deepEqual(task.context_files, ["src/math.ts", "README.md"]);
  assert.deepEqual(task.check_groups, ["g"]);
  assert.equal(task.description, kit.request);
});

test("stat gives the median and range", () => {
  assert.equal(stat([]), null);
  assert.deepEqual(stat([3, 1, 2]), { median: 2, min: 1, max: 3 });
  assert.deepEqual(stat([4, 1, 2, 3]), { median: 2.5, min: 1, max: 4 });
});
