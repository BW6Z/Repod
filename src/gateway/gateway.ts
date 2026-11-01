import type { Limits, Preset, Price, PricingTable } from "../config/schema.ts";
import { ProviderError, type AdapterResponse, type ProviderAdapter } from "./adapters/adapter.ts";
import { reservationUsd, standardizedCostUsd } from "./cost.ts";
import { toStrictJsonSchema } from "./json-schema.ts";
import { recordableUsage, type LedgerEvent, type LedgerWriter } from "./ledger.ts";
import type { SpendTracker } from "./spend.ts";
import type { FailureKind, ModelRequest, ModelResult, Usage } from "./types.ts";

export interface GatewayOptions {
  preset: Preset;
  pricing: PricingTable;
  limits: Limits;
  adapters: ProviderAdapter[];
  ledger: LedgerWriter;
  spend: SpendTracker;
  sleep?: (ms: number) => Promise<void>; // injectable so tests do not wait
}

/**
 * Conservative token estimate used only for budget reservation: one token
 * per two UTF-8 bytes. English and code usually tokenize at three to four
 * bytes per token and CJK text at about three, so this normally
 * overestimates. It is a heuristic, not a guaranteed bound, which is why the
 * budget is described as a stop policy rather than a hard cap.
 */
function estimateInputTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 2);
}

type EventType = LedgerEvent["type"];

/**
 * The ledger could not record an event of a model call. This is an
 * infrastructure fault for the orchestrator to stop on, not a model failure
 * to retry or escalate.
 *
 * If call_start failed, nothing was sent. If a later event failed, the
 * request may have been billed: its cost is already settled in the spend
 * tracker and, to be safe, the ledger still counts its reservation (a start
 * without an end). `costUsd` carries what the whole gateway call cost so far,
 * so the run's report does not understate it.
 */
export class LedgerWriteError extends Error {
  readonly event: EventType;
  costUsd: number | null = 0; // filled in by the gateway; null when unknown

