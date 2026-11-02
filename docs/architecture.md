# Architecture

Status: the pipeline and its building blocks are implemented and tested
offline with a scripted fake gateway; nothing has run against real models
yet. See the status table in the root README.

## Modules

```
cli / web UI ──> orchestrator (state machine, owns all run state)
     │             ├── gateway     every model call: budget, ledger, validation, failure kinds
     │             │     └── adapters/meta.ts, adapters/anthropic.ts
     │             ├── workspace   run copy, path allowlist, writes, hashes, diff
     │             └── verifier    fixed checks as child processes (no shell)
     └──> eval/experiment ──> orchestrator, once per run (arms A, B, C; metrics)
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
- **Experiment runner** (`src/eval/experiment.ts`) calls the same pipeline
  once per run and collects metrics; it adds no model calls of its own.
- **Run viewer** (`web/`, served by `src/server/view-server.ts`) reads the
  ledgers, reports and experiment results; the `conversation` and
  `plan_approved` ledger events let it show the conversation and the plan
  while a run is still going. In interactive mode the page also starts the
  demo run and answers Meta through the pipeline's hooks
  (`src/server/session.ts`), in place of the terminal.

## Run flow (`runPipeline`)

1. **Prepare**: the run workspace is a copy of the baseline in
   `runs/<runId>/`; the pipeline builds a repo summary (file tree, sizes,
   exports, optional responsibilities).
2. **Plan**: Meta returns either clarifying questions (at most 3, one round,
   each with a default answer) or a plan. The program validates the plan; an
   invalid plan gets one fix request with the problems listed, then the run
   stops.
3. **Approve**: the user approves, or sends the plan back once with a comment;
   the revised plan is validated again and can only be approved. Experiment
   runs use default answers and approve automatically. After this point the
   user no longer converses with Meta.
4. **Execute**: tasks in dependency order (a task whose dependency did not
   pass is skipped), one writer at a time. Before a task runs, the visible
   tests of its check groups are added to the workspace and its write scope
   is recorded; if it does not pass, its files are restored and its tests
   removed, so a failed task cannot fail unrelated later tasks. Each attempt reads the task's
   context and existing write files, snapshots its read and write scope,
   calls the executor, writes the output (scope and freshness checked), and
   runs the dev checks. Failures are classified:
   - **retry after a failed check**: the program decides which next steps
     are allowed (repair while the tier's attempts remain, one escalation
     from a cheaper model to the critical model, stop) and Meta picks among
     them. The next attempt gets the current diff, the failure evidence and
     Meta's guidance.
   - **retry after a rejected output** (outside the write scope, stale
     version, no files, a bad file request): repair or stop only. The
     reason can be stated, so a repair can fix it; a stronger model is no
     answer to a broken rule, so it never escalates. The triage input names
     the category.
   - **stop the task** (truncation, refusal, a reply that still fails the
     schema after the gateway's one format repair, a write or context path
     that an earlier task made unusable).
   - **stop the run** (budget, quota, rejected or failed requests, ledger
     write failure, environment problems in checks, a check process that
     could not be stopped, which also taints the workspace).
   A global rework limit applies across tasks. Code tasks without a type
   check and visible tests do not run. Each task's result is kept as soon as
   it is known, so if the run stops on an error, the report still lists the
   finished tasks; the task that was running is "stopped" and the rest are
   "skipped".
5. **Review**: tasks that require review (complex or high impact, or docs
   whose checks cannot run) are reviewed by the preset's review model. The
   reviewer sees the diff of that task's write scope only.
   Blocking findings and findings that need a human decision leave the run
   incomplete; they are not fixed automatically yet.
6. **Freeze**: only when every task passed. The dev checks run again on the
   integrated result, every file is hashed, holdout checks run once without
   feedback to any model, and the hashes are compared again so results are
   bound to the frozen content (`frozenIntact` in the report).
7. **Summarize**: Meta writes the closing message; the program owns every
   status and figure in the report. Skipped when the budget ran out.

Meta is called 2 to 6 times per run in normal operation (plus triage).

## Routing and plan checks

- **Tiers**: `free` < `cheap` < `strong`. Free-tier models are opt-in per
  preset (`allowFreeModels`).
- **Check groups**: trusted configuration (`eval/demo/checks.json`) splits
  the visible tests into named groups with an order (`requires`). Meta
  assigns every group to exactly one task (`check_groups`); plan validation
  rejects unknown, unassigned or doubly assigned groups, and a group whose
  task does not depend, directly or indirectly, on the tasks of the groups
  it requires. A task is checked with its own groups and those of finished
  tasks, never with tests for later work; its own test files are always in
  its executor input. Before freezing, every group runs together. Groups
  whose task did not pass are reported as pending, never as passed.
- **Executor models**: only models assigned to a preset role may execute
  tasks. The coordinator's model is not an executor option unless a role uses
  it, so the `quality` preset runs every task on its strong model.
- **Capability floor**: high impact or complex tasks need `strong`; medium
  complexity or impact needs `cheap`; simple, low-impact tasks may use
  `free`. A choice below the floor, or outside the executor models, is
  replaced by the preset's `critical` (strong) or `routine` (cheap) model,
  with the reason recorded.
- **Checks and review** (`reviewRequirement`, applied by the pipeline before
  each task; docs checks do not exist yet, so docs tasks are currently always
  reviewed): code tasks (implement, fix, test) need a type check and visible
  tests or they do not run; docs tasks may use free or cheap models, but a
  review is scheduled when any docs check (examples compile, referenced
  exports and commands exist) cannot run; complex or high-impact tasks are
  always reviewed.
- **Plan validation** (after every planning call, including revisions):
  question count and defaults, unique task ids, known and non-circular
  dependencies, context files that pass the path allowlist and either exist
  or are in the `write_files` of a task the reader depends on (directly or
  transitively; never its own, an unrelated or a later task's), models
  declared in the preset, acceptance criteria present, and write paths that
  can be written: none lies inside another write path of the plan, none is
  an existing folder or below an existing file. A worst-case output
  cost above the remaining budget is a warning, not an error; it prices each
  task on the model the floor will use and counts allowed escalations.
- **Executor input**: task, acceptance criteria, interface contract and full
  contents of the selected files, read from the workspace when the attempt
  starts (so a file an earlier task created is read as it was written). A
  context file that still does not exist then (a dependency passed without
  creating it) fails the task before any executor call. Repairs and
  escalations also get the diff of the task's write scope (not the visible
  tests copied into the workspace, nor files outside the scope), failure
  evidence (first 8000 characters) and Meta's guidance. The reply rules (protected paths, whether more files may be
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
   otherwise, or when the call failed after it may have been sent, at the
   full reservation. Usage that is not plausible (fractional or negative
   counts, more cached than total input, more reasoning than total output)
   counts as unknown. Only a failure with direct evidence that nothing left
   the machine (a refused connection or an unresolved host name) releases
   the reservation and is logged with a cost of 0; a reset or dropped
   connection, or our own timeout, is billed.
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
itself; an invalid cost still settles at the full reservation, so no hold
stays open. A failed ledger append does not block later appends.

Every event is validated against the same schema before it is written, so
the gateway can never write a line its own reader would reject (a negative
duration after a clock change, for instance; durations use a monotonic
clock). Any failed write of a call's events stops the run with a
`LedgerWriteError`. If the call may already have been billed, the error
carries the cost settled so far, and the report includes it; the ledger then
holds a start without an end, which the total counts at the reservation.

Each run's `SpendTracker` compares against a snapshot of past spend, so two
processes starting together could both pass against the same snapshot. The
paid commands (`run`, `probe` and `experiment`) therefore take one lock,
`runs/paid-run.lock`, created atomically (exclusive create) before the
ledgers are read and removed when the command ends, also on errors. A second
paid command is refused rather than queued. A lock left by a process that
was killed (including Ctrl+C) is never removed automatically, since its run
may have unfinished ledger entries and a reused process id cannot be told
apart from a live owner; the error names the owner and says how to check
spend and remove the lock by hand. Paid runs are therefore sequential; a
shared budget for concurrent runs is not implemented.

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
  environment (no API keys), `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_ATTR_NOSYSTEM=1`, and command-line
  settings that disable `core.fsmonitor`, hooks and commit signing and point
  `core.excludesFile` and `core.attributesFile` at `/dev/null` (the user's
  own `~/.config/git/ignore` and `attributes` are read even when the global
  config is replaced). Model-written code could edit the workspace's
  `.git/config` while tests run; command-line settings take precedence over
  it.
- **Write scope and freshness**: every planned task lists `write_files`
  (validated at planning time: not protected, no duplicates). Output that
  touches any other file is rejected. When the input is assembled, the
  program snapshots the task's read and write files (content hash, or "does
  not exist" for new files); right before writing, the snapshot is compared
  again and any change rejects the output. The echoed `context_version` only
  proves which input the model answered; the snapshot proves the workspace
  still matches it.
- **Tainted workspaces**: a check process that could not be confirmed dead
  marks the workspace tainted; every later write is refused and the run
  stops.
- **Writing executor output**: every file is validated first (task id,
  context version, write scope, file count and size, path allowlist,
  protected files, duplicates compared case-insensitively, no path inside
  another path of the same output, no NUL or bare CR, freshness). CRLF is
  normalized to LF. One invalid file rejects the whole output. Previous
  contents are read before any write; a read error other than "not found"
  aborts before writing. A new file is created under the plan's spelling
  of its path, not the executor's, because Windows keeps the case a file
  was first created with. If a write fails midway, each written file is
  restored independently and the original error is reported; a folder
  created along the way is left in place, since it is empty and only files
  are restored.
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
- **Diff**: `git add -A --force` then `git diff --cached --text <baseline>`,
  so new and ignored files are included and no attributes file can turn a
  change into "Binary files differ". Repairs and reviews pass the task's
  write scope as literal pathspecs, resolved to their real spelling on
  disk. Known limitation: the diff is against the baseline, so if an
  earlier task changed the same file, its changes appear too.
- **Protected files**: `package.json`, `package-lock.json`,
  `tsconfig.json`, everything under `test/`, and `.gitattributes` and
  `.gitignore` in every folder (they could hide changes from the diffs
  repairs and reviews rely on).
- **Manifest**: SHA-256 of every file except `.git` and `node_modules`
  (neither is writable by executors).
- **Checks**: `node <tsc> -p tsconfig.json` and
  `node --test --test-reporter=tap test/**/*.test.ts`, started without a
  shell. Failures are classified as `timeout`, `spawn_error`, `exit_code`,
  `no_tests` or `missing_tests`, so environment problems are never mistaken
  for code problems. `missing_tests` means fewer tests ran than trusted
  configuration says the suite has (a test file that crashed at load time,
  or code that exits the process early); it is a code problem and can be
  repaired. Visible test runs are held to the baseline's count plus the
  counts of the check groups whose tests are in the workspace
  (`eval/demo/checks.json`); the holdout run to the count in its private
  `expected-tests.json`.
  The test count comes from the last summary line in the last 8 KB of
  output, so code under test that prints "tests N" and truncated output do
  not distort it. On timeout the whole process tree is killed; if the
  process is not confirmed gone within a grace period, the result reports
  `processExited: false` instead of waiting forever, and the orchestrator
  must stop writing to that workspace.

## Demo kit and holdout layout

- `sample-repo/` is the baseline library a run starts from; `SPEC.md` holds
  the complete rules that every test checks.
- `eval/demo/` holds the request, the contract, `checks.json` and the
  visible tests (`src/eval/kit.ts` loads and validates it).
- Holdout tests are copied to `runs/<runId>/holdout/`, beside
  `runs/<runId>/workspace/`, and import the frozen workspace as
  `../workspace`. Keeping them outside the workspace means copying them
  never changes the frozen content.

## Experiments (`npm run repod -- experiment`)

- **Arms**: A is the pipeline's single-model mode (`singleModelTask`): one
  task from `eval/demo/single-model.json` covering the whole request, on
  the saving preset's critical model, with no planning, triage, review or
  summary; failed attempts are repaired until the run-wide rework limit,
  and a reply that still fails the schema after the format repair ends the
  task, as in coordinated runs. B and C are ordinary coordinated runs with
  the quality and saving presets. Everything else (checks, write scope,
  limits, freeze, holdout) is shared.
- **Report fields used**: `mode`, `costByPhase` (coordination, execution =
  first attempts, rework = later attempts and their triage, review),
  `frozenIntact`, the holdout check result, and the run's ledger for the
  call count.
- **Runner**: rounds of fresh runs under one paid-run lock, results saved
  after every run, early stops on the cumulative budget (a `call_refused`
  with `scope: "total"`), on changed inputs (fingerprints of code,
  configuration, demo kit, baseline and holdout) and on failures outside a
  run's pipeline. Metric definitions are in `eval/README.md`.

## Decisions

- Node 24 runs TypeScript directly through type stripping; `tsc --noEmit` is
  the type checker.
- Run state lives in JSON files and a JSONL event ledger; no database.
- Executors do not get a tool loop; the program supplies file contents.
