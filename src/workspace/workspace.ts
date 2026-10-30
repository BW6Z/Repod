import { NotImplementedError } from "../shared/errors.ts";
import type { ExecutorOutput } from "../orchestrator/schemas.ts";

export interface RunWorkspace {
  runId: string;
  root: string; // the isolated copy the executors write to
  ledgerFile: string;
  baselineCommit: string;
}

/**
 * Copies the sample repository at its fixed baseline into runs/<runId>/ and
 * initializes a git repository there, so diffs are always against a known
 * starting point rather than a possibly dirty working tree.
 */
export async function createRunWorkspace(_baselineDir: string, _runsDir: string, _runId: string): Promise<RunWorkspace> {
  // TODO: Deferred to the execution-loop milestone (10/31).
  throw new NotImplementedError("createRunWorkspace");
}

/**
 * Validates every file in an executor output first (paths, protected files,
 * size and count limits, UTF-8 with LF line endings, context version) and only
 * then writes them. One invalid file rejects the whole output, so a run never
 * contains half of an edit.
 */
export async function applyExecutorOutput(_workspace: RunWorkspace, _output: ExecutorOutput, _expectedContextVersion: string): Promise<string[]> {
  // TODO: Deferred to the execution-loop milestone (10/31). Depends on
  // resolveAllowedPath.
  throw new NotImplementedError("applyExecutorOutput");
}

/**
 * Content hash of every file in the workspace (tracked or not). Check results
 * are bound to this manifest; any change after freezing invalidates them.
 */
export async function snapshotManifest(_workspace: RunWorkspace): Promise<Record<string, string>> {
  // TODO: Deferred to the freeze milestone (11/2).
  throw new NotImplementedError("snapshotManifest");
}

/**
 * Diff against the baseline including new files: stage everything
 * (`git add -A`) and then run `git diff --cached <baseline>`. A plain
 * `git diff` would omit untracked files.
 */
export async function diffAgainstBaseline(_workspace: RunWorkspace): Promise<string> {
  // TODO: Deferred to the execution-loop milestone (10/31).
  throw new NotImplementedError("diffAgainstBaseline");
}
