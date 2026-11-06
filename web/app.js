// Repod run viewer. Reads run data under data/ (served live by
// `npm run repod -- view`, or published as a static replay) and renders it.
// With `view --interactive`, the page can also start the demo run and hold
// the conversation with Meta (answer its questions, approve the plan).
// Everything from a run is inserted as text, never as markup: plans,
// summaries and check output come from models and from code they wrote.

const POLL_MS = 2000;
const state = {
  view: "run", runs: [], models: {}, experiments: [], source: null, runId: null, timer: null,
  session: null, // data/session.json when the server is interactive
  // The answer form is kept across the 2-second refreshes, so typing is not lost.
  action: { key: null, node: null },
  // Collapsed parts stay as the user left them across refreshes.
  callsOpen: false,
  taskOpen: new Map(), // "<runId>:<taskId>" -> open
  tab: { run: null, name: null, picked: false }, // the open run's tab, and whether the user chose it
  last: null, // the open run's [runId, events, report], for switching tabs without fetching
  demoRequest: null, // the demo request's text, to tell its runs from free-form ones
  sourceKind: null, // "local" or "replay"
  search: "", // the run list filter; its input node is kept across refreshes like the action form
  searchNode: null,
};

// ---- small helpers ----------------------------------------------------------

/** Creates an element; children may be strings (inserted as text) or nodes. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const usd = (n) => (typeof n === "number" ? `$${n.toFixed(4)}` : "unknown");
const pct = (n) => `${Math.round(n * 100)}%`;
const card = (title, ...body) => el("section", { class: "card glass" }, title ? el("h2", {}, title) : null, ...body);
const empty = (text) => el("p", { class: "empty" }, text);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const when = (ts) => (ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

const STATUS_CLASS = { passed: "ok", completed: "ok", running: "live", "waiting for you": "live", failed: "bad", stopped: "bad", incomplete: "bad", interrupted: "bad", skipped: "warn" };
const statusText = (status) => el("span", { class: `status ${STATUS_CLASS[status] ?? ""}` }, status);

/** A run's title: the request's first clause, shortened. Taken from the request, never from a model. */
function requestTitle(request) {
  const first = String(request ?? "").split(/[:.\n]/)[0].trim();
  return first.length > 64 ? `${first.slice(0, 63)}…` : first || "Untitled request";
}

/**
 * "demo" when a run used the demo request (its contract, visible tests and
 * holdout tests apply), "own" for any other request, null when the page does
 * not know the demo request's text.
 */
function requestKind(request) {
  if (!state.demoRequest || typeof request !== "string") return null;
  return request.trim() === state.demoRequest.trim() ? "demo" : "own";
}
const KIND_LABEL = { demo: "Demo request", own: "Your own request" };

