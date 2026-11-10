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

With `--interactive` a **New run** button in the top bar (or the N key) opens
a panel over the page that starts a run with an optional name (one line of
up to 80 characters, recorded in the run's `run_started` event and shown in
the run list and the run's header) and a chosen preset, each preset
explained by its description from `config/`:
either the demo request, whose contract, visible tests and holdout tests
apply, or **your own request** on the same sample library, judged only by
the type check and the library's existing tests. The run is the same paid run
as `npm run repod -- run`, with the key in MODEL_API_KEY, the same budgets and the
same paid-run lock; the conversation happens on the page instead of the
terminal: answer Meta's clarifying questions (an empty answer takes the
default), then approve the plan, send it back once with feedback, or stop
the run.

## What it shows

The page is laid out as a workbench: a rail on the left switches between
Runs and Experiments and between light and dark; a top bar shows where you
are and what the open run is doing (and New run, when interactive). The run
view has three columns that scroll on their own; on wide screens the run
list runs the full height and the top bar sits over the other two:

- the run list (left; a picker in the top bar on narrower screens), grouped
  into runs, experiment runs and probes, with a search box (Ctrl/Cmd+K);
- the open run (center): its title, the name given when it was started or
  else the first clause of its request; whether it ran the demo request (verified by its holdout tests)
  or your own; when, how long and how many model calls; and the models by
  role (coordinator, strong, cheap);
- an inspector (right; below the run on narrow screens): cost split by phase,
  the comparison with one strong model, and the run's details.

The page tells the demo request from your own by comparing the run's request
with the demo request's text, which `data/source.json` carries (live and in a
replay). The open run is split into tabs, so each answers one question:

- **Overview**: the result first. The acceptance summary, computed from the
  report rather than Meta's words: tasks passed, integrated checks, holdout
  tests and blocking review findings, each judged on its own. Then a table
  with one row per task: its title and Meta's reason, the model it ran on
  (an arrow when it escalated to a stronger model), its labels, its result
  with any repairs or escalation ("Passed · 1 repair") and its cost; a row
  opens that task on the Tasks tab (its id is in the row's tooltip). Last,
  Meta's summary with problems and review findings.
- **Conversation**: your request, Meta's questions, your answers, each
  proposed plan and your decision, as messages with the time (yours) or the
  coordinator model (Meta's). The plan sits as a card inside Meta's last
  plan message: one row per task with its id, title, order and files, and
  model. In interactive mode, when the run waits for you, that card is the
  plan under decision and the answer form or the plan decision sits at the
  bottom.
- **Tasks**: one line per task, opened on demand. An open task shows its
  model (after the capability floor) and why Meta chose it, what it writes,
  and its history: every attempt with its model, cost and checks, and
  between attempts the decision that followed a failure (repair, escalate
  or stop), whether Meta or the program made it, and why. Tasks with a
  decision or still running are open by default. Runs recorded before
  decisions were logged show the attempts only. The model call log,
  collapsed, is at the bottom.
- **Changes** (once the report is written): the changed files with their
  diff, the frozen version the holdout ran on or marked as not frozen.
  Visible tests that Repod copied in for the checks are labelled as such,
  not shown as the model's work.

The tab follows the run: Conversation while Meta waits for you, Tasks while
it runs, Overview once it has finished, until you pick a tab yourself.

- **Side**: cost at list price with the split by phase, and **versus one
  strong model**: the median cost and holdout pass rate per arm from the
  newest experiment labelled `formal` (the newest of any label when there is
  none; shown only when an experiment result exists, never estimated).
- **Experiments**: per arm, runs, completed runs, runs that fully passed the
  holdout, pass rate, cost and wall time (median and range), with links to
  every run.

Where the data came from is never left to the reader to guess. Each run and
experiment records the origin of the model API it called: the run head,
the run list, the comparison and each experiment say "Meta Model API" or
"OpenRouter" (Meta's open-weight models, `config/open-weights`), mark a
local fake API as a rehearsal (or any other host as not a known model API),
and say "not recorded" for data from before the origin was kept. An
experiment not labelled `formal`, an arm with fewer than three runs, and a
comparison from another API than the open run's are flagged as well.

Light mode is frosted glass in muted blues over a soft gradient (CSS
`backdrop-filter`); where the browser cannot blur, or the user asks for
reduced transparency, the panels fall back to a solid colour. Dark mode is
opaque. The page follows the system setting until the moon button picks one;
that choice is kept per browser (local storage) and only affects the look.

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
`npm run repod -- export --out <dir>` writes the same layout as static files,
with `source.json` set to `replay` and the session disabled
(`src/server/replay.ts`). Serve that folder with any static file server; the
page fetches its data, which browsers do not allow from `file://`.

Run data is always inserted as text, never as markup: plans, summaries and
check output come from models and from code they wrote. The server sends a
content security policy that allows only the page's own files; `index.html`
repeats it in a meta tag, so a replay on another host keeps it.

## Not implemented yet

- Requests on other repositories, and generated checks for your own
  requests (today they are not verified by holdout tests).
