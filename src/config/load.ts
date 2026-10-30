import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { Limits, Preset, PricingTable, type RepodConfig } from "./schema.ts";

async function readJson<T>(file: string, schema: ZodType<T>): Promise<T> {
  const text = await readFile(file, "utf8");
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Invalid config file ${file}:\n${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Loads and validates every file under the config directory.
 *
 * Validation is strict on purpose: a typo in a limit or a model without a
 * price would silently weaken budget enforcement, so the run must refuse to
 * start instead.
 */
export async function loadConfig(configDir: string): Promise<RepodConfig> {
  const limits = await readJson(path.join(configDir, "limits.json"), Limits);
  const pricing = await readJson(path.join(configDir, "pricing.json"), PricingTable);

  const presetDir = path.join(configDir, "presets");
  const presets = new Map<string, Preset>();
  for (const entry of (await readdir(presetDir)).filter((f) => f.endsWith(".json")).sort()) {
    const preset = await readJson(path.join(presetDir, entry), Preset);
    if (presets.has(preset.name)) {
      throw new Error(`Duplicate preset name "${preset.name}" in ${entry}`);
    }
    presets.set(preset.name, preset);
  }

  // Budget reservation needs a price for every model that can be called.
  const priced = new Set(pricing.prices.map((p) => p.model));
  for (const preset of presets.values()) {
    for (const model of preset.models) {
      if (!priced.has(model.id)) {
        throw new Error(`Preset "${preset.name}" uses "${model.id}", which has no entry in pricing.json`);
      }
    }
  }

  return { limits, pricing, presets };
}
