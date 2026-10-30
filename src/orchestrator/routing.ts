import type { Preset } from "../config/schema.ts";
import { NotImplementedError } from "../shared/errors.ts";
import type { PlannedTask } from "./schemas.ts";

export interface FloorDecision {
  model: string;
  raised: boolean; // true when the program overrode Meta's choice
  reason: string | null; // recorded as an event and shown to the user when raised
}

/**
 * Enforces the capability floor on Meta's model choice.
 *
 * Meta chooses freely above the floor, and assigning everything to the strong
 * model is allowed. The floor exists so cost pressure can never route
 * high-risk work to a weak model:
 *   - impact "high"         -> strong tier
 *   - complexity "complex"  -> strong tier
 *   - no automatic check    -> strong tier, or a review must be scheduled
 * There is deliberately no quota that forces work onto cheap models.
 */
export function applyCapabilityFloor(_task: PlannedTask, _preset: Preset): FloorDecision {
  // TODO: Implement the rules above using the preset's model tiers, with unit
  // tests for each rule. Deferred to the routing milestone (11/1).
  throw new NotImplementedError("applyCapabilityFloor");
}
