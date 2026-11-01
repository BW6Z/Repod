# Evaluation

Protocol for checking whether Repod's routing saves cost without lowering
quality. Nothing here has been run yet.

## Arms

| Arm | Setup | Priority |
|---|---|---|
| A | One strong model does the whole request, same file I/O, checks and repair limits, no coordinator | Required |
| C | Repod with the `saving` preset | Required |
| B | Repod with the `quality` preset (same plan, context and checks; strong model everywhere) | If time allows |

All arms share the baseline commit, request text, holdout tests and budget
cap. Clarifying questions use their default answers and plan revision is
skipped, so runs are repeatable; any human input is counted.

## Procedure

1. One debug run per arm, then freeze the protocol.
2. Three formal runs per arm. Debug and formal results are reported separately.
3. Failed runs are reported with their cost.

## Metrics

Holdout pass rate, standardized total cost split into coordination,
execution, review and rework, call count, escalations, wall time, human
interventions. Results report median and range; three runs are exploratory
evidence only. Running time of the sample's 20,000-task cases is measured
and reported separately; it is not a pass condition.

## Demo kit (`eval/demo/`)

Trusted input for every run, written before any model sees the repository:

| File | Purpose |
|---|---|
| `request.md` | The user request given to Meta |
| `contract.md` | Interface conventions shown to every executor |
| `checks.json` | Which check kinds exist, and the visible test groups with their order (`planner`, then `cli`, then `docs`) |
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
