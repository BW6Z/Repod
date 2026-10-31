import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config/load.ts";
import { MetaAdapter } from "../gateway/adapters/meta.ts";
import { ModelGateway } from "../gateway/gateway.ts";
import { LedgerWriter, ledgerPath } from "../gateway/ledger.ts";
import { SpendTracker, totalSpentUsd } from "../gateway/spend.ts";
import { parseCommand } from "./args.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const configDir = path.join(repoRoot, "config");
const runsDir = path.join(repoRoot, "runs");

const USAGE = `Usage: npm run repod -- <command> [options]

Commands:
  check-config          Validate config/ (limits, pricing, presets)
  spend                 Show recorded spend across all runs against the total budget
  probe [--model <id>]  Send one tiny structured-output request (costs real money)
  run                   Run a request end to end (not implemented yet)
  experiment            Run the comparison arms (not implemented yet)
`;

/**
 * Reads secrets from .env (gitignored) without putting them into
 * process.env, so no child process can inherit them, whatever environment
 * it is started with. A key exported in the shell is used as a fallback.
 */
function readSecrets(): { modelApiKey: string } {
  const envFile = path.join(repoRoot, ".env");
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  return { modelApiKey: fromFile.MODEL_API_KEY || process.env.MODEL_API_KEY || "" };
}

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

  // Created before any folder, so a missing key leaves nothing behind.
  const adapter = new MetaAdapter({ apiKey: readSecrets().modelApiKey });
  // Throws on a corrupt ledger: no paid call while past spend is unknown.
  const spentBefore = await totalSpentUsd(runsDir);

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
    case "experiment":
      // TODO: Wire to runPipeline and the experiment runner once planning and
      // execution are connected. Returning a distinct exit code keeps scripts
      // from treating this placeholder as success.
      console.error(`"${parsed.command}" is not implemented yet.`);
      return 2;
    case null:
      console.log(USAGE);
      return 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
