import { NotImplementedError } from "../shared/errors.ts";

export interface CheckSpec {
  name: string; // e.g. "typecheck", "visible-tests", "holdout-tests"
  // Always an executable plus an argument array, started without a shell.
  // On Windows this means `node <script>` rather than `.cmd` shims, and no
  // string concatenation, so paths with spaces and model-written file names
  // can never be interpreted as shell syntax.
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  expectTests: boolean; // when true, zero executed tests counts as a failure
}

export interface CheckResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  testsRun: number | null;
  output: string; // truncated to the configured byte limit
  durationMs: number;
}

/**
 * Runs one fixed check in the run workspace.
 *
 * The child environment is built from an allowlist, so API keys present in
 * the parent process are never visible to model-written code. On timeout the
 * process is killed and the result is reported only after its "close" event,
 * so no orphaned process keeps running.
 */
export async function runCheck(_spec: CheckSpec): Promise<CheckResult> {
  // TODO: Deferred to the execution-loop milestone (10/31); must be verified
  // on Windows with a workspace path that contains spaces.
  throw new NotImplementedError("runCheck");
}
