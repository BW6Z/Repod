import { NotImplementedError } from "../shared/errors.ts";

export interface RunOptions {
  request: string;
  presetName: string;
  configDir: string;
  baselineDir: string; // sample repository at its fixed baseline
  runsDir: string; // where per-run workspaces and ledgers are created
  experimentMode: boolean; // default answers, no plan revision, no prompts to the user
}

/**
 * Runs one request end to end. Phases, in order:
 *   1. prepare      copy the baseline into a run workspace; build the repo summary
 *   2. plan         Meta returns clarifying questions or a plan (validated)
 *   3. approve      user approves, or sends the plan back once for revision
 *   4. execute      tasks in dependency order, one writer at a time; dev checks
 *                   after each task; Meta triages failures within fixed limits
 *   5. review       strong model reviews core diffs; findings are triaged
 *   6. freeze       hash every file; run holdout checks once, no feedback
 *   7. summarize    Meta writes the closing message; the program fills numbers
 */
export async function runPipeline(_options: RunOptions): Promise<void> {
  // TODO: Implement phase by phase. Phases 1, 4 and 6 come first (10/31 gate:
  // one real model edits the sample repo and checks pass on Windows); planning
  // and triage follow (11/1 gate); review and plan revision are the first
  // features cut if time runs out.
  throw new NotImplementedError("runPipeline");
}
