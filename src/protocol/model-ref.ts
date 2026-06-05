export type ProviderKind = "anthropic_subscription" | "openai_subscription" | "openai_api_key";

export interface ParsedModelRef {
  provider: ProviderKind;
  publicModel: string;
  upstreamModel: string;
}

export interface ModelRoutingConfig {
  anthropicDefaultModel?: string;
  openAIDefaultModel?: string;
  anthropicAliases?: Record<string, string>;
  openAIAliases?: Record<string, string>;
}

const CLAUDE_ALIASES: Record<string, string> = {
  "claude/sonnet": "claude-sonnet-4-5",
  "claude/opus": "claude-opus-4-1",
};

function cleanModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseModelRef(model: string | undefined, config: ModelRoutingConfig = {}): ParsedModelRef {
  const publicModel = cleanModel(model) ?? cleanModel(config.anthropicDefaultModel) ?? "claude/sonnet";

  if (publicModel.startsWith("openai/")) {
    const openAIModel = publicModel.slice("openai/".length);
    const defaultOpenAIModel = cleanModel(config.openAIDefaultModel);
    return {
      provider: "openai_subscription",
      publicModel,
      upstreamModel: config.openAIAliases?.[openAIModel]
        ?? (openAIModel === "default" && defaultOpenAIModel ? defaultOpenAIModel : openAIModel),
    };
  }

  if (publicModel.startsWith("anthropic/")) {
    const anthropicModel = publicModel.slice("anthropic/".length);
    return {
      provider: "anthropic_subscription",
      publicModel,
      upstreamModel: config.anthropicAliases?.[publicModel]
        ?? config.anthropicAliases?.[anthropicModel]
        ?? anthropicModel,
    };
  }

  return {
    provider: "anthropic_subscription",
    publicModel,
    upstreamModel: config.anthropicAliases?.[publicModel] ?? CLAUDE_ALIASES[publicModel] ?? publicModel,
  };
}
