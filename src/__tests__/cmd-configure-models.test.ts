import { describe, expect, it } from "vitest";
import { buildModelRoutingUpdate } from "../protocol/model-routing-config.js";

describe("buildModelRoutingUpdate", () => {
  it("stores provider defaults and practical aliases for selected models", () => {
    const next = buildModelRoutingUpdate(
      {},
      {
        claudeModel: "claude-sonnet-4-6",
        openAIModel: "gpt-5-codex",
      },
    );

    expect(next).toEqual({
      anthropicDefaultModel: "claude-sonnet-4-6",
      openAIDefaultModel: "gpt-5-codex",
      anthropicAliases: {
        "claude/sonnet": "claude-sonnet-4-6",
        sonnet: "claude-sonnet-4-6",
      },
      openAIAliases: {
        default: "gpt-5-codex",
        codex: "gpt-5-codex",
      },
    });
  });

  it("preserves existing provider settings when only one model is changed", () => {
    const next = buildModelRoutingUpdate(
      {
        anthropicDefaultModel: "claude-opus-4-1",
        openAIDefaultModel: "gpt-5-codex",
        openAIAliases: { codex: "gpt-5-codex" },
      },
      { claudeModel: "claude-sonnet-4-6" },
    );

    expect(next.openAIDefaultModel).toBe("gpt-5-codex");
    expect(next.openAIAliases).toEqual({ codex: "gpt-5-codex" });
    expect(next.anthropicDefaultModel).toBe("claude-sonnet-4-6");
  });

  it("normalizes provider-prefixed model ids before storing defaults", () => {
    const next = buildModelRoutingUpdate({}, {
      claudeModel: "anthropic/claude-sonnet-4-6",
      openAIModel: "openai/gpt-5-codex",
    });

    expect(next.anthropicDefaultModel).toBe("claude-sonnet-4-6");
    expect(next.openAIDefaultModel).toBe("gpt-5-codex");
  });
});
