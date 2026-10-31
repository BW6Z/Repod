import { lstat, realpath, stat } from "node:fs/promises";
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
  constructor(requestedPath: string, reason: string) {
    super(`Rejected path "${requestedPath}": ${reason}`);
    this.name = "PathRejectedError";
  }
}

// Windows treats these names as devices in every directory and with any
// extension ("nul.txt" still opens the NUL device), including the console
// handles and the superscript-digit COM/LPT variants.
const RESERVED_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul", "conin$", "conout$",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "com¹", "com²", "com³",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "lpt¹", "lpt²", "lpt³",
]);

// Directories that are never written by executors: git internals could run
// commands, and node_modules is left out of the freeze manifest, so anything
// placed there would escape integrity checks.
const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);

// Characters Windows forbids in names, plus ":" which would otherwise open an
// NTFS alternate data stream ("a.ts:hidden") instead of a normal file.
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

// "PACKAG~1.JSO" is the 8.3 short name of package.json on NTFS volumes that
// generate short names; it would bypass every textual check on long names.
const SHORT_NAME = /~\d/;

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
    if (SHORT_NAME.test(segment)) {
      throw new PathRejectedError(requested, `"${segment}" looks like a Windows 8.3 short name`);
    }
    const stem = segment.split(".")[0]!.toLowerCase();
    if (RESERVED_DEVICE_NAMES.has(stem)) {
      throw new PathRejectedError(requested, `"${segment}" is a reserved Windows device name`);
    }
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
      throw new PathRejectedError(requested, `"${segment}" is not writable`);
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
 * PathRejectedError. Returns the real location the file will be written to.
 *
 * Lexical checks alone are not enough: a directory inside the workspace may
 * be a symlink or junction (to somewhere outside, or to a protected folder
 * inside, such as `alias -> test`), and on Windows one file can be reached
 * under more than one name. So the real landing place is computed (the
 * deepest existing path, resolved through any links, plus the segments that
 * do not exist yet) and the same rules are applied to it as to the requested
 * text: inside the workspace, not under .git or node_modules, not protected.
 * New and existing targets go through exactly the same check.
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

  // The deepest part of the path that already exists: the target itself, or
  // its nearest existing ancestor, which must be a directory.
  let existing = target;
  if (!targetStat) {
    existing = path.dirname(target);
    while (!(await lstat(existing).then(() => true, () => false))) existing = path.dirname(existing);
  }
  const realExisting = await realpath(existing);
  if (existing !== target && !(await stat(realExisting)).isDirectory()) {
    throw new PathRejectedError(requested, "a parent path is a file, not a directory");
  }

  const landing = path.join(realExisting, path.relative(existing, target));
  if (!isInside(realRoot, landing)) {
    throw new PathRejectedError(requested, "path escapes the workspace through a link");
  }
  const canonical = path.relative(realRoot, landing).split(path.sep).join("/");
  if (canonical.toLowerCase().split("/").some((segment) => FORBIDDEN_SEGMENTS.has(segment)) || isProtected(canonical, patterns)) {
    throw new PathRejectedError(requested, `really resolves to "${canonical}", which is not writable`);
  }
  return landing;
}
