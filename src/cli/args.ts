import { parseArgs } from "node:util";
import { ARMS, type Arm } from "../eval/experiment.ts";

export const COMMANDS = ["check-config", "spend", "probe", "run", "experiment", "view", "export"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CommandOptions {
  model: string | null; // probe
  preset: string | null; // run
  experiment: boolean; // run: default answers and automatic plan approval
  holdout: string | null; // run, experiment: folder with holdout tests
  arms: Arm[]; // experiment: arms in run order; default A, C (B only when asked)
  runs: number; // experiment: runs per arm
  label: string | null; // experiment: "debug", "formal", ...
  port: number; // view: local port of the run viewer
  interactive: boolean; // view: the page may start paid runs and talk to Meta
  out: string | null; // export: folder for the static replay
  include: string[]; // export: run or experiment ids; empty means all finished runs and experiments
}

export type ParsedCommand = ({ ok: true; command: Command | null } & CommandOptions) | { ok: false; error: string };

// Which options each command accepts; anything else is an error.
const ALLOWED: Record<Command, ReadonlyArray<keyof CommandOptions>> = {
  "check-config": [],
  spend: [],
  probe: ["model"],
  run: ["preset", "experiment", "holdout"],
  experiment: ["arms", "runs", "label", "holdout"],
  view: ["port", "interactive", "holdout"],
  export: ["out", "include"],
};

const LABEL = /^[a-z0-9-]{1,20}$/; // becomes part of run ids and file names

/**
 * Parses CLI arguments strictly. Anything unexpected is an error rather than
 * silently ignored: a misplaced "--" once turned `--model` into a stray
 * positional, and probe then called the default model, which costs money.
 */
export function parseCommand(argv: string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        model: { type: "string" },
        preset: { type: "string" },
        experiment: { type: "boolean" },
        holdout: { type: "string" },
        arms: { type: "string" },
        runs: { type: "string" },
        label: { type: "string" },
        port: { type: "string" },
        interactive: { type: "boolean" },
        out: { type: "string" },
        include: { type: "string", multiple: true },
      },
    });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const { positionals, values } = parsed;
  if (positionals.length > 1) {
    return { ok: false, error: `Unexpected arguments: ${positionals.slice(1).join(" ")}` };
  }
  const command = positionals[0] ?? null;
  if (command !== null && !(COMMANDS as readonly string[]).includes(command)) {
    return { ok: false, error: `Unknown command "${command}"` };
  }
  const given = (Object.keys(values) as Array<keyof CommandOptions>).filter((key) => values[key] !== undefined);
  const allowed = command === null ? [] : ALLOWED[command as Command];
  const misplaced = given.find((key) => !allowed.includes(key));
  if (misplaced) {
    return { ok: false, error: `--${misplaced} is not valid${command ? ` with ${command}` : " without a command"}` };
  }

  // An experiment spends real money on every run, so a malformed value is an
  // error rather than a guess.
  const arms = values.arms === undefined ? ["A", "C"] : values.arms.split(",").map((a) => a.trim().toUpperCase());
  const badArm = arms.find((a) => !(ARMS as readonly string[]).includes(a));
  if (badArm !== undefined) return { ok: false, error: `Unknown arm "${badArm}"; use ${ARMS.join(", ")}` };
  if (new Set(arms).size !== arms.length) return { ok: false, error: "--arms lists an arm twice" };
  const runs = values.runs === undefined ? 1 : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) return { ok: false, error: "--runs must be a whole number from 1 to 10" };
  if (values.label !== undefined && !LABEL.test(values.label)) {
    return { ok: false, error: "--label may only use lower-case letters, digits and '-' (at most 20)" };
  }
  const port = values.port === undefined ? 4173 : Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: "--port must be a whole number from 1024 to 65535" };
  if (command === "export" && values.out === undefined) return { ok: false, error: "export needs --out <dir>: a new or empty folder" };
  if (command === "experiment" && values.holdout === undefined) {
    return { ok: false, error: "experiment needs --holdout <dir>: the holdout pass rate is its main result" };
  }

  return {
    ok: true,
    command: command as Command | null,
    model: values.model ?? null,
    preset: values.preset ?? null,
    experiment: values.experiment ?? false,
    holdout: values.holdout ?? null,
    arms: arms as Arm[],
    runs,
    label: values.label ?? null,
    port,
    interactive: values.interactive ?? false,
    out: values.out ?? null,
    include: values.include ?? [],
  };
}
