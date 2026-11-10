import { NotImplementedError } from "../../shared/errors.ts";
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from "./adapter.ts";

/**
 * Anthropic adapter.
 *
 * Planned approach: the official @anthropic-ai/sdk Messages API with structured
 * output via `output_config.format`. Forced tool choice is not available on
 * the current Opus and Sonnet models, so JSON must come from structured output.
 * Claude Opus 5.5 cannot disable thinking; depth is set with an explicit
 * `output_config.effort` (its default is "medium").
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic" as const;

  async call(_request: AdapterRequest): Promise<AdapterResponse> {
    // TODO: Implement the Messages API call. Check `stop_reason` before reading
    // content ("max_tokens" -> truncated, "refusal" -> refusal) and map usage
    // (input_tokens excludes cache reads, so it already matches the gateway
    // convention). Deferred: the current presets run on Meta models only, so
    // nothing calls this adapter yet; it is needed only once a preset assigns
    // a Claude model to a role.
    throw new NotImplementedError("AnthropicAdapter.call");
  }
}
