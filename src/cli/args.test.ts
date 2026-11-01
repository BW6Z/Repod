import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "./args.ts";

const defaults = { model: null, preset: null, experiment: false, holdout: null };

test("parses commands and their options", () => {
  assert.deepEqual(parseCommand([]), { ok: true, command: null, ...defaults });
  assert.deepEqual(parseCommand(["spend"]), { ok: true, command: "spend", ...defaults });
  assert.deepEqual(parseCommand(["probe", "--model", "muse-wonder-1.0"]), { ok: true, command: "probe", ...defaults, model: "muse-wonder-1.0" });
  assert.deepEqual(parseCommand(["run", "--preset", "quality", "--experiment", "--holdout", "../holdout"]), {
    ok: true, command: "run", model: null, preset: "quality", experiment: true, holdout: "../holdout",
  });
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
