import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import type { RepodConfig } from "../config/schema.ts";
import { ledgerPath } from "../gateway/ledger.ts";
import { SessionConflictError, type InteractiveSession } from "./session.ts";

/**
 * Read-only HTTP server for the run viewer (web/). It serves the page and
 * the data the page reads, under the same relative paths a static replay
 * uses, so one page works both live (polling a run in progress on this
 * machine) and as a published replay:
 *
 *   data/source.json                 where the data comes from
 *   data/runs.json                   one line per run, newest first
 *   data/models.json                 tier and price of every configured model
 *   data/experiments.json            every experiment result, newest first
 *   data/runs/<runId>/events.jsonl   the run's ledger
 *   data/runs/<runId>/report.json    the run's report, once it exists
 *
 * It never writes and never reads anything outside the page's own files
 * and the runs folder. It listens on 127.0.0.1 only.
 *
 * With a session (`view --interactive`), the page can also start a paid run
 * of the demo request and hold the conversation with Meta:
 *
 *   data/session.json   the session: state, what Meta is waiting for, token
 *   POST api/start      {"preset": "saving"}
 *   POST api/answers    {"answers": {"<question id>": "<answer>"}}
 *   POST api/review     {"action": "approve" | "revise" | "stop", "feedback"?: "..."}
 *
 * Because these spend money, other web pages must not be able to call them:
 * every request must name this machine as its host (no DNS rebinding), and
 * every action must come from this page's origin with the session token in
 * a custom header, which a cross-site request cannot send.
 */
export interface ViewServerOptions {
  webDir: string;
  runsDir: string;
  config: RepodConfig;
  session?: InteractiveSession | null;
}

