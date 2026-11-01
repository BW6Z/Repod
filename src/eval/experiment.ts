import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Preset, RepodConfig } from "../config/schema.ts";
import { readEvents, LedgerWriter } from "../gateway/ledger.ts";
import { experimentHooks, runPipeline, type ModelCaller } from "../orchestrator/orchestrator.ts";
import type { PlannedTask } from "../orchestrator/schemas.ts";
import type { CostPhase, RunReport } from "../orchestrator/state.ts";
import { standardChecks, type CheckResult, type CheckSpec } from "../verifier/verifier.ts";
import { createRunWorkspace, listFiles } from "../workspace/workspace.ts";
import { prepareHoldout, type DemoKit } from "./kit.ts";

/**
 * The comparison arms of eval/README.md. All arms share the baseline, the
 * request, the visible and holdout tests, the limits and the budget caps.
 *   A: one strong model does the whole request, no coordinator
 *   B: Repod with the quality preset (strong executors everywhere)
 *   C: Repod with the saving preset
 */
export const ARMS = ["A", "B", "C"] as const;
export type Arm = (typeof ARMS)[number];

const ARM_SETUP: Record<Arm, { preset: string; singleModel: boolean }> = {
  // A uses the saving preset's critical model, the same strong model C
  // escalates to, so A and C differ only in coordination and routing.
  A: { preset: "saving", singleModel: true },
  B: { preset: "quality", singleModel: false },
  C: { preset: "saving", singleModel: false },
};

export interface ExperimentOptions {
  experimentId: string; // also the prefix of every run id
  label: string; // for example "debug" or "formal"; debug and formal results are reported separately
  arms: Arm[];
  runsPerArm: number;
  config: RepodConfig;
  kit: DemoKit;
  baselineDir: string;
  runsDir: string;
  holdoutDir: string;
  tscEntry: string;
  /** Past spend across all ledgers; read again before every run. */
  spentUsd(): Promise<number>;
  /** The gateway for one run, with its own spend tracker. */
  gatewayFor(preset: Preset, ledger: LedgerWriter, spentBeforeUsd: number): ModelCaller;
  runCheck?: (spec: CheckSpec) => Promise<CheckResult>; // injectable for tests
  log?: (line: string) => void;
}

export interface RunMetrics {
  arm: Arm;
  round: number;
  runId: string;
  preset: string;
  model: string | null; // arm A: the one model; otherwise null (see the report's tasks)
  status: RunReport["status"];
  // Holdout tests run only on a frozen result, so an incomplete run has none.
  holdoutRan: boolean;
  holdoutTestsRun: number | null;
  holdoutTestsPassed: number | null;
  // Passed / run. 0 when the holdout did not run or its counts are unknown:
  // a run that delivered nothing checkable delivered nothing.
  holdoutPassRate: number;
  costUsd: number | null;
  costByPhase: Record<CostPhase, number | null>;
  calls: number; // requests sent, from the ledger: includes retries and format repairs
  escalations: number;
  wallMs: number;
  problems: string[];
}

export interface Stat {
  median: number;
  min: number;
  max: number;
}

export interface ArmSummary {
  arm: Arm;
  runs: number;
  completed: number;
  holdoutAllPassed: number; // runs whose holdout ran and passed in full
  holdoutPassRate: Stat | null;
  costUsd: Stat | null; // over runs with a known cost
  costUnknownRuns: number;
  wallMs: Stat | null;
}

export interface ExperimentResult {
  experimentId: string;
  label: string;
  startedAt: string;
  finishedAt: string;
  baselineCommit: string | null;
  request: string;
  // Every run uses default answers and approves the plan automatically, so
  // there is no human input to count.
  humanInput: "none";
  stoppedEarly: string | null;
  runs: RunMetrics[];
  arms: ArmSummary[];
}

/** Arm A's one task: the whole request, every baseline file as context. */
export function singleModelTask(kit: DemoKit, preset: Preset, baselineFiles: string[]): PlannedTask {
  return {
    id: "A1",
    type: "implement",
    title: kit.singleModel.title,
    description: kit.request,
    // Complex and high impact, so the capability floor keeps the strong model.
    complexity: "complex",
    impact: "high",
    capabilities: ["code", "writing"],
    acceptance: kit.singleModel.acceptance,
    context_files: baselineFiles,
    write_files: kit.singleModel.writeFiles,
    check_groups: kit.checkGroups.map((g) => g.name),
    depends_on: [],
    model: preset.roles.critical,
    reason: "Experiment arm A: one strong model does the whole request.",
    escalate_if: "",
  };
}

export function stat(values: number[]): Stat | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

export function summarizeArms(runs: RunMetrics[], arms: Arm[]): ArmSummary[] {
  return arms.map((arm) => {
    const own = runs.filter((r) => r.arm === arm);
    const known = own.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
    return {
      arm,
      runs: own.length,
      completed: own.filter((r) => r.status === "completed").length,
      holdoutAllPassed: own.filter((r) => r.holdoutRan && r.holdoutPassRate === 1).length,
      holdoutPassRate: stat(own.map((r) => r.holdoutPassRate)),
      costUsd: stat(known),
      costUnknownRuns: own.length - known.length,
      wallMs: stat(own.map((r) => r.wallMs)),
    };
  });
}

/**
 * Runs the arms in rounds (A, C, A, C, ...) so that slow drift, such as
 * provider load during the day, affects every arm alike. Each run gets a
 * fresh workspace, its own ledger and report under runs/<runId>/, and a
 * spend tracker built from the spend recorded so far.
 *
 * The caller must hold the paid-run lock for the whole experiment. Once a
 * run is refused by the cumulative budget, later runs would be refused too,
 * so the experiment stops and says so.
 */
