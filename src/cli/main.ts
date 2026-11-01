import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config/load.ts";
import { fingerprintDirs, renderSummary, runExperiment } from "../eval/experiment.ts";
import { loadDemoKit, prepareHoldout } from "../eval/kit.ts";
import { MetaAdapter } from "../gateway/adapters/meta.ts";
import { ModelGateway } from "../gateway/gateway.ts";
import { LedgerWriter, ledgerPath } from "../gateway/ledger.ts";
import { acquirePaidRunLock } from "../gateway/run-lock.ts";
import { SpendTracker, totalSpentUsd } from "../gateway/spend.ts";
import { experimentHooks, runPipeline } from "../orchestrator/orchestrator.ts";
import type { RunReport } from "../orchestrator/state.ts";
import { standardChecks } from "../verifier/verifier.ts";
import { createRunWorkspace } from "../workspace/workspace.ts";
import { parseCommand, type CommandOptions } from "./args.ts";
import { terminalHooks } from "./interactive.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const configDir = path.join(repoRoot, "config");

/**
 * Local settings come from .env (gitignored), with the shell environment as
 * a fallback. They are never copied into process.env, so no child process
 * (checks, git) can inherit them, whatever environment it is started with.
 */
const envFilePath = path.join(repoRoot, ".env");
const envFile: Record<string, string | undefined> = existsSync(envFilePath) ? parseEnv(readFileSync(envFilePath, "utf8")) : {};
function localSetting(name: string): string {
  return envFile[name] || process.env[name] || "";
}

// REPOD_RUNS_DIR lets a rehearsal against a local fake API keep its runs,
// and their spend, apart from the real ones.
const runsDir = path.resolve(repoRoot, localSetting("REPOD_RUNS_DIR") || "runs");

/**
 * The Meta adapter for paid commands. MODEL_API_BASE_URL points it at another
 * endpoint, such as a local fake for rehearsals; it is announced every time,
 * because the API key is sent to whatever address is configured.
 */
function metaAdapter(): MetaAdapter {
  const baseUrl = localSetting("MODEL_API_BASE_URL");
  // Created before any folder, so a missing key leaves nothing behind.
  const adapter = new MetaAdapter({ apiKey: localSetting("MODEL_API_KEY"), ...(baseUrl ? { baseUrl } : {}) });
  if (baseUrl) console.warn(`Using the Meta API at ${baseUrl} (MODEL_API_BASE_URL), runs in ${runsDir}`);
  return adapter;
}

const USAGE = `Usage: npm run repod -- <command> [options]

Commands:
  check-config          Validate config/ (limits, pricing, presets)
  spend                 Show recorded spend across all runs against the total budget
  probe [--model <id>]  Send one tiny structured-output request (costs real money)
  run [--preset <name>] [--experiment] [--holdout <dir>]
                        Run the demo request on a copy of sample-repo (costs real money).
                        --experiment uses default answers and approves the plan automatically.
                        --holdout runs the holdout tests in <dir> once after freezing.
  experiment --holdout <dir> [--arms A,C] [--runs <n>] [--label <name>]
                        Run the comparison arms on the demo request (costs real money).
                        Arms: A (one strong model), B (quality preset), C (saving preset).
                        Default: arms A,C, 1 run each, label "debug".
`;

async function checkConfig(): Promise<number> {
  const config = await loadConfig(configDir);
  console.log(`Config OK: ${config.presets.size} preset(s), ${config.pricing.prices.length} priced model(s).`);
  for (const price of config.pricing.prices.filter((p) => !p.verified)) {
    console.log(`  warning: price for ${price.model} is not verified against the live pricing page`);
  }
  return 0;
}

async function spend(): Promise<number> {
  const config = await loadConfig(configDir);
  const spent = await totalSpentUsd(runsDir);
  console.log(`Recorded spend: $${spent.toFixed(4)} of $${config.limits.totalBudgetUsd} total budget (list prices, pessimistic).`);
  return 0;
}

/**
 * Runs a paid command while holding the paid-run lock (see run-lock.ts).
 * Past spend is read only once the lock is held, so no other paid command
 * can be spending against the same snapshot; the lock is released when the
 * command ends, also on errors.
 */
async function withPaidRunLock(command: string, body: (spentBeforeUsd: number) => Promise<number>): Promise<number> {
  const release = await acquirePaidRunLock(runsDir, command);
  try {
    // Throws on a corrupt ledger: no paid call while past spend is unknown.
    return await body(await totalSpentUsd(runsDir));
  } finally {
    await release();
  }
}

