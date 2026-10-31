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

## Gateway call sequence

1. Reserve budget for the worst case (uncached input + full output limit).
2. Append `call_start` to the ledger.
3. Call the adapter (SDK retries disabled; the gateway owns retries).
4. Reject truncated or refused output.
5. Validate with the Zod schema; allow one format repair.
6. Compute standardized cost from `config/pricing.json`.
7. Append `call_end` and return.

## Workspace and checks

- **Run workspace**: `runs/<runId>/workspace` is a copy of the baseline
  (without `node_modules` and `.git`) committed in its own git repository
  with `core.autocrlf=false`. It is never pushed.
- **Writing executor output**: every file is validated first (task id,
  context version, file count and size, path allowlist, protected files,
  duplicates compared case-insensitively, no NUL or bare CR). CRLF is
  normalized to LF. One invalid file rejects the whole output; a failed write
  restores the files already written.
- **Path allowlist**: rejects absolute, drive-qualified, UNC and device paths,
  `.` and `..` segments, Windows reserved names (with any extension),
  alternate data streams, trailing spaces or dots, `.git`, protected files,
  and any path whose nearest existing ancestor resolves outside the workspace
  through a symlink or junction.
- **Diff**: `git add -A` then `git diff --cached <baseline>`, so new files are
  included.
- **Manifest**: SHA-256 of every file except `.git` and `node_modules`.
- **Checks**: `node <tsc> -p tsconfig.json` and
  `node --test --test-reporter=tap test/**/*.test.ts`, started without a
  shell. Failures are classified as `timeout`, `spawn_error`, `exit_code` or
  `no_tests`, so environment problems are never mistaken for code problems.

## Decisions

- Node 24 runs TypeScript directly through type stripping; `tsc --noEmit` is
  the type checker.
- Run state lives in JSON files and a JSONL event ledger; no database.
- Executors do not get a tool loop; the program supplies file contents.
