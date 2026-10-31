import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "./args.ts";

test("parses commands and the probe model option", () => {
  assert.deepEqual(parseCommand([]), { ok: true, command: null, model: null });
  assert.deepEqual(parseCommand(["spend"]), { ok: true, command: "spend", model: null });
  assert.deepEqual(parseCommand(["probe", "--model", "muse-wonder-1.0"]), { ok: true, command: "probe", model: "muse-wonder-1.0" });
});

test("a stray '--' that would hide --model is an error, not a silent default", () => {
  // What `npm run repod -- probe -- --model x` passes to the script.
  const result = parseCommand(["probe", "--", "--model", "muse-wonder-1.0"]);
  assert.equal(result.ok, false);
});

test("unknown commands, options and misplaced options are errors", () => {
  assert.equal(parseCommand(["deploy"]).ok, false);
  assert.equal(parseCommand(["probe", "--modle", "x"]).ok, false);
  assert.equal(parseCommand(["spend", "--model", "x"]).ok, false);
});
