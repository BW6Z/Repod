import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CheckGroup } from "../orchestrator/check-groups.ts";
import { CHECK_KINDS, type CheckKind } from "../orchestrator/routing.ts";
import type { CheckSpec } from "../verifier/verifier.ts";

/**
 * A demo kit: the request given to Repod, the interface contract shown to
 * executors, and the visible test groups that judge each task. It is trusted
 * configuration written by humans before a run, never by a model.
 *
 *   <dir>/request.md     the user request
 *   <dir>/contract.md    interface conventions for executors
 *   <dir>/checks.json    available check kinds and visible test groups
 *   <dir>/visible/       the groups' test files
 *   <dir>/single-model.json  experiment arm A's one task: title, acceptance
 *                        criteria and write scope (the files SPEC.md and the
 *                        contract name), since arm A has no coordinator to
 *                        plan them
 */
export interface DemoKit {
  request: string;
  contract: string;
  availableChecks: ReadonlySet<CheckKind>;
  checkGroups: CheckGroup[];
  visibleTestsDir: string;
  // Tests the baseline's own test files contain (they always run with the
  // visible tests); null when not declared.
  baselineTests: number | null;
  singleModel: SingleModelSetup;
}

const SingleModelSetup = z.strictObject({
  title: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  writeFiles: z.array(z.string().min(1)).min(1),
});
export type SingleModelSetup = z.infer<typeof SingleModelSetup>;

const KitChecks = z.strictObject({
  availableChecks: z.array(z.enum(CHECK_KINDS)),
  baselineTests: z.number().int().nonnegative().optional(),
  groups: z.array(CheckGroup),
});

export async function loadDemoKit(dir: string): Promise<DemoKit> {
  const request = (await readFile(path.join(dir, "request.md"), "utf8")).trim();
  const contract = (await readFile(path.join(dir, "contract.md"), "utf8")).trim();
  const parsed = KitChecks.safeParse(JSON.parse(await readFile(path.join(dir, "checks.json"), "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${path.join(dir, "checks.json")}:\n${parsed.error.message}`);
  const { availableChecks, baselineTests, groups } = parsed.data;

  const visibleTestsDir = path.join(dir, "visible");
  const present = new Set(await readdir(visibleTestsDir));
  const names = new Set<string>();
  for (const group of groups) {
    if (names.has(group.name)) throw new Error(`Duplicate check group "${group.name}"`);
    names.add(group.name);
    for (const file of group.tests) {
      if (!present.has(file)) throw new Error(`Check group "${group.name}" names missing test file ${file}`);
    }
  }
  for (const group of groups) {
    for (const required of group.requires) {
      if (!names.has(required) || required === group.name) throw new Error(`Check group "${group.name}" requires unknown group "${required}"`);
    }
  }
  const singleFile = path.join(dir, "single-model.json");
  const single = SingleModelSetup.safeParse(JSON.parse(await readFile(singleFile, "utf8")));
  if (!single.success) throw new Error(`Invalid ${singleFile}:\n${single.error.message}`);

  return {
    request, contract, availableChecks: new Set(availableChecks), checkGroups: groups, visibleTestsDir,
    baselineTests: baselineTests ?? null, singleModel: single.data,
  };
}

const HoldoutExpected = z.strictObject({ expectedTests: z.number().int().positive() });

/**
 * The number of tests the holdout suite contains, from
 * `<holdout dir>/expected-tests.json` ({"expectedTests": n}), kept private
 * with the tests themselves. null when the file does not exist.
 */
export async function readHoldoutExpected(sourceDir: string): Promise<number | null> {
  const file = path.join(sourceDir, "expected-tests.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = HoldoutExpected.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid ${file}:
${parsed.error.message}`);
  return parsed.data.expectedTests;
}

/**
 * Copies holdout tests next to a run's workspace (runs/<id>/holdout), where
 * they import the frozen workspace as ../workspace, and returns the check
 * that runs them. They are kept outside the workspace so that copying them
 * never changes the frozen content, and outside the public repository until
 * the experiments are over. If the holdout folder declares its test count,
 * the check fails when fewer tests run.
 */
export async function prepareHoldout(runDir: string, sourceDir: string, timeoutMs: number, maxOutputBytes: number): Promise<CheckSpec[]> {
  const files = (await readdir(sourceDir)).filter((file) => file.endsWith(".test.ts"));
  if (files.length === 0) throw new Error(`No holdout tests (*.test.ts) in ${sourceDir}`);
  const expectedTests = await readHoldoutExpected(sourceDir);
  const target = path.join(runDir, "holdout");
  await mkdir(target, { recursive: true });
  for (const file of files) await copyFile(path.join(sourceDir, file), path.join(target, file));
  return [{
    name: "holdout-tests",
    executable: process.execPath,
    args: ["--test", "--test-reporter=tap", "*.test.ts"],
    cwd: target,
    timeoutMs,
    maxOutputBytes,
    expectTests: true,
    ...(expectedTests === null ? {} : { expectedTests }),
  }];
}
