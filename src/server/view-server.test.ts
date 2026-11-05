import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import { InteractiveSession } from "./session.ts";
import { createViewServer, listRuns } from "./view-server.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let base: string;
let runsDir: string;
let server: Server;
let origin: string;

const line = (event: Record<string, unknown>) => JSON.stringify({ runId: "r", seq: 1, ts: "2026-11-01T10:00:00.000Z", ...event }) + "\n";

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "repod-view-"));
  runsDir = path.join(base, "runs");
  // A finished run with a report, a run still going, a probe, and folders that are not runs.
  await mkdir(path.join(runsDir, "run-done"), { recursive: true });
  await writeFile(path.join(runsDir, "run-done", "events.jsonl"),
    line({ type: "run_started", preset: "saving", request: "Add planOrder." }) + line({ type: "run_finished", status: "completed", summary: null }));
  await writeFile(path.join(runsDir, "run-done", "report.json"), JSON.stringify({ mode: "coordinated", costUsd: 0.12 }));
  await mkdir(path.join(runsDir, "run-going"));
  await writeFile(path.join(runsDir, "run-going", "events.jsonl"),
    line({ type: "run_started", preset: "saving", request: "Still going." }).replace("10:00", "11:00") + '{"type":"call_st');
  await mkdir(path.join(runsDir, "probe-1"));
  await writeFile(path.join(runsDir, "probe-1", "events.jsonl"), line({ type: "call_start" }).replace("10:00", "09:00"));
  await mkdir(path.join(runsDir, "experiments"));
  await writeFile(path.join(runsDir, "experiments", "exp-1.json"), JSON.stringify({ experimentId: "exp-1", startedAt: "2026-11-01T12:00:00Z" }));
  await writeFile(path.join(base, "secret.txt"), "outside the runs folder");

  const config = await loadConfig(path.join(repoRoot, "config"));
  server = createViewServer({ webDir: path.join(repoRoot, "web"), runsDir, config });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(base, { recursive: true, force: true });
});

