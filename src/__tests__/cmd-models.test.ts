import { describe, expect, it } from "vitest";
import { buildModelSetPayload, groupModelsByProvider } from "../cli/cmd-models.js";

describe("groupModelsByProvider", () => {
  it("groups provider-prefixed model ids for display", () => {
    const groups = groupModelsByProvider([
      { id: "anthropic/claude-sonnet-4-6" },
      { id: "openai/gpt-5-codex" },
      { id: "openai/default" },
      { id: "sonnet" },
    ]);

    expect(groups).toEqual({
      anthropic: ["anthropic/claude-sonnet-4-6"],
      openai: ["openai/default", "openai/gpt-5-codex"],
      aliases: ["sonnet"],
    });
  });
});

describe("buildModelSetPayload", () => {
  it("strips provider prefixes before sending model defaults", () => {
    expect(buildModelSetPayload({
      claudeModel: "anthropic/claude-sonnet-4-6",
      openAIModel: "openai/gpt-5-codex",
    })).toEqual({
      claudeModel: "claude-sonnet-4-6",
      openAIModel: "gpt-5-codex",
    });
  });
});
