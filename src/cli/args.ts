import { parseArgs } from "node:util";

export const COMMANDS = ["check-config", "spend", "probe", "run", "experiment"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CommandOptions {
  model: string | null; // probe
  preset: string | null; // run
  experiment: boolean; // run: default answers and automatic plan approval
  holdout: string | null; // run: folder with holdout tests
}

export type ParsedCommand = ({ ok: true; command: Command | null } & CommandOptions) | { ok: false; error: string };

// Which options each command accepts; anything else is an error.
const ALLOWED: Record<Command, ReadonlyArray<keyof CommandOptions>> = {
  "check-config": [],
  spend: [],
  probe: ["model"],
  run: ["preset", "experiment", "holdout"],
  experiment: [],
};

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
  return {
    ok: true,
    command: command as Command | null,
    model: values.model ?? null,
    preset: values.preset ?? null,
    experiment: values.experiment ?? false,
    holdout: values.holdout ?? null,
  };
}
