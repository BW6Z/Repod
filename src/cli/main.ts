import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config/load.ts";
import type { Preset, Provider } from "../config/schema.ts";
import { armPreset, fingerprintDirs, renderSummary, runExperiment } from "../eval/experiment.ts";
import { loadDemoKit, prepareHoldout } from "../eval/kit.ts";
import { MetaAdapter } from "../gateway/adapters/meta.ts";
import { ModelGateway } from "../gateway/gateway.ts";
import { LedgerWriter, ledgerPath } from "../gateway/ledger.ts";
import { acquirePaidRunLock } from "../gateway/run-lock.ts";
import { exportReplay } from "../server/replay.ts";
import { InteractiveSession } from "../server/session.ts";
import { createViewServer } from "../server/view-server.ts";
import { SpendTracker, totalSpentUsd } from "../gateway/spend.ts";
import { experimentHooks, runPipeline, type PipelineHooks } from "../orchestrator/orchestrator.ts";
import type { RunReport } from "../orchestrator/state.ts";
import { standardChecks } from "../verifier/verifier.ts";
import { createRunWorkspace } from "../workspace/workspace.ts";
import { parseCommand, type CommandOptions } from "./args.ts";
import { terminalHooks } from "./interactive.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

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

// REPOD_CONFIG_DIR swaps the whole model setup (presets, prices, limits) at
// once, for example to config/open-weights when Meta's open-weight models run
// on another host. Preset names stay the same, so the experiment arms and the
// page keep working; the folder is announced because it decides what is paid.
const configDir = path.resolve(repoRoot, localSetting("REPOD_CONFIG_DIR") || "config");
if (localSetting("REPOD_CONFIG_DIR")) console.warn(`Using the config in ${configDir} (REPOD_CONFIG_DIR)`);

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
  run [--preset <name>] [--experiment] [--holdout <dir> | --request <text>]
                        Run the demo request on a copy of sample-repo (costs real money).
                        --request runs your own request on sample-repo instead; only the type
                        check and the repo's own tests judge it (no visible-test groups, no holdout).
                        --experiment uses default answers and approves the plan automatically.
                        --holdout runs the holdout tests in <dir> once after freezing.
  experiment --holdout <dir> [--arms A,C] [--runs <n>] [--label <name>]
                        Run the comparison arms on the demo request (costs real money).
                        Arms: A (one strong model), B (quality preset), C (saving preset).
                        Default: arms A,C, 1 run each, label "debug".
  view [--port <n>] [--interactive [--holdout <dir>]]
                        Open the run viewer on http://127.0.0.1:<port> (default 4173).
                        Read-only and free by default. --interactive lets the page start
                        the demo run and hold the conversation with Meta (costs real money).
  export --out <dir> [--include <id>]...
                        Write a static replay of recorded runs for publishing (free).
                        --include picks a run or an experiment (with its runs); default: all
                        finished runs and experiments. Local paths and holdout output are removed.
