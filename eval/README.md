# Evaluation

Protocol for checking whether Repod's routing saves cost without lowering
quality. The runner is implemented (`npm run repod -- experiment`) but has
not been run with real models yet.

## Arms

| Arm | Setup | Priority |
|---|---|---|
| A | One strong model does the whole request, same file I/O, checks and repair limits, no coordinator | Required |
| C | Repod with the `saving` preset | Required |
| B | Repod with the `quality` preset (same plan, context and checks; strong model everywhere) | If time allows |

All arms share the baseline commit, request text, holdout tests and budget
cap. Clarifying questions use their default answers and plan revision is
skipped, so runs are repeatable; any human input is counted.

Arm A in detail (`singleModelTask` in `src/eval/experiment.ts`): one task
covering the whole request, run on the saving preset's critical model (the
model arm C escalates to), with every baseline file as context, every check
group's visible tests, and the write scope in `eval/demo/single-model.json`
(only files SPEC.md and the contract name). There is no coordinator, so
there is no planning, triage, review or closing summary; a failed attempt is
repaired with the previous diff and failure evidence until the run-wide
rework limit (`maxTotalReworks`), the same limit that bounds a coordinated
run's repairs. As in arm C, a reply that still fails the schema after the
gateway's one format repair ends the task instead of being retried. Checks,
file limits, freeze and holdout are identical.

## Running

```bash
npm run repod -- experiment --holdout <dir> --arms A,C --runs 1 --label debug
npm run repod -- experiment --holdout <dir> --arms A,C --runs 3 --label formal
```

Runs go in rounds (A, C, A, C, ...), so drift during the day affects every
arm alike. Each run's report stays in `runs/<runId>/report.json`; the
summary goes to `runs/experiments/<experimentId>.json` and is rewritten
after every run, so an interruption keeps the results so far.

The holdout folder must contain `expected-tests.json`
(`{"expectedTests": n}`, the size of the holdout suite counted on the
reference implementation); without it the experiment refuses to start. It
stays private with the holdout tests and is not copied into run folders.

The experiment stops early, keeping its results, when:

- the cumulative budget refuses a call (a run-budget refusal only ends that
  run);
- its inputs change: a fingerprint of `src/`, `config/`, `eval/demo/`,
  `sample-repo/` and the holdout folder is taken at the start, recorded in
  the results with the source commit, and compared before every run;
- something fails outside a run's own pipeline (a workspace that cannot be
  created, a ledger that cannot be read).

## Procedure

1. One debug run per arm, then freeze the protocol.
2. Three formal runs per arm. Debug and formal results are reported separately.
3. Failed runs are reported with their cost.

## Metrics

Holdout pass rate, standardized total cost split into coordination,
execution, review and rework, call count, escalations, wall time, human
interventions.

How they are computed:

- Holdout pass rate: passed / expected, where "expected" is the count in
  `expected-tests.json`, not the number of tests the runner happened to
  execute (a crashed test file or an early `process.exit` would otherwise
  shrink the denominator). Holdout tests run only on a frozen result, so a
  run that did not complete every task scores 0 and is marked "holdout not
  run".
- Holdout fully passed: the holdout check itself succeeded (exit code, no
  timeout, at least the expected number of tests), every expected test
  passed, and the frozen content was unchanged afterwards. Equal counts
  alone do not qualify.
- Cost by phase (list prices): coordination is planning, plan revision and
  the closing summary; execution is each task's first attempt; rework is
  later attempts and the triage before them; review is reviewer calls.
- Calls: requests in the run's ledger, including retries and format repairs.
- Human interventions: none by construction; experiment runs use default
  answers and approve the plan automatically.

Results report median and range; three runs are exploratory evidence only.
Running time of the sample's 20,000-task cases is measured and reported
separately; it is not a pass condition.

## Demo kit (`eval/demo/`)

Trusted input for every run, written before any model sees the repository:

| File | Purpose |
|---|---|
| `request.md` | The user request given to Meta |
| `contract.md` | Interface conventions shown to every executor |
| `checks.json` | Which check kinds exist, the visible test groups with their order (`planner`, then `cli`, then `docs`), and the number of tests in each group and in the baseline |
| `single-model.json` | Arm A's one task: title, acceptance criteria and write scope |
| `visible/*.test.ts` | The groups' tests. Each is copied into the run workspace's `test/` only when the task that owns its group runs |

The rules all tests check are in `sample-repo/SPEC.md`. Visible tests cover
the basic cases; holdout tests cover every edge case of the spec.

## Holdout tests

During the experiments the holdout tests live outside this public
repository. A run copies them to `runs/<runId>/holdout/`, next to the frozen
workspace, and runs them once without showing any result details to a model
(`npm run repod -- run --holdout <dir>`). `.gitignore` and the CI hygiene
check block committing them early. They move to `eval/holdout/` after the
experiments, so results can be reproduced.

Before use, the holdout and visible tests were validated against a private
reference implementation of `SPEC.md` (all pass), and against nine
deliberately wrong implementations (each fails at least one test): ignoring
priority, using `stages.flat()` as the order, counting a repeated dependency
twice, reporting duplicates in discovery order, reversing the cycle path,
modifying the input, a recursive implementation that overflows on long
chains, counting CLI stages from 0, and the wrong exit code for an
unreadable file.
