import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const configDir = path.join(repoRoot, "config");

const USAGE = `Usage: npm run repod -- <command>

Commands:
  check-config        Validate config/ (limits, pricing, presets)
  run                 Run a request end to end (not implemented yet)
  experiment          Run the comparison arms (not implemented yet)
`;

async function checkConfig(): Promise<number> {
  const config = await loadConfig(configDir);
  console.log(`Config OK: ${config.presets.size} preset(s), ${config.pricing.prices.length} priced model(s).`);
  for (const price of config.pricing.prices.filter((p) => !p.verified)) {
    console.log(`  warning: price for ${price.model} is not verified against the live pricing page`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false });
  const command = positionals[0];

  switch (command) {
    case "check-config":
      return checkConfig();
    case "run":
    case "experiment":
      // TODO: Wire to runPipeline and the experiment runner once the execution
      // loop exists. Returning a distinct exit code keeps scripts from treating
      // this placeholder as success.
      console.error(`"${command}" is not implemented yet.`);
      return 2;
    default:
      console.log(USAGE);
      return command === undefined ? 0 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
