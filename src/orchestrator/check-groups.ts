import { z } from "zod";
import type { PlannedTask } from "./schemas.ts";

/**
 * A named set of visible test files that checks one part of a request.
 *
 * Groups are defined in trusted configuration, never by a model. Meta assigns
 * each group to the task that implements what it tests (`check_groups`), and
 * the pipeline adds a group's tests to the workspace only when that task
 * runs. So a task is never failed by tests for work that comes later, and a
 * task cannot pass without its own tests running.
 */
export const CheckGroup = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  // Plain file names inside the visible tests folder; copied to test/<name>.
  tests: z.array(z.string().regex(/^[A-Za-z0-9._-]+\.test\.ts$/)).min(1),
  requires: z.array(z.string()), // groups whose work must be done first
  // How many tests the group's files contain, counted on a reference
  // implementation. Optional; when every group and the baseline declare it,
  // a visible test run with fewer executed tests fails (see CheckSpec).
  expectedTests: z.number().int().positive().optional(),
});
export type CheckGroup = z.infer<typeof CheckGroup>;

/**
 * Coverage rules for a plan: every group is assigned to exactly one task, no
 * task names an unknown group, and the task of a group depends (directly or
 * through other tasks) on the tasks of the groups it requires.
 */
export function checkGroupProblems(tasks: PlannedTask[], groups: CheckGroup[]): Array<{ taskId: string | null; message: string }> {
  const problems: Array<{ taskId: string | null; message: string }> = [];
  const known = new Set(groups.map((g) => g.name));
  const owner = new Map<string, string[]>();

  for (const task of tasks) {
    for (const name of task.check_groups) {
      if (!known.has(name)) problems.push({ taskId: task.id, message: `unknown check group "${name}"` });
      else owner.set(name, [...(owner.get(name) ?? []), task.id]);
    }
  }
  for (const group of groups) {
    const owners = owner.get(group.name) ?? [];
    if (owners.length === 0) problems.push({ taskId: null, message: `check group "${group.name}" is not assigned to any task` });
    if (owners.length > 1) problems.push({ taskId: null, message: `check group "${group.name}" is assigned to more than one task (${owners.join(", ")})` });
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dependsOnTask = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(byId.get(id)?.depends_on ?? []));
    }
    return false;
  };
  for (const group of groups) {
    const [taskId] = owner.get(group.name) ?? [];
    if (!taskId) continue;
    for (const required of group.requires) {
      const [requiredTask] = owner.get(required) ?? [];
      if (requiredTask && !dependsOnTask(taskId, requiredTask)) {
        problems.push({ taskId, message: `check group "${group.name}" requires "${required}", so ${taskId} must depend on ${requiredTask}` });
      }
    }
  }
  return problems;
}

/** Workspace paths of the visible test files of the given groups. */
export function groupTestPaths(groups: CheckGroup[], names: string[]): string[] {
  return groups.filter((g) => names.includes(g.name)).flatMap((g) => g.tests.map((file) => `test/${file}`));
}
