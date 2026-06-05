import { parseModelRef } from "../protocol/model-ref.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import type { ProviderRoute } from "./types.js";

export function selectRoute(model: string | undefined, config: ModelRoutingConfig = {}): ProviderRoute {
  const parsed = parseModelRef(model, config);
  return {
    ...parsed,
    ingressProtocol: parsed.provider === "openai_subscription" ? "responses" : "anthropic_messages",
  };
}
