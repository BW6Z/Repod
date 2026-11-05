// Visible checks for the "planner" group. They cover the basic cases of
// SPEC.md section 2; edge cases are covered by holdout tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CycleError, DuplicateTaskError, TaskPlanError, UnknownDependencyError, planOrder, type TaskSpec } from "../src/index.ts";

const task = (id: string, dependsOn: string[] = [], priority = 0): TaskSpec => ({ id, dependsOn, priority });

describe("planOrder", () => {
  test("orders a chain and puts each task in its own stage", () => {
    const result = planOrder([task("package", ["build"]), task("build", ["compile"]), task("compile")]);
    assert.deepEqual(result.order, ["compile", "build", "package"]);
    assert.deepEqual(result.stages, [["compile"], ["build"], ["package"]]);
  });

  test("picks the highest priority among ready tasks, then input order", () => {
    const result = planOrder([task("a"), task("b", [], 5), task("c")]);
    assert.deepEqual(result.order, ["b", "a", "c"]);
    assert.deepEqual(result.stages, [["b", "a", "c"]]);
  });

  test("order is not stages.flat(): an unblocked task competes immediately (SPEC R2 example)", () => {
    const result = planOrder([task("a"), task("b", [], -1), task("c", ["a"], 10)]);
    assert.deepEqual(result.order, ["a", "c", "b"]);
    assert.deepEqual(result.stages, [["a", "b"], ["c"]]);
  });

  test("an empty list plans to nothing", () => {
    assert.deepEqual(planOrder([]), { order: [], stages: [] });
  });

  test("reports duplicate ids", () => {
    assert.throws(
      () => planOrder([task("a"), task("a")]),
      (e: unknown) => e instanceof DuplicateTaskError && e instanceof TaskPlanError && e.code === "DUPLICATE_ID" && e.taskIds.join() === "a",
    );
  });

  test("reports an unknown dependency with the task and the missing id", () => {
    assert.throws(
      () => planOrder([task("a", ["ghost"])]),
      (e: unknown) => e instanceof UnknownDependencyError && e.code === "UNKNOWN_DEPENDENCY" && e.taskId === "a" && e.dependency === "ghost",
    );
  });

  test("reports a cycle as a closed simple path along dependencies", () => {
    const tasks = [task("a", ["b"]), task("b", ["a"])];
    try {
      planOrder(tasks);
      assert.fail("expected a CycleError");
    } catch (e) {
      assert.ok(e instanceof CycleError);
      assert.equal(e.code, "CYCLE");
      const cycle = e.cycle;
      assert.equal(cycle[0], cycle.at(-1));
      assert.equal(new Set(cycle.slice(0, -1)).size, cycle.length - 1);
      for (let i = 0; i < cycle.length - 1; i++) {
        const from = tasks.find((t) => t.id === cycle[i]);
        assert.ok(from?.dependsOn.includes(cycle[i + 1]!), `${cycle[i]} must depend on ${cycle[i + 1]}`);
      }
    }
  });
});
