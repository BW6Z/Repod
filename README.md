# Repod

Meta Global AI Developer Hackathon project.

Repod lets a Meta model coordinate a development request: it splits the work
into subtasks, assigns each one to a model suited to its difficulty and risk,
and reports what every step cost. Program-run checks gate quality, and a
model is escalated only when a cheaper attempt fails those checks.

The goal is to make the cost and quality trade-off visible, controllable and
verifiable. Whether routing actually saves money is a question for the
experiment in `eval/`, not a claim this project makes in advance.

## For judges

**The problem.** Coding with one strong model is reliable but expensive.
Cheap models are often good enough, but nobody knows in advance which tasks
are safe to give them, and a wrong guess costs a failed change.

**What Repod does.** You make one request. A Meta model then plans the work
with you: it asks clarifying questions, proposes tasks, and labels each
task's complexity and impact. You approve the plan. After that:

1. **Routing.** Each task goes to a cheap or a strong model. The program
   enforces a floor, so complex or high-impact work always gets a strong
   model, whatever the coordinator chose.
2. **Checks.** Fixed checks run after every task: type check, the task's
   visible tests, and docs and example checks.
3. **Failures.** When a task fails its checks, Meta decides whether to
   repair it on the same model, escalate it to the strong model, or stop.
   The program can override that decision, and the log records who decided
   and why.
4. **Results.** The result is frozen and run against holdout tests the
   models never saw. Every call's tokens and cost are recorded.

**How to judge it.** The `experiment` command runs the same request three
ways, with the same checks and holdout tests:

- arm A: one strong model alone;
- arm B: Repod with strong models only;
- arm C: Repod with cheap and strong models.

It reports the holdout pass rate and the cost of each arm. Whether arm C
saves money at the same quality is measured, not assumed.

**Meta models used and where they run.** The coordinator is always a Meta
model. There are two setups; each run records which API it called, and the
viewer shows it.

| Setup | Models | Runs on |
|---|---|---|
| `config/` (default) | Muse Spark 1.3 (coordinator, routine work), Muse Wonder 1.0 (critical work, review) | Meta Model API |
| `config/open-weights/` | Muse Spark Open (coordinator, critical work, review), Muse Glimmer 30B (routine work, docs), both open-weight | OpenRouter |

**Built during the Hackathon.** Everything in this repository was written
during the building period. The first commit is dated 2026-10-30, and the
git history shows each step. Only the open-source dependencies `zod`,
`typescript` and `@types/node` come from outside.

**Verified so far.** See the status table below. The pipeline, the checks,
the experiment and the viewer are tested offline and rehearsed end to end
against a local fake API. Results from real model runs have not been
published yet.

## Status

The pipeline is implemented and tested offline; it has not yet run against
real models. Do not treat planned items as working features.

