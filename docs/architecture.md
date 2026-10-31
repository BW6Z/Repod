# Architecture

Status: skeleton. Interfaces exist; most behavior is not implemented yet (see
the status table in the root README).

## Modules

```
cli / web UI ──> orchestrator (state machine, owns all run state)
                   ├── gateway     every model call: budget, ledger, validation, failure kinds
                   │     └── adapters/meta.ts, adapters/anthropic.ts
                   ├── workspace   run copy, path allowlist, writes, hashes, diff
                   └── verifier    fixed checks as child processes (no shell)
```

- **Orchestrator** never knows which provider serves a role; it calls the
  gateway with a role, a model id from the preset and a Zod schema.
- **Gateway** is the only place that talks to providers. Budgeting, logging,
  retries and failure classification are identical for every model.
- **Adapters** are thin: one request, normalized usage, mapped errors.
- **Workspace** applies executor output only after every file passes
  validation, so a run never holds half an edit.
- **Verifier** runs fixed commands with an allowlisted environment (no API
  keys) and a timeout.

## Run flow

1. **Prepare**: copy the sample repo baseline into `runs/<runId>/`; build a
   repo summary (file tree, sizes, exports, one-line responsibilities).
2. **Plan**: Meta returns either clarifying questions (at most 3, one round,
   each with a default answer) or a plan. The program validates the plan and
   applies the capability floor.
3. **Approve**: the user approves, or sends the plan back once with a comment;
   the revised plan is validated again and can only be approved.
   After this point the user no longer converses with Meta.
4. **Execute**: tasks in dependency order, one writer at a time. Executors get
   whole file contents and return whole-file replacements as JSON. Dev checks
   run after each task; failures are classified, and Meta triages implementation
   failures (repair, escalate once, or stop) within fixed limits.
5. **Review**: the strong model reviews core diffs; findings are triaged by
   severity and evidence.
6. **Freeze**: hash every file; run holdout tests once without feedback.
7. **Summarize**: Meta writes the closing message; the program fills in all
   numbers.

Meta is called 2 to 6 times per run in normal operation.

## Routing and plan checks

- **Tiers**: `free` < `cheap` < `strong`. Free-tier models are opt-in per
  preset (`allowFreeModels`).
- **Executor models**: only models assigned to a preset role may execute
  tasks. The coordinator's model is not an executor option unless a role uses
  it, so the `quality` preset runs every task on its strong model.
- **Capability floor**: high impact or complex tasks need `strong`; medium
  complexity or impact needs `cheap`; simple, low-impact tasks may use
  `free`. A choice below the floor, or outside the executor models, is
  replaced by the preset's `critical` (strong) or `routine` (cheap) model,
  with the reason recorded.
- **Checks and review** (`reviewRequirement`, not yet wired into the
  pipeline): code tasks (implement, fix, test) need a type check and visible
  tests or they do not run; docs tasks may use free or cheap models, but a
  review is scheduled when any docs check (examples compile, referenced
  exports and commands exist) cannot run; complex or high-impact tasks are
  always reviewed.
- **Plan validation** (after every planning call, including revisions):
  question count and defaults, unique task ids, known and non-circular
  dependencies, context files that exist and pass the path allowlist, models
  declared in the preset, acceptance criteria present. A worst-case output
  cost above the remaining budget is a warning, not an error; it prices each
  task on the model the floor will use and counts allowed escalations.
- **Executor input**: task, acceptance criteria, interface contract and full
  contents of the selected files, plus, for repairs and escalations, the
  previous diff, failure evidence (first 8000 characters) and Meta's
  guidance. The reply rules (protected paths, whether more files may be
  requested) are generated from the enforced lists and limits.
  `context_version` hashes every task field, the contract, guidance, the
  previous attempt and the file contents (file order ignored); output that
  echoes another version is rejected before writing.
- **Repository summary** for planning: one line per file with size,
  exported names (pattern-based) and an optional responsibility note.

## Gateway call sequence

1. Convert the Zod schema to JSON Schema and verify it is inside the strict
   structured-output subset.
2. Estimate input at one token per two UTF-8 bytes of system prompt, input
   and schema, price it as uncached, and add the full output limit. This is
   a conservative heuristic, so the budget is a stop policy rather than a
   guaranteed cap.
3. Reserve that amount. Reservations are held until settled, so concurrent
   calls cannot spend the same remaining budget. Refuse the call
   (`call_refused` event) if the per-run budget or the cumulative budget
   across all recorded runs would be exceeded.
4. Append `call_start`, then call the adapter with a request timeout.
   Adapters never retry. If `call_start` cannot be written, the reservation
   is released and the call is not sent (`LedgerWriteError`): a paid request
   never goes out without a recorded start.
