import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { z } from "zod";
import { loadConfig } from "../config/load.ts";
import type { PricingTable, RepodConfig } from "../config/schema.ts";
import { ProviderError, type AdapterRequest, type AdapterResponse, type ProviderAdapter } from "./adapters/adapter.ts";
import { LedgerWriteError, ModelGateway } from "./gateway.ts";
import { LedgerWriter, readEvents, type LedgerEvent } from "./ledger.ts";
import { SpendTracker } from "./spend.ts";
import type { ModelRequest } from "./types.ts";

type Step = AdapterResponse | ProviderError;

/** Replays scripted responses and records every request it receives. */
class FakeAdapter implements ProviderAdapter {
  readonly provider = "meta" as const;
  readonly requests: AdapterRequest[] = [];
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = steps;
  }

  async call(request: AdapterRequest): Promise<AdapterResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error("FakeAdapter ran out of scripted steps");
    if (step instanceof ProviderError) throw step;
    return step;
  }
}

const Answer = z.strictObject({ capital: z.string() });
const usage = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, reasoningTokens: 200, raw: {} };
const ok = (text: string): AdapterResponse => ({ text, stop: "complete", usage });
const rateLimited = (retryAfterMs: number | null = 10) => new ProviderError("rate_limited", "slow down", { retryable: true, retryAfterMs });

let config: RepodConfig;
let dir: string;
let ledger: LedgerWriter;
let waits: number[];

