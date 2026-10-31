import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Files executors may never write. Changing any of them could let a model
 * weaken the checks that judge its own work. Patterns are workspace-relative
 * POSIX paths; a trailing "/**" protects a whole directory.
 */
export const PROTECTED_PATTERNS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".gitattributes",
  "test/**", // visible tests are written by humans before the run
];

export class PathRejectedError extends Error {
  readonly requestedPath: string;

  constructor(requestedPath: string, reason: string) {
    super(`Rejected path "${requestedPath}": ${reason}`);
    this.name = "PathRejectedError";
    this.requestedPath = requestedPath;
  }
}

// Windows treats these names as devices in every directory and with any
// extension ("nul.txt" still opens the NUL device).
const RESERVED_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

// Characters Windows forbids in names, plus ":" which would otherwise open an
// NTFS alternate data stream ("a.ts:hidden") instead of a normal file.
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Validates the textual form of a model-supplied path and returns it in
 * normalized POSIX form. Purely lexical: filesystem checks happen in
 * resolveAllowedPath.
 */
export function normalizeRelativePath(requested: string): string {
  if (requested.length === 0) throw new PathRejectedError(requested, "empty path");
  if (path.win32.isAbsolute(requested) || path.posix.isAbsolute(requested)) {
    throw new PathRejectedError(requested, "absolute paths are not allowed");
  }
  if (/^[a-zA-Z]:/.test(requested)) {
    // "C:foo" is drive-relative on Windows and is not caught by isAbsolute.
    throw new PathRejectedError(requested, "drive-qualified paths are not allowed");
  }

  const segments = requested.replaceAll("\\", "/").split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new PathRejectedError(requested, `invalid segment "${segment}"`);
    }
    if (FORBIDDEN_CHARS.test(segment)) {
      throw new PathRejectedError(requested, `forbidden character in "${segment}"`);
    }
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      // Windows silently strips these, so "a.ts." would alias "a.ts".
      throw new PathRejectedError(requested, `segment "${segment}" ends with a space or dot`);
    }
    const stem = segment.split(".")[0]!.toLowerCase();
    if (RESERVED_DEVICE_NAMES.has(stem)) {
      throw new PathRejectedError(requested, `"${segment}" is a reserved Windows device name`);
    }
    if (segment.toLowerCase() === ".git") {
      throw new PathRejectedError(requested, "git internals are not writable");
    }
  }
  return segments.join("/");
}

/**
 * True when a normalized path matches a protected pattern. Comparison is
 * case-insensitive because the Windows filesystem is, so "Package.JSON" must
 * not slip past "package.json".
 */
export function isProtected(normalized: string, patterns: readonly string[] = PROTECTED_PATTERNS): boolean {
  const candidate = normalized.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.endsWith("/**")) {
      const dir = p.slice(0, -3);
      return candidate === dir || candidate.startsWith(dir + "/");
    }
    return candidate === p;
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a model-supplied relative path inside the run workspace, or throws
 * PathRejectedError.
 *
 * Lexical checks alone are not enough: a directory inside the workspace may
 * be a symlink or junction pointing elsewhere. So the deepest existing
 * ancestor of the target is resolved to its real location and must still be
 * inside the workspace's real root. An existing target that is itself a link
 * is rejected outright rather than written through.
 */
export async function resolveAllowedPath(
  workspaceRoot: string,
  requested: string,
  patterns: readonly string[] = PROTECTED_PATTERNS,
): Promise<string> {
  const normalized = normalizeRelativePath(requested);
  if (isProtected(normalized, patterns)) {
    throw new PathRejectedError(requested, "file is protected");
  }

  const realRoot = await realpath(workspaceRoot);
  const target = path.join(realRoot, ...normalized.split("/"));

  const targetStat = await lstat(target).catch(() => null);
  if (targetStat?.isSymbolicLink()) {
    throw new PathRejectedError(requested, "target is a symbolic link");
  }
  if (targetStat?.isDirectory()) {
    throw new PathRejectedError(requested, "target is a directory");
  }

  // Walk up to the nearest existing ancestor; new files and folders are fine
  // as long as that ancestor really lives inside the workspace.
  let ancestor = path.dirname(target);
  while (!(await lstat(ancestor).then(() => true, () => false))) {
    ancestor = path.dirname(ancestor);
  }
  const realAncestor = await realpath(ancestor);
  if (!isInside(realRoot, realAncestor)) {
    throw new PathRejectedError(requested, "path escapes the workspace through a link");
  }

  return target;
}
