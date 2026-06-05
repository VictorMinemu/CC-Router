import { describe, expect, it } from "vitest";
import { createHealthAccountViews } from "../proxy/server.js";
import type { Account } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

function makeAnthropicAccount(): Account {
  return {
    id: "max-account-1",
    tokens: {
      accessToken: "ant-access",
      refreshToken: "ant-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
    healthy: true,
    busy: false,
    requestCount: 2,
    errorCount: 0,
    lastUsed: 123,
    lastRefresh: 456,
    consecutiveErrors: 0,
    rateLimits: {
      status: "allowed",
      fiveHourUtil: 0.1,
      fiveHourReset: 0,
      sevenDayUtil: 0.2,
      sevenDayReset: 0,
      claim: "",
      plan: "Max 5x",
      requestsLimit: 500,
      lastUpdated: 789,
    },
    enabled: true,
    sessionLimitPercent: 80,
    weeklyLimitPercent: 90,
  };
}

describe("createHealthAccountViews", () => {
  it("combines Anthropic pool stats with OpenAI subscription account status", () => {
    const openAIAccount: OpenAISubscriptionAccount = {
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: Date.now() + 120_000,
      enabled: true,
    };

    const views = createHealthAccountViews([makeAnthropicAccount()], [openAIAccount]);

    expect(views.map(view => [view.id, view.provider])).toEqual([
      ["max-account-1", "anthropic_subscription"],
      ["openai-primary", "openai_subscription"],
    ]);
    expect(views[1]).toMatchObject({
      healthy: true,
      busy: false,
      requestCount: 0,
      errorCount: 0,
      enabled: true,
    });
    expect(views[1].rateLimits).toBeUndefined();
  });
});
