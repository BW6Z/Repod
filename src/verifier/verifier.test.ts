import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { childEnvironment, parseTestCount, runCheck, type CheckSpec } from "./verifier.ts";

// A space in the folder name mirrors the real project path on this machine.
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "repod verifier "));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function nodeCheck(code: string, overrides: Partial<CheckSpec> = {}): CheckSpec {
  return {
    name: "probe",
    executable: process.execPath,
    args: ["-e", code],
    cwd: dir,
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
    expectTests: false,
    ...overrides,
  };
}

describe("runCheck", () => {
  test("passes on exit code 0 and captures output", async () => {
    const result = await runCheck(nodeCheck("console.log('hello')"));
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /hello/);
  });

  test("fails with exit_code on a non-zero exit", async () => {
    const result = await runCheck(nodeCheck("process.exit(3)"));
    assert.equal(result.passed, false);
    assert.equal(result.failure, "exit_code");
    assert.equal(result.exitCode, 3);
  });

  test("kills a hanging process and reports a timeout only after it closed", async () => {
    const result = await runCheck(nodeCheck("setInterval(() => {}, 1000)", { timeoutMs: 500 }));
    assert.equal(result.passed, false);
    assert.equal(result.failure, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.processExited, true);
  });

  test("returns within the grace period when the process cannot be killed", async () => {
    // The kill is a no-op, as when taskkill is unavailable. The child exits on
    // its own after 3 s, so nothing is left behind after the test.
    const started = Date.now();
    // cwd outside the shared temp folder: on Windows a still-running child
    // would keep that folder locked and break cleanup.
    const result = await runCheck(nodeCheck("setTimeout(() => {}, 3000)", { timeoutMs: 200, cwd: tmpdir() }), {
      kill: (_child, onError) => onError("kill unavailable"),
      killGraceMs: 300,
    });
    assert.ok(Date.now() - started < 2500, "must not wait for the child to finish");
    assert.equal(result.failure, "timeout");
    assert.equal(result.processExited, false);
    assert.match(result.output, /kill unavailable/);
    assert.match(result.output, /did not exit within 300 ms/);
  });

  test("reports spawn_error when the executable does not exist", async () => {
    const result = await runCheck(nodeCheck("", { executable: path.join(dir, "missing-binary") }));
    assert.equal(result.passed, false);
    assert.equal(result.failure, "spawn_error");
  });

  test("does not pass API keys to the child process", async () => {
    process.env.REPOD_TEST_SECRET_KEY = "should-not-leak";
    try {
      const result = await runCheck(nodeCheck("console.log(process.env.REPOD_TEST_SECRET_KEY ?? 'absent')"));
      assert.match(result.output, /absent/);
      assert.doesNotMatch(result.output, /should-not-leak/);
    } finally {
      delete process.env.REPOD_TEST_SECRET_KEY;
    }
  });

  test("truncates output at the byte limit", async () => {
    const result = await runCheck(nodeCheck("process.stdout.write('x'.repeat(5000))", { maxOutputBytes: 100 }));
    assert.equal(result.outputTruncated, true);
    assert.equal(result.output.length, 100);
  });

  test("counts executed tests and fails when none ran", async () => {
    await mkdir(path.join(dir, "test"), { recursive: true });
    await writeFile(
      path.join(dir, "test", "sample.test.ts"),
      "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n",
    );
    const spec: CheckSpec = {
      ...nodeCheck(""),
      args: ["--test", "--test-reporter=tap", "test/**/*.test.ts"],
      expectTests: true,
    };
    const ran = await runCheck(spec);
    assert.equal(ran.passed, true, ran.output);
    assert.equal(ran.testsRun, 2);

    const none = await runCheck({ ...spec, args: ["--test", "--test-reporter=tap", "nothing/**/*.test.ts"] });
    assert.equal(none.passed, false);
    assert.ok(none.failure === "no_tests" || none.failure === "exit_code");
  });

  test("ignores 'tests N' printed by the code under test and finds the summary after truncation", async () => {
    await mkdir(path.join(dir, "noisy"), { recursive: true });
    await writeFile(
      path.join(dir, "noisy", "noisy.test.ts"),
      "import { test } from 'node:test';\nconsole.log('tests 99');\nconsole.log('x'.repeat(20000));\ntest('one', () => {});\n",
    );
    const result = await runCheck({
      ...nodeCheck(""),
      args: ["--test", "--test-reporter=tap", "noisy/**/*.test.ts"],
      expectTests: true,
      maxOutputBytes: 1000, // the summary lies beyond the kept head
    });
    assert.equal(result.outputTruncated, true);
    assert.equal(result.testsRun, 1);
    assert.equal(result.passed, true, result.output);
  });

  test("does not garble a multi-byte character cut by truncation", async () => {
    // 100 bytes end inside the 34th three-byte character.
    const result = await runCheck(nodeCheck("process.stdout.write('测试'.repeat(100))", { maxOutputBytes: 100 }));
    assert.equal(result.output, "测试".repeat(100).slice(0, 33));
    assert.doesNotMatch(result.output, /�/);
  });
});

describe("helpers", () => {
  test("childEnvironment keeps only allowlisted variables", () => {
    const env = childEnvironment({ Path: "/bin", ANTHROPIC_API_KEY: "k", MODEL_API_KEY: "k", TEMP: "/tmp" });
    assert.equal(env.Path, "/bin");
    assert.equal(env.TEMP, "/tmp");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.MODEL_API_KEY, undefined);
  });

  test("parseTestCount reads TAP and spec summaries", () => {
    assert.equal(parseTestCount("ok 1\n# tests 4\n# pass 4\n"), 4);
    assert.equal(parseTestCount("ℹ tests 7\nℹ pass 7\n"), 7);
    assert.equal(parseTestCount("# tests 99\nok 1\n# tests 1\n"), 1); // last summary wins
    assert.equal(parseTestCount("no summary"), null);
    assert.equal(parseTestCount("# tests 5\n# pass 3\n# fail 2\n", "pass"), 3);
    assert.equal(parseTestCount("ℹ tests 7\nℹ pass 7\n", "pass"), 7);
  });
});
