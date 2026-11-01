import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ledgerPath } from "../gateway/ledger.ts";
import type { ExecutorOutput } from "../orchestrator/schemas.ts";
import { minimalEnvironment } from "../shared/env.ts";
import { PathRejectedError, normalizeRelativePath, resolveAllowedPath } from "./paths.ts";

const execFileAsync = promisify(execFile);

export interface RunWorkspace {
  runId: string;
  runDir: string; // runs/<runId>: workspace plus run records
  root: string; // the isolated copy the executors write to
  ledgerFile: string;
  baselineCommit: string;
  // Set when something may still be running in the workspace (a check
  // process that could not be confirmed dead). A tainted workspace accepts
  // no further writes; the run must stop.
  tainted: string | null;
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

/** Raised on any write attempt to a tainted workspace. */
export class WorkspaceTaintedError extends Error {
  constructor(reason: string) {
    super(`Workspace is no longer usable: ${reason}`);
    this.name = "WorkspaceTaintedError";
  }
}

/** Content hash per POSIX path; null means the file did not exist. */
export type FileSnapshot = Record<string, string | null>;

export interface OutputExpectations {
  taskId: string;
  contextVersion: string; // the version the program sent with the task input
  allowedWrites: string[]; // the task's write scope (write_files)
  // State of every file the executor read or may write, taken when its input
  // was assembled. Any difference at write time means the output answers an
  // outdated workspace and is rejected rather than allowed to overwrite.
  snapshot: FileSnapshot;
}

export interface OutputLimits {
  maxFilesPerOutput: number;
  maxFileBytes: number;
}

// Run ids become directory names, so they are restricted to a safe alphabet.
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Directories never copied into, listed in or hashed from a workspace.
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

// Git understands "/dev/null" on every platform, including Git for Windows,
// which rejects the native "\\.\nul" spelling as a config path.
const GIT_NULL = "/dev/null";

// Applied to every git command in a run workspace. Model-written code runs
// in that workspace without a filesystem sandbox and could edit .git/config;
// command-line settings take precedence over it, so options that execute
// commands are switched off here. The internal baseline commit uses a fixed
// identity: run repositories are private scratch copies and never pushed.
const RUN_GIT_SETTINGS = [
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${GIT_NULL}`,
  "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false", // byte-exact: diffs show exactly what executors wrote
  "-c", "core.quotepath=false",
  // The user's own ignore and attributes files (~/.config/git/ignore and
  // attributes) are read even when the global config is replaced; they could
  // drop files from the baseline or turn diffs into "Binary files differ".
  "-c", `core.excludesFile=${GIT_NULL}`,
  "-c", `core.attributesFile=${GIT_NULL}`,
  "-c", "user.name=Repod Run",
  "-c", "user.email=repod-run@localhost",
];

/**
 * Environment for git in a run workspace: no API keys, and the user's system
 * and global git configuration ignored, as well as the system attributes
 * file, so their hooks, signing, excludes or attributes cannot change what a
 * run does or records (the user's own ignore and attributes files are
 * switched off in RUN_GIT_SETTINGS).
 */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...minimalEnvironment(source),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NULL,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...RUN_GIT_SETTINGS, ...args], {
    cwd,
    env: gitEnvironment(),
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
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
  // --force: every copied file is part of the baseline, whatever a
  // .gitignore in the sample says, matching what the freeze manifest hashes.
  await git(root, ["add", "-A", "--force"]);
  await git(root, ["commit", "-q", "-m", "baseline"]);
  const baselineCommit = (await git(root, ["rev-parse", "HEAD"])).trim();

  return { runId, runDir, root, ledgerFile: ledgerPath(runDir), baselineCommit, tainted: null };
}

/** Marks the workspace unusable; every later write is refused. */
export function markTainted(workspace: RunWorkspace, reason: string): void {
  workspace.tainted ??= reason;
}

async function hashOrNull(target: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Records the current state of the given workspace paths (read or write
 * scope): a content hash for existing files, null for files that do not exist
 * yet. Compared again right before an executor's output is written.
 */
export async function captureSnapshot(workspace: RunWorkspace, paths: string[]): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = {};
  for (const requested of paths) {
    // Reading is allowed for protected files, so no protected patterns here.
    const target = await resolveAllowedPath(workspace.root, requested, []);
    snapshot[normalizeRelativePath(requested)] = await hashOrNull(target);
  }
  return snapshot;
}

/**
 * Validates every file in an executor output and only then writes them.
 *
 * One invalid file rejects the whole output, so a run never holds half of an
 * edit. Previous contents are read before anything is written; if a write
 * still fails midway (disk full, file locked by another process), files
 * already written are restored. Folders created along the way are left in
 * place; they are empty and do not affect checks or diffs.
 */
export async function applyExecutorOutput(
  workspace: RunWorkspace,
  output: ExecutorOutput,
  expected: OutputExpectations,
  limits: OutputLimits,
): Promise<string[]> {
  if (workspace.tainted) throw new WorkspaceTaintedError(workspace.tainted);

  const reasons: string[] = [];
  // Write-scope key (lower case) -> the spelling the plan used.
  const allowed = new Map(expected.allowedWrites.map((p) => [normalizeRelativePath(p).toLowerCase(), normalizeRelativePath(p)]));
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
    try {
      relative = normalizeRelativePath(file.path);
    } catch (error) {
      if (error instanceof PathRejectedError) {
        reasons.push(error.message);
        continue;
      }
      throw error;
    }

    // Case-insensitive, because "src/A.ts" and "src/a.ts" are the same file on Windows.
    const key = relative.toLowerCase();
    const plannedSpelling = allowed.get(key);
    if (plannedSpelling === undefined) {
      reasons.push(`"${file.path}" is outside the task's write scope`);
      continue;
    }
    // A new file is created under the plan's spelling, not the executor's:
    // Windows keeps the case a file was first created with, so "Planner.ts"
    // for "planner.ts" would break case-sensitive imports and type checks
    // for good. An existing file keeps its name either way.
    relative = plannedSpelling;
    let target: string;
    try {
      target = await resolveAllowedPath(workspace.root, plannedSpelling);
    } catch (error) {
      if (error instanceof PathRejectedError) {
        reasons.push(error.message);
        continue;
      }
      throw error;
    }
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

