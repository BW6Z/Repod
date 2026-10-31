import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PROTECTED_PATTERNS, normalizeRelativePath, resolveAllowedPath } from "../workspace/paths.ts";
import type { PlannedTask } from "./schemas.ts";

export interface ContextFile {
  path: string; // POSIX relative path
  content: string;
}

/** What a repair or escalation attempt learns from the attempt before it. */
export interface PreviousAttempt {
  model: string;
  diff: string; // changes made so far, against the baseline
  failure: string; // check output or review evidence
}

export interface ExecutorInputParts {
  task: PlannedTask;
  files: ContextFile[];
  contract: string; // fixed interface conventions for the sample repository
  previous: PreviousAttempt | null;
  guidance: string | null; // Meta's triage instructions for this attempt
  needFilesAllowed: boolean; // whether this attempt may still ask for more files
}

// Long logs mostly repeat; the head holds the first (usually root) error.
const MAX_FAILURE_CHARS = 8000;

/**
 * Reads the files Meta selected for a task. Protected files such as tests
 * may be read (they are only protected from writes), but every path still
 * goes through the workspace allowlist and link checks.
 */
export async function readContextFiles(workspaceRoot: string, paths: string[]): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  for (const requested of paths) {
    const target = await resolveAllowedPath(workspaceRoot, requested, []);
    files.push({ path: normalizeRelativePath(requested), content: await readFile(target, "utf8") });
  }
  return files;
}

/**
 * Identifies exactly what an executor was asked to do and what it saw: every
 * task field, the contract, guidance, the previous attempt and the file
 * contents. Output that echoes an older version answers an outdated request
 * (a revised task, new guidance, changed files) and is rejected before
 * writing. File order does not matter.
 */
export function contextVersion(parts: ExecutorInputParts): string {
  const files = [...parts.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const material = {
    task: parts.task,
    contract: parts.contract,
    guidance: parts.guidance,
    previous: parts.previous,
    needFilesAllowed: parts.needFilesAllowed,
    files,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

/** Human-readable list of protected paths for the reply rules ("test/**" -> "test/"). */
function protectedList(): string {
  return PROTECTED_PATTERNS.map((p) => (p.endsWith("/**") ? p.slice(0, -2) : p)).join(", ");
}

/**
 * Assembles an executor's whole input: the task, its acceptance criteria, the
 * contract and full file contents. The executor gets nothing else (no chat
 * history, no unrelated files), which keeps both cost and confusion down.
 * The same format serves first attempts, repairs and escalations; for the
 * latter two the previous attempt's diff and failure evidence are included so
 * a stronger model continues the work instead of starting over.
 */
export function buildExecutorInput(parts: ExecutorInputParts): { input: string; contextVersion: string } {
  const { task, files, contract, previous, guidance, needFilesAllowed } = parts;
  const version = contextVersion(parts);

  const sections = [
    `# Task ${task.id}: ${task.title}`,
    task.description,
    "## Acceptance criteria",
    task.acceptance.map((a) => `- ${a}`).join("\n"),
    "## Interface contract",
    contract,
  ];

  if (previous) {
    const failure =
      previous.failure.length > MAX_FAILURE_CHARS
        ? previous.failure.slice(0, MAX_FAILURE_CHARS) + "\n[... output truncated ...]"
        : previous.failure;
    sections.push(
      `## Previous attempt (${previous.model})`,
      "Changes made so far:",
      "```diff\n" + previous.diff + "\n```",
      "Why it failed:",
      "```\n" + failure + "\n```",
    );
  }
  if (guidance) sections.push("## Coordinator guidance", guidance);

  // Generated from the same lists the program enforces, so the instructions
  // can never drift from the actual rules.
  const rules = [
    `Set task_id to "${task.id}" and context_version to "${version}".`,
    "Return every file you change or create in full in `files` (whole-file replacement, LF line endings).",
    `Do not modify these protected paths: ${protectedList()}.`,
    needFilesAllowed
      ? "If you cannot finish without seeing other existing files, return no files and list their paths in `need_files`. You can do this only once."
      : "Leave `need_files` empty: no further files can be provided for this attempt.",
  ];

  sections.push(
    "## Files",
    files.map((f) => `=== FILE: ${f.path} ===\n${f.content}\n=== END FILE: ${f.path} ===`).join("\n\n"),
    "## Reply",
    rules.join("\n"),
  );

  return { input: sections.join("\n\n"), contextVersion: version };
}
