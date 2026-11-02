# Server

`view-server.ts` serves the run viewer (`web/`) and the run data under
`runs/` for `npm run repod -- view`:

- built on `node:http`, no dependencies;
- listens on 127.0.0.1 only, and answers only requests addressed to
  `127.0.0.1:<port>` or `localhost:<port>` (a domain rebound to this
  machine is refused);
- read-only (GET and HEAD) unless started with `--interactive`;
- serves only the page's three files and `data/` paths built from run ids
  that match the run id alphabet, so no request can reach a file outside
  the runs folder;
- sends a strict content security policy (`default-src 'self'`).

See `web/README.md` for the data layout.

`session.ts` holds the interactive mode: one paid run of the demo request at
a time, started through the CLI's own `runDemo`, with pipeline hooks that
wait for the page instead of the terminal. Its actions (`POST api/start`,
`api/answers`, `api/review`) are accepted only from the page's own origin,
with the session token in a custom `X-Repod-Token` header and a JSON body
of at most 32 KB, so no other web page can start a paid run.
