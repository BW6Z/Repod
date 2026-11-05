import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RepodConfig } from "../config/schema.ts";
import { PAGE_FILES, listExperiments, listModels, listRuns } from "./view-server.ts";

/**
 * Exports recorded runs as a static replay: the viewer's own page files plus
 * the same data/ layout the view server serves (see web/README.md), so any
 * static file host shows them without an API key or a running Repod.
 *
 * What a replay must not carry:
 * - the ability to start a paid run: data/session.json is always disabled,
 *   and no server answers api/ requests;
 * - paths on this machine: absolute paths of the repository, the runs
 *   folder and the home folder are replaced with placeholders;
 * - the holdout tests' content: their raw output (test names, assertion
 *   messages) is dropped from reports, only the counts stay. The holdout
 *   only measures anything while models have never seen it.
 * Runs still in progress are left out: a replay never changes, so the page
 * would wait for them forever.
 */
export interface ReplayOptions {
  webDir: string;
  runsDir: string;
  repoRoot: string;
  config: RepodConfig;
  outDir: string;
  /** Run or experiment ids to export; an experiment brings its runs. Empty: every finished run and every experiment. */
  include: readonly string[];
}

export interface ReplaySummary {
  runs: string[];
  experiments: string[];
}

/** Replaces each absolute path, in every spelling it may have in JSON text, with a placeholder. */
export function scrubPaths(text: string, roots: ReadonlyArray<readonly [string, string]>): string {
  // Longest first, so the runs folder inside the repository is named <runs>, not <repo>/runs.
  const sorted = [...roots].filter(([root]) => root.length > 3).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [root, placeholder] of sorted) {
    const plain = root.replace(/[\\/]+$/, "");
    const forward = plain.replace(/\\/g, "/");
    // Git Bash writes C:\Users as /c/Users.
    const posixDrive = forward.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    const spellings = new Set([plain, forward, posixDrive, plain.replace(/\\/g, "\\\\")]);
    for (const spelling of spellings) {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Paths on Windows ignore case; a drive letter may be written either way.
      out = out.replace(new RegExp(escaped, "gi"), placeholder);
    }
  }
  return out;
}

/** The report without the holdout tests' raw output. */
function withoutHoldoutOutput(report: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(report.holdout)) return report;
  return { ...report, holdout: report.holdout.map((check: Record<string, unknown>) => ({ ...check, output: null })) };
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function exportReplay(o: ReplayOptions): Promise<ReplaySummary> {
  // Refusing a folder with files in it means an export never overwrites anything.
  if (!(await isEmptyOrMissing(o.outDir))) throw new Error(`${o.outDir} is not empty; choose a new folder.`);

  const allRuns = (await listRuns(o.runsDir)).filter((r) => r.kind === "run" && r.finished);
  const allExperiments = await listExperiments(o.runsDir);
  const wanted = new Set(o.include);
  const known = new Set([...allRuns.map((r) => r.id), ...allExperiments.map((e) => String(e.experimentId))]);
  const unknown = o.include.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Not a finished run or an experiment in ${o.runsDir}: ${unknown.join(", ")}`);

  const picked = wanted.size > 0;
  const experiments = picked ? allExperiments.filter((e) => wanted.has(String(e.experimentId))) : allExperiments;
  // An experiment's table links to its runs, so they come with it.
  for (const e of experiments) {
    for (const r of Array.isArray(e.runs) ? e.runs : []) if (typeof r?.runId === "string") wanted.add(r.runId);
  }
  const runs = picked ? allRuns.filter((r) => wanted.has(r.id)) : allRuns;

  const roots = [[o.runsDir, "<runs>"], [o.repoRoot, "<repo>"], [homedir(), "<home>"]] as const;
  const scrub = (text: string) => scrubPaths(text, roots);
  const data = path.join(o.outDir, "data");
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(data, rel)), { recursive: true });
    await writeFile(path.join(data, rel), text);
  };

  await mkdir(data, { recursive: true });
  for (const file of PAGE_FILES) await copyFile(path.join(o.webDir, file), path.join(o.outDir, file));
  await write("source.json", JSON.stringify({ source: "replay", exportedAt: new Date().toISOString() }));
  await write("session.json", JSON.stringify({ enabled: false }));
  await write("models.json", JSON.stringify(listModels(o.config)));
  await write("runs.json", scrub(JSON.stringify(runs)));
  await write("experiments.json", scrub(JSON.stringify(experiments)));
  for (const run of runs) {
    const dir = path.join(o.runsDir, run.id);
    await write(`runs/${run.id}/events.jsonl`, scrub(await readFile(path.join(dir, "events.jsonl"), "utf8")));
    let report: string;
    try {
      report = await readFile(path.join(dir, "report.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // a run stopped before its report
      throw error;
    }
    await write(`runs/${run.id}/report.json`, scrub(JSON.stringify(withoutHoldoutOutput(JSON.parse(report)))));
  }
  return { runs: runs.map((r) => r.id), experiments: experiments.map((e) => String(e.experimentId)) };
}
