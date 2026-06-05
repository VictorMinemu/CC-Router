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
});
