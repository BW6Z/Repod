import { InvalidTaskError } from "./errors.ts";

/** A task that may depend on other tasks by id. */
export interface TaskSpec {
  id: string;
  dependsOn: string[];
  priority: number;
}

const WHITESPACE = /\s/;

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !WHITESPACE.test(value);
}

/**
 * Turns untrusted input, such as parsed JSON, into tasks. Checks the format
 * only: duplicate ids and missing dependencies are left to the planner.
 * Unknown fields are ignored; the input is never modified.
 *
 * @throws InvalidTaskError for the first invalid item (index -1 when the
 *   input is not an array).
 */
export function parseTasks(input: unknown): TaskSpec[] {
  if (!Array.isArray(input)) {
    throw new InvalidTaskError(-1, "input must be an array of tasks");
  }
  // Array.from visits every index, unlike map and every, which skip the holes
  // of a sparse array: a hole reads as undefined and is rejected like one.
  return Array.from(input, (item: unknown, index): TaskSpec => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new InvalidTaskError(index, `task ${index} must be an object`);
    }
    // Defaults apply only to absent or undefined fields; null stays null and fails.
    const { id, dependsOn = [], priority = 0 } = item as Record<string, unknown>;
    if (!isValidId(id)) {
      throw new InvalidTaskError(index, `task ${index}: id must be a non-empty string without whitespace`);
    }
    if (!Array.isArray(dependsOn) || !Array.from(dependsOn).every(isValidId)) {
      throw new InvalidTaskError(index, `task ${index}: dependsOn must be an array of valid ids`);
    }
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < -100 || priority > 100) {
      throw new InvalidTaskError(index, `task ${index}: priority must be an integer from -100 to 100`);
    }
    return { id, dependsOn: [...dependsOn], priority };
  });
}