export async function runExperiment(o: ExperimentOptions): Promise<ExperimentResult> {
  const log = o.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const runs: RunMetrics[] = [];
  let baselineCommit: string | null = null;
  let stoppedEarly: string | null = null;

  rounds: for (let round = 1; round <= o.runsPerArm; round++) {
    for (const arm of o.arms) {
      const setup = ARM_SETUP[arm];
      const preset = o.config.presets.get(setup.preset);
      if (!preset) throw new Error(`Arm ${arm} needs preset "${setup.preset}", which is not configured`);
      const { limits } = o.config;
      const spentBefore = await o.spentUsd();

      const runId = `${o.experimentId}-${arm.toLowerCase()}${round}`;
      log(`Run ${runId} (arm ${arm}, ${setup.singleModel ? `single model ${preset.roles.critical}` : `preset ${preset.name}`})...`);
      const workspace = await createRunWorkspace(o.baselineDir, o.runsDir, runId);
      baselineCommit ??= workspace.baselineCommit;
      const ledger = new LedgerWriter(workspace.ledgerFile, runId);
      const holdoutChecks = await prepareHoldout(workspace.runDir, o.holdoutDir, limits.checkTimeoutMs, limits.maxCheckOutputBytes);
      const task = setup.singleModel ? singleModelTask(o.kit, preset, await listFiles(workspace.root)) : undefined;

      const started = Date.now();
      const report = await runPipeline({
        request: o.kit.request,
        config: o.config,
        preset,
        gateway: o.gatewayFor(preset, ledger, spentBefore),
        ledger,
        workspace,
        contract: o.kit.contract,
        devChecks: standardChecks({
          workspaceRoot: workspace.root,
          tscEntry: o.tscEntry,
          timeoutMs: limits.checkTimeoutMs,
          maxOutputBytes: limits.maxCheckOutputBytes,
        }),
        holdoutChecks,
        checkGroups: o.kit.checkGroups,
        visibleTestsDir: o.kit.visibleTestsDir,
        availableChecks: o.kit.availableChecks,
        remainingBudgetUsd: Math.min(limits.budgetUsd, limits.totalBudgetUsd - spentBefore),
        hooks: experimentHooks,
        ...(o.runCheck ? { runCheck: o.runCheck } : {}),
        ...(task ? { singleModelTask: task } : {}),
      });
      const wallMs = Date.now() - started;
      await writeFile(path.join(workspace.runDir, "report.json"), JSON.stringify(report, null, 2));

      const events = await readEvents(workspace.ledgerFile);
      const holdout = report.holdout.find((c) => c.name === "holdout-tests") ?? null;
      const metrics: RunMetrics = {
        arm,
        round,
        runId,
        preset: preset.name,
        model: task?.model ?? null,
        status: report.status,
        holdoutRan: holdout !== null,
        holdoutTestsRun: holdout?.testsRun ?? null,
        holdoutTestsPassed: holdout?.testsPassed ?? null,
        holdoutPassRate: holdout?.testsRun && holdout.testsPassed !== null ? holdout.testsPassed / holdout.testsRun : 0,
        costUsd: report.costUsd,
        costByPhase: report.costByPhase,
        calls: events.filter((e) => e.type === "call_start").length,
        escalations: report.tasks.filter((t) => t.escalated).length,
        wallMs,
        problems: report.problems,
      };
      runs.push(metrics);
      log(`  ${report.status}; holdout ${metrics.holdoutRan ? `${metrics.holdoutTestsPassed}/${metrics.holdoutTestsRun}` : "not run"}; cost ${formatUsd(metrics.costUsd)}`);

      const refused = events.find((e) => e.type === "call_refused" && /total budget/.test(e.reason));
      if (refused) {
        stoppedEarly = `run ${runId} reached the cumulative budget; the remaining runs were not started`;
        break rounds;
      }
    }
  }

  return {
    experimentId: o.experimentId,
    label: o.label,
    startedAt,
    finishedAt: new Date().toISOString(),
    baselineCommit,
    request: o.kit.request,
    humanInput: "none",
    stoppedEarly,
    runs,
    arms: summarizeArms(runs, o.arms),
  };
}

function formatUsd(value: number | null): string {
  return value === null ? "unknown" : `$${value.toFixed(4)}`;
}

/** A plain-text table of the arm summaries, for the terminal. */
export function renderSummary(result: ExperimentResult): string {
  const range = (s: Stat | null, format: (n: number) => string) =>
    s === null ? "-" : `${format(s.median)} (${format(s.min)}-${format(s.max)})`;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const secs = (n: number) => `${Math.round(n / 1000)}s`;
  const lines = [
    `Experiment ${result.experimentId} (${result.label}); median (min-max)`,
    "arm | runs | completed | holdout all passed | holdout pass rate | cost | wall time",
    ...result.arms.map((a) =>
      [
        a.arm,
        a.runs,
        a.completed,
        a.holdoutAllPassed,
        range(a.holdoutPassRate, pct),
        range(a.costUsd, usd) + (a.costUnknownRuns ? ` + ${a.costUnknownRuns} unknown` : ""),
        range(a.wallMs, secs),
      ].join(" | "),
    ),
  ];
  if (result.stoppedEarly) lines.push(`Stopped early: ${result.stoppedEarly}`);
  return lines.join("\n");
}
