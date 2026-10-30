import { NotImplementedError } from "../../shared/errors.ts";
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from "./adapter.ts";

/**
 * Meta Model API adapter.
 *
 * Planned approach: the OpenAI-compatible Responses protocol at
 * https://api.meta.ai/v1 (Meta's recommended protocol), with structured output
 * via `text.format` and `strict: true`. Authentication uses MODEL_API_KEY.
 */
export class MetaAdapter implements ProviderAdapter {
  readonly provider = "meta" as const;

  async call(_request: AdapterRequest): Promise<AdapterResponse> {
    // TODO: Implement the Responses API call and map usage, stop reasons and
    // errors to the gateway convention. Deferred until a real account has
    // confirmed the usage field names and the truncation and refusal shapes
    // (day-1 API verification), and until the SDK dependency is approved.
    throw new NotImplementedError("MetaAdapter.call");
  }
}