  constructor(event: EventType, cause: unknown) {
    const consequence = event === "call_start" ? "the request was not sent" : "the run must stop";
    super(`Could not record ${event}; ${consequence} (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
    this.name = "LedgerWriteError";
    this.event = event;
  }
}

// Longest wait honored from a provider's Retry-After hint. A longer hint ends
// the retries instead of stalling the whole run.
const MAX_RETRY_WAIT_MS = 60_000;

const REPAIR_NOTE =
  "\n\nYour previous reply was not valid JSON for the required schema. " +
  "Reply again with only a JSON object that matches the schema exactly.\nValidation error: ";

type SendResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: FailureKind; detail: string; retryable: boolean; retryAfterMs: number | null };

/** Running totals across every HTTP call made for one gateway call. */
class CallTotals {
  usage: Usage | null = null;
  costUsd = 0;
  costKnown = true;

  add(usage: Usage | null, costUsd: number | null, reservedUsd: number): void {
    if (usage) {
      const prev = this.usage;
      this.usage = {
        inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
        cachedInputTokens: (prev?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
        reasoningTokens:
          prev?.reasoningTokens == null && usage.reasoningTokens == null
            ? null
            : (prev?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
        raw: [...(Array.isArray(prev?.raw) ? prev.raw : []), usage.raw],
      };
    }
    if (costUsd === null) {
      this.costKnown = false;
      this.costUsd += reservedUsd;
    } else {
      this.costUsd += costUsd;
    }
  }

  get reportedCost(): number | null {
    return this.costKnown ? this.costUsd : null;
  }
}

/**
 * The single entry point for every model call in Repod.
 *
 * Keeping budgeting, logging, validation and failure classification here means
 * the orchestrator never depends on which provider serves a role, and changing
 * a model is a config change rather than a code change.
 */
export class ModelGateway {
  private readonly options: GatewayOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GatewayOptions) {
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Sequence per request: reserve budget, log call_start, call the adapter,
   * reject truncated or refused output, validate against the schema, settle
   * the cost, log call_end with the validated outcome. An invalid reply gets
   * one repair request. Rate limits and transient network errors are retried
   * a bounded number of times; nothing else is.
   */
  async call<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    const { adapter, price } = this.resolve(request.model);
    const jsonSchema = toStrictJsonSchema(request.schema);
    const totals = new CallTotals();
    let input = request.input;

    for (let formatAttempt = 1; ; formatAttempt++) {
      let sent: SendResult<T>;
      try {
        sent = await this.sendWithRetries(request, input, jsonSchema, adapter, price, `${request.attemptId}.f${formatAttempt}`, totals);
      } catch (error) {
        if (error instanceof LedgerWriteError) error.costUsd = totals.reportedCost;
        throw error;
      }
      if (sent.ok) {
        return { ok: true, data: sent.data, usage: totals.usage, costUsd: totals.reportedCost };
      }
      if (sent.failure !== "format" || formatAttempt === 2) {
        return { ok: false, failure: sent.failure, detail: sent.detail, usage: totals.usage, costUsd: totals.reportedCost };
      }
      input = request.input + REPAIR_NOTE + sent.detail;
    }
  }

  private resolve(model: string): { adapter: ProviderAdapter; price: Price } {
    const entry = this.options.preset.models.find((m) => m.id === model);
    if (!entry) throw new Error(`Model "${model}" is not declared in preset "${this.options.preset.name}"`);
    const adapter = this.options.adapters.find((a) => a.provider === entry.provider);
    if (!adapter) throw new Error(`No adapter configured for provider "${entry.provider}"`);
    const price = this.options.pricing.prices.find((p) => p.model === model);
    if (!price) throw new Error(`No price configured for model "${model}"`);
    return { adapter, price };
  }

  private async sendWithRetries<T>(
    request: ModelRequest<T>,
    input: string,
    jsonSchema: Record<string, unknown>,
    adapter: ProviderAdapter,
    price: Price,
    baseId: string,
    totals: CallTotals,
  ): Promise<SendResult<T>> {
    const maxRetries = this.options.limits.maxTransientRetries;
    for (let retry = 0; ; retry++) {
      const attemptId = retry === 0 ? baseId : `${baseId}.r${retry}`;
      const result = await this.sendOnce(request, input, jsonSchema, adapter, price, attemptId, totals);
      if (result.ok || !result.retryable || retry >= maxRetries) return result;
      // Exponential backoff with jitter unless the provider said how long to wait.
      const wait = result.retryAfterMs ?? 1000 * 2 ** retry + Math.floor(Math.random() * 250);
      if (wait > MAX_RETRY_WAIT_MS) {
        return { ...result, detail: `${result.detail} (provider asked to wait ${Math.round(wait / 1000)} s; not retrying)` };
      }
      await this.sleep(wait);
    }
  }

  private async sendOnce<T>(
    request: ModelRequest<T>,
    input: string,
    jsonSchema: Record<string, unknown>,
    adapter: ProviderAdapter,
    price: Price,
    attemptId: string,
    totals: CallTotals,
  ): Promise<SendResult<T>> {
    const { ledger, spend, limits } = this.options;
    // The schema travels in the request body and is billed as input too.
    const estimatedInput = estimateInputTokens(request.system + input + JSON.stringify(jsonSchema));
    const reservedUsd = reservationUsd(estimatedInput, request.maxOutputTokens, price);
    const base = { role: request.role, model: request.model, taskId: request.taskId, attemptId, reservedUsd };

    const reserved = spend.tryReserve(reservedUsd);
    if (!reserved.ok) {
      await this.record({ type: "call_refused", ...base, reason: reserved.reason });
      return { ok: false, failure: "budget", detail: reserved.reason, retryable: false, retryAfterMs: null };
    }

    try {
      await ledger.append({ type: "call_start", ...base });
    } catch (error) {
      // Nothing has been sent yet, so the hold is released rather than billed.
      // The request is not sent either: a paid call must never go out without
      // a recorded start, or a crash could leave spend nobody can see.
      spend.release(reserved.reservation);
      throw new LedgerWriteError("call_start", error);
    }
    // A monotonic clock: a wall-clock step back (time sync) would give a
    // negative duration, which the ledger rejects.
    const started = performance.now();
    const elapsedMs = () => Math.round(performance.now() - started);

    let response: AdapterResponse;
    try {
      response = await adapter.call({
        model: request.model,
        system: request.system,
        input,
        jsonSchema,
        schemaName: request.schemaName,
        maxOutputTokens: request.maxOutputTokens,
        reasoningEffort: limits.reasoningEffort[request.role],
        signal: AbortSignal.timeout(limits.requestTimeoutMs),
      });
    } catch (error) {
      const known = error instanceof ProviderError;
      const failure: FailureKind = known ? error.kind : "network";
      const detail = error instanceof Error ? error.message : String(error);
      if (known && error.sent === "no") {
        // The adapter has direct evidence that nothing left this machine
        // (refused connection, unresolved host): nothing can be billed.
        spend.release(reserved.reservation);
        totals.add(null, 0, reservedUsd);
        await this.record({ type: "call_end", attemptId, outcome: failure, usage: null, costUsd: 0, durationMs: elapsedMs() });
      } else {
        // The provider may still bill a request that failed on our side, so
        // the full reservation is recorded as spent.
        spend.settle(reserved.reservation, reservedUsd);
        totals.add(null, null, reservedUsd);
        await this.record({ type: "call_end", attemptId, outcome: failure, usage: null, costUsd: null, durationMs: elapsedMs() });
      }
      return { ok: false, failure, detail, retryable: known && error.retryable, retryAfterMs: known ? error.retryAfterMs : null };
    }

    // Implausible usage, or a cost that is not a finite non-negative number,
    // is treated as unknown and billed at the reservation, like a reply
    // without usage.
    const usage = recordableUsage(response.usage);
    const computed = usage ? standardizedCostUsd(usage, price) : null;
    const costUsd = computed !== null && Number.isFinite(computed) && computed >= 0 ? computed : null;
    spend.settle(reserved.reservation, costUsd ?? reservedUsd);
    totals.add(usage, costUsd, reservedUsd);

    // Validate before logging, so the ledger records what really happened:
    // a reply that arrived but does not match the schema is "format", not "ok".
    let result: SendResult<T>;
    if (response.stop === "truncated") {
      result = { ok: false, failure: "truncated", detail: "output hit max_output_tokens", retryable: false, retryAfterMs: null };
    } else if (response.stop === "refusal") {
      result = { ok: false, failure: "refusal", detail: response.text, retryable: false, retryAfterMs: null };
    } else {
      const parsed = parseJsonAgainst(response.text, request.schema);
      result = parsed.ok
        ? { ok: true, data: parsed.data }
        : { ok: false, failure: "format", detail: parsed.error, retryable: false, retryAfterMs: null };
    }

    const outcome = result.ok ? "ok" : result.failure;
    await this.record({ type: "call_end", attemptId, outcome, usage, costUsd, durationMs: elapsedMs() });
    return result;
  }

  /** Appends a call_refused or call_end event; any failure becomes a LedgerWriteError. */
  private async record(body: Parameters<LedgerWriter["append"]>[0] & { type: "call_refused" | "call_end" }): Promise<void> {
    try {
      await this.options.ledger.append(body);
    } catch (error) {
      throw new LedgerWriteError(body.type, error);
    }
  }
}

function parseJsonAgainst<T>(text: string, schema: ModelRequest<T>["schema"]): { ok: true; data: T } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  // Keep the repair hint short; the full Zod message can be very long.
  return { ok: false, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ") };
}
