import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecutorOutput } from "../orchestrator/schemas.ts";
import { PathRejectedError, normalizeRelativePath, resolveAllowedPath } from "./paths.ts";

const execFileAsync = promisify(execFile);

export interface RunWorkspace {
  runId: string;
  runDir: string; // runs/<runId>: workspace plus run records
  root: string; // the isolated copy the executors write to
  ledgerFile: string;
  baselineCommit: string;
}

/** Raised when an executor output fails validation; nothing has been written. */
export class OutputRejectedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Executor output rejected:\n- ${reasons.join("\n- ")}`);
    this.name = "OutputRejectedError";
    this.reasons = reasons;
  }
}

export interface OutputExpectations {
  taskId: string;
  contextVersion: string; // the version the program sent with the task input
}

export interface OutputLimits {
  maxFilesPerOutput: number;
  maxFileBytes: number;
}

// Run ids become directory names, so they are restricted to a safe alphabet.
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Directories never copied into or hashed from a workspace.
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

// Fixed identity for the internal baseline commit. Run repositories are
// private scratch copies inside runs/ and are never pushed anywhere.
const RUN_GIT_IDENTITY = ["-c", "user.name=Repod Run", "-c", "user.email=repod-run@localhost"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

/**
 * Copies the sample repository baseline into runs/<runId>/workspace and
 * commits it in a fresh git repository there, so every diff is taken against
 * a known starting point rather than a possibly dirty working tree.
 */
export async function createRunWorkspace(baselineDir: string, runsDir: string, runId: string): Promise<RunWorkspace> {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run id "${runId}"`);

  const runDir = path.join(runsDir, runId);
  const root = path.join(runDir, "workspace");
  // A reused run id would mix two runs' files and ledgers.
  if (await lstat(runDir).then(() => true, () => false)) {
    throw new Error(`Run directory already exists: ${runDir}`);
  }

  await mkdir(runDir, { recursive: true });
  await cp(baselineDir, root, {
    recursive: true,
    filter: (source) => !SKIPPED_DIRS.has(path.basename(source)),
  });

  await git(root, ["init", "-q", "-b", "run"]);
  // Byte-exact content: executors write LF and diffs must show what they wrote.
  await git(root, ["config", "core.autocrlf", "false"]);
  await git(root, ["add", "-A"]);
  await git(root, [...RUN_GIT_IDENTITY, "commit", "-q", "-m", "baseline"]);
  const baselineCommit = (await git(root, ["rev-parse", "HEAD"])).trim();

  return { runId, runDir, root, ledgerFile: path.join(runDir, "events.jsonl"), baselineCommit };
}

/**
 * Validates every file in an executor output and only then writes them.
 *
 * One invalid file rejects the whole output, so a run never holds half of an
 * edit. If a write still fails midway (disk full, file locked by another
 * process), files already written are restored to their previous content.
 * Folders created along the way are left in place; they are empty and do not
 * affect checks or diffs.
 */
export async function applyExecutorOutput(
  workspace: RunWorkspace,
  output: ExecutorOutput,
  expected: OutputExpectations,
  limits: OutputLimits,
): Promise<string[]> {
  const reasons: string[] = [];
  if (output.task_id !== expected.taskId) {
    reasons.push(`output is for task "${output.task_id}", expected "${expected.taskId}"`);
  }
  if (output.context_version !== expected.contextVersion) {
    reasons.push("output was produced from a stale context version");
  }
  if (output.files.length > limits.maxFilesPerOutput) {
    reasons.push(`${output.files.length} files exceed the limit of ${limits.maxFilesPerOutput}`);
  }

  const seen = new Set<string>();
  const planned: Array<{ relative: string; target: string; content: string }> = [];
  for (const file of output.files) {
    let relative: string;
    let target: string;
    try {
      relative = normalizeRelativePath(file.path);
      target = await resolveAllowedPath(workspace.root, file.path);
    } catch (error) {
      if (error instanceof PathRejectedError) {
        reasons.push(error.message);
        continue;
      }
      throw error;
    }

    // Case-insensitive, because "src/A.ts" and "src/a.ts" are the same file on Windows.
    const key = relative.toLowerCase();
    if (seen.has(key)) {
      reasons.push(`duplicate path "${file.path}"`);
      continue;
    }
    seen.add(key);

    // CRLF is normalized rather than rejected: it is a harmless, common model
    // habit, and mixed line endings would pollute diffs and token counts.
    const content = file.content.replaceAll("\r\n", "\n");
    if (content.includes("\u0000")) {
      reasons.push(`"${file.path}" looks binary (contains NUL)`);
      continue;
    }
    if (content.includes("\r")) {
      reasons.push(`"${file.path}" contains a bare carriage return`);
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > limits.maxFileBytes) {
      reasons.push(`"${file.path}" exceeds ${limits.maxFileBytes} bytes`);
      continue;
    }
    planned.push({ relative, target, content });
  }

  if (reasons.length > 0) throw new OutputRejectedError(reasons);

  const previous = new Map<string, Buffer | null>();
  try {
    for (const file of planned) {
      previous.set(file.target, await readFile(file.target).catch(() => null));
      await mkdir(path.dirname(file.target), { recursive: true });
      await writeFile(file.target, file.content, "utf8");
    }
  } catch (error) {
    for (const [target, content] of previous) {
      if (content === null) await rm(target, { force: true });
      else await writeFile(target, content);
    }
    throw error;
  }

  return planned.map((file) => file.relative);
}

async function collectFiles(root: string, dir: string, out: Record<string, string>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await collectFiles(root, full, out);
    } else if (entry.isSymbolicLink()) {
      // Recorded by target so a swapped link also changes the manifest.
      out[relative] = "link:" + (await readlink(full));
    } else if (entry.isFile()) {
      out[relative] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  }
}

/**
 * SHA-256 of every file in the workspace, tracked or not, keyed by POSIX
 * relative path in sorted order. Check results are bound to this manifest;
 * any change after freezing invalidates them.
 */
export async function snapshotManifest(workspace: RunWorkspace): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await collectFiles(workspace.root, workspace.root, files);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Diff against the baseline including new files. A plain `git diff` omits
 * untracked files, so everything is staged first and the index is compared
 * with the baseline commit.
 */
export async function diffAgainstBaseline(workspace: RunWorkspace): Promise<string> {
  await git(workspace.root, ["add", "-A"]);
  return git(workspace.root, [
    "-c", "core.quotepath=false",
    "diff", "--cached", "--no-color", "--no-ext-diff",
    workspace.baselineCommit,
  ]);
}