describe("view server", () => {
  test("serves the page with a strict content security policy", async () => {
    const response = await fetch(`${origin}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(await response.text(), /Repod run viewer/);
    assert.equal((await fetch(`${origin}/app.js`)).status, 200);
  });

  test("lists runs newest first, with probes and unfinished runs marked, skipping non-run folders", async () => {
    const runs = await (await fetch(`${origin}/data/runs.json`)).json();
    assert.deepEqual(runs.map((r: { id: string; kind: string; status: string }) => [r.id, r.kind, r.status]), [
      ["run-going", "run", "running"],
      ["run-done", "run", "completed"],
      ["probe-1", "probe", "probe"],
    ]);
    assert.equal(runs[1].costUsd, 0.12);
    assert.equal(runs[1].mode, "coordinated");
  });

  test("serves a run's ledger and report, and 404 for a report not written yet", async () => {
    assert.match(await (await fetch(`${origin}/data/runs/run-done/events.jsonl`)).text(), /run_finished/);
    assert.equal((await fetch(`${origin}/data/runs/run-done/report.json`)).status, 200);
    assert.equal((await fetch(`${origin}/data/runs/run-going/report.json`)).status, 404);
  });

  test("serves models with tier and price, and experiment results", async () => {
    const models = await (await fetch(`${origin}/data/models.json`)).json();
    assert.equal(models["muse-wonder-1.0"].tier, "strong");
    assert.equal(typeof models["muse-wonder-1.0"].outputPerMTok, "number");
    const experiments = await (await fetch(`${origin}/data/experiments.json`)).json();
    assert.deepEqual(experiments.map((x: { experimentId: string }) => x.experimentId), ["exp-1"]);
  });

  test("never serves anything outside the page and the runs folder", async () => {
    for (const url of [
      "/data/runs/..%2Fsecret.txt/events.jsonl",
      "/data/runs/../secret.txt",
      "/data/runs/run-done/../../secret.txt",
      "/data/runs/run-done/other.json",
      "/data/runs/run-done/events.jsonl/extra",
      "/../secret.txt",
      "/package.json",
      "/data/unknown.json",
    ]) {
      const response = await fetch(`${origin}${url}`);
      assert.equal(response.status, 404, url);
      assert.doesNotMatch(await response.text(), /outside the runs folder/, url);
    }
  });

  test("is read-only", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      assert.equal((await fetch(`${origin}/data/runs.json`, { method })).status, 405, method);
    }
  });
});

test("a missing runs folder lists no runs", async () => {
  assert.deepEqual(await listRuns(path.join(base, "no-such-folder")), []);
});

describe("view server with an interactive session", () => {
  let interactive: Server;
  let port: number;
  let started = 0;
  let lastRequest: string | null | undefined;

  before(async () => {
    const config = await loadConfig(path.join(repoRoot, "config"));
    const session = new InteractiveSession({
      request: "Add planOrder.",
      presets: ["saving"],
      async start(_preset, request, hooks, onStarted) {
        started++;
        lastRequest = request;
        onStarted("run-page");
        await hooks.answerQuestions([{ id: "q1", question: "YAML?", why: "", default: "No" }], "One question.");
      },
    });
    interactive = createViewServer({ webDir: path.join(repoRoot, "web"), runsDir, config, session });
    await new Promise<void>((resolve) => interactive.listen(0, "127.0.0.1", resolve));
    port = (interactive.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise((resolve) => interactive.close(resolve));
  });

  /** A raw request, so Host and Origin can be set the way another site or a rebound domain would. */
  function call(method: string, urlPath: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  test("the page can read the session and its token; a rebound host cannot", async () => {
    const own = await call("GET", "/data/session.json", { Host: `127.0.0.1:${port}` });
    const session = JSON.parse(own.text);
    assert.equal(session.enabled, true);
    assert.equal(typeof session.token, "string");
    assert.equal(session.request, "Add planOrder.");
    const rebound = await call("GET", "/data/session.json", { Host: `attacker.example:${port}` });
    assert.equal(rebound.status, 403);
    assert.doesNotMatch(rebound.text, new RegExp(session.token));
  });

  test("starting a paid run needs this page's origin, the token and a JSON body", async () => {
    const { token } = JSON.parse((await call("GET", "/data/session.json", { Host: `127.0.0.1:${port}` })).text);
    const page = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", "X-Repod-Token": token };
    const body = JSON.stringify({ preset: "saving" });

    assert.equal((await call("POST", "/api/start", { ...page, "X-Repod-Token": "guess" }, body)).status, 403, "wrong token");
    assert.equal((await call("POST", "/api/start", { ...page, Origin: "https://attacker.example" }, body)).status, 403, "other site");
    const { Origin: _origin, ...noOrigin } = page;
    assert.equal((await call("POST", "/api/start", noOrigin, body)).status, 403, "no origin");
    assert.equal((await call("POST", "/api/start", { ...page, Host: `attacker.example:${port}` }, body)).status, 403, "rebound host");
    assert.equal((await call("POST", "/api/start", { ...page, "Content-Type": "text/plain" }, body)).status, 415, "a form post");
    assert.equal((await call("POST", "/api/start", page, JSON.stringify({ preset: 1 }))).status, 400, "invalid body");
    assert.equal((await call("POST", "/api/start", page, JSON.stringify({ preset: "saving", request: "   " }))).status, 400, "blank request");
    assert.equal((await call("POST", "/api/start", page, JSON.stringify({ preset: "saving", request: "x".repeat(4001) }))).status, 400, "request too long");
    assert.equal(started, 0, "nothing was started by any refused request");

    const ok = await call("POST", "/api/start", page, body);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(JSON.parse(ok.text), { ok: true, runId: "run-page" });
    assert.equal(lastRequest, null, "no request field runs the demo request");
    assert.equal((await call("POST", "/api/start", page, body)).status, 409, "one run at a time");
  });

  test("a server without a session accepts no actions", async () => {
    assert.equal((await fetch(`${origin}/api/start`, { method: "POST", body: "{}" })).status, 405);
    assert.deepEqual(await (await fetch(`${origin}/data/session.json`)).json(), { enabled: false });
  });
});