| Area | Status |
|---|---|
| Config schemas and loader (`src/config`) | Implemented, tested |
| Cost calculation, budget reservation, per-run and cumulative spend caps (`src/gateway`) | Implemented, tested |
| JSONL event ledger (`src/gateway/ledger.ts`) | Implemented, tested |
| Model output schemas and strict JSON Schema check (`src/orchestrator/schemas.ts`, `src/gateway/json-schema.ts`) | Implemented, tested |
| Model gateway: retries, one format repair, failure classification (`src/gateway/gateway.ts`) | Implemented, tested with a fake adapter |
| Meta Model API adapter (`src/gateway/adapters/meta.ts`) | Implemented, tested with mocked HTTP only; **not yet verified against the live API** |
| Meta open-weight models on OpenRouter (`config/open-weights`, chosen with `REPOD_CONFIG_DIR`) | Config validated and tested; **not yet run against OpenRouter** |
| Anthropic adapter | Planned, optional (deadline build uses Meta models only) |
| CLI `check-config`, `spend` | Implemented |
| CLI `probe` | Implemented, not yet run against the live API |
| Capability floor with free/cheap/strong tiers; presets limit which models may execute (`src/orchestrator/routing.ts`) | Implemented, tested |
| Check and review requirements per task type (`reviewRequirement`) | Implemented, tested, applied by the pipeline |
| Check groups: each task is checked with its own visible tests and those of finished tasks; a failed task's files and tests are rolled back (`src/orchestrator/check-groups.ts`) | Implemented, tested |
| Plan validation: ids, dependencies, cycles, context files, models, budget warning (`src/orchestrator/plan-validation.ts`) | Implemented, tested |
| Executor input assembly and context versioning (`src/orchestrator/context.ts`) | Implemented, tested |
| Repository summary for planning (`src/workspace/summary.ts`) | Implemented, tested |
| Pipeline: planning with clarifying questions and one plan revision, execution with repair and one escalation, review, freeze, summary (`src/orchestrator/orchestrator.ts`) | Implemented, tested end to end with a scripted fake gateway and real checks; **not yet run with real models** |
| System prompts (`src/orchestrator/prompts.ts`) | First versions; to be tuned against real model behavior |
| Write scope per task, pre-write freshness check, tainted workspaces (`src/workspace`) | Implemented, tested |
| CLI `run`: the demo request on a copy of the sample repo, interactive or `--experiment` | Implemented; **not yet run with real models** |
| CLI `experiment`: arms A (one strong model, no coordinator), B and C in rounds, with per-run reports and a median/range summary (`src/eval/experiment.ts`) | Implemented, tested with a scripted gateway and real checks; **not yet run with real models** |
| Run workspace, path allowlist, diff, hashing (`src/workspace`) | Implemented, tested (Windows paths with spaces, junction escapes, links into protected folders) |
| Check runner (`src/verifier`) | Implemented, tested (timeouts kill the process tree; API keys withheld) |
| Sample repository: spec, baseline library and baseline tests (`sample-repo/`) | Implemented, tested |
| Demo kit: request, interface contract, check groups and visible tests (`eval/demo/`) | Implemented; validated against a private reference implementation |
| Holdout tests | Written and validated (including deliberately wrong implementations that must fail); kept private until the experiments are over |
| Run viewer: local page showing each run in tabs (live while it runs): an overview with an acceptance summary, the conversation with Meta, each task's attempts and who decided what after a failure, and the delivered diff; cost against one strong model from experiment results, and experiment results, each marked with where its data came from (Meta Model API, a rehearsal, or not recorded) and flagged when it is not a formal experiment or rests on fewer than three runs per arm (`web/`, `src/server/view-server.ts`) | Implemented, tested on rehearsal data |
| Conversation with Meta on the page: start the demo run, answer questions, approve, revise once or stop (`view --interactive`; `src/server/session.ts`) | Implemented, tested with a fake Meta API; **not yet run with real models** |
| Static replay export: recorded runs as static files anyone can open without a key; local paths and holdout output removed (`export`; `src/server/replay.ts`) | Implemented, tested on rehearsal data; nothing published yet |
| Free-form requests on the page | Planned |

## Requirements

- Node.js 24 or later
- npm

## Setup

```bash
npm install
cp .env.example .env   # fill in keys locally; never commit .env
```

Local `.env` and `.env.*` files are ignored, with `.env.example` kept as the
shared template. Dependencies, run artifacts, logs, `dist/` build output and
OS-generated metadata are also ignored. Keep `package-lock.json` tracked for
reproducible installs. Ignore rules do not remove files already tracked by Git.

## Commands