5. Settle the reservation: at list price when usage and rates are known,
   otherwise, or when the call failed after it was sent, at the full
   reservation.
6. Classify the reply: truncated, refused, invalid JSON or schema mismatch
   (`format`), or valid. Append `call_end` with that outcome, so the ledger
   records validation results, not just transport success.
7. On `format`, send one repair request that includes the validation error.

Only `rate_limited` and transient `network` failures are retried, a bounded
number of times. A provider `Retry-After` hint is honored up to 60 seconds; a
longer hint ends the retries instead of stalling the run. Our own request
timeout is not retried, because the provider may still be billing that work.
Quota, rejected requests, truncation and refusals return to the orchestrator
immediately.

Cumulative spend is computed from every `runs/*/events.jsonl`; a
`call_start` without a matching `call_end` counts its reservation. Every
ledger line is validated at runtime (event type, ids, finite non-negative
amounts), because a well-formed JSON line with a missing amount would
otherwise turn the total into NaN, which passes every comparison. Only a
missing directory or ledger counts as nothing spent: invalid JSON, a
malformed event, an end event with neither a cost nor a matching start, or an
unreadable directory raises an error, and no paid call is made until it is
resolved. `SpendTracker` also rejects NaN, infinite and negative amounts
itself. A failed ledger append does not block later appends.

The CLI reads `MODEL_API_KEY` from `.env` without putting it into
`process.env`, so no child process can inherit it.

## Meta adapter

`POST https://api.meta.ai/v1/responses` with plain `fetch`:
`instructions` (system prompt), `input`, `max_output_tokens`,
`reasoning.effort`, `store: false`, and
`text.format = {type: "json_schema", name, schema, strict: true}`.
The output text is the concatenation of `output_text` parts in `message`
items; a `refusal` part is reported as a refusal; status `incomplete` is
reported as truncation. HTTP errors map to: 429 `rate_limited` (retryable),
402 `quota`, 500/502/503 `network` (retryable), 504 `network` (not retried),
other 4xx `rejected`. Connection failures before a response are retryable;
our own timeout and an unreadable response body are not.

## Workspace and checks

- **Run workspace**: `runs/<runId>/workspace` is a copy of the baseline
  (without `node_modules` and `.git`) committed in its own git repository.
  It is never pushed.
- **Git isolation**: every git command runs with the allowlisted
  environment (no API keys), `GIT_CONFIG_NOSYSTEM=1` and
  `GIT_CONFIG_GLOBAL=/dev/null`, and command-line settings that disable
  `core.fsmonitor`, hooks and commit signing. Model-written code could edit
  the workspace's `.git/config` while tests run; command-line settings take
  precedence over it.
- **Writing executor output**: every file is validated first (task id,
  context version, file count and size, path allowlist, protected files,
  duplicates compared case-insensitively, no NUL or bare CR). CRLF is
  normalized to LF. One invalid file rejects the whole output. Previous
  contents are read before any write; a read error other than "not found"
  aborts before writing. If a write fails midway, each written file is
  restored independently and the original error is reported.
- **Path allowlist**: rejects absolute, drive-qualified, UNC and device paths,
  `.` and `..` segments, Windows reserved names (with any extension,
  including `CONIN$`, `CONOUT$` and superscript COM/LPT names), alternate
  data streams, trailing spaces or dots, 8.3 short names (`~` followed by a
  digit), `.git` and `node_modules`, protected files and paths whose parent
  is a file. It then computes where the file really lands (the deepest
  existing part of the path resolved through any symlink or junction, plus
  the parts that do not exist yet) and applies the same rules to that
  location: it must be inside the workspace, outside `.git` and
  `node_modules`, and not protected. New and existing targets get the same
  check, so a link such as `alias -> test` cannot be used to create files in
  a protected folder. The returned path is the real landing location.
- **Diff**: `git add -A` then `git diff --cached <baseline>`, so new files are
  included.
- **Manifest**: SHA-256 of every file except `.git` and `node_modules`
  (neither is writable by executors).
- **Checks**: `node <tsc> -p tsconfig.json` and
  `node --test --test-reporter=tap test/**/*.test.ts`, started without a
  shell. Failures are classified as `timeout`, `spawn_error`, `exit_code` or
  `no_tests`, so environment problems are never mistaken for code problems.
  The test count comes from the last summary line in the last 8 KB of
  output, so code under test that prints "tests N" and truncated output do
  not distort it. On timeout the whole process tree is killed; if the
  process is not confirmed gone within a grace period, the result reports
  `processExited: false` instead of waiting forever, and the orchestrator
  must stop writing to that workspace.

## Decisions

- Node 24 runs TypeScript directly through type stripping; `tsc --noEmit` is
  the type checker.
- Run state lives in JSON files and a JSONL event ledger; no database.
- Executors do not get a tool loop; the program supplies file contents.
