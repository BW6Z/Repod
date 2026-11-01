# task-planner-sample: specification

This is the complete, public set of rules for this library. Every test,
visible or holdout, checks only what is written here. Anything this file
leaves open is deliberately unspecified and is not tested.

Section 1 describes the baseline that exists before a Repod run. Sections 2
to 4 describe the planning feature a Repod run is asked to add.

## 1. Baseline: tasks and parsing

```ts
interface TaskSpec {
  id: string;
  dependsOn: string[];
  priority: number;
}
```

### `parseTasks(input: unknown): TaskSpec[]`

Turns untrusted input (for example parsed JSON) into tasks. It checks the
format only; duplicate ids and missing dependencies are not its concern.

- `input` must be an array. Otherwise it throws `InvalidTaskError` with
  `index` -1.
- Every item must be a plain object (not `null`, not an array).
- `id`: a non-empty string containing no whitespace (no character matching
  the JavaScript regular expression `\s`). Ids are case-sensitive and are
  not trimmed or converted. Any such string is a valid id, including
  `__proto__` or `constructor`.
- `dependsOn`: optional. When absent (or `undefined`) it becomes `[]`. When
  present it must be an array of valid ids. `null` is invalid.
- `priority`: optional. When absent (or `undefined`) it becomes `0`. When
  present it must be an integer from -100 to 100. `null`, fractions, `NaN`
  and infinities are invalid.
- Unknown fields are ignored and not copied to the result.
- The first invalid item (lowest index) throws `InvalidTaskError` with that
  `index`.
- The input is never modified. The result contains new task objects and new
  `dependsOn` arrays.

### Errors

- `TaskPlanError extends Error` is the base class of every error the library
  throws. It has a `code: string`.
- `InvalidTaskError extends TaskPlanError`: `code` is `"INVALID_TASK"`, and
  `index: number` is the position of the invalid item (-1 when the input is
  not an array).

Tests check the class, `code` and the documented fields. Messages are not
specified.

### Public entry

Everything public is exported from `src/index.ts`, and tests import only
from there.

## 2. Feature: `planOrder(tasks: TaskSpec[]): PlanResult`

```ts
interface PlanResult {
  order: string[];    // every task id, in execution order
  stages: string[][]; // stages[k]: the tasks that can run at the earliest in round k
}
```

`planOrder` expects tasks in the shape `parseTasks` returns. It decides
everything about duplicates, dependencies and cycles itself. Behavior for
input that does not have that shape is unspecified.

### R1: `order`

- Every task comes after all tasks it depends on.
- The order is built one task at a time. At each step, among all tasks whose
  dependencies are already in the order, pick the one with the highest
  `priority`; on a tie, the one that comes first in the input.
- As soon as a task is placed, the tasks it unblocks join the candidates for
  the very next step. There is no notion of finishing a whole round first.
- The result is fully determined by the input.

### R2: `stages`

- A task with no dependencies is in round 0. Any other task is in round
  1 + the highest round among its dependencies.
- `stages[k]` lists the tasks of round k, ordered by `priority` (highest
  first) and then by input position. No stage is empty.
- `order` is generally not the same as `stages.flat()`. Example:

  | position | id | dependsOn | priority |
  |---|---|---|---|
  | 0 | a | [] | 0 |
  | 1 | b | [] | -1 |
  | 2 | c | [a] | 10 |

  `order` is `["a", "c", "b"]`: once `a` is placed, `c` (priority 10) beats
  `b` (priority -1). `stages` is `[["a", "b"], ["c"]]`.

### R3: errors

Checked in this order; only the first kind found is thrown:

1. **Duplicate ids**: `DuplicateTaskError`, `code` `"DUPLICATE_ID"`,
   `taskIds: string[]` lists every id that occurs more than once, each once,
   ordered by its first position in the input. Ids `[x, y, y, x]` give
   `["x", "y"]`.
2. **Unknown dependency**: `UnknownDependencyError`, `code`
   `"UNKNOWN_DEPENDENCY"`, with `taskId: string` (the task) and
   `dependency: string` (the missing id). If there are several, the one
   reported is in the earliest task, and within that task the earliest entry
   of `dependsOn`.
3. **Cycle**, including a task depending on itself: `CycleError`, `code`
   `"CYCLE"`, with `cycle: string[]`, a closed path: the first and last ids
   are equal, each id depends on the id after it, and no id appears twice
   before the closing one (a simple cycle). A task depending on itself gives
   `["a", "a"]`. Which cycle is reported, and where it starts, is
   unspecified.

All three classes extend `TaskPlanError` and are exported from
`src/index.ts`, as are `planOrder` and the `PlanResult` type.

### R4: other rules

- A dependency listed more than once in the same `dependsOn` counts once.
- An empty array gives `{ order: [], stages: [] }`.
- The input array and task objects are not modified.
- Scale: 20,000 tasks forming one dependency chain, and 20,000 tasks forming
  one cycle, must be handled correctly without a stack overflow, also when
  dependencies appear later in the input than the tasks that need them.
  Running time is measured and reported separately; it is not a pass
  condition.

## 3. Feature: the `plan` command

```
node src/cli.ts plan <file.json> [--json]
```

`--json` may appear anywhere after `plan`. A relative file path is resolved
against the current working directory. The file is read as UTF-8 JSON, then
passed through `parseTasks` and `planOrder`.

**Default output** (stdout): one line per stage, counted from 1, then the
order:

```
Stage 1: a, b
Stage 2: c
Order: a, b, c
```

Ids are joined with `", "`. For an empty task list the output is the single
line `Order:` (no trailing space).

**`--json` output** (stdout): one line of JSON with the `order` and `stages`
of `PlanResult`. Key order and spacing are unspecified; tests compare the
parsed value.

Every output ends with a newline (LF or CRLF). On success stderr is empty.

| Situation | Exit code | stdout | stderr |
|---|---|---|---|
| Success | 0 | the result | empty |
| The file is not valid JSON | 1 | empty | one line `error INVALID_JSON: <description>` |
| A library error (`TaskPlanError`) | 1 | empty | one line `error <code>: <description>` |
| Usage error: missing or extra arguments, unknown command or option, `--json` given twice | 2 | empty | a usage message |
| The file cannot be read (missing, a directory, no permission) | 2 | empty | one line `error: <reason>`, then a usage message |

## 4. Feature: example and documentation

- `examples/basic.ts` runs with `node examples/basic.ts`, imports from
  `../src/index.ts`, calls `planOrder` on exactly these tasks:

  | id | dependsOn | priority |
  |---|---|---|
  | compile | [] | 0 |
  | test | [compile] | 0 |
  | docs | [] | 5 |
  | package | [compile, test] | 0 |

  and prints the result in the default `plan` format:

  ```
  Stage 1: docs, compile
  Stage 2: test
  Stage 3: package
  Order: docs, compile, test, package
  ```

- `README.md` has a `## Planning` section that names `planOrder`,
  `DuplicateTaskError`, `UnknownDependencyError`, `CycleError` and the
  `node src/cli.ts plan` command, and points to `examples/basic.ts`. Every
  name it uses must really be exported. Every ```` ```ts ```` code block in
  the README must type-check on its own; such blocks import only from
  `./src/index.ts`.
- `CHANGELOG.md` has an entry under `## Unreleased` that mentions
  `planOrder`.
- Public functions and classes added by the feature carry API comments.
