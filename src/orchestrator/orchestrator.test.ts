import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import type { RepodConfig } from "../config/schema.ts";
import { LedgerWriter, readEvents } from "../gateway/ledger.ts";
import type { FailureKind, ModelRequest, ModelResult } from "../gateway/types.ts";
import { standardChecks, type CheckResult } from "../verifier/verifier.ts";
import { createRunWorkspace, type RunWorkspace } from "../workspace/workspace.ts";
import { experimentHooks, runPipeline, type ModelCaller, type PipelineHooks, type PipelineOptions } from "./orchestrator.ts";
import type { CheckKind } from "./routing.ts";
import type { ExecutorOutput, PlanResponse, PlannedTask } from "./schemas.ts";

// ---- scripted gateway --------------------------------------------------------

type Reply = unknown | ((request: ModelRequest<unknown>) => unknown) | { fail: FailureKind };

/** Replies from per-schema queues and records every request. */
class ScriptedGateway implements ModelCaller {
  readonly requests: Array<ModelRequest<unknown>> = [];
  private readonly queues: Record<string, Reply[]>;

  constructor(queues: Record<string, Reply[]>) {
    this.queues = queues;
  }

  async call<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request as ModelRequest<unknown>);
    const reply = this.queues[request.schemaName]?.shift();
    if (reply === undefined) throw new Error(`no scripted reply left for ${request.schemaName}`);
    if (typeof reply === "object" && reply !== null && "fail" in reply) {
      return { ok: false, failure: (reply as { fail: FailureKind }).fail, detail: "scripted failure", usage: null, costUsd: 0 };
    }
    const data = typeof reply === "function" ? reply(request as ModelRequest<unknown>) : reply;
    return { ok: true, data: request.schema.parse(data), usage: null, costUsd: 0.001 };
  }

  calls(schemaName: string) {
    return this.requests.filter((r) => r.schemaName === schemaName);
  }
}

// ---- fixtures ------------------------------------------------------------------

const BASELINE: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "es2024", module: "nodenext", moduleResolution: "nodenext", strict: true,
      noEmit: true, allowImportingTsExtensions: true, types: [],
    },
    include: ["src"],
  }),
  "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "test/math.test.ts":
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/math.ts';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
};
const WITH_MUL = BASELINE["src/math.ts"] + "export function mul(a: number, b: number): number {\n  return a * b;\n}\n";
const BROKEN = "export const n: number = 'not a number';\n";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const allChecks = new Set<CheckKind>(["typecheck", "visible-tests"]);

let config: RepodConfig;
let base: string;
let baselineDir: string;
let runCounter = 0;

before(async () => {
  config = await loadConfig(path.join(repoRoot, "config"));
  base = await mkdtemp(path.join(tmpdir(), "repod pipeline "));
  baselineDir = path.join(base, "baseline");
  for (const [file, content] of Object.entries(BASELINE)) {
    await mkdir(path.dirname(path.join(baselineDir, file)), { recursive: true });
    await writeFile(path.join(baselineDir, file), content);
  }
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id, type: "implement", title: `Task ${id}`, description: "Add mul().",
    complexity: "simple", impact: "low", capabilities: ["code"], acceptance: ["tsc passes", "visible tests pass"],
    context_files: ["src/math.ts"], write_files: ["src/math.ts"], depends_on: [],
    model: "muse-spark-1.3", reason: "Simple change.", escalate_if: "checks fail twice",
    ...overrides,
  };
}
const plan = (...tasks: PlannedTask[]): PlanResponse => ({ kind: "plan", message: "Plan.", questions: [], tasks });
const summary = { message: "Done.", completed: [], unresolved: [] };

/** An executor reply that echoes the task id and context version from its input. */
function writes(files: Record<string, string>) {
  return (request: ModelRequest<unknown>): ExecutorOutput => ({
    task_id: request.taskId!,
    context_version: /context_version to "([0-9a-f]+)"/.exec(request.input)![1]!,
    files: Object.entries(files).map(([p, content]) => ({ path: p, content })),
    need_files: [],
    notes: "",
  });
}
const triage = (decision: "repair" | "escalate" | "stop") => ({ decision, reason: `${decision} chosen`, instructions: `guidance for ${decision}` });

