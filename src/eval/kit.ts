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
 */
export interface DemoKit {
  request: string;
  contract: string;
  availableChecks: ReadonlySet<CheckKind>;
  checkGroups: CheckGroup[];
  visibleTestsDir: string;
}

const KitChecks = z.strictObject({
  availableChecks: z.array(z.enum(CHECK_KINDS)),
  groups: z.array(CheckGroup),
});

export async function loadDemoKit(dir: string): Promise<DemoKit> {
  const request = (await readFile(path.join(dir, "request.md"), "utf8")).trim();
  const contract = (await readFile(path.join(dir, "contract.md"), "utf8")).trim();
  const parsed = KitChecks.safeParse(JSON.parse(await readFile(path.join(dir, "checks.json"), "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${path.join(dir, "checks.json")}:\n${parsed.error.message}`);
  const { availableChecks, groups } = parsed.data;

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
  return { request, contract, availableChecks: new Set(availableChecks), checkGroups: groups, visibleTestsDir };
}

/**
 * Copies holdout tests next to a run's workspace (runs/<id>/holdout), where
 * they import the frozen workspace as ../workspace, and returns the check
 * that runs them. They are kept outside the workspace so that copying them
 * never changes the frozen content, and outside the public repository until
 * the experiments are over.
 */
export async function prepareHoldout(runDir: string, sourceDir: string, timeoutMs: number, maxOutputBytes: number): Promise<CheckSpec[]> {
  const files = (await readdir(sourceDir)).filter((file) => file.endsWith(".test.ts"));
  if (files.length === 0) throw new Error(`No holdout tests (*.test.ts) in ${sourceDir}`);
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
  }];
}
