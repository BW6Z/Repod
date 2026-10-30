/**
 * A task that may depend on other tasks by id.
 *
 * This is the baseline of the demo library. The demo request asks Repod to add
 * dependency-order planning (cycle detection, stable ordering, error types), a
 * CLI, examples and documentation on top of it.
 */
export interface TaskSpec {
  id: string;
  dependsOn: string[];
}

// TODO: Add the baseline's existing behavior (for example input parsing and
// validation) and its visible tests. Deferred until the behavior rules for
// the demo request are written down (10/31), because holdout tests may only
// check rules that the request states explicitly.
