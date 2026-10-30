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
| Cost calculation and budget reservation (`src/gateway/cost.ts`) | Implemented, tested |
| JSONL event ledger (`src/gateway/ledger.ts`) | Implemented, tested |
| Model output schemas (`src/orchestrator/schemas.ts`) | Implemented, tested |
| CLI `check-config` | Implemented |
| Model gateway and provider adapters | Planned (interfaces only) |
| Planning, routing floor, plan validation, triage | Planned (interfaces only) |
| Run workspace, path allowlist, diff, hashing | Planned (interfaces only) |
| Check runner | Planned (interfaces only) |
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

## Commands

```bash
npm run check                    # type check + unit tests
npm run typecheck
npm test
npm run repod -- check-config    # validate config/
```

## Repository structure

```
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

- `config/presets/*.json`: which model serves each role. The coordinator must
  be a Meta model. The model choice in the shipped presets is provisional.
- `config/pricing.json`: per-model prices with source URL, date and a
  `verified` flag. Unverified prices are reported as such.
- `config/limits.json`: budget, attempt and escalation limits, output and
  file size limits.

Environment variables (see `.env.example`): `MODEL_API_KEY` for the Meta Model
API, `ANTHROPIC_API_KEY` for Anthropic models.

## Known limitations

- No model is called yet; adapters are not implemented.
- Running checks on model-written code is not sandboxed beyond a separate
  working copy, a stripped environment and a timeout. Repod is not a safe
  platform for running arbitrary code and only runs its bundled sample.
- Competition compliance has not been verified; see `docs/compliance.md`.

## Documentation

- [Architecture](docs/architecture.md)
- [Compliance tracker](docs/compliance.md)
- [Evaluation protocol](eval/README.md)
