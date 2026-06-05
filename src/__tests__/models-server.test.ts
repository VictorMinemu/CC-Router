import { createServer } from "http";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { mountModelsRoute } from "../proxy/models-server.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { Account } from "../proxy/types.js";

describe("mountModelsRoute", () => {
  it("returns discovered Anthropic and OpenAI models in OpenAI list format", async () => {
    const app = express();

    mountModelsRoute(app, {
      getAnthropicAccounts: () => [makeAnthropicAccount()],
      getOpenAIAccounts: () => [makeOpenAIAccount()],
      fetchAnthropicModels: async () => ["claude-sonnet-4-6"],
      fetchOpenAIModels: async () => ["gpt-5-codex"],
    });

    const body = await getJson(app, "/v1/models");

    expect(body).toEqual({
      object: "list",
      data: [
        { id: "anthropic/claude-sonnet-4-6", object: "model", owned_by: "anthropic_subscription" },
        { id: "openai/gpt-5-codex", object: "model", owned_by: "openai_subscription" },
      ],
    });
  });

  it("adds configured aliases and deduplicates repeated provider models", async () => {
    const app = express();

    mountModelsRoute(app, {
      getAnthropicAccounts: () => [makeAnthropicAccount(), makeAnthropicAccount("claude-2")],
      getOpenAIAccounts: () => [makeOpenAIAccount()],
      fetchAnthropicModels: async () => ["claude-sonnet-4-6"],
      fetchOpenAIModels: async () => ["gpt-5-codex"],
      modelRouting: {
        anthropicAliases: { sonnet: "claude-sonnet-4-6" },
        openAIAliases: { codex: "gpt-5-codex" },
      },
    });

    const body = await getJson(app, "/v1/models");

    expect(body.data.map((model: { id: string }) => model.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/codex",
      "openai/gpt-5-codex",
      "sonnet",
    ]);
  });

  it("prepares OpenAI accounts before discovery and skips accounts that cannot refresh", async () => {
    const prepare = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const fetchOpenAIModels = vi.fn().mockResolvedValue(["gpt-5-codex"]);
    const app = express();

    mountModelsRoute(app, {
      getAnthropicAccounts: () => [],
      getOpenAIAccounts: () => [makeOpenAIAccount("expired"), makeOpenAIAccount("ready")],
      prepareOpenAIAccount: prepare,
      fetchOpenAIModels,
    });

    const body = await getJson(app, "/v1/models");

    expect(body.data).toEqual([
      { id: "openai/gpt-5-codex", object: "model", owned_by: "openai_subscription" },
    ]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(fetchOpenAIModels).toHaveBeenCalledTimes(1);
    expect(fetchOpenAIModels.mock.calls[0][0].id).toBe("ready");
  });

  it("returns available models when one provider discovery fails", async () => {
    const app = express();

    mountModelsRoute(app, {
      getAnthropicAccounts: () => [makeAnthropicAccount()],
      getOpenAIAccounts: () => [makeOpenAIAccount()],
      fetchAnthropicModels: async () => ["claude-sonnet-4-6"],
      fetchOpenAIModels: async () => { throw new Error("upstream unavailable"); },
    });

    const body = await getJson(app, "/v1/models");

    expect(body.data).toEqual([
      { id: "anthropic/claude-sonnet-4-6", object: "model", owned_by: "anthropic_subscription" },
    ]);
  });

  it("returns discovered models with current routing from the management endpoint", async () => {
    const app = express();

    mountModelsRoute(app, {
      getAnthropicAccounts: () => [makeAnthropicAccount()],
      getOpenAIAccounts: () => [makeOpenAIAccount()],
      fetchAnthropicModels: async () => ["claude-sonnet-4-6"],
      fetchOpenAIModels: async () => ["gpt-5-codex"],
      getModelRouting: () => ({
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
      }),
    });

    const body = await getJson(app, "/cc-router/models");

    expect(body).toEqual({
      routing: {
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
      },
      models: [
        { id: "anthropic/claude-sonnet-4-6", object: "model", owned_by: "anthropic_subscription" },
        { id: "claude/default", object: "model", owned_by: "anthropic_subscription" },
        { id: "openai/default", object: "model", owned_by: "openai_subscription" },
        { id: "openai/gpt-5-codex", object: "model", owned_by: "openai_subscription" },
      ],
    });
  });

  it("updates model routing from the management endpoint", async () => {
    const app = express();
    let routing = {};

    mountModelsRoute(app, {
      getAnthropicAccounts: () => [],
      getOpenAIAccounts: () => [],
      getModelRouting: () => routing,
      setModelRouting: async next => { routing = next; },
    });

    const body = await patchJson(app, "/cc-router/models", {
      claudeModel: "claude-sonnet-4-6",
      openAIModel: "openai/gpt-5-codex",
    });

    expect(body.routing).toEqual({
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
    expect(routing).toEqual(body.routing);
  });
});

async function getJson(app: express.Express, path: string): Promise<any> {
  return requestJson(app, path, { method: "GET" });
}

async function patchJson(app: express.Express, path: string, body: unknown): Promise<any> {
  return requestJson(app, path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson(app: express.Express, path: string, init: RequestInit): Promise<any> {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    expect(res.status).toBe(200);
    return await res.json();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

function makeAnthropicAccount(id = "claude-1"): Account {
  return {
    id,
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

function makeOpenAIAccount(id = "openai-1"): OpenAISubscriptionAccount {
  return {
    id,
    provider: "openai_subscription",
    accessToken: "openai-access",
    refreshToken: "openai-refresh",
    expiresAt: Date.now() + 60_000,
    enabled: true,
  };
}
