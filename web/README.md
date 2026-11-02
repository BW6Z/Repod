# Run viewer

A page for following runs, comparing experiment results and, in interactive
mode, holding the conversation with Meta. Plain HTML, CSS and JavaScript
with no build step and no dependencies.

```bash
npm run repod -- view                                         # read-only, free
npm run repod -- view --port 8080
npm run repod -- view --interactive --holdout <dir>           # the page can start paid runs
```

Without `--interactive` the command only reads `runs/`; it never calls a
model and costs nothing, so it can run next to `run` or `experiment` to
follow them live.

With `--interactive` a **New run** tab starts the demo request (fixed, so
the demo's tests apply) with a chosen preset. The run is the same paid run
as `npm run repod -- run`, with your Meta key, the same budgets and the
same paid-run lock; the conversation happens on the page instead of the
terminal: answer Meta's clarifying questions (an empty answer takes the
default), then approve the plan, send it back once with feedback, or stop
the run.

## What it shows

The run view has three columns: the run list (left; a picker in the header
on narrow screens), the conversation (center) and the numbers (right).

- **Conversation with Meta** (center): the whole run as one thread, from
  the run's ledger. Your request, Meta's questions, your answers, each
  proposed plan and your decision. Then the approved plan with each task's
  model (after the capability floor, with an arrow when the task escalated
  to a stronger model), why Meta chose it, its status, attempts and cost.
  Last, Meta's summary with problems and review findings. In interactive
  mode, when the run waits for you, the proposed plan appears in the thread
  and the answer form or the plan decision sits at the bottom.
- **Side**: cost at list price with the split by phase; **versus one strong
  model**, the median cost and holdout pass rate per arm from the newest
  experiment (shown only when an experiment result exists, never
  estimated); checks (per task, integrated, holdout with its count and
  whether the frozen content stayed intact); and the model call log,
  collapsed.
- **Experiments**: per arm, runs, completed runs, runs that fully passed the
  holdout, pass rate, cost and wall time (median and range), with links to
  every run.

The style is frosted glass in muted blues over a soft gradient (CSS
`backdrop-filter`). Where the browser cannot blur, or the user asks for
reduced transparency, the panels fall back to a solid colour.

A run in progress is reloaded every 2 seconds until its `run_finished`
event; then its report is shown.

## Data

The page reads only relative paths under `data/`:

| Path | Content |
|---|---|
| `data/source.json` | where the data comes from (`local` or `replay`) |
| `data/runs.json` | one entry per run, newest first |
| `data/models.json` | tier and price of every configured model |
| `data/experiments.json` | every experiment result |
| `data/session.json` | interactive mode: what the run waits for, and the page's token |
| `data/runs/<runId>/events.jsonl` | the run's ledger |
| `data/runs/<runId>/report.json` | the run's report, once written |

`npm run repod -- view` serves these from `runs/` (`src/server/view-server.ts`).
The same layout as static files is meant for a published replay; exporting
one is not implemented yet.

Run data is always inserted as text, never as markup: plans, summaries and
check output come from models and from code they wrote. The server sends a
content security policy that allows only the page's own files.

## Not implemented yet

- Requests other than the demo request (they would need their own checks).
- Exporting a static replay for publishing.