```bash
npm run check                    # type check + unit tests + sample repo tests
npm run typecheck
npm test
npm run test:sample              # the demo baseline's own tests
npm run repod -- check-config    # validate config/
npm run repod -- spend           # recorded spend across runs vs. total budget
npm run repod -- probe           # one tiny live request; costs real money
npm run repod -- probe --model muse-wonder-1.0
npm run repod -- run             # the demo request, interactive; costs real money
npm run repod -- run --experiment --holdout <dir>
npm run repod -- experiment --holdout <dir>                    # arms A and C, 1 run each ("debug"); <dir> needs expected-tests.json
npm run repod -- experiment --holdout <dir> --runs 3 --label formal
npm run repod -- view                                          # read-only run viewer on http://127.0.0.1:4173; free
npm run repod -- view --interactive --holdout <dir>            # the page can start the demo run; costs real money
npm run repod -- export --out <dir> [--include <id>]...         # static replay of recorded runs; free
```

`run` copies `sample-repo/` into `runs/<runId>/workspace`, gives Meta the
request in `eval/demo/request.md`, and lets you answer clarifying questions
and approve the plan (or send it back once). `--experiment` uses default
answers and approves automatically; `--preset quality` switches presets;
`--holdout <dir>` runs the holdout tests in `<dir>` once after the result is
frozen. The report is written to `runs/<runId>/report.json`.

`experiment` runs the comparison arms of `eval/README.md` (`--arms A,C` by
default; add `B` for the quality preset) for `--runs` rounds, each run on a
fresh copy with default answers and automatic approval. Each run keeps its
own report; the summary (holdout pass rate, cost by phase, calls,
escalations, wall time; median and range per arm) is written to
`runs/experiments/<experimentId>.json`. It stops early once the cumulative
budget refuses a call.

Note there is only one `--` (it tells npm where its own options end). The CLI
rejects unknown commands, unknown options and stray arguments instead of
ignoring them, so a typo cannot silently send a paid request to the default
model.

`export` writes the viewer page and the finished runs (or only the runs and
experiments named with `--include`; an experiment brings its runs) into a
new, empty folder. Absolute paths of this machine are replaced with `<repo>`,
`<runs>` and `<home>`, the holdout tests' output is dropped (only their
counts stay), and the page cannot start runs. Serve the folder with any static
file server, for example `python -m http.server` inside it; browsers do not
let the page read its data from `file://`.

`probe` needs `MODEL_API_KEY` in `.env`. Every call is recorded in
`runs/<runId>/events.jsonl` (gitignored).

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `development` (docs-only
changes skipped), on every pull request to `main`, and on manual dispatch:

- `check` on Ubuntu and Windows: `npm ci`, type check, unit tests, sample
  repo tests, config validation
- `audit`: `npm audit --audit-level=high`
- `repo-hygiene`: `.env` is not tracked; holdout tests and the reference
  implementation are not tracked; required files exist

CI uses a read-only token, needs no secrets, and never calls model APIs.

## Repository structure

```
.github/       CI workflow
config/        limits, pricing (with source and date), model presets
src/
  cli/         command-line entry point
  config/      config schemas and loader
  gateway/     single entry point for model calls; adapters per provider
  orchestrator/ pipeline, output schemas, routing floor, plan validation, check groups
  workspace/   isolated run copies, path allowlist, diffs
  verifier/    fixed checks run as child processes
  eval/        demo kit loader and holdout preparation
  server/      server for the run viewer (read-only unless --interactive); static replay export
web/           run viewer page (plain HTML, CSS, JS)
sample-repo/   demo baseline that runs modify (copies only); SPEC.md holds its rules
eval/          experiment protocol; demo kit (eval/demo); holdout tests after the experiments
docs/          architecture and compliance notes
```

## Configuration

- `config/presets/*.json`: which model serves each role, and each model's
  tier (`free`, `cheap` or `strong`). The coordinator must be a Meta model;
  executors may come from any supported provider. The critical and review
  roles need a strong model, the routine role at least a cheap one.
  Free-tier models can only be used when the preset sets
  `allowFreeModels: true`, because free tiers may use submitted content for
  training. Both shipped presets use Meta models only: `muse-spark-1.3`
  coordinates and handles routine work, `muse-wonder-1.0` handles critical
  work and review (`saving`), or every executor role (`quality`).
