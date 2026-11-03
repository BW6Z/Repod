import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "./args.ts";

const defaults = { model: null, preset: null, experiment: false, holdout: null, arms: ["A", "C"], runs: 1, label: null, port: 4173, interactive: false, out: null, include: [] };

test("parses commands and their options", () => {
  assert.deepEqual(parseCommand([]), { ok: true, command: null, ...defaults });
  assert.deepEqual(parseCommand(["spend"]), { ok: true, command: "spend", ...defaults });
  assert.deepEqual(parseCommand(["probe", "--model", "muse-wonder-1.0"]), { ok: true, command: "probe", ...defaults, model: "muse-wonder-1.0" });
  assert.deepEqual(parseCommand(["run", "--preset", "quality", "--experiment", "--holdout", "../holdout"]), {
    ok: true, command: "run", ...defaults, preset: "quality", experiment: true, holdout: "../holdout",
  });
  assert.deepEqual(parseCommand(["experiment", "--holdout", "h", "--arms", "c,a,B", "--runs", "3", "--label", "formal"]), {
    ok: true, command: "experiment", ...defaults, holdout: "h", arms: ["C", "A", "B"], runs: 3, label: "formal",
  });
  assert.deepEqual(parseCommand(["experiment", "--holdout", "h"]), { ok: true, command: "experiment", ...defaults, holdout: "h" });
});

test("a stray '--' that would hide --model is an error, not a silent default", () => {
  // What `npm run repod -- probe -- --model x` passes to the script.
  assert.equal(parseCommand(["probe", "--", "--model", "muse-wonder-1.0"]).ok, false);
});

test("unknown commands, options and options of another command are errors", () => {
  assert.equal(parseCommand(["deploy"]).ok, false);
  assert.equal(parseCommand(["probe", "--modle", "x"]).ok, false);
  assert.equal(parseCommand(["spend", "--model", "x"]).ok, false);
  assert.equal(parseCommand(["probe", "--holdout", "x"]).ok, false);
  assert.equal(parseCommand(["run", "--model", "x"]).ok, false);
});

test("experiment options are validated before anything is spent", () => {
  const errorOf = (argv: string[]) => {
    const parsed = parseCommand(argv);
    return parsed.ok ? null : parsed.error;
  };
  assert.match(errorOf(["experiment"]) ?? "", /needs --holdout/);
  assert.match(errorOf(["experiment", "--holdout", "h", "--arms", "A,D"]) ?? "", /Unknown arm "D"/);
  assert.match(errorOf(["experiment", "--holdout", "h", "--arms", "A,a"]) ?? "", /twice/);
  for (const runs of ["0", "1.5", "x", "11"]) {
    assert.match(errorOf(["experiment", "--holdout", "h", "--runs", runs]) ?? "", /--runs/);
  }
  assert.match(errorOf(["experiment", "--holdout", "h", "--label", "Bad Label"]) ?? "", /--label/);
  assert.equal(parseCommand(["run", "--arms", "A"]).ok, false);
});

test("view takes an optional port within the unprivileged range", () => {
  assert.deepEqual(parseCommand(["view"]), { ok: true, command: "view", ...defaults });
  assert.deepEqual(parseCommand(["view", "--port", "8080"]), { ok: true, command: "view", ...defaults, port: 8080 });
  for (const port of ["80", "70000", "x", "1.5"]) assert.equal(parseCommand(["view", "--port", port]).ok, false, port);
  assert.equal(parseCommand(["run", "--port", "8080"]).ok, false);
});

test("export needs a folder and may pick runs or experiments", () => {
  assert.equal(parseCommand(["export"]).ok, false);
  assert.deepEqual(parseCommand(["export", "--out", "replay"]), { ok: true, command: "export", ...defaults, out: "replay" });
  assert.deepEqual(parseCommand(["export", "--out", "r", "--include", "run-1", "--include", "exp-1"]), {
    ok: true, command: "export", ...defaults, out: "r", include: ["run-1", "exp-1"],
  });
  assert.equal(parseCommand(["view", "--out", "r"]).ok, false);
});
