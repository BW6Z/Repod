// Variables a compiler, test runner or git legitimately needs. Everything
// else, including API keys, is withheld from child processes. Matching is
// case-insensitive because Windows environment names are ("Path" vs "PATH").
const ENV_ALLOWLIST = new Set([
  "path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir",
  "home", "userprofile", "lang", "lc_all",
]);

/** A copy of `source` reduced to the allowlisted variables. */
export function minimalEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toLowerCase())) env[key] = value;
  }
  return env;
}
