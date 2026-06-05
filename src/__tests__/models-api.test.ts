import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelsApi } from "../ui/modelsApi.js";

describe("createModelsApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists models through the authenticated router management endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      routing: { openAIDefaultModel: "gpt-5-codex" },
      models: [{ id: "openai/gpt-5-codex" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const api = createModelsApi("http://router.local/", "secret");
    const status = await api.list();

    expect(status.models.map(model => model.id)).toEqual(["openai/gpt-5-codex"]);
    expect(fetchMock).toHaveBeenCalledWith("http://router.local/cc-router/models", expect.objectContaining({
      headers: { authorization: "Bearer secret" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("updates model routing through the authenticated router management endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      routing: {
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const api = createModelsApi("http://router.local", "secret");
    const status = await api.setDefaults({
      claudeModel: "anthropic/claude-sonnet-4-6",
      openAIModel: "openai/gpt-5-codex",
    });

    expect(status.routing.openAIDefaultModel).toBe("gpt-5-codex");
    expect(fetchMock).toHaveBeenCalledWith("http://router.local/cc-router/models", expect.objectContaining({
      method: "PATCH",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        claudeModel: "anthropic/claude-sonnet-4-6",
        openAIModel: "openai/gpt-5-codex",
      }),
      signal: expect.any(AbortSignal),
    }));
  });
});
