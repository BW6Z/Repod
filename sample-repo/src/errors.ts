/** Base class of every error this library throws. */
export class TaskPlanError extends Error {
  /** Stable, machine-readable error code. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The input to `parseTasks` is not a valid task list. */
export class InvalidTaskError extends TaskPlanError {
  /** Position of the first invalid task, or -1 when the input is not an array. */
  readonly index: number;

  constructor(index: number, message: string) {
    super("INVALID_TASK", message);
    this.index = index;
  }
}
