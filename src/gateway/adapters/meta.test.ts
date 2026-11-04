import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProviderError, type AdapterRequest } from "./adapter.ts";
import { MetaAdapter, normalizeUsage, parseResponsesBody, parseRetryAfter } from "./meta.ts";

const request: AdapterRequest = {
  model: "muse-spark-1.3",
  system: "Answer in JSON.",
  input: "Capital of France?",
  jsonSchema: { type: "object", properties: { capital: { type: "string" } }, required: ["capital"], additionalProperties: false },
  schemaName: "answer",
  maxOutputTokens: 2000,
  reasoningEffort: "low",
  signal: new AbortController().signal,
};

// Shape taken from the documented Responses example (resp, message, output_text, usage).
const completed = {
  id: "resp_abc123",
  object: "response",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"capital":"Paris"}', annotations: [] }] },
  ],
  usage: {
    input_tokens: 69,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 163,
    output_tokens_details: { reasoning_tokens: 120 },
    total_tokens: 232,
  },
};

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { impl, calls };
}

describe("MetaAdapter", () => {
  test("names the origin it calls, so runs record where their data came from", () => {
    assert.equal(new MetaAdapter({ apiKey: "k" }).endpoint, "https://api.meta.ai");
    assert.equal(new MetaAdapter({ apiKey: "k", baseUrl: "http://127.0.0.1:8787/v1" }).endpoint, "http://127.0.0.1:8787");
  });

  test("sends a strict json_schema request with auth and store disabled", async () => {
    const { impl, calls } = fakeFetch(200, completed);
    await new MetaAdapter({ apiKey: "LLM_test_key", fetch: impl }).call(request);

    assert.equal(calls[0]?.url, "https://api.meta.ai/v1/responses");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer LLM_test_key");
    const body = JSON.parse(String(calls[0]?.init.body));
    assert.deepEqual(body.text.format, { type: "json_schema", name: "answer", schema: request.jsonSchema, strict: true });
    assert.equal(body.store, false);
    assert.equal(body.instructions, "Answer in JSON.");
    assert.equal(body.max_output_tokens, 2000);
    assert.deepEqual(body.reasoning, { effort: "low" });
  });

  test("returns the output text and normalized usage", async () => {
    const { impl } = fakeFetch(200, completed);
    const result = await new MetaAdapter({ apiKey: "k", fetch: impl }).call(request);
    assert.equal(result.text, '{"capital":"Paris"}');
    assert.equal(result.stop, "complete");
    assert.equal(result.usage?.outputTokens, 163);
    assert.equal(result.usage?.reasoningTokens, 120);
  });

  test("classifies HTTP errors", async () => {
    const cases: Array<[number, string, boolean]> = [
      [429, "rate_limited", true],
      [402, "quota", false],
      [503, "network", true],
      [504, "network", false],
      [400, "rejected", false],
      [401, "rejected", false],
    ];
    for (const [status, kind, retryable] of cases) {
      const { impl } = fakeFetch(status, { error: { message: "x", type: "t", param: null, code: null } }, { "retry-after": "15" });
      const error = await new MetaAdapter({ apiKey: "k", fetch: impl }).call(request).catch((e: unknown) => e);
      assert.ok(error instanceof ProviderError, `status ${status}`);
      assert.equal(error.kind, kind, `status ${status}`);
      assert.equal(error.retryable, retryable, `status ${status}`);
      if (status === 429) assert.equal(error.retryAfterMs, 15_000);
    }
  });

  test("connection failures become retryable network errors without leaking the key", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const error = await new MetaAdapter({ apiKey: "LLM_secret", fetch: impl }).call(request).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, "network");
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /LLM_secret/);
  });

  test("our own timeout is not retried, because the provider may still bill the work", async () => {
    const impl = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    const error = await new MetaAdapter({ apiKey: "k", fetch: impl }).call(request).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, "network");
    assert.equal(error.retryable, false);
  });

  test("an unreadable body after a successful response is a non-retryable network error", async () => {
    const { impl } = fakeFetch(200, "{ this is not json");
    const error = await new MetaAdapter({ apiKey: "k", fetch: impl }).call(request).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, "network");
    assert.equal(error.retryable, false);
  });

  test("refuses to start without an API key", () => {
    assert.throws(() => new MetaAdapter({ apiKey: "" }), /MODEL_API_KEY/);
  });

  test("a key with spaces or control characters is rejected before any request, without echoing it", () => {
    for (const apiKey of ["sk-abc\ndef", "sk abc", "sk-abc\u0000"]) {
      assert.throws(() => new MetaAdapter({ apiKey }), (error: Error) => /control characters/.test(error.message) && !error.message.includes("sk-abc"));
    }
  });

  test("an invalid or non-http base URL is rejected at construction", () => {
    assert.throws(() => new MetaAdapter({ apiKey: "k", baseUrl: "not a url" }), /not a valid URL/);
    assert.throws(() => new MetaAdapter({ apiKey: "k", baseUrl: "ftp://example.com/v1" }), /http or https/);
  });

  test("only a refused connection or an unresolved host counts as never sent", async () => {
    const failing = (cause: unknown) =>
      (async () => {
        throw new TypeError("fetch failed", { cause });
      }) as typeof fetch;
    const code = (c: string) => Object.assign(new Error(`connect ${c}`), { code: c });
    const cases: Array<[unknown, "no" | "maybe"]> = [
      [code("ENOTFOUND"), "no"],
      [code("EAI_AGAIN"), "no"],
      [code("ECONNREFUSED"), "no"],
      // localhost tries every address; all of them were refused.
      [new AggregateError([code("ECONNREFUSED"), code("ECONNREFUSED")], ""), "no"],
      [new AggregateError([code("ECONNREFUSED"), code("ECONNRESET")], ""), "maybe"],
      [code("ECONNRESET"), "maybe"],
      [new Error("other side closed"), "maybe"],
      [undefined, "maybe"],
    ];
    for (const [cause, sent] of cases) {
      const error = await new MetaAdapter({ apiKey: "k", fetch: failing(cause) }).call(request).catch((e: unknown) => e);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.sent, sent, String((cause as Error | undefined)?.message));
      assert.equal(error.retryable, true);
    }
  });

  test("error messages never contain the key, even when the provider echoes it", async () => {
    const { impl } = fakeFetch(401, { error: { message: "bad key LLM_secret_123" } });
    const error = await new MetaAdapter({ apiKey: "LLM_secret_123", fetch: impl }).call(request).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, "rejected");
    assert.doesNotMatch(error.message, /LLM_secret_123/);
    assert.match(error.message, /\*\*\*/);
  });

  test("a non-string or very long JSON error message is handled", async () => {
    const odd = await new MetaAdapter({ apiKey: "k", fetch: fakeFetch(400, { error: { message: { nested: true } } }).impl }).call(request).catch((e: Error) => e);
    assert.doesNotMatch((odd as Error).message, /\[object Object\]/);
    const long = await new MetaAdapter({ apiKey: "k", fetch: fakeFetch(400, { error: { message: "x".repeat(5000) } }).impl }).call(request).catch((e: Error) => e);
    assert.ok((long as Error).message.length < 700);
  });
});

