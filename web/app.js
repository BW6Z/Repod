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
  callsOpen: false, // the collapsed call log stays as the user left it across refreshes
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

const STATUS_CLASS = { passed: "ok", completed: "ok", running: "live", failed: "bad", stopped: "bad", incomplete: "bad", interrupted: "bad", skipped: "warn" };
const statusText = (status) => el("span", { class: `status ${STATUS_CLASS[status] ?? ""}` }, status);

function modelBadge(id) {
  const tier = state.models[id]?.tier;
  return el("span", { class: `badge ${tier ? `tier-${tier}` : ""}`, title: tier ? `${tier} tier` : null }, id);
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

const message = (from, label, ...body) =>
  el("div", { class: `msg ${from}` }, el("div", { class: "msg-from" }, label), el("div", { class: "bubble" }, ...body));

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
  const view = { started: null, plan: null, finished: null, tasks: new Map(), checks: [], calls: [], refused: [], conversation: [] };
  const open = new Map();
  for (const e of events) {
    if (e.type === "run_started") view.started = e;
    else if (e.type === "plan_approved") view.plan = e;
    else if (e.type === "conversation") view.conversation.push(e);
    else if (e.type === "task_status") view.tasks.set(e.taskId, { status: e.status, detail: e.detail });
    else if (e.type === "check_result") view.checks.push(e);
    else if (e.type === "run_finished") view.finished = e;
    else if (e.type === "call_refused") view.refused.push(e);
    else if (e.type === "call_start") {
      const call = { ...e, outcome: null, costUsd: null };
      open.set(e.attemptId, call);
      view.calls.push(call);
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

// ---- run view: run list | conversation | dashboard ------------------------------

function renderRun(run, events, report) {
  const view = summarize(events);
  const status = view.finished?.status ?? (view.started ? "running" : "probe");
  const session = state.session;
  const ours = Boolean(session?.enabled && session.runId === run);
  const waiting = ours && session.state === "waiting";

  if (waiting) setLive("Meta is waiting for you", "turn");
  else if (session?.state === "waiting") liveFromSession(); // another run, started from this page, needs the user
  else if (status === "running") setLive(`Running · ${view.started.preset} preset`, "running");
  else if (view.started) setLive(`Run ${status}`, STATUS_CLASS[status] ?? "");
  else setLive(null);

  render([
    historyColumn(),
    el("section", { class: "main glass dense" }, threadFor(run, view, report, ours), waiting ? actionForm(run, session.pending) : null),
    column("side", costCard(view, report), compareCard(view, report), checksCard(view, report), callsCard(view)),
  ]);
}

function historyColumn() {
  const runs = state.runs.slice(0, 40);
  return el("aside", { class: "history glass", "aria-label": "Runs" },
    el("h2", {}, "Runs"),
    runs.length
      ? el("ul", { class: "runs" }, runs.map((r) => {
          const name = r.kind === "probe" ? "Connectivity probe" : `${r.mode === "single-model" ? "Single model" : "Meta"} · ${r.preset ?? "?"}`;
          const dot = r.kind === "probe" ? "" : r.status === "running" ? "running" : STATUS_CLASS[r.status] ?? "";
          return el("li", {}, el("button", { type: "button", "aria-current": String(r.id === state.runId), title: r.id, onclick: () => openRun(r.id) },
            el("span", { class: "t" }, el("span", { class: `dot ${dot}` }), name),
            el("span", { class: "s num" }, [when(r.startedAt) || r.id, r.kind === "probe" ? null : r.status, r.costUsd !== null ? usd(r.costUsd) : null].filter(Boolean).join(" · "))));
        }))
      : empty("No runs yet."),
    state.source ? el("p", { class: "note" }, state.source) : null);
}

// ---- conversation -----------------------------------------------------------------

/** The run as one conversation: request, Meta's questions and plans, the decisions, the work, the summary. */
function threadFor(run, view, report, ours) {
  const session = state.session;
  const head = el("div", { class: "thread-head" },
    el("h2", {}, "Conversation with Meta"),
    el("span", { class: "note" }, [
      view.started ? `${view.started.preset} preset` : null,
      report?.mode === "single-model" ? "single model, no coordinator (experiment arm A)" : null,
      run,
    ].filter(Boolean).join(" · ")));
  if (!view.started) return el("div", { class: "thread" }, head, empty("Not a pipeline run (a connectivity probe)."));

  const items = [head, message("user", "You", el("p", { class: "request" }, view.started.request))];
  for (const turn of view.conversation) {
    if (turn.from === "user" && turn.kind === "approval") {
      items.push(el("div", { class: "decision" }, `You approved the plan · ${clock(turn.ts)}`));
    } else if (turn.from === "user") {
      items.push(message("user", "You", el("p", { class: "request" }, turn.text)));
    } else {
      items.push(message("meta", turn.kind === "plan" ? "Meta · plan" : "Meta",
        turn.text ? el("p", { class: "request" }, turn.text) : null,
        turn.questions?.length
          ? el("ul", { class: "questions" }, turn.questions.map((q) =>
              el("li", {}, q.question, el("div", { class: "note" }, [q.why, `Default: ${q.default}`].filter(Boolean).join(" · ")))))
          : null));
    }
  }

  const pending = ours && session.state === "waiting" ? session.pending : null;
  const planned = plannedTasks(view, report);
  if (pending?.kind === "plan") {
    items.push(el("div", { class: "block" },
      el("h2", {}, pending.canRevise ? "Proposed plan" : "Revised plan"),
      el("div", { class: "tasks" }, pending.tasks.map((t) => taskRow(t, null))),
      pending.warnings.map((w) => el("p", { class: "note raised" }, `Warning: ${w}`))));
  } else if (planned.length) {
    items.push(el("div", { class: "block" },
      el("h2", {}, "Plan and progress"),
      el("div", { class: "tasks" }, planned.map((t) => taskRow(t, taskProgress(view, report, t))))));
  } else if (!view.finished && !pending) {
    items.push(el("p", { class: "note" }, "Waiting for Meta..."));
  }

  const summary = report?.summary?.message ?? view.finished?.summary;
  const outcome = outcomeDetails(report);
  if (summary || outcome.length) items.push(message("meta", "Meta · summary", summary ? el("p", { class: "request" }, summary) : null, outcome));
  if (view.finished) items.push(el("div", { class: "decision" }, `Run ${view.finished.status} · ${clock(view.finished.ts)}`));
  if (ours && session.state === "failed") items.push(el("p", { class: "error" }, `The run failed: ${session.error}`));
  return el("div", { class: "thread" }, items);
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
  const priced = calls.filter((c) => typeof c.costUsd === "number");
  const status = outcome?.status ?? view.tasks.get(t.id)?.status ?? "pending";
  return {
    status,
    model: outcome?.model ?? executor.at(-1)?.model ?? t.model,
    attempts: outcome?.attempts ?? executor.length,
    costUsd: priced.length ? priced.reduce((sum, c) => sum + c.costUsd, 0) : null,
    reason: outcome?.reason ?? (status !== "running" ? view.tasks.get(t.id)?.detail : null),
  };
}

/** One task: the model Meta chose (and the one it escalated to), its state, and why. */
function taskRow(t, progress) {
  const used = progress?.model ?? t.model;
  const model = used !== t.model
    ? el("span", { class: "route", title: "escalated to a stronger model" }, modelBadge(t.model), el("span", { class: "arrow" }, "→"), modelBadge(used))
    : modelBadge(t.model);
  return el("article", { class: "task" },
    el("span", { class: "id" }, t.id),
    el("div", { class: "main-line" }, el("span", { class: "title" }, t.title), model),
    el("div", { class: "state" },
      progress ? statusText(progress.status) : null,
      progress?.attempts
        ? el("div", { class: "note num" }, `${plural(progress.attempts, "attempt")}${progress.costUsd !== null ? ` · ${usd(progress.costUsd)}` : ""}`)
        : null),
    el("div", { class: "details" },
      el("p", { class: "note" }, `complexity: ${t.complexity} · impact: ${t.impact}${t.reason ? ` — ${t.reason}` : ""}`),
      t.floorReason ? el("p", { class: "note raised" }, `Raised by the program: ${t.floorReason}`) : null,
      t.dependsOn?.length ? el("p", { class: "note" }, `After ${t.dependsOn.join(", ")}`) : null,
      t.writeFiles?.length ? el("p", { class: "note mono" }, `Writes ${t.writeFiles.join(", ")}`) : null,
      progress?.reason ? el("p", { class: "note" }, progress.reason) : null));
}

function outcomeDetails(report) {
  if (!report) return [];
  return [
    report.problems?.length ? el("ul", { class: "problems" }, report.problems.map((p) => el("li", {}, p))) : null,
    report.pendingCheckGroups?.length ? el("p", { class: "note" }, `Not verified: ${report.pendingCheckGroups.join(", ")}`) : null,
    report.findings?.length
      ? el("ul", { class: "findings" }, report.findings.map((f) => el("li", {}, statusText(f.severity), ` ${f.taskId} · ${f.file}: ${f.evidence}`)))
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
    phases.length
      ? el("dl", { class: "kv num" }, phases.flatMap(([phase, value]) => [el("dt", {}, phase), el("dd", {}, usd(value))]))
      : null,
  );
}

const ARM_LABEL = { A: "One strong model (arm A)", B: "Meta, quality preset (arm B)", C: "Meta, saving preset (arm C)" };

/** Routed runs against one strong model, from the newest experiment; never estimated. */
function compareCard(view, report) {
  const experiment = state.experiments.find((x) => x.arms?.filter((a) => a.costUsd).length >= 2);
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
    el("p", { class: "note" }, `Medians from experiment ${experiment.label} (${when(experiment.startedAt)}).${report?.mode !== "single-model" && total !== null ? ` This run: ${usd(total)}.` : ""}`));
}

function checksCard(view, report) {
  const items = [];
  const latest = new Map();
  for (const c of view.checks) latest.set(`${c.taskId ?? "final"}:${c.check}`, c);
  // The holdout has its own line below; it is never part of the per-task checks.
  for (const c of [...latest.values()].filter((c) => c.check !== "holdout-tests")) {
    items.push(el("li", {}, el("span", {}, `${c.taskId ?? "integrated"} · ${c.check}${c.testsRun !== null ? ` (${c.testsRun} tests)` : ""}`), statusText(c.passed ? "passed" : "failed")));
  }
  const holdout = report?.holdout?.find((c) => c.name === "holdout-tests");
  return card(
    "Checks",
    items.length ? el("ul", { class: "list" }, items) : empty("No checks yet."),
    holdout
      ? el("ul", { class: "list" }, el("li", {},
          el("span", {}, `Holdout · ${holdout.testsPassed ?? "?"} of ${holdout.testsRun ?? "?"} tests`), statusText(holdout.passed ? "passed" : "failed")),
          report.frozenIntact === false ? el("li", {}, el("span", {}, "Frozen content"), statusText("changed")) : null)
      : null,
  );
}

function callsCard(view) {
  const calls = [...view.calls].reverse().slice(0, 40);
  const details = el("details", { open: state.callsOpen },
    el("summary", {}, `Model calls · ${view.calls.length}`),
    calls.length
      ? el("ul", { class: "list" }, calls.map((c) =>
          el("li", {},
            el("span", {}, el("span", { class: "muted" }, `${c.role}${c.taskId ? ` · ${c.taskId}` : ""} `), modelBadge(c.model)),
            el("span", { class: "num" }, c.outcome === null ? "in progress" : `${c.outcome} · ${usd(c.costUsd)}`))))
      : empty("No calls yet."));
  details.addEventListener("toggle", () => (state.callsOpen = details.open));
  return el("section", { class: "card glass" }, details);
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
    el("div", { class: "row" }, el("h2", {}, `${x.label}: ${x.experimentId}`), statusText(x.stoppedEarly ? "stopped early" : "completed")),
    x.stoppedEarly ? el("p", { class: "note" }, x.stoppedEarly) : null,
    el("p", { class: "note" }, `Started ${when(x.startedAt)} · source ${x.sourceCommit ?? "unknown"} · median (min–max)`),
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

// ---- new run ------------------------------------------------------------------------

function renderNewRun() {
  const session = state.session;
  const busy = ["starting", "running", "waiting"].includes(session.state);
  const preset = el("select", { class: "input", "aria-label": "Preset" }, session.presets.map((p) => el("option", { value: p }, p)));
  preset.value = session.presets.includes("saving") ? "saving" : session.presets[0];
  const start = el("button", { type: "submit", class: "btn primary", disabled: busy }, "Start run");
  const errorLine = el("p", { class: "error", hidden: true });
  const form = el("form", { class: "start-form" },
    message("user", "You", el("p", { class: "request" }, session.request)),
    el("p", { class: "note" }, "This build runs the demo request on a copy of the sample library; the request is fixed so its tests apply."),
    el("label", { class: "field" }, el("span", {}, "Preset"), preset),
    el("p", { class: "note raised" }, "Costs real money: every model call is billed to your Meta key, within the budgets in config/limits.json."),
    busy ? el("p", { class: "row" }, "A run started from this page is in progress.",
      el("button", { type: "button", class: "link", onclick: () => openRun(session.runId) }, "Open it")) : null,
    el("div", { class: "buttons" }, start), errorLine);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    start.disabled = true;
    errorLine.hidden = true;
    try {
      const { runId } = await act("start", { preset: preset.value });
      state.runs = (await fetchJson("data/runs.json")) ?? state.runs;
      fillPicker();
      openRun(runId);
    } catch (error) {
      errorLine.textContent = error.message;
      errorLine.hidden = false;
      start.disabled = false;
    }
  });
  render([el("section", { class: "main glass dense" }, el("div", { class: "thread" }, el("h2", {}, "Start a run"), form))]);
}

// ---- navigation and polling --------------------------------------------------------

async function loadRun(runId, wasLive = false) {
  clearTimeout(state.timer);
  state.runId = runId;
  if (!runId) {
    setLive(null);
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
    state.experiments = (await fetchJson("data/experiments.json")) ?? state.experiments;
    renderExperiments(state.experiments);
  }
  if (view === "new") renderNewRun();
}

/** Reloads the current run at once, after the user answered. */
function refresh() {
  return state.view === "run" ? loadRun(state.runId, true) : Promise.resolve();
}

function fillPicker() {
  const picker = document.getElementById("run-picker");
  picker.replaceChildren(...state.runs.map((r) =>
    el("option", { value: r.id }, `${r.id} · ${r.kind === "probe" ? "probe" : r.status}${r.costUsd !== null ? ` · ${usd(r.costUsd)}` : ""}`)));
  if (state.runId) picker.value = state.runId;
}

async function init() {
  const [source, runs, models, session, experiments] = await Promise.all([
    fetchJson("data/source.json"), fetchJson("data/runs.json"), fetchJson("data/models.json"), fetchJson("data/session.json"), fetchJson("data/experiments.json"),
  ]);
  state.runs = runs ?? [];
  state.models = models ?? {};
  state.experiments = experiments ?? [];
  state.session = session?.enabled ? session : null;
  if (state.session) {
    // Only an interactive server offers starting a run.
    document.querySelector(".tabs").append(el("button", { type: "button", class: "tab", "data-view": "new", "aria-pressed": "false" }, "New run"));
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