/** "2m 48s" from milliseconds; null for a negative or missing span. */
function span(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
const TIER_ROLE = { strong: "Strong", cheap: "Cheap", free: "Free" };

/** The top bar's path: where the page is, as text. */
function setCrumbs(...parts) {
  document.getElementById("crumbs").replaceChildren(...parts.flatMap((p, i) => [
    ...(i ? [el("span", { class: "sep", "aria-hidden": "true" }, "/")] : []),
    el("span", { class: i === parts.length - 1 ? "here" : null }, p),
  ]));
}

// Model APIs whose data counts as real: the Meta Model API (META_BASE_URL in
// src/gateway/adapters/meta.ts) and OpenRouter, which serves Meta's
// open-weight models for config/open-weights.
const REAL_APIS = new Map([
  ["https://api.meta.ai", "Meta Model API"],
  ["https://openrouter.ai", "OpenRouter"],
]);
const isLocalApi = (endpoint) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(endpoint);

/**
 * Where a run's or an experiment's model calls went, as [text, warn]. Data
 * from a fake API or a proxy is marked, so a rehearsal is never read as a
 * result; data from before the origin was recorded says so.
 */
function dataSource(endpoint) {
  if (!endpoint) return ["model API not recorded", false];
  if (REAL_APIS.has(endpoint)) return [REAL_APIS.get(endpoint), false];
  const host = endpoint.replace(/^https?:\/\//, "");
  return isLocalApi(endpoint)
    ? [`rehearsal against a local fake API (${host})`, true]
    : [`${host}, not a known model API`, true];
}
const sourceNote = (endpoint, prefix = "") => {
  const [text, warn] = dataSource(endpoint);
  return el("span", { class: `note ${warn ? "raised" : ""}` }, prefix + text);
};

/** A model's tier badge. `short` drops the vendor prefix (the plan card); the full id stays in the tooltip. */
function modelBadge(id, short = false) {
  const tier = state.models[id]?.tier;
  const label = short ? String(id ?? "").split("/").pop() : id;
  const title = [short ? id : null, tier ? `${tier} tier` : null].filter(Boolean).join(" · ");
  return el("span", { class: `badge ${tier ? `tier-${tier}` : ""}`, title: title || null }, label);
}

/** A bar filled to `fraction`; the width is set through the DOM, which the strict CSP allows (style attributes it does not). */
function bar(fraction, fillClass = "", thick = false) {
  const fill = el("span", { class: `fill ${fillClass}` });
  fill.style.width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
  return el("div", { class: `track ${thick ? "thick" : ""}` }, fill);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  return response.ok ? response.text() : null;
}

/** Sends one conversation action; the token proves the request comes from this page. */
async function act(action, body) {
  const response = await fetch(`api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Repod-Token": state.session?.token ?? "" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/** One turn of the conversation: an avatar, who spoke (with a time or the model, muted), and what they said. */
const message = (from, label, aside, ...body) =>
  el("div", { class: `msg ${from}` },
    el("span", { class: "avatar", "aria-hidden": "true" }, from === "meta" ? "M" : "Y"),
    el("div", { class: "msg-body" },
      el("div", { class: "msg-from" }, label, aside ? el("span", { class: "aside" }, aside) : null),
      el("div", { class: "bubble" }, ...body)));

function parseEvents(text) {
  return (text ?? "").split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return []; // a line still being written
    }
  });
}

/** Replaces the page body with the given columns; one column is the single-column layout. */
function render(columns) {
  const app = document.getElementById("app");
  // A kept form node is moved into the new tree; give it its focus back.
  const focused = document.activeElement;
  app.className = columns.length > 1 ? "app" : "app single";
  app.replaceChildren(...columns);
  if (focused && focused !== document.body && app.contains(focused)) focused.focus({ preventScroll: true });
  state.rendered = null;
}

const column = (cls, ...children) => el("div", { class: `column ${cls}` }, ...children);

/** The header's status line: what the open run is doing, or that Meta waits for the user. */
function setLive(text, dot, onclick = null) {
  const live = document.getElementById("live");
  if (!text) return live.replaceChildren();
  live.replaceChildren(el("span", { class: `dot ${dot}` }),
    onclick ? el("button", { type: "button", class: "link", onclick }, text) : el("span", {}, text));
}

/** Outside the run view, the header still says when a page-started run waits for the user. */
function liveFromSession() {
  const s = state.session;
  if (s?.state === "waiting") setLive("Meta is waiting for you", "turn", () => openRun(s.runId));
  else if (s && ["starting", "running"].includes(s.state) && s.runId) setLive("A run is in progress", "running", () => openRun(s.runId));
  else setLive(null);
}

// ---- what a run's events say --------------------------------------------------

/** Folds the ledger into what the page shows; the report, when present, overrides it. */
function summarize(events) {
  const view = { started: null, plan: null, finished: null, tasks: new Map(), checks: [], calls: [], refused: [], conversation: [], timelines: new Map() };
  const open = new Map();
  // Per task: the attempt still collecting calls and checks, and Meta's
  // triage call waiting for the decision it led to.
  const attemptOf = new Map();
  const triageOf = new Map();
  const timeline = (taskId) => view.timelines.get(taskId) ?? view.timelines.set(taskId, []).get(taskId);
  for (const e of events) {
    if (e.type === "run_started") view.started = e;
    else if (e.type === "plan_approved") view.plan = e;
    else if (e.type === "conversation") view.conversation.push(e);
    else if (e.type === "task_status") view.tasks.set(e.taskId, { status: e.status, detail: e.detail });
    else if (e.type === "check_result") {
      view.checks.push(e);
      attemptOf.get(e.taskId)?.checks.push(e);
    } else if (e.type === "task_decision") {
      timeline(e.taskId).push({ kind: "decision", ...e, call: triageOf.get(e.taskId) ?? null });
      attemptOf.delete(e.taskId);
      triageOf.delete(e.taskId);
    } else if (e.type === "run_finished") view.finished = e;
    else if (e.type === "call_refused") view.refused.push(e);
    else if (e.type === "call_start") {
      const call = { ...e, outcome: null, costUsd: null };
      open.set(e.attemptId, call);
      view.calls.push(call);
      if (e.taskId && e.role === "executor") {
        // An attempt ends with its checks or a decision; an executor call
        // after either starts the next one. Format repairs and file requests
        // within one attempt stay in it. (Ledgers written before decisions
        // were recorded still split at the checks.)
        let attempt = attemptOf.get(e.taskId);
        if (!attempt || attempt.checks.length) {
          const steps = timeline(e.taskId);
          attempt = { kind: "attempt", n: steps.filter((x) => x.kind === "attempt").length + 1, model: e.model, calls: [], checks: [] };
          attemptOf.set(e.taskId, attempt);
          steps.push(attempt);
        }
        attempt.calls.push(call);
      } else if (e.taskId && e.role === "coordinator") triageOf.set(e.taskId, call);
    } else if (e.type === "call_end") {
      const call = open.get(e.attemptId);
      if (call) Object.assign(call, { outcome: e.outcome, costUsd: e.costUsd, durationMs: e.durationMs });
    }
  }
  return view;
}

/** The run's total at list price: the report's once written, else the sum of finished calls (null while any cost is unknown). */
function runCost(view, report) {
  if (report) return report.costUsd;
  const unknown = view.calls.some((c) => c.outcome !== null && c.costUsd === null);
  return unknown ? null : view.calls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
}

// ---- run view: run list | one run in tabs | dashboard ------------------------------

const RUN_TABS = [["overview", "Overview"], ["conversation", "Conversation"], ["tasks", "Tasks"], ["changes", "Changes"]];

/**
 * The tab a run shows follows its state: the conversation while Meta waits
 * for the user, the tasks while it runs, the result once it has finished.
 * Once the user picks a tab, that choice holds for the run.
 */
function runTab(run, auto, available) {
  if (state.tab.run !== run) state.tab = { run, name: auto, picked: false };
  else if (!state.tab.picked) state.tab.name = auto;
  return available.includes(state.tab.name) ? state.tab.name : auto;
}

/** Switches the open run to a tab; with a task, opens that task's card on the Tasks tab. */
function showTab(name, taskId = null) {
  state.tab = { ...state.tab, name, picked: true };
  if (taskId) state.taskOpen.set(`${state.runId}:${taskId}`, true);
  if (state.last) renderRun(...state.last);
  if (taskId) document.getElementById(`task-${taskId}`)?.scrollIntoView({ block: "center" });
}

function renderRun(run, events, report) {
  state.last = [run, events, report]; // a tab switch re-renders without fetching again
  // Kept nodes (the search box, the answer form) move into the new tree while
  // it is built, before render() runs, which drops their focus; note it here.
  const focused = document.activeElement;
  const view = summarize(events);
  const status = view.finished?.status ?? (view.started ? "running" : "probe");
  const session = state.session;
  const ours = Boolean(session?.enabled && session.runId === run);
  const waiting = ours && session.state === "waiting";
  const planned = plannedTasks(view, report);
  const files = report?.changes?.diff ? diffFiles(report.changes.diff) : null;

  // Changes exist only once the report is written.
  const available = ["overview", "conversation", "tasks", ...(report ? ["changes"] : [])];
  const tab = view.started ? runTab(run, waiting ? "conversation" : status === "running" ? "tasks" : "overview", available) : "overview";

  if (waiting) setLive("Meta is waiting for you", "turn", tab === "conversation" ? null : () => showTab("conversation"));
  else if (session?.state === "waiting") liveFromSession(); // another run, started from this page, needs the user
  else if (status === "running") setLive(`Running · ${view.started.preset} preset`, "running");
  else if (view.started) setLive(`Run ${status}`, STATUS_CLASS[status] ?? "");
  else setLive(null);

  const counts = { tasks: planned.length || null, changes: files?.length || null };
  const tabs = view.started
    ? el("div", { class: "run-tabs", role: "tablist", "aria-label": "Run" }, RUN_TABS.filter(([name]) => available.includes(name)).map(([name, label]) =>
        el("button", { type: "button", role: "tab", class: "run-tab", "aria-selected": String(name === tab), "aria-controls": "run-panel", onclick: () => showTab(name) },
          label,
          counts[name] ? el("span", { class: "count num" }, counts[name]) : null,
          name === "conversation" && waiting ? el("span", { class: "dot turn", title: "Meta is waiting for you" }) : null)))
    : null;

  const panel = !view.started ? empty("Not a pipeline run (a connectivity probe).")
    : tab === "conversation" ? conversationPanel(view, report, ours)
    : tab === "tasks" ? tasksPanel(view, report, planned, waiting)
    : tab === "changes" ? changesList(report.changes, files)
    : overviewPanel(view, report, planned, status, waiting, ours);

  setCrumbs("Runs", run);
  render([
    historyColumn(),
    el("section", { class: "main glass dense" },
      runHead(run, view, report, waiting ? "waiting for you" : status, planned),
      tabs,
      el("div", { class: "panel", id: "run-panel", role: tabs ? "tabpanel" : null }, panel),
      waiting && tab === "conversation" ? actionForm(run, session.pending) : null),
    column("side", costCard(view, report), compareCard(view, report), view.started ? detailsCard(run, view, report) : null),
  ]);
  if (focused && focused !== document.body && document.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

/** How long a run took: start to finish, or null while it runs. */
const runSpan = (view) => (view.started && view.finished ? span(Date.parse(view.finished.ts) - Date.parse(view.started.ts)) : null);

/** The models the run used, by role: the coordinator first, then the executors by tier. */
function modelChips(view, planned, single) {
  const chip = (role, id) => {
    const tier = state.models[id]?.tier;
    // A readable name ("Muse Spark Open"); the full model id stays in the tooltip.
    return el("span", { class: `chip ${tier ? `tier-${tier}` : ""}`, title: id }, el("span", { class: "swatch" }), el("span", { class: "role" }, role), modelName(id));
  };
  const coordinator = view.calls.find((c) => c.role === "coordinator")?.model;
  const executors = [...new Set([...planned.map((t) => t.model), ...view.calls.filter((c) => c.role === "executor").map((c) => c.model)])];
  const chips = [
    coordinator ? chip("Coordinator", coordinator) : null,
    ...executors.map((id) => chip(single ? "Single model" : TIER_ROLE[state.models[id]?.tier] ?? "Executor", id)),
  ].filter(Boolean);
  return chips.length ? el("div", { class: "chips" }, chips) : null;
}

/** The inspector's facts about the run: which request, which setup, what it proved. */
function detailsCard(run, view, report) {
  const kind = requestKind(view.started.request);
  const holdout = report?.holdout?.find((c) => c.name === "holdout-tests");
  const rows = [
    ["Request", kind === "demo" ? "Demo · verified" : kind === "own" ? "Your own · not holdout-verified" : "unknown"],
    ["Preset", view.started.preset ?? "?"],
    ["Model API", dataSource(view.started.endpoint)[0]],
    ["Holdout", holdout ? `${holdout.testsPassed ?? "?"} / ${holdout.testsRun ?? "?"} passed` : report ? "not run" : "after the run"],
    ["Duration", runSpan(view) ?? (view.finished ? "unknown" : "running")],
    ["Run", run],
  ];
  return card("Run details", el("dl", { class: "kv details" }, rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", { title: v }, v)])));
}

const ARM_NAME = { a: "Arm A · one strong model", b: "Arm B · strong everywhere", c: "Arm C · routed" };

/** A run's line in the list: the user's name for it, else experiment arm, kind of request, or probe; then its preset. */
function runName(r) {
  if (r.kind === "probe") return "Connectivity probe";
  if (r.name) return r.name;
  const arm = /^exp-.*-([abc])\d+$/i.exec(r.id)?.[1]?.toLowerCase();
  if (arm) return ARM_NAME[arm];
  const kind = requestKind(r.request);
  return `${kind ? KIND_LABEL[kind] : r.mode === "single-model" ? "Single model" : "Meta"} · ${r.preset ?? "?"}`;
}

/** Stroked icons for the task timeline and check chips. */
const ICON_PATH = { x: "M6 6l12 12M18 6 6 18", check: "m5 12 5 5 9-10", arrow: "M4 12h12M12 6l6 6-6 6", dot: "M12 12h.01" };

/** One of ICON_PATH as an inline SVG; like the magnifier, built in the SVG namespace. */
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  // The dot is a zero-length line, drawn round by a wide stroke.
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": name === "dot" ? "8" : "3", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICON_PATH[name]);
  svg.append(path);
  return svg;
}

/** A magnifier; SVG needs its own namespace, which el() does not set. */
function searchIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "11");
  circle.setAttribute("cy", "11");
  circle.setAttribute("r", "7");
  const handle = document.createElementNS(ns, "path");
  handle.setAttribute("d", "m20 20-3.5-3.5");
  svg.append(circle, handle);
  return svg;
}

/** "6:23 PM" for today, "Nov 4 · 6:23 PM" otherwise. */
function shortWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

/** The run list's filter; the same input node across refreshes keeps typing and focus. */
function searchBox() {
  if (!state.searchNode) {
    const input = el("input", { type: "search", class: "search-input", placeholder: "Search runs", "aria-label": "Search runs", value: state.search });
    input.addEventListener("input", () => {
      state.search = input.value;
      if (state.view === "run" && state.last) renderRun(...state.last);
    });
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    state.searchNode = el("label", { class: "search" }, searchIcon(), input, el("kbd", {}, mac ? "⌘K" : "Ctrl K"));
  }
  return state.searchNode;
}

function historyColumn() {
  const query = state.search.trim().toLowerCase();
  const matches = (r) => !query || [runName(r), r.id, r.status, r.preset, r.request].some((v) => typeof v === "string" && v.toLowerCase().includes(query));
  const runs = state.runs.filter(matches).slice(0, 60);
  // Runs from the page or `run`, experiment runs, then connectivity probes.
  const groups = [
    ["Runs", runs.filter((r) => r.kind !== "probe" && !r.id.startsWith("exp-"))],
    ["Experiments", runs.filter((r) => r.kind !== "probe" && r.id.startsWith("exp-"))],
    ["Probes", runs.filter((r) => r.kind === "probe")],
  ].filter(([, list]) => list.length);
  const item = (r) => {
    const dot = r.kind === "probe" ? "" : r.status === "running" ? "running" : STATUS_CLASS[r.status] ?? "";
    return el("li", {}, el("button", { type: "button", "aria-current": String(r.id === state.runId), title: r.id, onclick: () => openRun(r.id) },
      el("span", { class: "t" }, el("span", { class: `dot ${dot}` }), el("span", { class: "name" }, runName(r)),
        el("span", { class: "c num" }, r.costUsd !== null ? usd(r.costUsd) : "")),
      el("span", { class: "s num" }, [shortWhen(r.startedAt) || r.id, r.kind === "probe" ? null : r.status,
        r.endpoint && isLocalApi(r.endpoint) ? "rehearsal" : r.endpoint && !REAL_APIS.has(r.endpoint) ? "unknown API" : null].filter(Boolean).join(" · "))));
  };
  return el("aside", { class: "history glass", "aria-label": "Runs" },
    el("div", { class: "workspace" },
      el("div", {}, el("b", {}, "Repod"), el("small", {}, "sample library")),
      state.sourceKind ? el("span", { class: "pill kind" }, state.sourceKind === "replay" ? "Replay" : "Live") : null),
    searchBox(),
    groups.length
      ? groups.flatMap(([label, list]) => [
          el("div", { class: "group-label" }, el("span", {}, label), el("span", { class: "num" }, list.length)),
          el("ul", { class: "runs" }, list.map(item)),
        ])
      : empty(state.runs.length ? "No run matches." : "No runs yet."),
    state.source ? el("p", { class: "note" }, state.source) : null);
}

/**
 * The run's title (from its request), state and kind of request, then when
 * it ran, how long, how many calls, and which models it used. The status
 * reads "waiting for you" while Meta waits on this page.
 */
function runHead(run, view, report, status, planned) {
  if (!view.started) return el("div", { class: "run-head" }, el("h1", { class: "run-name" }, "Connectivity probe"), el("span", { class: "note" }, run));
  const single = report?.mode === "single-model";
  const kind = requestKind(view.started.request);
  const took = runSpan(view);
  return el("div", { class: "run-head" },
    el("h1", { class: "run-name", title: view.started.request }, view.started.name || requestTitle(view.started.request)),
    statusText(status),
    kind ? el("span", { class: `pill kind ${kind}` }, kind === "demo" ? "Demo request · verified" : "Your own request") : null,
    el("div", { class: "meta-row num" }, [
      when(view.started.ts),
      took,
      plural(view.calls.length, "model call"),
      `${single ? "Single model" : "Meta"} · ${view.started.preset} preset`,
    ].filter(Boolean).map((text) => el("span", {}, text))),
    sourceNote(view.started.endpoint),
    modelChips(view, planned, single));
}

// ---- overview ----------------------------------------------------------------------

/** The answer first: the acceptance summary, how the work was routed, and Meta's summary. */
function overviewPanel(view, report, planned, status, waiting, ours) {
  const session = state.session;
  const summary = report?.summary?.message ?? view.finished?.summary;
  const outcome = outcomeDetails(report);
  return [
    report ? acceptance(report)
      : el("p", { class: "note" }, waiting ? "Meta is waiting for you on the Conversation tab."
        : status === "running" ? "The result appears here when the run finishes. Meanwhile, follow it on the Tasks tab."
        : "This run has no report."),
    planned.length ? routeBlock(view, report, planned) : null,
    summary || outcome.length
      ? el("div", { class: "block card-block outcome" },
          el("div", { class: "block-head" }, el("h2", {}, summary ? "Meta's summary" : "Outcome"),
            summary ? el("span", { class: "note" }, "Written by the coordinator; figures come from checks") : null),
          el("div", { class: "card-body" }, summary ? el("p", { class: "request" }, summary) : null, outcome))
      : null,
    ours && session.state === "failed" ? el("p", { class: "error" }, `The run failed: ${session.error}`) : null,
  ];
}

/** One line per task: the model it ran on (with any escalation), its result and cost. A line opens the task. */
function routeBlock(view, report, planned) {
  return el("div", { class: "block card-block" },
    el("div", { class: "block-head" },
      el("h2", {}, report?.mode === "single-model" ? "The single model's task" : "How Meta routed the work"),
      el("span", { class: "note" }, "Select a task to see its attempts")),
    el("div", { class: "route-list" },
      el("div", { class: "route-row route-head", "aria-hidden": "true" },
        el("span", {}, "Task"), el("span", {}, "Model"), el("span", { class: "labels" }, "Labels"), el("span", {}, "Result"), el("span", { class: "cost" }, "Cost")),
      planned.map((t) => {
        const progress = taskProgress(view, report, t);
        // The task id stays in the tooltip; the row reads as the plan's title and Meta's reason.
        return el("button", { type: "button", class: "route-row", title: t.id, onclick: () => showTab("tasks", t.id) },
          el("span", { class: "cell task-cell" }, el("span", { class: "title" }, t.title),
            t.reason ? el("span", { class: "why" }, t.reason) : null),
          el("span", { class: "cell" }, modelRoute(t, progress, true)),
          el("span", { class: "meta labels" }, `${t.complexity} · ${t.impact}`),
          el("span", { class: "meta" }, resultPill(progress)),
          el("span", { class: "num cost" }, progress.costUsd !== null ? usd(progress.costUsd) : ""));
      })));
}

/**
 * "Passed", "Passed · 1 repair", "Failed · escalated": the status, then what
 * the decisions after failed attempts were. Without decisions (older runs),
 * extra attempts are counted instead.
 */
function resultPill(progress) {
  const decisions = progress.timeline.filter((x) => x.kind === "decision");
  const repairs = decisions.filter((d) => d.decision === "repair").length;
  const escalated = decisions.some((d) => d.decision === "escalate");
  const extra = decisions.length
    ? [repairs ? plural(repairs, "repair") : null, escalated ? "escalated" : null]
    : [progress.attempts > 1 ? plural(progress.attempts, "attempt") : null];
  const status = String(progress.status);
  return el("span", { class: `status ${STATUS_CLASS[status] ?? ""}` },
    [status.charAt(0).toUpperCase() + status.slice(1), ...extra].filter(Boolean).join(" · "));
}

// ---- conversation -----------------------------------------------------------------

/** "Muse Spark Open" from "meta/muse-spark-open"; sizes such as "30b" in capitals. */
function modelName(id) {
  return String(id ?? "").split("/").pop().split("-")
    .map((w) => (/^\d+b$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

/**
 * The dialogue only: the request, Meta's questions and plans, the user's
 * answers and decisions. The plan (the one under decision, else the approved
 * one) sits inside Meta's last plan message, as Meta proposed it.
 */
function conversationPanel(view, report, ours) {
  const session = state.session;
  const pending = ours && session.state === "waiting" ? session.pending : null;
  const planned = plannedTasks(view, report);
  const coordinator = view.calls.find((c) => c.role === "coordinator")?.model;
  const lastPlan = view.conversation.map((t) => t.from !== "user" && t.kind === "plan").lastIndexOf(true);
  const planBody = () => (pending?.kind === "plan"
    ? [planCard(pending.tasks), pending.warnings.map((w) => el("p", { class: "note raised" }, `Warning: ${w}`))]
    : planned.length ? planCard(planned) : null);

  const items = [message("user", "You", clock(view.started.ts), el("p", { class: "request" }, view.started.request))];
  view.conversation.forEach((turn, i) => {
    if (turn.from === "user" && turn.kind === "approval") {
      items.push(el("div", { class: "decision" }, `You approved the plan · ${clock(turn.ts)}`));
    } else if (turn.from === "user") {
      items.push(message("user", "You", clock(turn.ts), el("p", { class: "request" }, turn.text)));
    } else {
      items.push(message("meta", turn.kind === "plan" ? "Meta · plan" : "Meta", coordinator ? modelName(coordinator) : null,
        turn.text ? el("p", { class: "request" }, turn.text) : null,
        turn.questions?.length
          ? el("ul", { class: "questions" }, turn.questions.map((q) =>
              el("li", {}, q.question, el("div", { class: "note" }, [q.why, `Default: ${q.default}`].filter(Boolean).join(" · ")))))
          : null,
        i === lastPlan ? planBody() : null));
    }
  });

  // No plan message to hold the plan (arm A plans nothing): show it on its own.
  if (lastPlan < 0 && (pending?.kind === "plan" || planned.length)) {
    items.push(el("div", { class: "block" },
      el("h2", {}, report?.mode === "single-model" ? "The task (no planning in arm A)" : "Plan"), planBody()));
  } else if (lastPlan < 0 && !view.finished && !pending) {
    items.push(el("p", { class: "note" }, "Waiting for Meta..."));
  }
  if (view.finished) items.push(el("div", { class: "decision" }, `Run ${view.finished.status} · ${clock(view.finished.ts)}`));
  return el("div", { class: "thread" }, items);
}

/** A plan as a card: per task its id, title, order and files, and the model it goes to. */
function planCard(tasks) {
  return el("div", { class: "plan-card" }, tasks.map((t) => {
    const scope = [t.dependsOn?.length ? `After ${t.dependsOn.join(", ")}` : null, t.writeFiles?.length ? `writes ${t.writeFiles.join(", ")}` : null].filter(Boolean).join(" · ");
    return el("div", { class: "plan-row" },
      el("span", { class: "id", title: t.id }, t.id),
      el("div", { class: "plan-body" },
        el("span", { class: "title" }, t.title),
        scope ? el("span", { class: "note" }, scope.charAt(0).toUpperCase() + scope.slice(1)) : null,
        t.floorReason ? el("span", { class: "note raised" }, `Raised by the program: ${t.floorReason}`) : null),
      modelBadge(t.model, true));
  }));
}

/** A task's labels and scope in one row, then Meta's reason and any change the program made. */
function taskFacts(t, costUsd = null) {
  const fact = (label, value, cls = "") => el("span", {}, `${label} `, el("b", { class: cls }, value));
  return [
    el("div", { class: "facts" },
      fact("Complexity", t.complexity),
      fact("Impact", t.impact),
      costUsd !== null ? fact("Cost", usd(costUsd), "num") : null,
      t.dependsOn?.length ? fact("After", t.dependsOn.join(", ")) : null,
      t.writeFiles?.length ? fact("Writes", t.writeFiles.join(", "), "mono") : null),
    t.reason ? el("p", { class: "note" }, t.reason) : null,
    t.floorReason ? el("p", { class: "note raised" }, `Raised by the program: ${t.floorReason}`) : null,
  ];
}

/** The approved plan, from the ledger while the run goes, else from the report. */
function plannedTasks(view, report) {
  return view.plan?.tasks ?? (report?.plan ?? []).map((t) => ({
    id: t.id, title: t.title, type: t.type, complexity: t.complexity, impact: t.impact,
    model: t.model, requestedModel: t.model, floorReason: null, reason: t.reason, dependsOn: t.depends_on, writeFiles: t.write_files, checkGroups: t.check_groups,
  }));
}

/** How a task went so far: the report's outcome once written, else what its calls and status events say. */
function taskProgress(view, report, t) {
  const outcome = (report?.tasks ?? []).find((o) => o.taskId === t.id);
  const calls = view.calls.filter((c) => c.taskId === t.id);
  const executor = calls.filter((c) => c.role === "executor");
  const status = outcome?.status ?? view.tasks.get(t.id)?.status ?? "pending";
  return {
    status,
    model: outcome?.model ?? executor.at(-1)?.model ?? t.model,
    attempts: outcome?.attempts ?? executor.length,
    costUsd: pricedSum(calls),
    reason: outcome?.reason ?? (status !== "running" ? view.tasks.get(t.id)?.detail : null),
    timeline: view.timelines.get(t.id) ?? [],
  };
}

/** Sum of the priced calls; null when none has a price yet. */
function pricedSum(calls) {
  const priced = calls.filter((c) => typeof c.costUsd === "number");
  return priced.length ? priced.reduce((sum, c) => sum + c.costUsd, 0) : null;
}

// ---- tasks ------------------------------------------------------------------------

/** One line per task; a task opens to its reasons and its history of attempts and decisions. */
function tasksPanel(view, report, planned, waiting) {
  if (!planned.length) {
    return el("p", { class: "note" }, waiting ? "Tasks start once you approve the plan." : view.finished ? "No task ran." : "Waiting for Meta...");
  }
  return [el("div", { class: "tasks" }, planned.map((t) => taskCard(t, taskProgress(view, report, t)))), callsCard(view)];
}

/** The model a task was planned on, with an arrow to the one it ended on when it escalated. */
function modelRoute(t, progress, short = false) {
  const used = progress?.model ?? t.model;
  return used !== t.model
    ? el("span", { class: "route", title: "escalated to a stronger model" }, modelBadge(t.model, short), el("span", { class: "arrow" }, "→"), modelBadge(used, short))
    : modelBadge(t.model, short);
}

const DECISION_TEXT = { repair: "repair on", escalate: "escalate to", stop: "stop the task" };
// Check names as the pipeline records them, in words.
const CHECK_LABEL = { typecheck: "type check" };
const checkLabel = (name) => CHECK_LABEL[name] ?? String(name).replace(/-/g, " ");

/** One step on a task's timeline: a round node (its colour from cls), then the step. */
function timelineStep(cls, iconName, ...body) {
  return el("li", { class: `step ${cls}` },
    el("span", { class: "node", "aria-hidden": "true" }, icon(iconName)),
    el("div", { class: "step-body" }, ...body));
}

function taskCard(t, progress) {
  const key = `${state.runId}:${t.id}`;
  const decided = progress.timeline.some((x) => x.kind === "decision");
  // Open by default where there is something to follow: a decision after a
  // failure, or work in progress. A card the user toggled stays that way.
  const details = el("details", { class: "task", id: `task-${t.id}`, open: state.taskOpen.get(key) ?? (decided || progress.status === "running") },
    el("summary", {},
      el("span", { class: "id" }, t.id),
      el("span", { class: "cell" }, el("span", { class: "title" }, t.title), modelRoute(t, progress)),
      el("span", { class: "state" }, statusText(progress.status),
        progress.attempts
          ? el("span", { class: "note num" }, `${plural(progress.attempts, "attempt")}${progress.costUsd !== null ? ` · ${usd(progress.costUsd)}` : ""}`)
          : null)),
    el("div", { class: "task-body" },
      taskFacts(t, progress.costUsd),
      progress.reason ? el("p", { class: "note" }, progress.reason) : null,
      progress.timeline.length
        ? el("ol", { class: "timeline", "aria-label": "Attempts and decisions" }, progress.timeline.map((step, i, steps) =>
            step.kind === "attempt" ? attemptStep(step, steps[i + 1], progress, i === steps.length - 1) : decisionStep(step)))
        : null));
  details.addEventListener("toggle", () => state.taskOpen.set(key, details.open));
  return details;
}

function attemptStep(attempt, next, progress, last) {
  const running = last && attempt.calls.some((c) => c.outcome === null);
  // The failure comes from the decision that followed; the last attempt's
  // result is the task's own status. The class colours the attempt's node.
  const outcome = next?.kind === "decision" ? "bad" : running ? "live" : last ? STATUS_CLASS[progress.status] ?? "" : "";
  const result = next?.kind === "decision" ? next.failure : running ? "running" : last ? progress.status : null;
  const cost = pricedSum(attempt.calls);
  const aside = [result, cost !== null ? usd(cost) : null].filter(Boolean).join(" · ");
  return timelineStep(outcome, outcome === "bad" ? "x" : outcome === "ok" ? "check" : "dot",
    el("div", { class: "step-head" }, `Attempt ${attempt.n}`, modelBadge(attempt.model, true),
      aside ? el("span", { class: "aside num" }, aside) : null),
    attempt.checks.length
      ? el("div", { class: "checks" }, attempt.checks.map((c) =>
          el("span", { class: `ck ${c.passed ? "ok" : "bad"}`, title: `${checkLabel(c.check)} ${c.passed ? "passed" : "failed"}` },
            icon(c.passed ? "check" : "x"),
            `${checkLabel(c.check)}${typeof c.testsRun === "number" ? ` · ${c.testsRun}` : ""}`,
            el("span", { class: "visually-hidden" }, c.passed ? " passed" : " failed"))))
      : null);
}

/** "Meta decided: repair on the same model", or an escalation with the model it moves to; then the reason. */
function decisionStep(d) {
  const sameModel = d.decision === "repair" && (!d.toModel || d.toModel === d.fromModel);
  const what = sameModel ? "repair on the same model" : DECISION_TEXT[d.decision];
  const chip = !sameModel && d.decision !== "stop" && d.toModel ? modelBadge(d.toModel, true) : null;
  return timelineStep(`decided ${d.by}`, d.decision === "stop" ? "x" : "arrow",
    el("div", { class: "step-head" }, `${d.by === "meta" ? "Meta" : "The program"} decided: ${what}`, chip,
      d.call && typeof d.call.costUsd === "number" ? el("span", { class: "aside num" }, usd(d.call.costUsd)) : null),
    d.requested ? el("p", { class: "note raised" }, `Meta chose ${d.requested}, which the limits did not allow here`) : null,
    d.reason ? el("div", { class: "reason-box" }, el("b", {}, "Reason"), ` · ${d.reason}`) : null);
}

// ---- what the run delivered ---------------------------------------------------------

/** The acceptance summary, computed from the report (not Meta's words). */
function acceptance(report) {
  const tasks = report.tasks ?? [];
  const passed = tasks.filter((t) => t.status === "passed").length;
  const integrated = report.finalChecks ?? [];
  const integratedFailed = integrated.filter((c) => !c.passed).length;
  const holdout = report.holdout?.find((c) => c.name === "holdout-tests");
  const blocking = (report.findings ?? []).filter((f) => f.severity === "blocking").length;
  // Each line is judged on its own: one green status must not stand for all of them.
  const rows = [
    ["Tasks", `${passed} of ${tasks.length} passed`, tasks.length > 0 && passed === tasks.length],
    ["Integrated checks", integrated.length ? (integratedFailed ? `${integratedFailed} of ${integrated.length} failed` : `${integrated.length} passed`) : "not run", integrated.length ? !integratedFailed : null],
    ["Holdout tests", holdout
      ? `${holdout.testsPassed ?? "?"} of ${holdout.testsRun ?? "?"} passed${report.frozenIntact === false ? ", not valid: files changed while they ran" : ""}`
      : "not run", holdout ? holdout.passed && report.frozenIntact !== false : null],
    ["Blocking review findings", report.mode === "single-model" ? "no review (arm A)" : blocking ? String(blocking) : "none", blocking ? false : null],
  ];
  // The tile's big figure; the line under it keeps the full wording above.
  const figures = [
    tasks.length ? `${passed} / ${tasks.length}` : "–",
    integrated.length ? `${integrated.length - integratedFailed} / ${integrated.length}` : "–",
    holdout ? `${holdout.testsPassed ?? "?"} / ${holdout.testsRun ?? "?"}` : "–",
    report.mode === "single-model" ? "–" : String(blocking),
  ];
  return el("div", { class: "acceptance" }, rows.map(([label, value, ok], i) =>
    el("div", { class: "stat" },
      el("div", { class: "note" }, label),
      el("div", { class: "stat-figure num" }, figures[i]),
      el("div", { class: `stat-value status ${ok === true ? "ok" : ok === false ? "bad" : ""}` }, value))));
}

function changesList(changes, files) {
  if (!changes) return el("p", { class: "note" }, "No changes recorded for this run (it was written before the viewer kept them).");
  if (!changes.diff) return el("p", { class: "note" }, "No changes were kept.");
  // Visible tests the program copied in for the checks are not the model's work.
  const provided = new Set(changes.provided ?? []);
  const shown = files.map((f) => (provided.has(f.path) ? { ...f, status: "test provided by Repod" } : f));
  const providedCount = shown.filter((f) => provided.has(f.path)).length;
  return el("div", { class: "files" },
    el("p", { class: "note" }, [
      `${plural(shown.length, "file")} changed${providedCount ? `, ${providedCount} of them tests Repod provided for the checks` : ""}.`,
      changes.frozen ? "Frozen: the version the final checks and holdout ran on." : "Not frozen: the holdout did not check these changes.",
      changes.truncated ? "The diff was cut at 200 KB." : null,
    ].filter(Boolean).join(" ")),
    shown.map(fileDiff));
}

/** Splits a git diff into files with their status and added/removed line counts. */
function diffFiles(diff) {
  const files = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (head) {
      files.push({ path: head[2], status: "modified", added: 0, removed: 0, lines: [] });
      inHunk = false;
      continue;
    }
    const file = files.at(-1);
    if (!file) continue;
    file.lines.push(line);
    // Header lines come before the first hunk; inside hunks "+++" can be content.
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk && line.startsWith("new file mode")) file.status = "added";
    else if (!inHunk && line.startsWith("deleted file mode")) file.status = "deleted";
    else if (inHunk && line.startsWith("+")) file.added++;
    else if (inHunk && line.startsWith("-")) file.removed++;
  }
  return files;
}

function fileDiff(file) {
  const body = el("pre", { class: "diff" });
  const details = el("details", { class: "file" },
    el("summary", {}, el("span", { class: "mono path" }, file.path), el("span", { class: `tag ${file.status === "added" ? "new" : ""}` }, file.status),
      el("span", { class: "delta num" }, el("span", { class: "add" }, `+${file.added}`), el("span", { class: "del" }, `\u2212${file.removed}`))),
    body);
  // Filled on first open: a large diff costs nothing until someone reads it.
  details.addEventListener("toggle", () => {
    if (!details.open || body.childElementCount) return;
    let inHunk = false;
    body.append(...file.lines.map((line) => {
      if (line.startsWith("@@")) inHunk = true;
      const kind = line.startsWith("@@") ? "hunk" : !inHunk ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
      return el("span", { class: kind }, line || " ");
    }));
  });
  return details;
}

function outcomeDetails(report) {
  if (!report) return [];
  return [
    report.problems?.length ? el("ul", { class: "problems" }, report.problems.map((p) => el("li", {}, p))) : null,
    report.pendingCheckGroups?.length ? el("p", { class: "note" }, `Not verified: ${report.pendingCheckGroups.join(", ")}`) : null,
    report.findings?.length
      ? el("ul", { class: "findings" }, report.findings.map((f) => el("li", {},
          el("span", { class: `sev ${f.severity}` }, f.severity.replace(/_/g, " ")),
          el("span", { title: f.taskId }, el("span", { class: "mono" }, f.file), ` · ${f.evidence}`))))
      : null,
  ].filter(Boolean);
}

/** What Meta is waiting for: answers to its questions, or a decision on its plan. */
function actionForm(run, pending) {
  const key = `${run}:${JSON.stringify(pending)}`;
  if (state.action.key === key) return state.action.node; // keep what the user is typing
  const errorLine = el("p", { class: "error", hidden: true });
  const submit = async (action, body, buttons) => {
    buttons.forEach((b) => (b.disabled = true));
    errorLine.hidden = true;
    try {
      await act(action, body);
      state.action = { key: null, node: null };
      await refresh();
    } catch (error) {
      errorLine.textContent = error.message;
      errorLine.hidden = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  const title = (text) => el("div", { class: "action-title" }, el("span", { class: "dot turn" }), text);

  let node;
  if (pending.kind === "questions") {
    const inputs = pending.questions.map((q) => el("input", { type: "text", class: "input", name: q.id, placeholder: q.default, "aria-label": q.question }));
    const send = el("button", { type: "submit", class: "btn primary" }, "Send answers");
    node = el("form", { class: "action" },
      title("Your answers"),
      pending.questions.map((q, i) => el("label", { class: "field" }, el("span", {}, q.question), inputs[i])),
      el("p", { class: "note" }, "An empty answer uses the default shown in the box."),
      el("div", { class: "buttons" }, send), errorLine);
    node.addEventListener("submit", (e) => {
      e.preventDefault();
      submit("answers", { answers: Object.fromEntries(inputs.map((i) => [i.name, i.value])) }, [send]);
    });
  } else {
    const feedback = el("textarea", { class: "input", rows: 2, placeholder: "What should change in the plan? (one revision)", "aria-label": "Feedback on the plan" });
    const approve = el("button", { type: "button", class: "btn primary" }, "Approve plan");
    const revise = el("button", { type: "button", class: "btn" }, "Send back");
    const stop = el("button", { type: "button", class: "btn quiet" }, "Stop run");
    const buttons = pending.canRevise ? [approve, revise, stop] : [approve, stop];
    approve.addEventListener("click", () => submit("review", { action: "approve" }, buttons));
    revise.addEventListener("click", () => submit("review", { action: "revise", feedback: feedback.value }, buttons));
    stop.addEventListener("click", () => submit("review", { action: "stop" }, buttons));
    node = el("div", { class: "action" },
      title("Your decision on the plan"),
      pending.canRevise ? feedback : el("p", { class: "note" }, "The plan was sent back once already; approve it or stop the run."),
      el("div", { class: "buttons" }, buttons), errorLine);
  }
  state.action = { key, node };
  return node;
}

// ---- dashboard -------------------------------------------------------------------------

function costCard(view, report) {
  const total = runCost(view, report);
  const unknown = view.calls.filter((c) => c.outcome !== null && c.costUsd === null).length;
  const phases = report?.costByPhase ? Object.entries(report.costByPhase) : [];
  return card(
    "Cost at list price",
    el("div", { class: "metric num" }, usd(total)),
    el("p", { class: "note" }, `${plural(view.calls.length, "model call")}${unknown ? `, ${unknown} with unknown cost (billed at their reservation)` : ""}${view.refused.length ? `, ${view.refused.length} refused by the budget` : ""}`),
    phases.length ? phaseStack(phases) : null,
    phases.length
      ? el("dl", { class: "kv num legend" }, phases.flatMap(([phase, value]) => [
          el("dt", {}, el("i", { class: `ph ph-${phase}`, "aria-hidden": "true" }), phase), el("dd", {}, usd(value))]))
      : null,
  );
}

/** One bar split by cost phase; widths through the DOM, which the strict CSP allows. A phase with unknown cost is left out. */
function phaseStack(phases) {
  const known = phases.filter(([, v]) => typeof v === "number" && v > 0);
  const total = known.reduce((sum, [, v]) => sum + v, 0);
  if (!total) return null;
  return el("div", { class: "stack", "aria-hidden": "true" }, known.map(([phase, v]) => {
    const part = el("i", { class: `ph ph-${phase}` });
    part.style.width = `${((v / total) * 100).toFixed(1)}%`;
    return part;
  }));
}

const ARM_LABEL = { A: "One strong model (arm A)", B: "Meta, quality preset (arm B)", C: "Meta, saving preset (arm C)" };

/**
 * Routed runs against one strong model, from the newest formal experiment
 * (the newest of any label when there is none); never estimated. The note
 * says where the figures come from and how many runs they rest on.
 */
function compareCard(view, report) {
  const usable = state.experiments.filter((x) => x.arms?.filter((a) => a.costUsd).length >= 2);
  const experiment = usable.find((x) => x.label === "formal") ?? usable[0];
  if (!experiment) {
    return card("Versus one strong model",
      empty("No comparison yet."),
      el("p", { class: "note" }, "Run ", el("code", {}, "npm run repod -- experiment --holdout <dir>"), " to measure routed runs against one strong model."));
  }
  const arms = experiment.arms.filter((a) => a.costUsd);
  const max = Math.max(...arms.map((a) => a.costUsd.median), 0.000001);
  const total = runCost(view, report);
  return card("Versus one strong model",
    el("div", { class: "compare" }, arms.map((a) => el("div", {},
      el("div", { class: "label" }, el("span", {}, ARM_LABEL[a.arm] ?? `Arm ${a.arm}`), el("span", { class: "num" }, usd(a.costUsd.median))),
      bar(a.costUsd.median / max, a.arm === "A" ? "tier-strong" : "", true),
      el("div", { class: "note num" }, `holdout pass rate ${a.holdoutPassRate ? pct(a.holdoutPassRate.median) : "–"} · ${plural(a.runs, "run")}`)))),
    el("p", { class: "note" }, `Medians from experiment ${experiment.label} (${when(experiment.startedAt)}).${report?.mode !== "single-model" && total !== null ? ` This run: ${usd(total)}.` : ""}`),
    experimentCaveats(experiment, view.started?.endpoint));
}

/** What limits an experiment's figures: its source, its label, its sample size. */
function experimentCaveats(x, runEndpoint = undefined) {
  const fewest = Math.min(...(x.arms ?? []).map((a) => a.runs));
  return [
    sourceNote(x.endpoint, "Data: "),
    x.label === "formal" ? null : el("p", { class: "note raised" }, `Label "${x.label}", not "formal": a check of the pipeline, not a reported result.`),
    Number.isFinite(fewest) && fewest < 3 ? el("p", { class: "note raised" }, `${plural(fewest, "run")} in the smallest arm: too few for a stable median.`) : null,
    runEndpoint && x.endpoint && runEndpoint !== x.endpoint ? el("p", { class: "note raised" }, "This run and the experiment called different model APIs.") : null,
  ];
}

function callsCard(view) {
  const calls = [...view.calls].reverse().slice(0, 40);
  const details = el("details", { class: "block", open: state.callsOpen },
    el("summary", {}, `Model calls · ${view.calls.length}`),
    calls.length
      ? el("ul", { class: "list" }, calls.map((c) =>
          el("li", {},
            el("span", {}, el("span", { class: "muted" }, `${c.role}${c.taskId ? ` · ${c.taskId}` : ""} `), modelBadge(c.model)),
            el("span", { class: "num" }, c.outcome === null ? "in progress" : `${c.outcome} · ${usd(c.costUsd)}`))))
      : empty("No calls yet."));
  details.addEventListener("toggle", () => (state.callsOpen = details.open));
  return details;
}

// ---- experiments view -----------------------------------------------------------

const range = (s, format) => (s ? `${format(s.median)} (${format(s.min)}–${format(s.max)})` : "–");

function renderExperiments(experiments) {
  if (!experiments?.length) {
    render([card("Experiments", el("p", { class: "empty" }, "No experiment results yet. Run ", el("code", {}, "npm run repod -- experiment --holdout <dir>"), "."))]);
    return;
  }
  render([column("", experiments.map((x) => card(
    null,
    el("div", { class: "exp-head" }, el("h2", {}, `${x.label}: ${x.experimentId}`), statusText(x.stoppedEarly ? "stopped early" : "completed")),
    x.stoppedEarly ? el("p", { class: "note" }, x.stoppedEarly) : null,
    el("p", { class: "note" }, `Started ${when(x.startedAt)} · source ${x.sourceCommit ?? "unknown"} · median (min–max)`),
    experimentCaveats(x),
    el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Arm", "Runs", "Completed", "Holdout fully passed", "Holdout pass rate", "Cost", "Wall time"].map((h, i) => el("th", { class: i > 0 ? "num" : null }, h)))),
      el("tbody", {}, x.arms.map((a) => el("tr", {},
        el("td", {}, ARM_LABEL[a.arm] ?? a.arm),
        el("td", { class: "num" }, a.runs),
        el("td", { class: "num" }, a.completed),
        el("td", { class: "num" }, a.holdoutAllPassed),
        el("td", { class: "num" }, range(a.holdoutPassRate, pct)),
        el("td", { class: "num" }, range(a.costUsd, usd) + (a.costUnknownRuns ? ` + ${a.costUnknownRuns} unknown` : "")),
        el("td", { class: "num" }, range(a.wallMs, (n) => `${Math.round(n / 1000)} s`))))))),
    el("details", {},
      el("summary", {}, `Runs · ${x.runs.length}`),
      el("ul", { class: "list" }, x.runs.map((r) => el("li", {},
        el("button", { type: "button", class: "link", onclick: () => openRun(r.runId) }, `${r.arm} · round ${r.round} · ${r.runId}`),
        el("span", { class: "num" }, `${r.status} · holdout ${r.holdoutRan ? `${r.holdoutTestsPassed ?? "?"}/${r.holdoutTestsExpected ?? r.holdoutTestsRun ?? "?"}` : "not run"} · ${usd(r.costUsd)}`))))),
  )))]);
}

// ---- new run: a panel over the page -------------------------------------------------

/** The New run panel and its backdrop, built once; the run behind it keeps updating while it is open. */
function sheet() {
  if (!state.sheet) {
    const scrim = el("div", { class: "scrim", hidden: true, onclick: () => closeNewRun() });
    const body = el("div", { class: "sheet-body" });
    const panel = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "sheet-title", hidden: true },
      el("div", { class: "sheet-head" },
        el("h2", { id: "sheet-title" }, "New run"),
        el("button", { type: "button", class: "btn quiet", "aria-label": "Close", onclick: () => closeNewRun() }, "Esc")),
      body);
    document.body.append(scrim, panel);
    state.sheet = { scrim, panel, body };
  }
  return state.sheet;
}

async function openNewRun() {
  if (!state.session) return;
  state.session = (await fetchJson("data/session.json")) ?? state.session;
  const s = sheet();
  s.body.replaceChildren(newRunForm());
  s.scrim.hidden = false;
  s.panel.hidden = false;
  s.panel.querySelector("input")?.focus();
}

function closeNewRun() {
  const s = state.sheet;
  if (!s || s.panel.hidden) return;
  s.scrim.hidden = true;
  s.panel.hidden = true;
  document.getElementById("new-run")?.focus();
}

/** The form inside the panel: which request, which preset, then start. */
function newRunForm() {
  const session = state.session;
  const busy = ["starting", "running", "waiting"].includes(session.state);
  const start = el("button", { type: "submit", class: "btn primary", disabled: busy }, "Start run");
  const errorLine = el("p", { class: "error", hidden: true });

  // Two kinds of request on the same sample library. Only the demo request has
  // the contract, visible tests and holdout tests written for it; a request of
  // your own is judged by the type check and the library's existing tests.
  // An optional name for the list and the run's header; the server keeps one short line.
  const name = el("input", { type: "text", class: "input", maxlength: 80, autocomplete: "off", placeholder: "For example: retry test with the cheap model", "aria-label": "Run name" });
  const own = el("textarea", { class: "input", rows: 4, maxlength: 4000, placeholder: "Describe a change to the sample library, for example: add a function that counts tasks by priority, export it and test it.", "aria-label": "Your request" });
  const demoChoice = el("input", { type: "radio", name: "request-kind", value: "demo", checked: true });
  const ownChoice = el("input", { type: "radio", name: "request-kind", value: "own" });
  const demoPart = el("div", { class: "start-part" },
    el("div", { class: "request-box" }, session.request),
    el("p", { class: "note" }, "Checked by its visible tests and, when the page was started with --holdout, by hidden holdout tests."));
  const ownPart = el("div", { class: "start-part", hidden: true },
    own,
    el("p", { class: "note raised" }, "Not verified by holdout tests: only the type check and the library's own tests judge the result. Runs on the same sample library."));
  const showKind = () => {
    demoPart.hidden = !demoChoice.checked;
    ownPart.hidden = !ownChoice.checked;
  };
  demoChoice.addEventListener("change", showKind);
  ownChoice.addEventListener("change", showKind);

  // Presets as a segmented control, each explained by its description in config/.
  let preset = session.presets.includes("saving") ? "saving" : session.presets[0];
  const help = el("p", { class: "note seg-help" });
  const segments = session.presets.map((p) => el("button", { type: "button", "aria-pressed": "false" }, p));
  const pick = (p) => {
    preset = p;
    segments.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === p)));
    help.textContent = session.presetInfo?.[p] ?? "";
  };
  segments.forEach((b) => b.addEventListener("click", () => pick(b.textContent)));
  pick(preset);

  const choice = (input, title, text) => el("label", { class: "choice card-choice" }, input, el("span", {}, el("b", {}, title), el("span", { class: "note" }, text)));
  const form = el("form", { class: "start-form" },
    el("label", { class: "field" }, el("span", {}, "Name ", el("span", { class: "note" }, "optional")), name),
    el("div", { class: "field" }, el("span", {}, "Request"),
      el("div", { class: "choices", role: "radiogroup", "aria-label": "Request" },
        choice(demoChoice, "Demo request", "Verified: its contract, visible tests and hidden holdout tests apply."),
        choice(ownChoice, "Your own request", "On the same sample library; judged by the type check and its existing tests only."))),
    demoPart,
    ownPart,
    el("div", { class: "field" }, el("span", {}, "Preset"), el("div", { class: "seg", role: "group", "aria-label": "Preset" }, segments), help),
    busy ? el("p", { class: "row" }, "A run started from this page is in progress.",
      el("button", { type: "button", class: "link", onclick: () => { closeNewRun(); openRun(session.runId); } }, "Open it")) : null,
    el("div", { class: "sheet-foot" },
      el("span", { class: "note raised" }, "Costs real money: billed to the key in MODEL_API_KEY, within config/limits.json."),
      start),
    errorLine);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = own.value.trim();
    if (ownChoice.checked && !text) {
      errorLine.textContent = "Write your request first, or choose the demo request.";
      errorLine.hidden = false;
      return;
    }
    start.disabled = true;
    errorLine.hidden = true;
    try {
      const label = name.value.trim();
      const { runId } = await act("start", {
        preset,
        ...(ownChoice.checked ? { request: text } : {}),
        ...(label ? { name: label } : {}),
      });
      state.runs = (await fetchJson("data/runs.json")) ?? state.runs;
      fillPicker();
      closeNewRun();
      openRun(runId);
    } catch (error) {
      errorLine.textContent = error.message;
      errorLine.hidden = false;
      start.disabled = false;
    }
  });
  return form;
}

// ---- navigation and polling --------------------------------------------------------

async function loadRun(runId, wasLive = false) {
  clearTimeout(state.timer);
  state.runId = runId;
  if (!runId) {
    setLive(null);
    setCrumbs("Runs");
    render([card("Runs", state.session
      ? empty("No runs recorded yet. Start one from New run.")
      : el("p", { class: "empty" }, "No runs recorded yet. Start one with ", el("code", {}, "npm run repod -- run"), "."))]);
    return;
  }
  const base = `data/runs/${encodeURIComponent(runId)}/`;
  if (state.session?.enabled) state.session = (await fetchJson("data/session.json")) ?? state.session;
  const events = parseEvents(await fetchText(`${base}events.jsonl`));
  const finished = events.some((e) => e.type === "run_finished") || !events.some((e) => e.type === "run_started");
  const report = finished ? await fetchJson(`${base}report.json`) : null;
  if (state.runId !== runId || state.view !== "run") return; // the user moved on meanwhile
  // While Meta waits for the user nothing changes; re-rendering then would
  // only disturb typing.
  const renderKey = JSON.stringify([runId, events.length, Boolean(report), state.session?.state, state.session?.runId, state.session?.pending, state.runs.length]);
  if (state.rendered !== renderKey) {
    renderRun(runId, events, report);
    state.rendered = renderKey;
  }
  if (!finished) {
    state.timer = setTimeout(() => loadRun(runId, true), POLL_MS);
  } else if (wasLive) {
    // The run just finished: its entry in the run list still says "running".
    state.runs = (await fetchJson("data/runs.json")) ?? state.runs;
    fillPicker();
    renderRun(runId, events, report);
  }
}

function openRun(runId) {
  setView("run");
  document.getElementById("run-picker").value = runId;
  location.hash = `run=${encodeURIComponent(runId)}`;
  loadRun(runId);
}

async function setView(view) {
  state.view = view;
  clearTimeout(state.timer);
  for (const tab of document.querySelectorAll(".tab")) tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
  document.getElementById("run-picker").hidden = view !== "run";
  if (view === "run") return;
  if (state.session) state.session = (await fetchJson("data/session.json")) ?? state.session;
  liveFromSession();
  if (view === "experiments") {
    setCrumbs("Experiments");
    state.experiments = (await fetchJson("data/experiments.json")) ?? state.experiments;
    renderExperiments(state.experiments);
  }
}

/** Reloads the current run at once, after the user answered. */
function refresh() {
  return state.view === "run" ? loadRun(state.runId, true) : Promise.resolve();
}

function fillPicker() {
  const picker = document.getElementById("run-picker");
  picker.replaceChildren(...state.runs.map((r) =>
    el("option", { value: r.id }, `${r.name ? `${r.name} · ` : ""}${r.id} · ${r.kind === "probe" ? "probe" : r.status}${r.costUsd !== null ? ` · ${usd(r.costUsd)}` : ""}`)));
  if (state.runId) picker.value = state.runId;
}

/** Light or dark: follows the system until the user picks one here; the choice is kept per browser. */
function setupTheme() {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("repod-theme");
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the system setting applies.
  }
  document.getElementById("theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("repod-theme", root.dataset.theme);
    } catch {
      // Not kept across reloads then; the toggle still works for this page.
    }
  });
}

/**
 * Keys: Ctrl/Cmd+K focuses the run search (the picker where the list is
 * hidden), N opens New run when not typing, Esc closes it.
 */
function setupKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeNewRun();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const input = state.searchNode?.querySelector("input");
      if (input && input.offsetParent) input.focus();
      else document.getElementById("run-picker").focus();
      return;
    }
    const active = document.activeElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? "") || active?.isContentEditable;
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n" && state.session) {
      e.preventDefault();
      openNewRun();
    }
  });
}

async function init() {
  setupTheme();
  setupKeys();
  const [source, runs, models, session, experiments] = await Promise.all([
    fetchJson("data/source.json"), fetchJson("data/runs.json"), fetchJson("data/models.json"), fetchJson("data/session.json"), fetchJson("data/experiments.json"),
  ]);
  state.runs = runs ?? [];
  state.models = models ?? {};
  state.experiments = experiments ?? [];
  state.session = session?.enabled ? session : null;
  // The demo request's text: from the data source, else from the session.
  state.demoRequest = source?.demoRequest ?? state.session?.request ?? null;
  state.sourceKind = source?.source === "replay" ? "replay" : source ? "local" : null;
  if (state.session) {
    // Only an interactive server offers starting a run: the top bar's primary
    // button, which opens the New run panel over the page.
    document.getElementById("actions").append(el("button", { type: "button", class: "btn primary", id: "new-run", onclick: () => openNewRun() },
      "New run", el("kbd", {}, "N")));
  }
  state.source = source?.source === "replay" ? "Replay of recorded runs" : source ? `Live view of local runs (${source.runsDir})` : null;

  const fromHash = decodeURIComponent((location.hash.match(/run=([^&]+)/) ?? [])[1] ?? "");
  state.runId = state.runs.some((r) => r.id === fromHash) ? fromHash : state.runs.find((r) => r.kind === "run")?.id ?? state.runs[0]?.id ?? null;
  fillPicker();

  document.getElementById("run-picker").addEventListener("change", (e) => openRun(e.target.value));
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => (tab.dataset.view === "run" ? openRun(state.runId) : setView(tab.dataset.view)));
  }
  await loadRun(state.runId);
}

init().catch((error) => render([card("Could not load run data", el("p", {}, String(error)))]));
