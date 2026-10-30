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
evidence only.
