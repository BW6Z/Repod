import type { ZodType } from "zod";

export const ROLES = ["coordinator", "executor", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Provider-neutral token usage.
 *
 * Convention (adapters must normalize to it): `inputTokens` counts only
 * uncached input. Providers differ here: some report cached tokens inside the
 * input total, others report them separately. Normalizing once in the adapter
 * prevents double billing in every cost report.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number; // includes reasoning tokens when the provider bills them as output
  cachedInputTokens: number;
  reasoningTokens: number | null; // display only, never billed twice
  // Provider usage object as returned, kept for later reconciliation. When a
  // gateway call made several requests (retries, a format repair), this is
  // the list of their raw usage objects.
  raw: unknown;
}

// A runtime list as well as a type, so ledger validation accepts exactly
// these values and cannot drift from the type.
export const FAILURE_KINDS = [
  "format", // invalid JSON or schema mismatch: one format repair allowed
  "truncated", // hit the output token limit: never escalate for this
  "refusal",
  "rate_limited", // wait for the provider's retry hint
  "quota", // provider billing or credit problem: stop, retrying cannot help
  "rejected", // provider refused the request itself (bad request, auth, unknown model)
  "network", // connection error, timeout or server error
  "budget", // local budget reservation failed: request never sent
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface ModelRequest<T> {
  role: Role;
  model: string;
  system: string; // kept byte-stable across calls so provider caches can hit
  input: string; // task, contract and file contents assembled by the program
  schema: ZodType<T>;
  schemaName: string; // sent to the provider as the structured-output format name
  maxOutputTokens: number; // also the upper bound used for budget reservation
  taskId: string | null; // null for run-level calls such as planning
  attemptId: string;
}

export type ModelResult<T> =
  | { ok: true; data: T; usage: Usage | null; costUsd: number | null } // usage null: provider reported none
  | { ok: false; failure: FailureKind; detail: string; usage: Usage | null; costUsd: number | null };