async function run(gateway: ScriptedGateway, overrides: Partial<PipelineOptions> = {}) {
  const runId = `run-${++runCounter}`;
  const workspace: RunWorkspace = await createRunWorkspace(baselineDir, path.join(base, "runs"), runId);
  const ledger = new LedgerWriter(workspace.ledgerFile, runId);
  const report = await runPipeline({
    request: "Add a mul function.",
    config,
    preset: config.presets.get("saving")!,
    gateway,
    ledger,
    workspace,
    contract: "Functions take and return numbers.",
    devChecks: standardChecks({ workspaceRoot: workspace.root, tscEntry, timeoutMs: 60_000, maxOutputBytes: 100_000 }),
    holdoutChecks: [],
    availableChecks: allChecks,
    remainingBudgetUsd: 100,
    hooks: experimentHooks,
    ...overrides,
  });
  return { report, workspace, ledger };
}

// ---- tests ----------------------------------------------------------------------

describe("runPipeline: the main path", () => {
  test("plans, executes, checks the integrated result, freezes and summarizes", async () => {
    const gateway = new ScriptedGateway({ plan_response: [plan(task("T1"))], executor_output: [writes({ "src/math.ts": WITH_MUL })], run_summary: [summary] });
    const { report, workspace, ledger } = await run(gateway);

    assert.equal(report.status, "completed", report.problems.join("\n"));
    assert.equal(report.tasks[0]?.status, "passed");
    assert.equal(report.tasks[0]?.attempts, 1);
    assert.ok(report.finalChecks.length === 2 && report.finalChecks.every((c) => c.passed));
    assert.ok(report.manifest && "src/math.ts" in report.manifest);
    assert.equal(await readFile(path.join(workspace.root, "src", "math.ts"), "utf8"), WITH_MUL);
    assert.equal(report.summary?.message, "Done.");
    const types = (await readEvents(ledger.file)).map((e) => e.type);
    assert.equal(types[0], "run_started");
    assert.equal(types.at(-1), "run_finished");
    // The coordinator is the Meta model; the executor is what the plan chose.
    assert.equal(gateway.calls("plan_response")[0]?.model, "muse-spark-1.3");
    assert.equal(gateway.calls("plan_response")[0]?.role, "coordinator");
  });

  test("clarifying questions are answered (defaults in experiment mode) before planning", async () => {
    const questions: PlanResponse = {
      kind: "questions", message: "One question.", tasks: [],
      questions: [{ id: "Q1", question: "Name of the function?", why: "Changes the API.", default: "mul" }],
    };
    const gateway = new ScriptedGateway({
      plan_response: [questions, plan(task("T1"))],
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.status, "completed", report.problems.join("\n"));
    assert.match(gateway.calls("plan_response")[1]?.input ?? "", /Answer: mul/);
  });

  test("a rejected plan gets one fix attempt", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1", { write_files: ["test/math.test.ts"] })), plan(task("T1"))],
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.status, "completed", report.problems.join("\n"));
    assert.match(gateway.calls("plan_response")[1]?.input ?? "", /is protected/);
  });

  test("the user can send the plan back once with feedback", async () => {
    let reviews = 0;
    const hooks: PipelineHooks = {
      ...experimentHooks,
      async reviewPlan() {
        return ++reviews === 1 ? { approve: false, feedback: "Use the strong model." } : { approve: true };
      },
    };
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1")), plan(task("T1", { model: "muse-wonder-1.0" }))],
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { report } = await run(gateway, { hooks });
    assert.equal(report.status, "completed", report.problems.join("\n"));
    const revise = gateway.calls("plan_response")[1]!;
    assert.match(revise.system, /sent your plan back/);
    assert.match(revise.input, /Use the strong model\./);
    assert.equal(gateway.calls("executor_output")[0]?.model, "muse-wonder-1.0");
  });
});

