# Web UI (planned)

A minimal React + Vite UI that reads run data from the server:

- Conversation with Meta in the center (request, clarifying questions, plan
  approval or one revision, final summary).
- Task panel: task, model, reason, dependencies, status.
- Results panel: diff, checks, review findings, usage and cost.

Style: muted blue (Morandi) palette, simple layout, no decorative effects.
Progress is read by incremental polling of the event ledger.

Deferred to 11/3. React and Vite are not dependencies yet.
