import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { listFiles } from "./workspace.ts";

export interface FileSummary {
  path: string;
  bytes: number;
  exports: string[];
  note: string | null; // one-line responsibility, written by a human or a cheap model
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const DECLARATION =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const DEFAULT_EXPRESSION = /^export\s+default\s+(?!(?:abstract\s+)?(?:async\s+)?(?:function|class)\b)/m;

/**
 * Exported names found by pattern matching on top-level `export` lines.
 *
 * Deliberately lightweight: this feeds Meta a map of the repository, not a
 * type-accurate API listing, and avoids depending on the TypeScript compiler
 * API (which differs in the native TypeScript 7 toolchain).
 */
export function extractExports(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(DECLARATION)) names.add(match[1]!);
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const item of match[1]!.split(",")) {
      // "a as b" exports b; "type T" exports T.
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (DEFAULT_EXPRESSION.test(source)) names.add("default");
  return [...names];
}

/** Builds the repository map Meta plans from: every file, its size and exports. */
export async function summarizeRepo(root: string, notes: Record<string, string> = {}): Promise<FileSummary[]> {
  const summaries: FileSummary[] = [];
  for (const relative of await listFiles(root)) {
    const full = path.join(root, ...relative.split("/"));
    const bytes = (await stat(full)).size;
    const exports = SOURCE_EXTENSIONS.has(path.extname(relative)) ? extractExports(await readFile(full, "utf8")) : [];
    summaries.push({ path: relative, bytes, exports, note: notes[relative] ?? null });
  }
  return summaries;
}

/** Compact text form, one line per file, so the summary costs few tokens. */
export function renderRepoSummary(files: FileSummary[]): string {
  return files
    .map((f) => {
      const parts = [`${f.path} (${f.bytes} B)`];
      if (f.exports.length > 0) parts.push(`exports: ${f.exports.join(", ")}`);
      if (f.note) parts.push(f.note);
      return parts.join(" | ");
    })
    .join("\n");
}
