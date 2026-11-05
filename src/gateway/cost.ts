import type { Price } from "../config/schema.ts";
import type { Usage } from "./types.ts";

const PER_MTOK = 1_000_000;

/**
 * Standardized cost of one call at the configured list price.
 *
 * Returns null instead of a guess when cached tokens were used but no cached
 * rate is known: reports must show "unknown" rather than a false exact figure.
 */
export function standardizedCostUsd(usage: Usage, price: Price): number | null {
  if (usage.cachedInputTokens > 0 && price.cachedInputPerMTok === null) {
    return null;
  }
  const cached = usage.cachedInputTokens * (price.cachedInputPerMTok ?? 0);
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok + cached) / PER_MTOK;
}

/**
 * Worst-case cost reserved before a call is sent.
 *
 * Every input token is priced as uncached and the full output limit is
 * assumed, so a call is refused when the remaining budget cannot cover the
 * worst case. This is a budget stop policy, not a hard guarantee: a provider
 * may still bill for work done after a client-side timeout.
 */
export function reservationUsd(estimatedInputTokens: number, maxOutputTokens: number, price: Price): number {
  return (estimatedInputTokens * price.inputPerMTok + maxOutputTokens * price.outputPerMTok) / PER_MTOK;
}
