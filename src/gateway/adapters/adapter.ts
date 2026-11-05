import type { Provider, ReasoningEffort } from "../../config/schema.ts";
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
  schemaName: string;
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
  signal: AbortSignal;
}

/** Raw provider result before schema validation. */
export interface AdapterResponse {
  text: string; // the JSON text produced by the model (or the refusal text)
  stop: "complete" | "truncated" | "refusal";
  // Normalized to the gateway convention. null when the provider sent no
  // usage; the gateway then bills the full reservation instead of guessing.
  usage: Usage | null;
}

/**
 * Adapters translate provider errors into this so the gateway can classify them.
 *
 * Two independent questions: may the gateway retry (`retryable`), and could
 * the provider have received and billed the request (`sent`)? "no" is only
 * for failures with direct evidence that nothing left this machine, such as
 * a refused connection or an unresolved host name; anything less certain is
 * "maybe", and the gateway then bills the full reservation.
 */
export class ProviderError extends Error {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly sent: "no" | "maybe";

  constructor(
    kind: FailureKind,
    message: string,
    options: { retryable: boolean; retryAfterMs?: number | null; sent?: "no" | "maybe" },
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.sent = options.sent ?? "maybe";
  }
}

/**
 * One thin adapter per provider. Adapters do no retries, budgeting or
 * logging; the gateway owns those so the rules are identical for every model.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  call(request: AdapterRequest): Promise<AdapterResponse>;
}
