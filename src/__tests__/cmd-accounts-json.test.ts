import { describe, expect, it } from "vitest";
import { buildStoredAccountsJson } from "../cli/cmd-accounts.js";
import type { Account } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

describe("buildStoredAccountsJson", () => {
  it("returns provider-tagged account metadata without tokens", () => {
    const anthropic = [{
      id: "max-account-1",
      tokens: {
        accessToken: "ant-access",
        refreshToken: "ant-refresh",
        expiresAt: 1999999999000,
        scopes: ["user:inference"],
      },
      enabled: true,
    } as Account];
    const openAI: OpenAISubscriptionAccount[] = [{
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: 1999999998000,
      enabled: false,
    }];

    const json = buildStoredAccountsJson(anthropic, openAI);

    expect(json).toEqual([
      {
        id: "max-account-1",
        provider: "anthropic_subscription",
        enabled: true,
        expiresAt: 1999999999000,
        scopes: ["user:inference"],
      },
      {
        id: "openai-primary",
        provider: "openai_subscription",
        enabled: false,
        expiresAt: 1999999998000,
      },
    ]);
    expect(JSON.stringify(json)).not.toContain("access");
    expect(JSON.stringify(json)).not.toContain("refresh");
  });
});