describe("parseResponsesBody", () => {
  test("incomplete responses are reported as truncated", () => {
    assert.equal(parseResponsesBody({ ...completed, status: "incomplete" }).stop, "truncated");
  });

  test("refusal content is reported as a refusal", () => {
    const result = parseResponsesBody({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    });
    assert.equal(result.stop, "refusal");
    assert.equal(result.text, "I can't help with that.");
  });

  test("failed responses are classified by error code", () => {
    assert.throws(
      () => parseResponsesBody({ status: "failed", error: { code: "rate_limit_exceeded", message: "" } }),
      (e: unknown) => e instanceof ProviderError && e.kind === "rate_limited",
    );
  });
});

describe("helpers", () => {
  test("implausible usage is reported as unknown instead of producing a wrong cost", () => {
    const usage = (input: unknown, output: unknown, cached?: unknown, reasoning?: unknown) =>
      normalizeUsage({
        input_tokens: input as number,
        output_tokens: output as number,
        ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached as number } }),
        ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning as number } }),
      });
    assert.equal(usage(10.5, 5), null);
    assert.equal(usage(10, -50000), null);
    assert.equal(usage(10, "5"), null);
    assert.equal(usage(10, 5, 11), null, "more cached than total input");
    assert.equal(usage(10, 5, -1), null);
    assert.equal(usage(10, 5, 0, 1.5), null);
    assert.equal(usage(10, 5, 0, -1), null);
    assert.deepEqual(usage(10, 5, 10, 5) && { ...usage(10, 5, 10, 5), raw: undefined }, {
      inputTokens: 0, outputTokens: 5, cachedInputTokens: 10, reasoningTokens: 5, raw: undefined,
    });
  });

  test("more reasoning than total output keeps the cost and caps reasoning at the output", () => {
    // Seen from Muse Glimmer on OpenRouter; its billed cost follows output_tokens.
    const usage = normalizeUsage({ input_tokens: 45, output_tokens: 116, output_tokens_details: { reasoning_tokens: 118 } });
    assert.equal(usage?.outputTokens, 116);
    assert.equal(usage?.reasoningTokens, 116);
    assert.equal(usage?.inputTokens, 45);
  });

  test("cached tokens are subtracted so they are not billed twice", () => {
    const usage = normalizeUsage({ input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 400 } });
    assert.equal(usage?.inputTokens, 600);
    assert.equal(usage?.cachedInputTokens, 400);
  });

  test("missing usage is reported as unknown", () => {
    assert.equal(normalizeUsage(undefined), null);
  });

  test("Retry-After accepts seconds and HTTP dates", () => {
    assert.equal(parseRetryAfter("2"), 2000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(parseRetryAfter(null), null);
  });
});
