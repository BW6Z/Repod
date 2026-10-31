import { parseArgs } from "node:util";

export const COMMANDS = ["check-config", "spend", "probe", "run", "experiment"] as const;
export type Command = (typeof COMMANDS)[number];

export type ParsedCommand =
  | { ok: true; command: Command | null; model: string | null }
  | { ok: false; error: string };

/**
 * Parses CLI arguments strictly. Anything unexpected is an error rather than
 * silently ignored: a misplaced "--" once turned `--model` into a stray
 * positional, and probe then called the default model, which costs money.
 */
export function parseCommand(argv: string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { model: { type: "string" } } });
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
  if (values.model !== undefined && command !== "probe") {
    return { ok: false, error: "--model is only valid with probe" };
  }
  return { ok: true, command: command as Command | null, model: values.model ?? null };
}
