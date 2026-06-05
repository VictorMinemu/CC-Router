import { describe, expect, it, vi } from "vitest";
import {
  fetchAnthropicModels,
  fetchOpenAICodexModels,
  normalizeModelIds,
} from "../providers/model-discovery.js";
import type { Account } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

function makeAnthropicAccount(): Account {
  return {
    id: "claude-account",
    tokens: {
      accessToken: "ant-access",
      refreshToken: "ant-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: {
      status: "unknown",
      fiveHourUtil: 0,
      fiveHourReset: 0,
      sevenDayUtil: 0,
      sevenDayReset: 0,
      claim: "",
      plan: "",
      requestsLimit: 0,
      lastUpdated: 0,
    },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

function makeOpenAIAccount(): OpenAISubscriptionAccount {
  return {
    id: "openai-account",
    provider: "openai_subscription",
    accessToken: "openai-access",
    refreshToken: "openai-refresh",
    expiresAt: Date.now() + 60_000,
    enabled: true,
  };
}

describe("normalizeModelIds", () => {
  it("extracts model ids from common provider response shapes", () => {
    expect(normalizeModelIds({
      data: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-1" }],
    })).toEqual(["claude-sonnet-4-6", "claude-opus-4-1"]);

    expect(normalizeModelIds({
      models: [{ slug: "gpt-5-codex" }, { id: "gpt-5.5" }],
    })).toEqual(["gpt-5-codex", "gpt-5.5"]);

    expect(normalizeModelIds(["gpt-5-codex", { name: "gpt-5.5" }])).toEqual([
      "gpt-5-codex",
      "gpt-5.5",
    ]);
  });
});

describe("fetchAnthropicModels", () => {
  it("calls Anthropic /v1/models with OAuth bearer headers and returns ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "claude-sonnet-4-6" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const models = await fetchAnthropicModels(makeAnthropicAccount(), fetchMock);

    expect(models).toEqual(["claude-sonnet-4-6"]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: expect.objectContaining({
        authorization: "Bearer ant-access",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      }),
      signal: expect.any(AbortSignal),
    });
  });
});

describe("fetchOpenAICodexModels", () => {
  it("calls the Codex ChatGPT backend models endpoint with account bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "gpt-5-codex" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const models = await fetchOpenAICodexModels(makeOpenAIAccount(), fetchMock);

    expect(models).toEqual(["gpt-5-codex"]);
    expect(fetchMock).toHaveBeenCalledWith("https://chatgpt.com/backend-api/codex/models", {
      method: "GET",
      headers: expect.objectContaining({
        authorization: "Bearer openai-access",
        accept: "application/json",
      }),
      signal: expect.any(AbortSignal),
    });
  });
});
