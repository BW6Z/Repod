import type { ZodType } from "zod";

export type Role = "coordinator" | "executor" | "reviewer";

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
  raw: unknown; // provider usage object as returned, kept for later reconciliation
}

export type FailureKind =
  | "format" // invalid JSON or schema mismatch: one format repair allowed
  | "truncated" // hit the output token limit: never escalate for this
  | "refusal"
  | "rate_limited" // wait for the provider's retry hint
  | "quota" // spending limit reached: stop, retrying cannot help
  | "network" // connection error or timeout: bounded retries
  | "budget"; // local budget reservation failed: request never sent

export interface ModelRequest<T> {
  role: Role;
  model: string;
  system: string; // kept byte-stable across calls so provider caches can hit
  input: string; // task, contract and file contents assembled by the program
  schema: ZodType<T>;
  maxOutputTokens: number; // also the upper bound used for budget reservation
  runId: string;
  taskId: string | null; // null for run-level calls such as planning
  attemptId: string;
}

export type ModelResult<T> =
  | { ok: true; data: T; usage: Usage; costUsd: number | null }
  | { ok: false; failure: FailureKind; detail: string; usage: Usage | null; costUsd: number | null };
