# Repod

Meta Global AI Developer Hackathon project.

Repod lets a Meta model coordinate a development request: it splits the work
into subtasks, assigns each one to a model suited to its difficulty and risk,
and reports what every step cost. Program-run checks gate quality, and a
model is escalated only when a cheaper attempt fails those checks.

The goal is to make the cost and quality trade-off visible, controllable and
verifiable. Whether routing actually saves money is a question for the
experiment in `eval/`, not a claim this project makes in advance.

## Status

This is an early skeleton. Do not treat planned items as working features.

| Area | Status |
|---|---|
| Config schemas and loader (`src/config`) | Implemented, tested |
| Cost calculation, budget reservation, per-run and cumulative spend caps (`src/gateway`) | Implemented, tested |
| JSONL event ledger (`src/gateway/ledger.ts`) | Implemented, tested |
| Model output schemas and strict JSON Schema check (`src/orchestrator/schemas.ts`, `src/gateway/json-schema.ts`) | Implemented, tested |
| Model gateway: retries, one format repair, failure classification (`src/gateway/gateway.ts`) | Implemented, tested with a fake adapter |
| Meta Model API adapter (`src/gateway/adapters/meta.ts`) | Implemented, tested with mocked HTTP only; **not yet verified against the live API** |
| Anthropic adapter | Planned, optional (deadline build uses Meta models only) |
| CLI `check-config`, `spend` | Implemented |
| CLI `probe` | Implemented, not yet run against the live API |
| Capability floor with free/cheap/strong tiers; presets limit which models may execute (`src/orchestrator/routing.ts`) | Implemented, tested |
| Check and review requirements per task type (`reviewRequirement`) | Implemented, tested; not yet wired into the pipeline |
| Plan validation: ids, dependencies, cycles, context files, models, budget warning (`src/orchestrator/plan-validation.ts`) | Implemented, tested |
| Executor input assembly and context versioning (`src/orchestrator/context.ts`) | Implemented, tested |
| Repository summary for planning (`src/workspace/summary.ts`) | Implemented, tested |
| Prompts, planning and triage calls, pipeline (`src/orchestrator/orchestrator.ts`) | Planned (interfaces only) |
| Run workspace, path allowlist, diff, hashing (`src/workspace`) | Implemented, tested (Windows paths with spaces, junction escapes, links into protected folders) |
| Check runner (`src/verifier`) | Implemented, tested (timeouts kill the process tree; API keys withheld) |
| Sample repository and tests | Planned (placeholder) |
| Experiment runner | Planned |
| Server and web UI | Planned |

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
npm run check                    # type check + unit tests
npm run typecheck
npm test
npm run repod -- check-config    # validate config/
npm run repod -- spend           # recorded spend across runs vs. total budget
npm run repod -- probe           # one tiny live request; costs real money
npm run repod -- probe --model muse-wonder-1.0
```

Note there is only one `--` (it tells npm where its own options end). The CLI
rejects unknown commands, unknown options and stray arguments instead of
ignoring them, so a typo cannot silently send a paid request to the default
model.

`probe` needs `MODEL_API_KEY` in `.env`. Every call is recorded in
`runs/<runId>/events.jsonl` (gitignored).

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `development` (docs-only
changes skipped), on every pull request to `main`, and on manual dispatch:

- `check` on Ubuntu and Windows: `npm ci`, type check, unit tests, config
  validation
- `audit`: `npm audit --audit-level=high`
- `repo-hygiene`: `.env` is not tracked; required files exist

CI uses a read-only token, needs no secrets, and never calls model APIs.

## Repository structure

```
.github/       CI workflow
config/        limits, pricing (with source and date), model presets
src/
  cli/         command-line entry point
  config/      config schemas and loader
  gateway/     single entry point for model calls; adapters per provider
  orchestrator/ run state, output schemas, routing floor, plan validation
  workspace/   isolated run copies, path allowlist, diffs
  verifier/    fixed checks run as child processes
  server/      planned read-only API
web/           planned UI
sample-repo/   demo baseline that runs modify (copies only)
eval/          experiment protocol; holdout tests
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
  sent.

Environment variables (see `.env.example`): `MODEL_API_KEY` for the Meta Model
API. `ANTHROPIC_API_KEY` is reserved for the optional Anthropic adapter and is
not used yet. The CLI reads keys from `.env` without adding them to the
process environment, so child processes (checks, git) never inherit them.

## Known limitations

- The Meta adapter has only been tested against mocked responses based on
  Meta's documentation. Two details are assumptions until a live call
  confirms them: whether `input_tokens` includes cached tokens, and that an
  `incomplete` status means the output token limit was hit.
- Spend figures are list-price estimates. Hackathon credits are not tracked
  as a separate balance.
- Running checks on model-written code is not sandboxed beyond a separate
  working copy, an allowlisted environment without API keys, and a timeout
  that kills the whole process tree. Network and filesystem access are not
  restricted. Git in the run workspace ignores system and global config and
  has fsmonitor, hooks and signing disabled, but model-written code could
  still define git filters in the workspace's own `.git/config`; they would
  run without API keys. Repod is not a safe
  platform for running arbitrary code and only runs its bundled sample.
- Competition compliance has not been verified; see `docs/compliance.md`.

## Documentation

- [Architecture](docs/architecture.md)
- [Compliance tracker](docs/compliance.md)
- [Evaluation protocol](eval/README.md)