describe("runPipeline: failures, repair and escalation", () => {
  test("a failed check is triaged and repaired with the previous diff and guidance", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"))],
      executor_output: [writes({ "src/math.ts": BROKEN }), writes({ "src/math.ts": WITH_MUL })],
      triage_decision: [triage("repair")],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.status, "completed", report.problems.join("\n"));
    assert.equal(report.tasks[0]?.attempts, 2);
    const second = gateway.calls("executor_output")[1]!.input;
    assert.match(second, /## Previous attempt/);
    assert.match(second, /guidance for repair/);
  });

  test("after the cheap model's attempts, the task escalates once to the critical model", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"))],
      executor_output: [writes({ "src/math.ts": BROKEN }), writes({ "src/math.ts": BROKEN }), writes({ "src/math.ts": WITH_MUL })],
      triage_decision: [triage("repair"), triage("escalate")],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.status, "completed", report.problems.join("\n"));
    assert.deepEqual(gateway.calls("executor_output").map((r) => r.model), ["muse-spark-1.3", "muse-spark-1.3", "muse-wonder-1.0"]);
    assert.equal(report.tasks[0]?.escalated, true);
    assert.match(gateway.calls("triage_decision")[1]?.input ?? "", /Allowed decisions\nescalate, stop/);
  });

  test("output outside the write scope is rejected, and a stopped task skips its dependents", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"), task("T2", { depends_on: ["T1"] }))],
      executor_output: [writes({ "src/other.ts": "export {};\n" })],
      triage_decision: [triage("stop")],
      run_summary: [summary],
    });
    const { report, workspace } = await run(gateway);
    assert.equal(report.status, "incomplete");
    assert.equal(report.tasks[0]?.status, "failed");
    assert.equal(report.tasks[1]?.status, "skipped");
    assert.equal(gateway.calls("executor_output").length, 1);
    assert.match(gateway.calls("triage_decision")[0]?.input ?? "", /outside the task's write scope/);
    await assert.rejects(readFile(path.join(workspace.root, "src", "other.ts")));
    assert.equal(report.manifest, null, "an incomplete run is not frozen");
  });

  test("a code task without runnable tests is not executed", async () => {
    const gateway = new ScriptedGateway({ plan_response: [plan(task("T1"))], run_summary: [summary] });
    const { report } = await run(gateway, { availableChecks: new Set<CheckKind>(["typecheck"]) });
    assert.equal(report.tasks[0]?.status, "stopped");
    assert.match(report.tasks[0]?.reason ?? "", /without automated tests/);
    assert.equal(gateway.calls("executor_output").length, 0);
  });

  test("a check process that cannot be stopped taints the workspace and stops the run", async () => {
    const stuck: CheckResult = {
      name: "visible-tests", passed: false, failure: "timeout", exitCode: null, timedOut: true, processExited: false,
      testsRun: null, output: "", outputTruncated: false, durationMs: 1,
    };
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"), task("T2", { write_files: ["src/extra.ts"] }))],
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { report, workspace } = await run(gateway, { runCheck: async () => stuck });
    assert.equal(report.status, "incomplete");
    assert.ok(workspace.tainted);
    assert.equal(report.tasks[1]?.status, "skipped");
    assert.match(report.problems[0] ?? "", /run stopped: .*no longer usable/);
  });

  test("a budget refusal stops the run instead of retrying or escalating", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"), task("T2", { write_files: ["src/extra.ts"] }))],
      executor_output: [{ fail: "budget" }],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.tasks[0]?.status, "stopped");
    assert.equal(report.tasks[1]?.status, "skipped");
    assert.equal(gateway.calls("triage_decision").length, 0);
    assert.equal(gateway.calls("run_summary").length, 0, "no further paid call once the budget is exhausted");
  });
});

describe("runPipeline: review", () => {
  test("a blocking review finding leaves the run incomplete", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1", { complexity: "complex", impact: "high", model: "muse-wonder-1.0" }))],
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      review_output: [{
        summary: "One problem.",
        findings: [{ file: "src/math.ts", snippet: "a * b", severity: "blocking", evidence: "Overflow is not handled.", suggested_check: "mul(1e308, 10)" }],
      }],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.tasks[0]?.status, "passed");
    assert.equal(report.status, "incomplete");
    assert.equal(report.findings.length, 1);
    assert.equal(gateway.calls("review_output")[0]?.model, "muse-wonder-1.0");
    assert.match(report.problems.join("\n"), /blocking review finding/);
  });
});
