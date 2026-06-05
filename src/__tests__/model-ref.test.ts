import { describe, expect, it } from "vitest";
import { parseModelRef } from "../protocol/model-ref.js";

describe("parseModelRef", () => {
  it("routes openai-prefixed models to OpenAI subscription transport", () => {
    expect(parseModelRef("openai/gpt-5.5")).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/gpt-5.5",
      upstreamModel: "gpt-5.5",
    });
  });

  it("routes claude-prefixed models to Anthropic subscription transport", () => {
    expect(parseModelRef("claude/sonnet")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude/sonnet",
      upstreamModel: "claude-sonnet-4-5",
    });
  });

  it("keeps unprefixed models on the current Anthropic default path", () => {
    expect(parseModelRef("claude-3-5-sonnet-latest")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude-3-5-sonnet-latest",
      upstreamModel: "claude-3-5-sonnet-latest",
    });
  });

  it("uses a configured Anthropic default when the client omits a model", () => {
    expect(parseModelRef(undefined, {
      anthropicDefaultModel: "claude-opus-4-1",
    })).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude-opus-4-1",
      upstreamModel: "claude-opus-4-1",
    });
  });

  it("lets deployments remap provider aliases to preferred upstream models", () => {
    expect(parseModelRef("claude/sonnet", {
      anthropicAliases: { "claude/sonnet": "claude-sonnet-4-6" },
    }).upstreamModel).toBe("claude-sonnet-4-6");

    expect(parseModelRef("openai/codex", {
      openAIAliases: { codex: "gpt-5-codex" },
    })).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/codex",
      upstreamModel: "gpt-5-codex",
    });
  });

  it("resolves openai/default to the configured OpenAI default model", () => {
    expect(parseModelRef("openai/default", {
      openAIDefaultModel: "gpt-5-codex",
    })).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/default",
      upstreamModel: "gpt-5-codex",
    });
  });
});