export interface RunListing {
  id: string;
  kind: "run" | "probe"; // a probe has no run_started event
  request: string | null;
  preset: string | null;
  startedAt: string | null;
  finished: boolean;
  status: string; // "running" until run_finished, then its status
  mode: string | null; // from the report: "coordinated" or "single-model"
  costUsd: number | null; // from the report, once it exists
  endpoint: string | null; // origin of the model API, when the ledger recorded it
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const PAGE_FILES = new Set(["index.html", "app.js", "style.css"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Parses JSONL leniently: the viewer shows what it can, a half-written last line included. */
function parseLines(text: string): Array<Record<string, unknown>> {
  return text.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

async function readJsonOrNull(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function listRuns(runsDir: string): Promise<RunListing[]> {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const runs: RunListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const runDir = path.join(runsDir, entry.name);
    let events;
    try {
      events = parseLines(await readFile(ledgerPath(runDir), "utf8"));
    } catch (error) {
      if (isMissing(error)) continue; // not a run folder (experiments/, rehearsal/)
      throw error;
    }
    const started = events.find((e) => e.type === "run_started");
    const finished = events.find((e) => e.type === "run_finished");
    const report = await readJsonOrNull(path.join(runDir, "report.json"));
    runs.push({
      id: entry.name,
      kind: started ? "run" : "probe",
      request: typeof started?.request === "string" ? started.request : null,
      preset: typeof started?.preset === "string" ? started.preset : null,
      startedAt: typeof events[0]?.ts === "string" ? events[0].ts : null,
      finished: Boolean(finished) || (!started && events.length > 0),
      status: typeof finished?.status === "string" ? finished.status : started ? "running" : "probe",
      mode: typeof report?.mode === "string" ? report.mode : null,
      costUsd: typeof report?.costUsd === "number" ? report.costUsd : null,
      endpoint: typeof started?.endpoint === "string" ? started.endpoint : null,
    });
  }
  return runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export async function listExperiments(runsDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(runsDir, "experiments");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const results = (await Promise.all(files.map((f) => readJsonOrNull(path.join(dir, f))))).filter((r) => r !== null);
  return results.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
}

/** Tier, provider and list price of every model in any preset. */
export function listModels(config: RepodConfig): Record<string, { tier: string; provider: string; inputPerMTok: number | null; outputPerMTok: number | null }> {
  const models: Record<string, { tier: string; provider: string; inputPerMTok: number | null; outputPerMTok: number | null }> = {};
  for (const preset of config.presets.values()) {
    for (const m of preset.models) {
      const price = config.pricing.prices.find((p) => p.model === m.id);
      models[m.id] = { tier: m.tier, provider: m.provider, inputPerMTok: price?.inputPerMTok ?? null, outputPerMTok: price?.outputPerMTok ?? null };
    }
  }
  return models;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    "Content-Type": type,
    // The page loads only its own files; run data is shown as text, never as markup.
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const json = (res: ServerResponse, value: unknown, status = 200) => send(res, status, TYPES[".json"]!, JSON.stringify(value));
const notFound = (res: ServerResponse) => send(res, 404, "text/plain; charset=utf-8", "Not found");

const MAX_BODY_BYTES = 32 * 1024;
const StartBody = z.strictObject({ preset: z.string().min(1) });
const AnswersBody = z.strictObject({ answers: z.record(z.string(), z.string().max(4000)) });
const ReviewBody = z.strictObject({ action: z.enum(["approve", "revise", "stop"]), feedback: z.string().max(4000).optional() });

/** The names this server answers to; anything else (a rebound domain) is refused. */
function ownHosts(req: IncomingMessage): Set<string> {
  const port = req.socket.localPort;
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new SessionConflictError("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SessionConflictError("Request body is not valid JSON.");
  }
}

async function handleAction(session: InteractiveSession, token: string, req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
  const origin = req.headers.origin;
  const hosts = ownHosts(req);
  if (!origin || !hosts.has(origin.replace(/^http:\/\//, "")) || req.headers["x-repod-token"] !== token) {
    return json(res, { ok: false, error: "Actions are accepted only from this page." }, 403);
  }
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return json(res, { ok: false, error: "Expected a JSON body." }, 415);
  }
  try {
    const body = await readBody(req);
    if (action === "start") {
      const { preset } = StartBody.parse(body);
      return json(res, { ok: true, runId: await session.start(preset) });
    }
    if (action === "answers") {
      session.answer(AnswersBody.parse(body).answers);
      return json(res, { ok: true });
    }
    if (action === "review") {
      const { action: decision, feedback } = ReviewBody.parse(body);
      session.review(decision, feedback ?? "");
      return json(res, { ok: true });
    }
    return notFound(res);
  } catch (error) {
    if (error instanceof SessionConflictError) return json(res, { ok: false, error: error.message }, 409);
    if (error instanceof z.ZodError) return json(res, { ok: false, error: "Invalid request." }, 400);
    // Failures before the run starts (no key, the paid-run lock held, ...)
    return json(res, { ok: false, error: (error as Error).message }, 500);
  }
}

async function handle(o: ViewServerOptions, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownHosts(req).has(req.headers.host ?? "")) {
    send(res, 403, "text/plain; charset=utf-8", "Unknown host");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && parts[0] === "api" && parts.length === 2 && o.session) {
    return handleAction(o.session, token, req, res, parts[1]!);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }

  if (parts.length === 0 || (parts.length === 1 && PAGE_FILES.has(parts[0]!))) {
    const file = parts[0] ?? "index.html";
    send(res, 200, TYPES[path.extname(file)]!, await readFile(path.join(o.webDir, file)));
    return;
  }
  if (parts[0] !== "data") return notFound(res);

  const route = parts.slice(1).join("/");
  if (route === "source.json") return json(res, { source: "local", runsDir: path.basename(o.runsDir) });
  if (route === "runs.json") return json(res, await listRuns(o.runsDir));
  if (route === "models.json") return json(res, listModels(o.config));
  if (route === "experiments.json") return json(res, await listExperiments(o.runsDir));
  if (route === "session.json") {
    // Readable only by this page: no CORS headers, and the host check above.
    return json(res, o.session
      ? { enabled: true, token, request: o.session.request, presets: o.session.presets, ...o.session.snapshot() }
      : { enabled: false });
  }

  // data/runs/<runId>/events.jsonl or report.json; the id is checked against
  // the run id alphabet, so it cannot name anything outside the runs folder.
  const [runs, runId, file, ...rest] = parts.slice(1);
  if (runs !== "runs" || !runId || !RUN_ID.test(runId) || rest.length > 0 || (file !== "events.jsonl" && file !== "report.json")) {
    return notFound(res);
  }
  try {
    send(res, 200, TYPES[path.extname(file)]!, await readFile(path.join(o.runsDir, runId, file)));
  } catch (error) {
    if (isMissing(error)) return notFound(res);
    throw error;
  }
}

export function createViewServer(o: ViewServerOptions): Server {
  const token = randomUUID();
  return createServer((req, res) => {
    handle(o, token, req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", `Server error: ${(error as Error).message}`);
      else res.end();
    });
  });
}
