# Server (planned)

A small Fastify server exposing read-only run data (events by offset, task
state, diff, checks, cost) plus an endpoint to start a run. It will reuse the
same orchestrator and event ledger as the CLI.

Deferred to 11/3, after the CLI pipeline works end to end. Fastify is not a
dependency yet.
