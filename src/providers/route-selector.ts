import { parseModelRef } from "../protocol/model-ref.js";
import type { ProviderRoute } from "./types.js";

export function selectRoute(model: string | undefined): ProviderRoute {
  const parsed = parseModelRef(model);
  return {
    ...parsed,
    ingressProtocol: parsed.provider === "openai_subscription" ? "responses" : "anthropic_messages",
  };
}
