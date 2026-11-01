import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { minimalEnvironment } from "../shared/env.ts";

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
  // false when a timed-out process could not be confirmed dead within the
  // grace period. The orchestrator must then stop the run and not write to
  // this workspace again: something may still be running in it.
  processExited: boolean;
  testsRun: number | null;
  testsPassed: number | null; // from the same summary; null when no tests were expected or none was found
  output: string; // stdout and stderr interleaved, truncated to maxOutputBytes
  outputTruncated: boolean;
  durationMs: number;
}

export interface RunCheckOptions {
  // Injectable so tests can simulate a process that cannot be killed.
  kill?: (child: ChildProcess, onError: (message: string) => void) => void;
  killGraceMs?: number;
}

// The summary is printed last, so the tail is kept separately from the
// (possibly truncated) head and always parsed.
const TAIL_BYTES = 8192;
const DEFAULT_KILL_GRACE_MS = 10_000;

/** Environment for model-written code: allowlisted variables, uncolored output. */
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Plain, uncolored output keeps the test summary parseable.
  return { ...minimalEnvironment(source), NO_COLOR: "1", FORCE_COLOR: "0" };
}

/**
 * Reads a count from the node:test summary (TAP or spec reporter): "tests"
 * (executed) or "pass". The last summary line wins: code under test can
 * print "tests N" itself, and the TAP reporter turns such console output
 * into "# tests N" comments that appear before the real summary.
 */
export function parseTestCount(output: string, line: "tests" | "pass" = "tests"): number | null {
  let count: number | null = null;
  for (const match of output.matchAll(new RegExp(`^(?:#|ℹ) ${line} (\\d+)\\s*$`, "gm"))) count = Number(match[1]);
  return count;
}

/**
 * Kills a process and everything it started. Killing only the direct child
 * would leave grandchildren running: `node --test` starts one process per test
 * file, and on Windows child.kill() never reaches them.
 */
function killTree(child: ChildProcess, onError: (message: string) => void): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
      // Also fails when the process already exited; the caller's grace timer
      // decides whether that matters.
      if (error) onError(`taskkill failed: ${error.message}`);
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // negative pid: the whole process group
    } catch (error) {
      onError(`group kill failed: ${(error as Error).message}`);
      child.kill("SIGKILL");
    }
  }
}

/**
 * Runs one fixed check in the run workspace.
 *
 * Normally the result is produced after the child's "close" event, so a
 * timed-out check does not report back while its processes still run. If the
 * kill fails and the child does not close within a grace period, the result
 * is reported anyway with processExited: false rather than waiting forever.
 */
export function runCheck(spec: CheckSpec, options: RunCheckOptions = {}): Promise<CheckResult> {
  const started = Date.now();
  const kill = options.kill ?? killTree;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise((resolve) => {
    // Raw bytes are kept and decoded once at the end, so multi-byte
    // characters split across chunks are not garbled.
    const head: Buffer[] = [];
    let headBytes = 0;
    let tail = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let spawnError: Error | null = null;
    const notes: string[] = [];

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
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
      if (truncated) return;
      const room = spec.maxOutputBytes - headBytes;
      if (chunk.length > room) {
        head.push(chunk.subarray(0, room));
        headBytes = spec.maxOutputBytes;
        truncated = true;
        return;
      }
      head.push(chunk);
      headBytes += chunk.length;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const finish = (exitCode: number | null, processExited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);

      // StringDecoder drops an incomplete trailing character at the cut.
      let output = new StringDecoder("utf8").write(Buffer.concat(head));
      if (spawnError) output += `\n[spawn error] ${spawnError.message}`;
      for (const note of notes) output += `\n[${note}]`;

      const count = (line: "tests" | "pass") => (spec.expectTests ? (parseTestCount(tail.toString("utf8"), line) ?? parseTestCount(output, line)) : null);
      const testsRun = count("tests");
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
        processExited,
        testsRun,
        testsPassed: count("pass"),
        output,
        outputTruncated: truncated,
        durationMs: Date.now() - started,
      });
    };

    let graceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child, (message) => notes.push(message));
      graceTimer = setTimeout(() => {
        notes.push(`process did not exit within ${killGraceMs} ms after the kill`);
        finish(null, false);
      }, killGraceMs);
    }, spec.timeoutMs);

    child.on("error", (error) => {
      // e.g. ENOENT when the executable does not exist. "close" still follows.
      spawnError = error;
    });

    child.on("close", (exitCode) => finish(exitCode, true));
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
