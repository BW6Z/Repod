import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface CheckSpec {
  name: string; // e.g. "typecheck", "visible-tests", "holdout-tests"
  // Always an executable plus an argument array, started without a shell.
  // On Windows this means `node <script>` rather than `.cmd` shims, and no
  // string concatenation, so paths with spaces and model-written file names
  // can never be interpreted as shell syntax.
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  expectTests: boolean; // when true, zero executed tests counts as a failure
}

/**
 * Why a check failed. The orchestrator uses this to tell environment
 * problems (never worth escalating to a stronger model) from code problems.
 */
export type CheckFailure = "timeout" | "spawn_error" | "exit_code" | "no_tests";

export interface CheckResult {
  name: string;
  passed: boolean;
  failure: CheckFailure | null;
  exitCode: number | null;
  timedOut: boolean;
  testsRun: number | null;
  output: string; // stdout and stderr interleaved, truncated to maxOutputBytes
  outputTruncated: boolean;
  durationMs: number;
}

// Variables a compiler or test runner legitimately needs. Everything else,
// including API keys, is withheld from model-written code. Matching is
// case-insensitive because Windows environment names are ("Path" vs "PATH").
const ENV_ALLOWLIST = new Set([
  "path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir",
  "home", "userprofile", "lang", "lc_all",
]);

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toLowerCase())) env[key] = value;
  }
  // Plain, uncolored output keeps the test summary parseable.
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

/** Reads the executed-test count from node:test output (TAP or spec reporter). */
export function parseTestCount(output: string): number | null {
  const match = /^(?:#|ℹ) tests (\d+)\s*$/m.exec(output);
  return match ? Number(match[1]) : null;
}

/**
 * Kills a process and everything it started. Killing only the direct child
 * would leave grandchildren running: `node --test` starts one process per test
 * file, and on Windows child.kill() never reaches them.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
      // The process may already be gone; the "close" event decides the outcome.
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // negative pid: the whole process group
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Runs one fixed check in the run workspace.
 *
 * The result is produced only after the child's "close" event, so a timed-out
 * check never reports back while its processes are still running.
 */
export function runCheck(spec: CheckSpec): Promise<CheckResult> {
  const started = Date.now();

  return new Promise((resolve) => {
    let output = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError: Error | null = null;

    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
      // A separate process group lets killTree reach grandchildren on POSIX.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunk: Buffer) => {
      if (truncated) return;
      const room = spec.maxOutputBytes - outputBytes;
      if (chunk.length > room) {
        output += chunk.subarray(0, room).toString("utf8");
        outputBytes = spec.maxOutputBytes;
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
      outputBytes += chunk.length;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, spec.timeoutMs);

    child.on("error", (error) => {
      // e.g. ENOENT when the executable does not exist. "close" still follows.
      spawnError = error;
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (spawnError) output += `\n[spawn error] ${spawnError.message}`;

      const testsRun = spec.expectTests ? parseTestCount(output) : null;
      let failure: CheckFailure | null = null;
      if (spawnError) failure = "spawn_error";
      else if (timedOut) failure = "timeout";
      else if (exitCode !== 0) failure = "exit_code";
      else if (spec.expectTests && !testsRun) failure = "no_tests";

      resolve({
        name: spec.name,
        passed: failure === null,
        failure,
        exitCode,
        timedOut,
        testsRun,
        output,
        outputTruncated: truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}

export interface StandardCheckOptions {
  workspaceRoot: string;
  tscEntry: string; // absolute path to typescript/bin/tsc, run through node
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * The fixed development checks for a TypeScript workspace: a type check and
 * the visible test suite. Both run through the current Node executable so no
 * PATH lookup or shell shim is involved.
 */
export function standardChecks(options: StandardCheckOptions): CheckSpec[] {
  const common = {
    cwd: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  };
  return [
    {
      name: "typecheck",
      executable: process.execPath,
      args: [options.tscEntry, "-p", path.join(options.workspaceRoot, "tsconfig.json")],
      expectTests: false,
      ...common,
    },
    {
      name: "visible-tests",
      executable: process.execPath,
      // node expands the glob itself; TAP output carries a stable "# tests N" line.
      args: ["--test", "--test-reporter=tap", "test/**/*.test.ts"],
      expectTests: true,
      ...common,
    },
  ];
}
