export type ProviderKind = "anthropic_subscription" | "openai_subscription" | "openai_api_key";

export interface ParsedModelRef {
  provider: ProviderKind;
  publicModel: string;
  upstreamModel: string;
}

const CLAUDE_ALIASES: Record<string, string> = {
  "claude/sonnet": "claude-sonnet-4-5",
  "claude/opus": "claude-opus-4-1",
};

export function parseModelRef(model: string | undefined): ParsedModelRef {
  const publicModel = model && model.trim() ? model.trim() : "claude/sonnet";

  if (publicModel.startsWith("openai/")) {
    return {
      provider: "openai_subscription",
      publicModel,
      upstreamModel: publicModel.slice("openai/".length),
    };
  }

  if (publicModel.startsWith("anthropic/")) {
    return {
      provider: "anthropic_subscription",
      publicModel,
      upstreamModel: publicModel.slice("anthropic/".length),
    };
  }

  return {
    provider: "anthropic_subscription",
    publicModel,
    upstreamModel: CLAUDE_ALIASES[publicModel] ?? publicModel,
  };
}
