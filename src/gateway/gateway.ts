import type { RepodConfig } from "../config/schema.ts";
import { NotImplementedError } from "../shared/errors.ts";
import type { ProviderAdapter } from "./adapters/adapter.ts";
import type { ModelRequest, ModelResult } from "./types.ts";

export interface GatewayOptions {
  config: RepodConfig;
  presetName: string;
  adapters: ProviderAdapter[];
  ledgerFile: string;
  spentUsd: () => number; // running total from the ledger, used for reservations
}

/**
 * The single entry point for every model call in Repod.
 *
 * Keeping budgeting, logging, validation and failure classification here means
 * the orchestrator never depends on which provider serves a role, and changing
 * a model is a config change rather than a code change.
 */
export class ModelGateway {
  private readonly options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  async call<T>(_request: ModelRequest<T>): Promise<ModelResult<T>> {
    // TODO: Implement the call sequence documented in docs/architecture.md:
    //   1. reserve budget (refuse with "budget" if the worst case does not fit)
    //   2. append call_start
    //   3. call the adapter (SDK-level retries disabled; the gateway retries)
    //   4. reject truncated or refused output
    //   5. validate with the Zod schema (one format repair per attempt)
    //   6. compute standardized cost
    //   7. append call_end and return
    // Deferred until at least one adapter is implemented.
    throw new NotImplementedError("ModelGateway.call");
  }
}
