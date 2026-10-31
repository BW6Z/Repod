import { z } from "zod";

// Tiers are deliberately coarse. The routing floor only needs to know whether a
// model may take complex or high-impact work, not a benchmark score. "free"
// covers free-tier models, which may only take simple, low-impact work.
export const Tier = z.enum(["free", "cheap", "strong"]);
export type Tier = z.infer<typeof Tier>;

const TIER_RANK: Record<Tier, number> = { free: 0, cheap: 1, strong: 2 };

export function tierAtLeast(tier: Tier, floor: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[floor];
}

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
    // Free tiers may use submitted content for training, so sending a
    // project's code to them is an explicit per-project opt-in.
    allowFreeModels: z.boolean(),
    models: z.array(ModelEntry).min(1),
  })
  .superRefine((preset, ctx) => {
    // Every model a preset refers to must be declared in the same file, so the
    // gateway can always resolve its provider and tier without guessing.
    const tierOf = new Map(preset.models.map((m) => [m.id, m.tier]));
    const referenced = [preset.coordinator, ...Object.values(preset.roles)];
    for (const id of referenced) {
      if (!tierOf.has(id)) {
        ctx.addIssue({ code: "custom", message: `Model "${id}" is used but not declared in "models"` });
      }
    }

    const coordinator = preset.models.find((m) => m.id === preset.coordinator);
    if (coordinator && coordinator.provider !== "meta") {
      // Competition requirement: the main (coordinating) AI is a Meta model.
      ctx.addIssue({ code: "custom", message: "The coordinator must be a Meta model" });
    }

    // The capability floor raises under-powered choices to these role models,
    // so they must themselves satisfy the floors they stand in for.
    const require = (role: keyof typeof preset.roles, floor: Tier) => {
      const tier = tierOf.get(preset.roles[role]);
      if (tier && !tierAtLeast(tier, floor)) {
        ctx.addIssue({ code: "custom", message: `Role "${role}" needs a ${floor}-tier model or better` });
      }
    };
    require("critical", "strong");
    require("review", "strong");
    require("routine", "cheap");

    if (!preset.allowFreeModels && referenced.some((id) => tierOf.get(id) === "free")) {
      ctx.addIssue({ code: "custom", message: "A free-tier model is used but allowFreeModels is false" });
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

// "none" is omitted on purpose: Muse Spark rejects it with HTTP 400.
export const ReasoningEffort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const Limits = z.strictObject({
  budgetUsd: z.number().positive(), // per run
  // Across all runs recorded under runs/. Guards real money while hackathon
  // credits are pending and keeps a reserve for the demo afterwards.
  totalBudgetUsd: z.number().positive(),
  maxClarifyingQuestions: z.number().int().min(0).max(3),
  maxPlanRevisions: z.number().int().min(0).max(1),
  cheapAttemptsPerTask: z.number().int().min(1),
  strongAttemptsPerTask: z.number().int().min(1),
  maxEscalationsPerTask: z.number().int().min(0).max(1),
  maxTotalReworks: z.number().int().min(0),
  maxNeedFilesRequests: z.number().int().min(0).max(1),
  maxTransientRetries: z.number().int().min(0).max(5), // rate limits and network errors only
  requestTimeoutMs: z.number().int().min(1000),
  maxFilesPerOutput: z.number().int().min(1),
  maxFileBytes: z.number().int().min(1),
  checkTimeoutMs: z.number().int().min(1000),
  maxCheckOutputBytes: z.number().int().min(1),
  maxOutputTokens: z.strictObject({
    coordinator: z.number().int().min(1),
    executor: z.number().int().min(1),
    reviewer: z.number().int().min(1),
  }),
  reasoningEffort: z.strictObject({
    coordinator: ReasoningEffort,
    executor: ReasoningEffort,
    reviewer: ReasoningEffort,
  }),
});
export type Limits = z.infer<typeof Limits>;

export interface RepodConfig {
  limits: Limits;
  pricing: PricingTable;
  presets: Map<string, Preset>;
}
