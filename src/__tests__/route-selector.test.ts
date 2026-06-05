import { describe, expect, it } from "vitest";
import { selectRoute } from "../providers/route-selector.js";

describe("selectRoute", () => {
  it("selects OpenAI subscription route for openai model refs", () => {
    const route = selectRoute("openai/gpt-5.5");
    expect(route).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/gpt-5.5",
      upstreamModel: "gpt-5.5",
      ingressProtocol: "responses",
    });
  });

  it("selects Anthropic subscription route for claude model refs", () => {
    const route = selectRoute("claude/sonnet");
    expect(route.provider).toBe("anthropic_subscription");
    expect(route.upstreamModel).toBe("claude-sonnet-4-5");
  });
});