  // A path cannot be both a file and a folder of another file in the same
  // output; writing both would fail midway with a file-system error.
  const keys = planned.map((file) => file.relative.toLowerCase());
  for (const [i, key] of keys.entries()) {
    const outer = keys.find((other) => key.startsWith(`${other}/`));
    if (outer) reasons.push(`"${planned[i]!.relative}" lies inside "${outer}", which is also written as a file`);
  }

  // The model echoing the right context_version only proves which input it
  // answered; this proves the workspace still matches that input.
  for (const [relative, recorded] of Object.entries(expected.snapshot)) {
    let current: string | null;
    try {
      current = await hashOrNull(await resolveAllowedPath(workspace.root, relative, []));
    } catch (error) {
      if (!(error instanceof PathRejectedError)) throw error;
      reasons.push(`"${relative}" is no longer a valid path (${error.message})`);
      continue;
    }
    if (current !== recorded) {
      reasons.push(
        recorded === null
          ? `"${relative}" was expected not to exist yet but now does`
          : `"${relative}" changed after the task input was assembled`,
      );
    }
  }

  if (reasons.length > 0) throw new OutputRejectedError(reasons);

  // Only "does not exist" means "new file". Any other read error (for
  // example a locked file) aborts before anything is written, so a rollback
  // can never delete a file it merely failed to read.
  const previous = new Map<string, Buffer | null>();
  for (const file of planned) {
    try {
      previous.set(file.target, await readFile(file.target));
    } catch (error) {
      if (!isMissing(error)) throw error;
      previous.set(file.target, null);
    }
  }

  const written: string[] = [];
  try {
    for (const file of planned) {
      await mkdir(path.dirname(file.target), { recursive: true });
      written.push(file.target);
      await writeFile(file.target, file.content, "utf8");
    }
  } catch (error) {
    // Restore each file independently; one failed restore must not skip the
    // rest or hide the original error.
    const restoreErrors: unknown[] = [];
    for (const target of written) {
      const content = previous.get(target);
      try {
        if (content === null || content === undefined) {
          // A folder at the target is not something this write created (only
          // files are written): leave it rather than report a false failure.
          const isDir = await lstat(target).then((s) => s.isDirectory(), () => false);
          if (!isDir) await rm(target, { force: true });
        } else await writeFile(target, content);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError([error, ...restoreErrors], "Write failed and the workspace could not be fully restored");
    }
    throw error;
  }

  return planned.map((file) => file.relative);
}

/**
 * Every entry below root except .git and node_modules, which are skipped
 * during traversal rather than listed and filtered afterwards.
 */
async function walk(root: string, dir = root, out: Array<{ relative: string; full: string; entry: Dirent }> = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walk(root, full, out);
      continue;
    }
    out.push({ relative: path.relative(root, full).split(path.sep).join("/"), full, entry });
  }
  return out;
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Regular files as sorted POSIX relative paths: plan validation, the repo summary and existence checks. */
export async function listFiles(root: string): Promise<string[]> {
  return (await walk(root))
    .filter(({ entry }) => entry.isFile())
    .map(({ relative }) => relative)
    .sort(byPath);
}

/**
 * SHA-256 of every file in the workspace, tracked or not, keyed by POSIX
 * relative path in sorted order. Check results are bound to this manifest;
 * any change after freezing invalidates them.
 */
export async function snapshotManifest(workspace: RunWorkspace): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const { relative, full, entry } of await walk(workspace.root)) {
    if (entry.isSymbolicLink()) {
      // Recorded by target so a swapped link also changes the manifest.
      files[relative] = "link:" + (await readlink(full));
    } else if (entry.isFile()) {
      files[relative] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => byPath(a, b)));
}

/**
 * Diff against the baseline including new files. A plain `git diff` omits
 * untracked files, so everything is staged first (ignored files too) and the
 * index is compared with the baseline commit. `--text` keeps every change
 * readable even if an attributes file marks it binary.
 *
 * With `paths`, only those files are included: repairs and reviews of one
 * task see that task's write scope, not the visible tests copied into the
 * workspace or other tasks' files. If an earlier task changed the same file,
 * its changes are included too (the diff is against the baseline, not
 * against the state before this task). Paths are matched literally (no glob
 * characters) and by their real spelling on disk, since git pathspecs are
 * case-sensitive.
 */
export async function diffAgainstBaseline(workspace: RunWorkspace, paths?: readonly string[]): Promise<string> {
  await git(workspace.root, ["add", "-A", "--force"]);
  const base = ["--literal-pathspecs", "diff", "--cached", "--no-color", "--no-ext-diff", "--text", workspace.baselineCommit];
  if (paths === undefined) return git(workspace.root, base);

  const realRoot = await realpath(workspace.root);
  const specs: string[] = [];
  for (const requested of paths) {
    try {
      const landing = await resolveAllowedPath(workspace.root, requested, []);
      specs.push(path.relative(realRoot, landing).split(path.sep).join("/"));
    } catch (error) {
      if (!(error instanceof PathRejectedError)) throw error;
    }
  }
  // An empty pathspec would mean "everything".
  return specs.length === 0 ? "" : git(workspace.root, [...base, "--", ...specs]);
}