before(async () => {
  config = await loadConfig(path.resolve(import.meta.dirname, "../../config"));
  dir = await mkdtemp(path.join(tmpdir(), "repod-gateway-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
let counter = 0;
beforeEach(() => {
  ledger = new LedgerWriter(path.join(dir, `events-${++counter}.jsonl`), "run");
  waits = [];
});

function gateway(adapter: ProviderAdapter, spend = new SpendTracker(3, 10, 0), pricing: PricingTable = config.pricing) {
  return new ModelGateway({
    preset: config.presets.get("saving")!,
    pricing,
    limits: config.limits,
    adapters: [adapter],
    ledger,
    spend,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
}

function request(overrides: Partial<ModelRequest<{ capital: string }>> = {}): ModelRequest<{ capital: string }> {
  return {
    role: "coordinator",
    model: "muse-spark-1.3",
    system: "Answer in JSON.",
    input: "Capital of France?",
    schema: Answer,
    schemaName: "answer",
    maxOutputTokens: 2000,
    taskId: null,
    attemptId: "a1",
    ...overrides,
  };
}

async function outcomes(): Promise<string[]> {
  return (await readEvents(ledger.file))
    .filter((e): e is Extract<LedgerEvent, { type: "call_end" }> => e.type === "call_end")
    .map((e) => e.outcome);
}

describe("ModelGateway: results and the ledger", () => {
  test("returns validated data, bills at list price and logs start and end", async () => {
    const adapter = new FakeAdapter([ok('{"capital":"Paris"}')]);
    const result = await gateway(adapter).call(request());

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.data, { capital: "Paris" });
    // muse-spark-1.3: 1000 * 1.25 + 500 * 4.25 per million tokens
    assert.ok(Math.abs((result.costUsd ?? 0) - 0.003375) < 1e-9);
    assert.equal(adapter.requests[0]?.reasoningEffort, config.limits.reasoningEffort.coordinator);
    assert.equal(adapter.requests[0]?.jsonSchema.additionalProperties, false);
    assert.deepEqual((await readEvents(ledger.file)).map((e) => e.type), ["call_start", "call_end"]);
    assert.deepEqual(await outcomes(), ["ok"]);
  });

  test("an invalid reply is logged as format, then one repair succeeds", async () => {
    const adapter = new FakeAdapter([ok("not json"), ok('{"capital":"Paris"}')]);
    const result = await gateway(adapter).call(request());
    assert.equal(result.ok, true);
    assert.match(adapter.requests[1]?.input ?? "", /not valid JSON/);
    assert.deepEqual(await outcomes(), ["format", "ok"]);
  });

  test("a schema mismatch after the repair fails with format, and both replies are logged as format", async () => {
    const adapter = new FakeAdapter([ok('{"city":"Paris"}'), ok('{"city":"Paris"}')]);
    const result = await gateway(adapter).call(request());
    assert.equal(!result.ok && result.failure, "format");
    assert.equal(adapter.requests.length, 2);
    assert.deepEqual(await outcomes(), ["format", "format"]);
  });

  test("truncated output and refusals fail without retry", async () => {
    const truncated = new FakeAdapter([{ text: '{"capi', stop: "truncated", usage }]);
    assert.equal((await gateway(truncated).call(request())).ok === false && truncated.requests.length, 1);

    const refused = new FakeAdapter([{ text: "I can't help with that.", stop: "refusal", usage }]);
    const result = await gateway(refused).call(request());
    assert.equal(!result.ok && result.failure, "refusal");
    assert.equal(!result.ok && result.detail, "I can't help with that.");
    assert.equal(refused.requests.length, 1);
    assert.deepEqual(await outcomes(), ["truncated", "refusal"]);
  });
});

describe("ModelGateway: retries", () => {
  test("rate limits are retried, other provider errors are not", async () => {
    const limited = new FakeAdapter([rateLimited(), ok('{"capital":"Paris"}')]);
    assert.equal((await gateway(limited).call(request())).ok, true);
    assert.equal(limited.requests.length, 2);

    const quota = new FakeAdapter([new ProviderError("quota", "no credits", { retryable: false })]);
    const result = await gateway(quota).call(request());
    assert.equal(!result.ok && result.failure, "quota");
    assert.equal(quota.requests.length, 1);
  });

  test("retries stop after maxTransientRetries", async () => {
    const adapter = new FakeAdapter([rateLimited(), rateLimited(), rateLimited(), rateLimited()]);
    const result = await gateway(adapter).call(request());
    assert.equal(!result.ok && result.failure, "rate_limited");
    assert.equal(adapter.requests.length, config.limits.maxTransientRetries + 1);
  });

  test("a Retry-After above the cap ends retries instead of stalling the run", async () => {
    const adapter = new FakeAdapter([rateLimited(10 * 60_000), ok('{"capital":"Paris"}')]);
    const result = await gateway(adapter).call(request());
    assert.equal(!result.ok && result.failure, "rate_limited");
    assert.match(!result.ok ? result.detail : "", /not retrying/);
    assert.deepEqual(waits, []);
    assert.equal(adapter.requests.length, 1);
  });
});

describe("ModelGateway: budget", () => {
  test("a failed call is billed at its full reservation", async () => {
    const spend = new SpendTracker(3, 10, 0);
    const adapter = new FakeAdapter([new ProviderError("network", "socket hang up", { retryable: false })]);
    const result = await gateway(adapter, spend).call(request());
    assert.equal(result.ok, false);
    assert.equal(result.costUsd, null); // unknown, not zero
    assert.ok(spend.runSpent > 0);
  });

  test("an unknown cached-token rate bills the reservation and reports the cost as unknown", async () => {
    const pricing: PricingTable = {
      ...config.pricing,
      prices: config.pricing.prices.map((p) => (p.model === "muse-spark-1.3" ? { ...p, cachedInputPerMTok: null } : p)),
    };
    const spend = new SpendTracker(3, 10, 0);
    const adapter = new FakeAdapter([{ ...ok('{"capital":"Paris"}'), usage: { ...usage, cachedInputTokens: 300 } }]);
    const result = await gateway(adapter, spend, pricing).call(request());
    assert.equal(result.ok, true);
    assert.equal(result.costUsd, null);
    assert.ok(spend.runSpent > 0.003375, "the pessimistic reservation, not the partial list-price cost");
  });

  test("refuses to send when the budget cannot cover the worst case", async () => {
    const adapter = new FakeAdapter([]);
    const result = await gateway(adapter, new SpendTracker(3, 10, 9.999)).call(request());
    assert.equal(!result.ok && result.failure, "budget");
    assert.equal(adapter.requests.length, 0);
    const events = await readEvents(ledger.file);
    assert.deepEqual(events.map((e) => e.type), ["call_refused"]);
    // Which budget refused it is recorded as data, not only as text.
    assert.equal(events[0]?.type === "call_refused" && events[0].scope, "total");
  });

  test("a larger schema reserves more budget", async () => {
    const reservation = async (schema: z.ZodType<{ capital: string }>) => {
      await gateway(new FakeAdapter([ok('{"capital":"Paris"}')])).call(request({ schema }));
      const start = (await readEvents(ledger.file)).find((e) => e.type === "call_start");
      ledger = new LedgerWriter(path.join(dir, `events-${++counter}.jsonl`), "run");
      return start?.type === "call_start" ? start.reservedUsd : NaN;
    };
    const small = await reservation(Answer);
    const large = await reservation(z.strictObject({ capital: z.string().describe("x".repeat(20_000)) }));
    assert.ok(large > small, `${large} should exceed ${small}`);
  });

  /** Fails one chosen append (1-based), like a briefly locked ledger file. */
  class FlakyLedger extends LedgerWriter {
    private appends = 0;
    private readonly failOn: number;

    constructor(file: string, failOn: number) {
      super(file, "run");
      this.failOn = failOn;
    }

    override append(body: Parameters<LedgerWriter["append"]>[0]): Promise<void> {
      if (++this.appends === this.failOn) return Promise.reject(new Error("simulated ledger failure"));
      return super.append(body);
    }
  }

  test("a failed call_start write sends nothing and releases the reservation", async () => {
    ledger = new FlakyLedger(path.join(dir, `events-${++counter}.jsonl`), 1);
    // Enough budget for exactly one reservation of this request.
    const spend = new SpendTracker(0.015, 10, 0);
    const adapter = new FakeAdapter([ok('{"capital":"Paris"}')]);
    const gw = gateway(adapter, spend);

    await assert.rejects(gw.call(request({ attemptId: "first" })), LedgerWriteError);
    assert.equal(adapter.requests.length, 0, "nothing may be sent without a recorded start");
    assert.equal(spend.runSpent, 0);

    // Once the ledger works again, the next call is not blocked by a stale hold.
    const result = await gw.call(request({ attemptId: "second" }));
    assert.equal(result.ok, true);
    assert.equal(adapter.requests.length, 1);
  });

  test("a failed call_end write after sending still keeps the spend and reports it", async () => {
    ledger = new FlakyLedger(path.join(dir, `events-${++counter}.jsonl`), 2);
    const spend = new SpendTracker(3, 10, 0);
    const adapter = new FakeAdapter([ok('{"capital":"Paris"}')]);
    const error = await gateway(adapter, spend).call(request()).catch((e: unknown) => e);
    assert.ok(error instanceof LedgerWriteError);
    assert.equal(error.event, "call_end");
    assert.match(error.message, /simulated ledger failure/);
    assert.equal(adapter.requests.length, 1);
    assert.ok(spend.runSpent > 0, "the request went out, so its cost must stay recorded");
    assert.equal(error.costUsd, spend.runSpent, "the caller learns what was already spent");
    // Only call_start reached the ledger, so the spend total still counts the reservation.
    assert.deepEqual((await readEvents(ledger.file)).map((e) => e.type), ["call_start"]);
  });

  test("a failed call_refused write is a LedgerWriteError too", async () => {
    ledger = new FlakyLedger(path.join(dir, `events-${++counter}.jsonl`), 1);
    const error = await gateway(new FakeAdapter([]), new SpendTracker(3, 10, 9.999)).call(request()).catch((e: unknown) => e);
    assert.ok(error instanceof LedgerWriteError);
    assert.equal(error.event, "call_refused");
  });

  test("a request that provably never left is not billed, and is still retried", async () => {
    const spend = new SpendTracker(3, 10, 0);
    const unsent = () => new ProviderError("network", "connect ECONNREFUSED", { retryable: true, sent: "no" });
    const adapter = new FakeAdapter([unsent(), unsent(), ok('{"capital":"Paris"}')]);
    const result = await gateway(adapter, spend).call(request());
    assert.equal(result.ok, true);
    assert.equal(adapter.requests.length, 3);
    const events = await readEvents(ledger.file);
    const ends = events.filter((e) => e.type === "call_end");
    assert.deepEqual(ends.map((e) => e.type === "call_end" && [e.outcome, e.costUsd === 0]), [["network", true], ["network", true], ["ok", false]]);
    // Only the successful request costs anything, in the tracker and in the result.
    const okEnd = ends[2];
    assert.equal(okEnd?.type === "call_end" ? okEnd.costUsd : null, spend.runSpent);
    assert.equal(result.costUsd, spend.runSpent);
  });

  test("implausible usage from an adapter is billed at the reservation and keeps the ledger readable", async () => {
    const spend = new SpendTracker(3, 10, 0);
    const adapter = new FakeAdapter([{ ...ok('{"capital":"Paris"}'), usage: { ...usage, outputTokens: -50000 } }]);
    const result = await gateway(adapter, spend).call(request());
    assert.equal(result.ok, true);
    assert.equal(result.costUsd, null, "unknown, not negative");
    const events = await readEvents(ledger.file); // would throw on an unreadable line
    const start = events.find((e) => e.type === "call_start");
    assert.equal(spend.runSpent, start?.type === "call_start" ? start.reservedUsd : NaN);
    assert.equal(spend.tryReserve(3 - spend.runSpent).ok, true, "no hold is left behind");
  });

  test("a wall-clock step back during a call does not produce a negative duration", async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => (now -= 5000); // every reading is five seconds earlier
    try {
      const result = await gateway(new FakeAdapter([ok('{"capital":"Paris"}')])).call(request());
      assert.equal(result.ok, true);
    } finally {
      Date.now = realNow;
    }
    const end = (await readEvents(ledger.file)).find((e) => e.type === "call_end");
    assert.ok(end?.type === "call_end" && end.durationMs >= 0);
  });

  test("models outside the preset are a configuration error", async () => {
    await assert.rejects(gateway(new FakeAdapter([])).call(request({ model: "unknown-model" })), /not declared/);
  });
});
