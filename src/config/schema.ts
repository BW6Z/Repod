import { z } from "zod";

// Tiers are deliberately coarse. The routing floor only needs to know whether a
// model may take complex or high-impact work, not a benchmark score.
export const Tier = z.enum(["cheap", "strong"]);
export type Tier = z.infer<typeof Tier>;

export const Provider = z.enum(["meta", "anthropic"]);
export type Provider = z.infer<typeof Provider>;

export const ModelEntry = z.strictObject({
  id: z.string().min(1),
  provider: Provider,
  tier: Tier,
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export const Preset = z
  .strictObject({
    name: z.string().min(1),
    description: z.string(),
    coordinator: z.string().min(1),
    roles: z.strictObject({
      critical: z.string().min(1),
      routine: z.string().min(1),
      review: z.string().min(1),
      docs: z.string().min(1),
    }),
    models: z.array(ModelEntry).min(1),
  })
  .superRefine((preset, ctx) => {
    // Every model a preset refers to must be declared in the same file, so the
    // gateway can always resolve its provider and tier without guessing.
    const declared = new Set(preset.models.map((m) => m.id));
    const referenced = [preset.coordinator, ...Object.values(preset.roles)];
    for (const id of referenced) {
      if (!declared.has(id)) {
        ctx.addIssue({ code: "custom", message: `Model "${id}" is used but not declared in "models"` });
      }
    }
    const coordinator = preset.models.find((m) => m.id === preset.coordinator);
    if (coordinator && coordinator.provider !== "meta") {
      // Competition requirement as currently understood: Meta coordinates.
      ctx.addIssue({ code: "custom", message: "The coordinator must be a Meta model" });
    }
  });
export type Preset = z.infer<typeof Preset>;

export const Price = z.strictObject({
  model: z.string().min(1),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  // null means the provider publishes no separate cached rate or we do not know
  // it; cost reports must then say "unknown" instead of inventing a number.
  cachedInputPerMTok: z.number().nonnegative().nullable(),
  source: z.url(),
  checkedOn: z.iso.date(),
  // true only after the rate was confirmed on the provider's live pricing page.
  verified: z.boolean(),
  note: z.string().optional(),
});
export type Price = z.infer<typeof Price>;

export const PricingTable = z.strictObject({
  currency: z.literal("USD"),
  prices: z.array(Price),
});
export type PricingTable = z.infer<typeof PricingTable>;

export const Limits = z.strictObject({
  budgetUsd: z.number().positive(),
  maxClarifyingQuestions: z.number().int().min(0).max(3),
  maxPlanRevisions: z.number().int().min(0).max(1),
  cheapAttemptsPerTask: z.number().int().min(1),
  strongAttemptsPerTask: z.number().int().min(1),
  maxEscalationsPerTask: z.number().int().min(0).max(1),
  maxTotalReworks: z.number().int().min(0),
  maxNeedFilesRequests: z.number().int().min(0).max(1),
  maxFilesPerOutput: z.number().int().min(1),
  maxFileBytes: z.number().int().min(1),
  checkTimeoutMs: z.number().int().min(1000),
  maxCheckOutputBytes: z.number().int().min(1),
  maxOutputTokens: z.strictObject({
    coordinator: z.number().int().min(1),
    executor: z.number().int().min(1),
    reviewer: z.number().int().min(1),
  }),
});
export type Limits = z.infer<typeof Limits>;

export interface RepodConfig {
  limits: Limits;
  pricing: PricingTable;
  presets: Map<string, Preset>;
}
