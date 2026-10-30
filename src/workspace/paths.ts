import { NotImplementedError } from "../shared/errors.ts";

/**
 * Files executors may never write. Changing any of them could let a model
 * weaken the checks that judge its own work.
 */
export const PROTECTED_PATTERNS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "test/**", // visible tests are written by humans before the run
];

/**
 * Resolves a model-supplied relative path inside the run workspace, or throws.
 *
 * Must reject: absolute paths, drive letters, UNC and device paths (CON, NUL,
 * \\?\...), ".." segments, symlinks or junctions that resolve outside the
 * workspace, and anything matching PROTECTED_PATTERNS. The check is made on
 * the fully resolved real path, not on the string the model sent.
 */
export function resolveAllowedPath(_workspaceRoot: string, _relativePath: string): string {
  // TODO: Implement with Windows-specific unit tests. Deferred to the
  // execution-loop milestone (10/31); no executor output may be written to
  // disk until this exists.
  throw new NotImplementedError("resolveAllowedPath");
}
