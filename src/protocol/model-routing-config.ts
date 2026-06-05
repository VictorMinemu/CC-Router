import type { ModelRoutingConfig } from "./model-ref.js";

export interface ConfigureModelsOptions {
  claudeModel?: string;
  openAIModel?: string;
}

function cleanModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildModelRoutingUpdate(
  existing: ModelRoutingConfig | undefined,
  opts: ConfigureModelsOptions,
): ModelRoutingConfig {
  const next: ModelRoutingConfig = {
    ...existing,
    anthropicAliases: { ...(existing?.anthropicAliases ?? {}) },
    openAIAliases: { ...(existing?.openAIAliases ?? {}) },
  };

  const claudeModel = cleanModel(opts.claudeModel)?.replace(/^anthropic\//, "");
  if (claudeModel) {
    next.anthropicDefaultModel = claudeModel;
    next.anthropicAliases = {
      ...next.anthropicAliases,
      "claude/sonnet": claudeModel,
      sonnet: claudeModel,
    };
  }

  const openAIModel = cleanModel(opts.openAIModel)?.replace(/^openai\//, "");
  if (openAIModel) {
    next.openAIDefaultModel = openAIModel;
    next.openAIAliases = {
      ...next.openAIAliases,
      default: openAIModel,
      codex: openAIModel,
    };
  }

  return next;
}
