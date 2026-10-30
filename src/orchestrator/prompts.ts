import { NotImplementedError } from "../shared/errors.ts";

export type PromptKind = "plan" | "revise_plan" | "execute" | "triage" | "review" | "summarize";

/**
 * System prompts for each call type. They must stay byte-stable between calls
 * (no timestamps or run ids) so provider prompt caches can be reused; all
 * per-run data goes into the request input instead.
 */
export function systemPrompt(kind: PromptKind): string {
  // TODO: Write the prompts once the output schemas are exercised against real
  // models in the day-1 API verification. Deferred so prompts are tuned
  // against observed behavior rather than guesses.
  throw new NotImplementedError(`systemPrompt(${kind})`);
}