- `config/open-weights/`: the same two presets with Meta's open-weight
  models only, for when the Meta Model API is not available. It has its own
  prices and limits (see below).
- Routing: Meta labels each task's complexity and impact and picks a model.
  The program enforces a floor (high impact or complex: strong; medium:
  cheap; simple and low impact: free if allowed) and replaces a choice below
  it with the preset's role model, recording why.
- `config/pricing.json`: per-model prices with source URL, date and a
  `verified` flag. Unverified prices are reported as such.
- `config/limits.json`: per-run budget (`budgetUsd`), cumulative budget
  across all recorded runs (`totalBudgetUsd`), attempt, retry and escalation
  limits, request timeout, output and file size limits, reasoning effort per
  role. A call is refused before it is sent if its estimated worst-case cost
  would exceed either budget. The estimate is deliberately conservative but
  heuristic, so the budgets are a stop policy rather than a guaranteed cap.
  If a recorded ledger is corrupt, malformed (for example an event with a
  missing or non-numeric amount) or unreadable, no paid call is made until
  it is resolved. If the start of a call cannot be recorded, the call is not
  sent, and a request that provably never left the machine (refused
  connection, unresolved host) is not billed. Only one paid command (`run`,
  `probe` or `experiment`) runs at a time: each takes
  `runs/paid-run.lock` before reading past spend, and a second one is
  refused. If a command was killed (for example with Ctrl+C) the lock stays;
  make sure no Repod command is running, check `npm run repod -- spend`,
  then delete the lock file.

Environment variables (see `.env.example`): `MODEL_API_KEY` for the Meta Model
API. `ANTHROPIC_API_KEY` is reserved for the optional Anthropic adapter and is
not used yet. The CLI reads keys from `.env` without adding them to the
process environment, so child processes (checks, git) never inherit them.

Two optional settings exist for rehearsing against a local fake of the Meta
API: `MODEL_API_BASE_URL` sends requests (and the key) to another address,
and the CLI announces it on every paid command; `REPOD_RUNS_DIR` (relative
to the repository) keeps those runs and their spend apart from the real
ones, for example `runs/rehearsal`. Leave both unset for real runs on the
Meta Model API.

### Meta's open-weight models on OpenRouter

When the Meta Model API cannot be used, Repod can run on Meta's open-weight
models instead. The organizers confirmed that projects built on them are
eligible (see `docs/compliance.md`). With this setup, the models and the
place they run are:

| Model | Licence | Runs on | Roles in `saving` |
|---|---|---|---|
| Muse Spark Open (`meta/muse-spark-open`) | Muse Model License | OpenRouter | coordinator, critical work, review |
| Muse Glimmer 30B (`meta/muse-glimmer-30b`) | Apache 2.0 | OpenRouter | routine code, docs |

`quality` (experiment arm B) uses Muse Spark Open for every role, and the
single-model arm A uses Muse Spark Open alone. Set these in `.env`:

```
MODEL_API_KEY=<OpenRouter key>
MODEL_API_BASE_URL=https://openrouter.ai/api/v1
REPOD_CONFIG_DIR=config/open-weights
```

The same Meta adapter sends the requests, because OpenRouter offers the same
Responses endpoint. That OpenRouter accepts every field of that request has
not been confirmed by a live call yet; run `probe` first.
`REPOD_CONFIG_DIR` switches presets, prices and limits together, and the CLI
announces it on every command. Executor output is
limited to 16,000 tokens there, because OpenRouter serves Muse Glimmer with at
most 16,384. Every run records `https://openrouter.ai` as its model API, and
the viewer labels it OpenRouter.

## License

MIT, see [LICENSE](LICENSE). Under the Official Rules the Organizers also
receive their own licence to the submission; that does not change this one.

## Documentation

- [Architecture](docs/architecture.md)
- [Compliance tracker](docs/compliance.md)
- [Evaluation protocol](eval/README.md)
