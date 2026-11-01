import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InvalidTaskError, TaskPlanError, parseTasks } from "../src/index.ts";

function invalidAt(input: unknown, index: number): void {
  assert.throws(
    () => parseTasks(input),
    (error: unknown) => error instanceof InvalidTaskError && error instanceof TaskPlanError && error.code === "INVALID_TASK" && error.index === index,
  );
}

describe("parseTasks", () => {
  test("fills defaults for missing dependsOn and priority", () => {
    assert.deepEqual(parseTasks([{ id: "a" }, { id: "b", dependsOn: ["a"], priority: 3 }]), [
      { id: "a", dependsOn: [], priority: 0 },
      { id: "b", dependsOn: ["a"], priority: 3 },
    ]);
  });

  test("ignores unknown fields", () => {
    assert.deepEqual(parseTasks([{ id: "a", owner: "me" }]), [{ id: "a", dependsOn: [], priority: 0 }]);
  });

  test("accepts any id without whitespace, including prototype names", () => {
    assert.deepEqual(parseTasks([{ id: "__proto__" }, { id: "constructor" }]).map((t) => t.id), ["__proto__", "constructor"]);
  });

  test("rejects input that is not an array with index -1", () => {
    invalidAt({ id: "a" }, -1);
    invalidAt(null, -1);
  });

  test("reports the first invalid item", () => {
    invalidAt([{ id: "a" }, null, 5], 1);
    invalidAt([{ id: "a" }, ["b"]], 1);
    invalidAt([{ id: "" }], 0);
    invalidAt([{ id: "a b" }], 0);
    invalidAt([{ id: 1 }], 0);
    invalidAt([{ id: "a", dependsOn: null }], 0);
    invalidAt([{ id: "a", dependsOn: ["b c"] }], 0);
    invalidAt([{ id: "a", priority: 1.5 }], 0);
    invalidAt([{ id: "a", priority: 101 }], 0);
    invalidAt([{ id: "a", priority: null }], 0);
  });

  test("rejects holes in sparse arrays like undefined items", () => {
    invalidAt(Array(1), 0);
    invalidAt([{ id: "a" }, , { id: "c" }], 1);
    invalidAt([{ id: "a" }, undefined], 1);
    invalidAt([{ id: "a" }, { id: "b", dependsOn: Array(1) }], 1);
    invalidAt([{ id: "a", dependsOn: ["b", , "c"] }], 0);
    invalidAt([{ id: "a", dependsOn: [undefined] }], 0);
  });

  test("keeps empty and repeated dependencies as given", () => {
    assert.deepEqual(parseTasks([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a", "a"] }]), [
      { id: "a", dependsOn: [], priority: 0 },
      { id: "b", dependsOn: ["a", "a"], priority: 0 },
    ]);
  });

  test("does not modify a frozen input", () => {
    const deps = Object.freeze(["a"]);
    const input = Object.freeze([Object.freeze({ id: "a" }), Object.freeze({ id: "b", dependsOn: deps, priority: 2 })]);
    const result = parseTasks(input);
    assert.deepEqual(result, [{ id: "a", dependsOn: [], priority: 0 }, { id: "b", dependsOn: ["a"], priority: 2 }]);
    assert.notEqual(result[1]?.dependsOn, deps);
  });

  test("does not modify the input and returns new arrays", () => {
    const input = [{ id: "a", dependsOn: ["b"], priority: 1 }];
    const snapshot = JSON.stringify(input);
    const result = parseTasks(input);
    assert.equal(JSON.stringify(input), snapshot);
    assert.notEqual(result[0], input[0]);
    assert.notEqual(result[0]?.dependsOn, input[0]?.dependsOn);
  });
});