`;

// Providers this CLI can call: it constructs only the Meta adapter.
const CLI_PROVIDERS: ReadonlySet<Provider> = new Set(["meta"]);

/** Models a preset uses (coordinator and roles) whose provider this CLI has no adapter for. */
function modelsWithoutAdapter(preset: Preset): string[] {
  const used = new Set([preset.coordinator, ...Object.values(preset.roles)]);
  return preset.models.filter((m) => used.has(m.id) && !CLI_PROVIDERS.has(m.provider)).map((m) => `${m.id} (${m.provider})`);
}

/**
 * Checked before any paid call: otherwise a run would pay for planning and
 * only fail when the first task reaches a model it cannot call.
 */
function requireAdapters(preset: Preset): void {
  const missing = modelsWithoutAdapter(preset);
  if (missing.length > 0) {
    throw new Error(`Preset "${preset.name}" uses models this CLI has no adapter for: ${missing.join(", ")}. Nothing was sent.`);
  }
}

async function checkConfig(): Promise<number> {
  const config = await loadConfig(configDir);
  console.log(`Config OK: ${config.presets.size} preset(s), ${config.pricing.prices.length} priced model(s).`);
  for (const preset of config.presets.values()) {
    const missing = modelsWithoutAdapter(preset);
    if (missing.length > 0) console.log(`  warning: preset "${preset.name}" cannot run in this CLI (no adapter for ${missing.join(", ")})`);
  }
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
async function withPaidRunLock<T>(command: string, body: (spentBeforeUsd: number) => Promise<T>): Promise<T> {
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

// The contract a free-form request gets in place of eval/demo/contract.md.
const FREE_FORM_CONTRACT =
  "No interface contract was written for this request. Follow sample-repo's SPEC.md and the conventions of the existing code and keep the existing public API working. Files under test/ cannot be changed: the type check and the existing tests judge the result.";

/**
 * Runs the demo request (eval/demo) end to end on a fresh copy of
 * sample-repo: Meta plans and coordinates, executors change the copy, checks
 * judge every attempt, and the report is written to runs/<runId>/report.json.
 */
async function run(options: CommandOptions): Promise<number> {
  if (options.request) console.warn("Free-form request: only the type check and the sample repo's own tests will judge the result.");
  else if (!options.holdout) console.warn("No --holdout folder given: holdout tests will not run.");
  const { report, reportFile } = await runDemo({
    preset: options.preset,
    holdout: options.holdout,
    request: options.request,
    hooks: options.experiment ? experimentHooks : terminalHooks(),
    command: "run",
  });
  printReport(report, path.relative(repoRoot, reportFile));
  return report.status === "completed" ? 0 : 1;
}

/**
 * One paid run of the demo request, shared by `run` (terminal conversation)
 * and the run viewer's page (conversation in the browser). Everything that
 * can fail without spending (unknown preset, missing adapter or key, a lock
 * held by another paid command) fails before the run starts; onStarted then
 * receives the run id as soon as its folder exists.
 */
async function runDemo(o: {
  preset: string | null;
  holdout: string | null;
  request?: string | null; // a free-form request instead of the demo request
  hooks: PipelineHooks;
  command: string;
  onStarted?: (runId: string) => void;
}): Promise<{ report: RunReport; reportFile: string }> {
  const config = await loadConfig(configDir);
  const presetName = o.preset ?? "saving";
  const preset = config.presets.get(presetName);
  if (!preset) throw new Error(`Unknown preset "${presetName}"`);
  const kit = await loadDemoKit(path.join(repoRoot, "eval", "demo"));
  // A free-form request keeps the sample repo and its own tests, but none of
  // the demo's contract, visible-test groups or holdout: they were written for
  // the demo request and would judge a different request against the wrong goal.
  const freeForm = o.request ? o.request : null;
  const { limits } = config;
  requireAdapters(preset);

  const adapter = metaAdapter();
  return withPaidRunLock(o.command, async (spentBefore) => {
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const workspace = await createRunWorkspace(path.join(repoRoot, "sample-repo"), runsDir, runId);
    const ledger = new LedgerWriter(workspace.ledgerFile, runId);
    const holdoutChecks = o.holdout && !freeForm
      ? await prepareHoldout(workspace.runDir, path.resolve(o.holdout), limits.checkTimeoutMs, limits.maxCheckOutputBytes)
      : [];
    o.onStarted?.(runId);

    const report = await runPipeline({
      request: freeForm ?? kit.request,
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
      contract: freeForm ? FREE_FORM_CONTRACT : kit.contract,
      devChecks: standardChecks({
        workspaceRoot: workspace.root,
        tscEntry: path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
        timeoutMs: limits.checkTimeoutMs,
        maxOutputBytes: limits.maxCheckOutputBytes,
      }),
      holdoutChecks,
      checkGroups: freeForm ? [] : kit.checkGroups,
      ...(kit.baselineTests === null ? {} : { baselineTests: kit.baselineTests }),
      visibleTestsDir: kit.visibleTestsDir,
      availableChecks: kit.availableChecks,
      remainingBudgetUsd: Math.min(limits.budgetUsd, limits.totalBudgetUsd - spentBefore),
      hooks: o.hooks,
      endpoint: adapter.endpoint,
    });

    const reportFile = path.join(workspace.runDir, "report.json");
    await writeFile(reportFile, JSON.stringify(report, null, 2));
    return { report, reportFile };
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
  for (const arm of options.arms) {
    const preset = config.presets.get(armPreset(arm));
    if (!preset) throw new Error(`Arm ${arm} needs preset "${armPreset(arm)}", which is not configured`);
    requireAdapters(preset);
  }

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
      endpoint: adapter.endpoint,
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

/**
 * Serves the run viewer (web/) and the run data in runs/ on this machine
 * only. By default it reads files and nothing else, so it costs nothing and
 * can run next to a paid command to follow it live. With --interactive the
 * page can also start the demo run and answer Meta in place of the
 * terminal; that run is the same paid run as `run`, under the same lock.
 */
async function view(options: CommandOptions): Promise<number> {
  const config = await loadConfig(configDir);
  let session: InteractiveSession | null = null;
  if (options.interactive) {
    const kit = await loadDemoKit(path.join(repoRoot, "eval", "demo"));
    session = new InteractiveSession({
      request: kit.request,
      presets: [...config.presets.keys()],
      start: (preset, request, hooks, onStarted) => runDemo({ preset, holdout: options.holdout, request, hooks, command: "view", onStarted }),
    });
    if (!options.holdout) console.warn("No --holdout folder given: runs started from the page will not run holdout tests.");
  }
  const server = createViewServer({ webDir: path.join(repoRoot, "web"), runsDir, config, session });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  console.log(`Run viewer: http://127.0.0.1:${options.port}/  (runs from ${path.relative(repoRoot, runsDir) || runsDir}; Ctrl+C to stop)`);
  if (session) console.log("Interactive: the page can start paid runs of the demo request with the key in MODEL_API_KEY.");
  // Keeps serving until the process is stopped.
  await new Promise<never>(() => {});
  return 0;
}

/** Writes the static replay; reads the runs folder only and makes no model calls. */
async function exportCommand(options: CommandOptions): Promise<number> {
  const outDir = path.resolve(options.out!);
  const config = await loadConfig(configDir);
  const exported = await exportReplay({ webDir: path.join(repoRoot, "web"), runsDir, repoRoot, config, outDir, include: options.include });
  console.log(`Replay written to ${outDir}: ${exported.runs.length} run(s), ${exported.experiments.length} experiment(s).`);
  console.log("Serve the folder with any static file server; the page cannot open it from disk (file://).");
  return 0;
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
    case "view":
      return view(parsed);
    case "export":
      return exportCommand(parsed);
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
