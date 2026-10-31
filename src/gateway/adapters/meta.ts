import type { Usage } from "../types.ts";
import { ProviderError, type AdapterRequest, type AdapterResponse, type ProviderAdapter } from "./adapter.ts";

const META_BASE_URL = "https://api.meta.ai/v1";

export interface MetaAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch; // injectable for tests
}

// The subset of the Responses API body this adapter reads.
interface ResponsesBody {
  status?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { code?: string | null; message?: string } | null;
}

/**
 * Meta Model API adapter using the Responses protocol with plain fetch, so no
 * SDK dependency is needed. Structured output uses `text.format` with
 * `strict: true`; `store: false` keeps prompts and outputs off Meta's
 * response storage.
 */
export class MetaAdapter implements ProviderAdapter {
  readonly provider = "meta" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MetaAdapterOptions) {
    if (!options.apiKey) throw new Error("MODEL_API_KEY is not set (see .env.example)");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? META_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call(request: AdapterRequest): Promise<AdapterResponse> {
    const payload = {
      model: request.model,
      instructions: request.system,
      input: request.input,
      max_output_tokens: request.maxOutputTokens, // covers reasoning plus visible output
      reasoning: { effort: request.reasoningEffort },
      store: false,
      text: {
        format: { type: "json_schema", name: request.schemaName, schema: request.jsonSchema, strict: true },
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: request.signal,
      });
    } catch (error) {
      if (isAbort(error)) {
        // Our own timeout: the provider may still be generating and billing,
        // so retrying would pay again for the same work.
        throw new ProviderError("network", "Request to Meta timed out", { retryable: false });
      }
      // Connection failures before a response: usually safe to retry. The
      // gateway still bills the reservation in case the request got through.
      throw new ProviderError("network", `Request to Meta failed: ${messageOf(error)}`, { retryable: true });
    }

    if (!response.ok) throw await httpError(response);

    let body: ResponsesBody;
    try {
      body = (await response.json()) as ResponsesBody;
    } catch (error) {
      // The request succeeded and was billed; only reading the reply failed.
      throw new ProviderError("network", `Could not read Meta's response body: ${messageOf(error)}`, { retryable: false });
    }
    return parseResponsesBody(body);
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Maps a non-2xx response to a classified, sanitized error (the key is never included). */
async function httpError(response: Response): Promise<ProviderError> {
  const text = await response.text().catch(() => "");
  let message = text.slice(0, 500);
  try {
    message = (JSON.parse(text) as ResponsesBody).error?.message ?? message;
  } catch {
    // Non-JSON error body; keep the raw text excerpt.
  }
  const detail = `Meta API ${response.status}: ${message}`;
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

  switch (response.status) {
    case 429:
      return new ProviderError("rate_limited", detail, { retryable: true, retryAfterMs });
    case 402: // insufficient balance or lapsed payment method
      return new ProviderError("quota", detail, { retryable: false });
    case 500:
    case 502:
    case 503:
      return new ProviderError("network", detail, { retryable: true, retryAfterMs });
    case 504:
      // Meta's docs advise against blindly retrying gateway timeouts: the
      // work may still be running and billed. Long calls should use streaming.
      return new ProviderError("network", detail, { retryable: false });
    default: // 400, 401, 403, 404, 413: the request itself is wrong
      return new ProviderError("rejected", detail, { retryable: false });
  }
}

/** Retry-After may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function parseResponsesBody(body: ResponsesBody): AdapterResponse {
  if (body.status === "failed") {
    const code = body.error?.code ?? "unknown";
    const detail = `Meta response failed: ${code} ${body.error?.message ?? ""}`.trim();
    if (code === "rate_limit_exceeded") throw new ProviderError("rate_limited", detail, { retryable: true });
    if (code === "server_error") throw new ProviderError("network", detail, { retryable: true });
    throw new ProviderError("rejected", detail, { retryable: false });
  }
  if (body.status !== "completed" && body.status !== "incomplete") {
    throw new ProviderError("network", `Unexpected response status "${body.status}"`, { retryable: false });
  }

  const parts = (body.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  const refusal = parts.find((part) => part.type === "refusal");
  const text = parts
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");

  return {
    text: refusal ? (refusal.refusal ?? "") : text,
    // "incomplete" is treated as truncation: the reason field is not
    // documented, and max_output_tokens is the case that matters here.
    // TODO: Confirm incomplete_details.reason values with a real probe call.
    stop: refusal ? "refusal" : body.status === "incomplete" ? "truncated" : "complete",
    usage: normalizeUsage(body.usage),
  };
}

/**
 * Converts Meta usage to the gateway convention (inputTokens = uncached only).
 *
 * TODO: Meta's docs do not say whether input_tokens already includes
 * cached_tokens. This follows the OpenAI Responses convention (included) and
 * subtracts it; verify with the first probe call that hits the cache.
 */
export function normalizeUsage(usage: ResponsesBody["usage"]): Usage | null {
  if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return null;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, usage.input_tokens - cached),
    outputTokens: usage.output_tokens, // reasoning tokens are counted within this total
    cachedInputTokens: cached,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
    raw: usage,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
