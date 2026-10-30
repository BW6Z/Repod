# Sample repository (demo baseline)

A small TypeScript library that Repod modifies during demos and experiments.
Every run starts from a copy of this directory at a fixed commit; Repod never
edits it in place.

## Planned demo request

Add dependency-order planning to the library, with a CLI, runnable examples,
API comments, README and changelog updates. The core ordering logic (stable
ordering, unknown dependencies, duplicate ids, cycle detection, no input
mutation, defined error types) is the hard part; the rest is routine work.

## Status

- Baseline code: types only (placeholder).
- Behavior rules: not written yet. They must be complete before holdout tests
  are written, because holdout tests may only check stated rules.
- Visible tests: not written yet (`test/`).
