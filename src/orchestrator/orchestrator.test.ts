import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import type { RepodConfig } from "../config/schema.ts";
import { LedgerWriteError } from "../gateway/gateway.ts";
import { LedgerWriter, readEvents } from "../gateway/ledger.ts";
import type { FailureKind, ModelRequest, ModelResult } from "../gateway/types.ts";
import { standardChecks, type CheckResult, type CheckSpec } from "../verifier/verifier.ts";
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
    context_files: ["src/math.ts"], write_files: ["src/math.ts"], check_groups: [], depends_on: [],
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
    checkGroups: [],
    visibleTestsDir: null,
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
    const events = await readEvents(ledger.file);
    const types = events.map((e) => e.type);
    assert.equal(types[0], "run_started");
    assert.equal(types.at(-1), "run_finished");
    // The approved plan is logged before any task runs, so a viewer can show it live.
    assert.ok(types.indexOf("plan_approved") < types.indexOf("task_status"));
    const approved = events.find((e) => e.type === "plan_approved");
    assert.deepEqual(approved?.type === "plan_approved" && approved.tasks.map((t) => [t.id, t.model]), [["T1", "muse-spark-1.3"]]);
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

  test("the conversation is logged, and the second review is told no revision is left", async () => {
    const canRevise: boolean[] = [];
    let reviews = 0;
    const hooks: PipelineHooks = {
      ...experimentHooks,
      async reviewPlan(_plan, _decisions, _warnings, revisable) {
        canRevise.push(revisable);
        return ++reviews === 1 ? { approve: false, feedback: "Cheaper, please." } : { approve: true };
      },
    };
    const questions = { kind: "questions", message: "One question.", tasks: [], questions: [{ id: "q1", question: "YAML?", why: "parser", default: "No" }] };
    const gateway = new ScriptedGateway({
      plan_response: [questions, plan(task("T1")), plan(task("T1"))],
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { ledger } = await run(gateway, { hooks });
    assert.deepEqual(canRevise, [true, false]);
    const turns = (await readEvents(ledger.file)).flatMap((e) => (e.type === "conversation" ? [[e.from, e.kind, e.text]] : []));
    assert.deepEqual(turns, [
      ["meta", "questions", "One question."],
      ["user", "answers", "YAML? No"],
      ["meta", "plan", "Plan."],
      ["user", "feedback", "Cheaper, please."],
      ["meta", "plan", "Plan."],
      ["user", "approval", "Approved the plan."],
    ]);
  });

  test("stopping at the plan ends the run without paying for a revision", async () => {
    const hooks: PipelineHooks = { ...experimentHooks, reviewPlan: async () => ({ approve: false, feedback: null }) };
    const gateway = new ScriptedGateway({ plan_response: [plan(task("T1"))], run_summary: [summary] });
    const { report } = await run(gateway, { hooks });
    assert.equal(report.status, "incomplete");
    assert.match(report.problems[0] ?? "", /the user stopped the run at the plan/);
    assert.equal(gateway.calls("plan_response").length, 1, "no revision was requested");
    assert.equal(gateway.calls("executor_output").length, 0);
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

  test("cost is split into coordination, first attempts, rework and review", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"))],
      executor_output: [writes({ "src/math.ts": BROKEN }), writes({ "src/math.ts": WITH_MUL })],
      triage_decision: [triage("repair")],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    // The scripted gateway charges $0.001 per successful call.
    const rounded = Object.fromEntries(Object.entries(report.costByPhase).map(([phase, cost]) => [phase, cost?.toFixed(3)]));
    assert.deepEqual(rounded, { coordination: "0.002", execution: "0.001", rework: "0.002", review: "0.000" });
    assert.equal(report.costUsd?.toFixed(3), "0.005");
    assert.equal(report.mode, "coordinated");
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

  test("a task can read a file its dependency created, with the content actually written", async () => {
    const created = "export const PLANNER = 1;\n";
    const gateway = new ScriptedGateway({
      plan_response: [plan(
        task("T1", { write_files: ["src/planner.ts"] }),
        task("T2", { depends_on: ["T1"], context_files: ["src/planner.ts"] }),
      )],
      executor_output: [writes({ "src/planner.ts": created }), writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { report } = await run(gateway);

    assert.deepEqual(report.tasks.map((t) => t.status), ["passed", "passed"], report.problems.join("\n"));
    assert.ok(gateway.calls("executor_output")[1]?.input.includes(created));
  });

  test("a dependency that passes without creating a promised file stops the dependent task before any call", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(
        task("T1", { write_files: ["src/math.ts", "src/planner.ts"] }),
        task("T2", { depends_on: ["T1"], context_files: ["src/planner.ts"] }),
      )],
      // T1 passes but only changes math.ts.
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { report } = await run(gateway);

    assert.deepEqual(report.tasks.map((t) => t.status), ["passed", "failed"]);
    assert.match(report.tasks[1]?.reason ?? "", /missing before execution.*src\/planner\.ts/);
    assert.equal(gateway.calls("executor_output").length, 1);
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
      testsRun: null, testsPassed: null, output: "", outputTruncated: false, durationMs: 1,
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

  test("a reply that still fails the schema after the format repair stops the task: no triage, no escalation", async () => {
    const gateway = new ScriptedGateway({ plan_response: [plan(task("T1"))], executor_output: [{ fail: "format" }], run_summary: [summary] });
    const { report } = await run(gateway);
    assert.equal(report.tasks[0]?.status, "failed");
    assert.match(report.tasks[0]?.reason ?? "", /after the format repair/);
    assert.equal(gateway.calls("triage_decision").length, 0);
    assert.deepEqual(gateway.calls("executor_output").map((r) => r.model), ["muse-spark-1.3"]);
  });

  test("a rejected output can be repaired but is never a reason to escalate", async () => {
    const outside = writes({ "src/other.ts": "export {};\n" });
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"))],
      executor_output: [outside, outside],
      triage_decision: [triage("escalate")], // asked for, but not allowed
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.match(gateway.calls("triage_decision")[0]?.input ?? "", /# Failure \(rejected-output\)[\s\S]*# Allowed decisions\nrepair, stop/);
    assert.deepEqual(gateway.calls("executor_output").map((r) => r.model), ["muse-spark-1.3", "muse-spark-1.3"]);
    assert.equal(report.tasks[0]?.escalated, false);
    assert.match(report.tasks[0]?.reason ?? "", /attempts exhausted/);
  });

  test("an output with no files is not a result: it is repaired, not passed", async () => {
    const empty = (request: ModelRequest<unknown>) => ({ ...writes({})(request), notes: "nothing to do" });
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"))],
      executor_output: [empty, writes({ "src/math.ts": WITH_MUL })],
      triage_decision: [triage("repair")],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.tasks[0]?.status, "passed");
    assert.equal(report.tasks[0]?.attempts, 2);
    assert.match(gateway.calls("triage_decision")[0]?.input ?? "", /no files returned/);
  });

  test("an error in a later task keeps the earlier results in the report", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1"), task("T2", { write_files: ["src/extra.ts"] }), task("T3", { write_files: ["src/more.ts"], depends_on: ["T2"] }))],
      executor_output: [
        writes({ "src/math.ts": WITH_MUL }),
        () => {
          throw new Error("disk exploded");
        },
      ],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.deepEqual(report.tasks.map((t) => [t.taskId, t.status]), [["T1", "passed"], ["T2", "stopped"], ["T3", "skipped"]]);
    assert.match(report.problems[0] ?? "", /run stopped: unexpected error: disk exploded/);
    assert.equal(report.tasks[1]?.model, "muse-spark-1.3", "the model after the floor");
  });

  test("a write path that is an existing folder costs a re-plan, not the run", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1", { write_files: ["src"] })), plan(task("T1"))],
      executor_output: [writes({ "src/math.ts": WITH_MUL })],
      run_summary: [summary],
    });
    const { report } = await run(gateway);
    assert.equal(report.status, "completed", report.problems.join("\n"));
    assert.match(gateway.calls("plan_response")[1]?.input ?? "", /Rejected path "src": target is a directory/);
  });

  test("a ledger write failure after a paid call stops the run without understating its cost", async () => {
    const failedWrite = () => {
      const error = new LedgerWriteError("call_end", new Error("disk full"));
      error.costUsd = 0.25; // what the gateway had already settled for this call
      throw error;
    };
    const gateway = new ScriptedGateway({ plan_response: [plan(task("T1"))], executor_output: [failedWrite] });
    const { report } = await run(gateway);

    assert.equal(report.status, "incomplete");
    assert.match(report.problems[0] ?? "", /run stopped: Could not record call_end/);
    assert.equal(report.costByPhase.execution?.toFixed(2), "0.25");
    assert.equal(report.costUsd?.toFixed(3), "0.251", "planning $0.001 plus the failed call's $0.25");
    assert.equal(gateway.calls("run_summary").length, 0, "no further call once the ledger fails");
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

describe("runPipeline: single-model mode (experiment arm A)", () => {
  const solo = (overrides: Partial<PlannedTask> = {}) =>
    task("A1", { complexity: "complex", impact: "high", model: "muse-wonder-1.0", ...overrides });

  test("runs the one task with no coordinator calls, then freezes", async () => {
    const gateway = new ScriptedGateway({ executor_output: [writes({ "src/math.ts": WITH_MUL })] });
    const { report } = await run(gateway, { singleModelTask: solo() });

    assert.equal(report.mode, "single-model");
    assert.equal(report.status, "completed", report.problems.join("\n"));
    assert.deepEqual(gateway.requests.map((r) => `${r.role}:${r.model}`), ["executor:muse-wonder-1.0"]);
    assert.ok(report.manifest, "a completed single-model run is frozen like any other");
    assert.equal(report.summary, null);
    assert.equal(report.costByPhase.coordination, 0);
    assert.equal(report.tasks[0]?.reviewRequired, false, "arm A has no review step to wait for");
  });

  test("failed attempts are repaired without triage until the run's rework limit", async () => {
    const reworks = config.limits.maxTotalReworks;
    const broken = Array.from({ length: reworks + 1 }, () => writes({ "src/math.ts": BROKEN }));
    const gateway = new ScriptedGateway({ executor_output: broken });
    const { report } = await run(gateway, { singleModelTask: solo() });

    assert.equal(report.tasks[0]?.status, "failed");
    assert.match(report.tasks[0]?.reason ?? "", /rework limit reached/);
    assert.equal(report.tasks[0]?.attempts, reworks + 1);
    assert.equal(report.tasks[0]?.escalated, false);
    assert.equal(gateway.calls("triage_decision").length, 0);
    assert.match(gateway.calls("executor_output")[1]?.input ?? "", /## Previous attempt/);
    assert.doesNotMatch(gateway.calls("executor_output")[1]?.input ?? "", /Coordinator guidance/);
  });

  test("an invalid single-model task stops the run before any call", async () => {
    const gateway = new ScriptedGateway({});
    const { report } = await run(gateway, { singleModelTask: solo({ write_files: ["test/math.test.ts"] }) });
    assert.equal(report.status, "incomplete");
    assert.match(report.problems[0] ?? "", /single-model task is invalid: .*protected/);
    assert.equal(gateway.requests.length, 0);
  });
});

describe("runPipeline: check groups", () => {
  const WITH_MUL_SUB = WITH_MUL + "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
  const groups = [
    { name: "mul", description: "mul()", tests: ["mul.test.ts"], requires: [] },
    { name: "sub", description: "sub()", tests: ["sub.test.ts"], requires: ["mul"] },
  ];
  let visibleTestsDir: string;

  before(async () => {
    visibleTestsDir = path.join(base, "visible");
    await mkdir(visibleTestsDir, { recursive: true });
    const testFor = (fn: string, expected: number) =>
      `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { ${fn} } from '../src/math.ts';\ntest('${fn}', () => assert.equal(${fn}(5, 3), ${expected}));\n`;
    await writeFile(path.join(visibleTestsDir, "mul.test.ts"), testFor("mul", 15));
    await writeFile(path.join(visibleTestsDir, "sub.test.ts"), testFor("sub", 2));
  });

  test("each task is checked with its own tests and earlier ones, never later ones", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1", { check_groups: ["mul"] }), task("T2", { check_groups: ["sub"], depends_on: ["T1"] }))],
      executor_output: [writes({ "src/math.ts": WITH_MUL }), writes({ "src/math.ts": WITH_MUL_SUB })],
      run_summary: [summary],
    });
    const { report, workspace } = await run(gateway, { checkGroups: groups, visibleTestsDir });

    // Without groups, sub.test.ts would break T1's type check: sub() does not exist yet.
    assert.equal(report.status, "completed", report.problems.join("\n"));
    const [first, second] = gateway.calls("executor_output").map((r) => r.input);
    assert.match(first!, /=== FILE: test\/mul\.test\.ts ===/);
    assert.doesNotMatch(first!, /sub\.test\.ts/);
    assert.match(second!, /=== FILE: test\/sub\.test\.ts ===/);
    assert.deepEqual(report.pendingCheckGroups, []);
    await readFile(path.join(workspace.root, "test", "sub.test.ts")); // both groups are in the final result
  });

  test("each visible test run must execute the baseline's tests plus those of the groups present", async () => {
    const counted = groups.map((g) => ({ ...g, expectedTests: g.name === "mul" ? 2 : 5 }));
    const seen: Array<{ name: string; expected: number | undefined }> = [];
    const pass = async (spec: CheckSpec): Promise<CheckResult> => {
      seen.push({ name: spec.name, expected: spec.expectedTests });
      return { name: spec.name, passed: true, failure: null, exitCode: 0, timedOut: false, processExited: true, testsRun: 99, testsPassed: 99, output: "", outputTruncated: false, durationMs: 1 };
    };
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1", { check_groups: ["mul"] }), task("T2", { check_groups: ["sub"], depends_on: ["T1"] }))],
      executor_output: [writes({ "src/math.ts": WITH_MUL }), writes({ "src/math.ts": WITH_MUL_SUB })],
      run_summary: [summary],
    });
    const { report } = await run(gateway, { checkGroups: counted, visibleTestsDir, baselineTests: 1, runCheck: pass });

    assert.equal(report.status, "completed", report.problems.join("\n"));
    // T1 (baseline + mul), T2 (baseline + mul + sub), then the integrated check.
    assert.deepEqual(seen.filter((c) => c.name === "visible-tests").map((c) => c.expected), [3, 8, 8]);
    assert.ok(seen.filter((c) => c.name === "typecheck").every((c) => c.expected === undefined));
    assert.equal(report.frozenIntact, true);
  });

  test("a repair sees only its own write scope in the diff, not the copied visible tests", async () => {
    const BROKEN_SUB = WITH_MUL + "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
    const gateway = new ScriptedGateway({
      plan_response: [plan(
        task("T1", { check_groups: ["mul"] }),
        task("T2", { check_groups: ["sub"], depends_on: ["T1"], write_files: ["src/math.ts", "src/notes.ts"] }),
      )],
      executor_output: [
        writes({ "src/math.ts": WITH_MUL }),
        writes({ "src/math.ts": BROKEN_SUB, "src/notes.ts": "export const notes = 1;\n" }),
        writes({ "src/math.ts": WITH_MUL_SUB, "src/notes.ts": "export const notes = 1;\n" }),
      ],
      triage_decision: [triage("repair")],
      run_summary: [summary],
    });
    const { report } = await run(gateway, { checkGroups: groups, visibleTestsDir });
    assert.equal(report.status, "completed", report.problems.join("\n"));

    const repair = gateway.calls("executor_output")[2]!.input;
    const diff = /Changes made so far:\n\n```diff\n([\s\S]*?)\n```/.exec(repair)?.[1] ?? "";
    assert.match(diff, /diff --git a\/src\/math\.ts/);
    assert.match(diff, /diff --git a\/src\/notes\.ts/);
    assert.doesNotMatch(diff, /test\//, "the copied visible tests are not the executor's changes");
  });

  test("a failed task's files and tests are rolled back so they cannot fail unrelated later tasks", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(
        task("T1", { check_groups: ["mul"] }),
        task("T2", { check_groups: ["sub"], depends_on: ["T1"] }),
        task("T3", { context_files: [], write_files: ["src/extra.ts"] }),
      )],
      executor_output: [writes({ "src/math.ts": BROKEN }), writes({ "src/extra.ts": "export const extra = 1;\n" })],
      triage_decision: [triage("stop")],
      run_summary: [summary],
    });
    const { report, workspace } = await run(gateway, { checkGroups: groups, visibleTestsDir });
    // T3 does not depend on T1; it passes because T1's broken code and its
    // failing tests were removed when T1 failed.
    assert.deepEqual(report.tasks.map((t) => t.status), ["failed", "skipped", "passed"], report.problems.join("\n"));
    assert.deepEqual(report.pendingCheckGroups, ["mul", "sub"]);
    assert.equal(await readFile(path.join(workspace.root, "src", "math.ts"), "utf8"), BASELINE["src/math.ts"]);
    await assert.rejects(readFile(path.join(workspace.root, "test", "mul.test.ts")));
  });

  test("a plan that leaves a group unassigned is rejected", async () => {
    const gateway = new ScriptedGateway({
      plan_response: [plan(task("T1", { check_groups: ["mul"] })), plan(task("T1", { check_groups: ["mul"] }))],
    });
    const { report } = await run(gateway, { checkGroups: groups, visibleTestsDir });
    assert.equal(report.plan, null);
    assert.match(report.problems.join("\n"), /"sub" is not assigned/);
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