const ProbeAnswer = z.strictObject({ capital: z.string() });

/**
 * One minimal request through the full gateway path (budget, ledger, strict
 * schema, adapter). Used to confirm connectivity, the response shape and the
 * real cost of a call before anything larger runs.
 */
async function probe(model: string | null): Promise<number> {
  const config = await loadConfig(configDir);
  const preset = config.presets.get("saving");
  if (!preset) throw new Error('Preset "saving" is missing');
  const target = model ?? preset.coordinator;

  const adapter = metaAdapter();
  return withPaidRunLock("probe", async (spentBefore) => {
    const runId = `probe-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const runDir = path.join(runsDir, runId);
    await mkdir(runDir, { recursive: true });

    const gateway = new ModelGateway({
      preset,
      pricing: config.pricing,
      limits: config.limits,
      adapters: [adapter],
      ledger: new LedgerWriter(ledgerPath(runDir), runId),
      spend: new SpendTracker(config.limits.budgetUsd, config.limits.totalBudgetUsd, spentBefore),
    });

    const result = await gateway.call({
      role: "coordinator",
      model: target,
      system: "You are a connectivity probe. Reply with JSON only.",
      input: "What is the capital of France?",
      schema: ProbeAnswer,
      schemaName: "probe_answer",
      maxOutputTokens: 2000,
      taskId: null,
      attemptId: "probe",
    });

    console.log(`Model: ${target}`);
    console.log(result.ok ? `Result: ${JSON.stringify(result.data)}` : `Failed: ${result.failure} - ${result.detail}`);
    console.log(`Usage (normalized): ${JSON.stringify(result.usage && { ...result.usage, raw: undefined })}`);
    console.log(`Usage (raw from provider): ${JSON.stringify(result.usage?.raw ?? null)}`);
    console.log(`Cost at list price: ${result.costUsd === null ? "unknown" : `$${result.costUsd.toFixed(6)}`}`);
    console.log(`Ledger: ${path.relative(repoRoot, ledgerPath(runDir))}`);
    return result.ok ? 0 : 1;
  });
}

/**
 * Runs the demo request (eval/demo) end to end on a fresh copy of
 * sample-repo: Meta plans and coordinates, executors change the copy, checks
 * judge every attempt, and the report is written to runs/<runId>/report.json.
 */
async function run(options: CommandOptions): Promise<number> {
  const config = await loadConfig(configDir);
  const presetName = options.preset ?? "saving";
  const preset = config.presets.get(presetName);
  if (!preset) throw new Error(`Unknown preset "${presetName}"`);
  const kit = await loadDemoKit(path.join(repoRoot, "eval", "demo"));
  const { limits } = config;

  const adapter = metaAdapter();
  return withPaidRunLock("run", async (spentBefore) => {
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const workspace = await createRunWorkspace(path.join(repoRoot, "sample-repo"), runsDir, runId);
    const ledger = new LedgerWriter(workspace.ledgerFile, runId);
    const holdoutChecks = options.holdout
      ? await prepareHoldout(workspace.runDir, path.resolve(options.holdout), limits.checkTimeoutMs, limits.maxCheckOutputBytes)
      : [];
    if (!options.holdout) console.warn("No --holdout folder given: holdout tests will not run.");

    const report = await runPipeline({
      request: kit.request,
      config,
      preset,
      gateway: new ModelGateway({
        preset,
        pricing: config.pricing,
        limits,
        adapters: [adapter],
        ledger,
        spend: new SpendTracker(limits.budgetUsd, limits.totalBudgetUsd, spentBefore),
      }),
      ledger,
      workspace,
      contract: kit.contract,
      devChecks: standardChecks({
        workspaceRoot: workspace.root,
        tscEntry: path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
        timeoutMs: limits.checkTimeoutMs,
        maxOutputBytes: limits.maxCheckOutputBytes,
      }),
      holdoutChecks,
      checkGroups: kit.checkGroups,
      ...(kit.baselineTests === null ? {} : { baselineTests: kit.baselineTests }),
      visibleTestsDir: kit.visibleTestsDir,
      availableChecks: kit.availableChecks,
      remainingBudgetUsd: Math.min(limits.budgetUsd, limits.totalBudgetUsd - spentBefore),
      hooks: options.experiment ? experimentHooks : terminalHooks(),
    });

    const reportFile = path.join(workspace.runDir, "report.json");
    await writeFile(reportFile, JSON.stringify(report, null, 2));
    printReport(report, path.relative(repoRoot, reportFile));
    return report.status === "completed" ? 0 : 1;
  });
}

/** The repository's current commit, with "+dirty" if the working tree has changes; null if git is unavailable. */
function sourceCommit(): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim() !== "";
    return dirty ? `${head}+dirty` : head;
  } catch {
    return null;
  }
}

/**
 * Runs the comparison arms of eval/README.md: rounds of fresh runs on copies
 * of sample-repo, each frozen and holdout-tested once, then a summary with
 * median and range per arm. Per-run reports stay in runs/<runId>/; the
 * summary goes to runs/experiments/<experimentId>.json.
 */
async function experiment(options: CommandOptions): Promise<number> {
  const config = await loadConfig(configDir);
  const kit = await loadDemoKit(path.join(repoRoot, "eval", "demo"));
  const { limits } = config;

  const adapter = metaAdapter();
  const holdoutDir = path.resolve(options.holdout!);
  // The lock is held for the whole experiment; each run re-reads past spend.
  return withPaidRunLock("experiment", async () => {
    const label = options.label ?? "debug";
    const experimentId = `exp-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const file = path.join(runsDir, "experiments", `${experimentId}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    const result = await runExperiment({
      experimentId,
      label,
      arms: options.arms,
      runsPerArm: options.runs,
      config,
      kit,
      baselineDir: path.join(repoRoot, "sample-repo"),
      runsDir,
      holdoutDir,
      tscEntry: path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      spentUsd: () => totalSpentUsd(runsDir),
      // Everything that decides what a run does; a change mid-experiment stops it.
      fingerprint: () =>
        fingerprintDirs({
          src: path.join(repoRoot, "src"),
          config: configDir,
          demoKit: path.join(repoRoot, "eval", "demo"),
          baseline: path.join(repoRoot, "sample-repo"),
          holdout: holdoutDir,
        }),
      sourceCommit: sourceCommit(),
      // Written after every run, so an interruption keeps the results so far.
      save: (partial) => writeFile(file, JSON.stringify(partial, null, 2)),
      gatewayFor: (preset, ledger, spentBeforeUsd) =>
        new ModelGateway({
          preset,
          pricing: config.pricing,
          limits,
          adapters: [adapter],
          ledger,
          spend: new SpendTracker(limits.budgetUsd, limits.totalBudgetUsd, spentBeforeUsd),
        }),
      log: (line) => console.log(line),
    });

    console.log(`\n${renderSummary(result)}\n\nResults: ${path.relative(repoRoot, file)}`);
    return result.stoppedEarly ? 1 : 0;
  });
}

function printReport(report: RunReport, reportFile: string): void {
  console.log(`\nRun ${report.status}.`);
  for (const task of report.tasks) {
    const detail = [`${task.model}`, `${task.attempts} attempt(s)`, task.escalated ? "escalated" : null, task.reason].filter(Boolean).join(", ");
    console.log(`  ${task.taskId}: ${task.status} (${detail})`);
  }
  if (report.pendingCheckGroups.length) console.log(`  Not verified: ${report.pendingCheckGroups.join(", ")}`);
  if (report.holdout.length) console.log(`  Holdout tests: ${report.holdout.every((c) => c.passed) ? "passed" : "failed"}`);
  console.log(`  Cost at list price: ${report.costUsd === null ? "unknown" : `$${report.costUsd.toFixed(4)}`}`);
  for (const problem of report.problems) console.log(`  - ${problem}`);
  if (report.summary) console.log(`\nMeta: ${report.summary.message}`);
  console.log(`\nReport: ${reportFile}`);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv);
  if (!parsed.ok) {
    console.error(`${parsed.error}\n`);
    console.log(USAGE);
    return 1;
  }

  switch (parsed.command) {
    case "check-config":
      return checkConfig();
    case "spend":
      return spend();
    case "probe":
      return probe(parsed.model);
    case "run":
      return run(parsed);
    case "experiment":
      return experiment(parsed);
    case null:
      console.log(USAGE);
      return 0;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Expected failures (missing key, corrupt ledger, bad config) are reported
  // as one line; the stack trace adds nothing for a user.
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
