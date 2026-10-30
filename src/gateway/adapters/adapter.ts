import type { FailureKind, Usage } from "../types.ts";

/** What the gateway hands to a provider adapter after budget checks pass. */
export interface AdapterRequest {
  model: string;
  system: string;
  input: string;
  // JSON Schema generated from the task's Zod schema. It must stay inside the
  // strict subset both providers accept: object root, every key required,
  // additionalProperties false, no oneOf/allOf, no recursion.
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}

/** Raw provider result before schema validation. */
export interface AdapterResponse {
  text: string; // the JSON text produced by the model
  stop: "complete" | "truncated" | "refusal";
  usage: Usage; // already normalized to the gateway convention
}

/** Adapters translate provider errors into this so the gateway can classify them. */
export class ProviderError extends Error {
  readonly kind: FailureKind;
  readonly retryAfterMs: number | null;

  constructor(kind: FailureKind, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * One thin adapter per provider. Adapters do no retries, budgeting or
 * logging; the gateway owns those so the rules are identical for every model.
 */
export interface ProviderAdapter {
  readonly provider: "meta" | "anthropic";
  call(request: AdapterRequest): Promise<AdapterResponse>;
}
