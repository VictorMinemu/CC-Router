import { describe, expect, it } from "vitest";
import { createOpenAIAccountRecord } from "../providers/openai/account-record.js";

describe("createOpenAIAccountRecord", () => {
  it("normalizes a valid OpenAI subscription account record", () => {
    expect(createOpenAIAccountRecord({
      id: "openai-primary",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "1999999999000",
      scopes: "openid profile email offline_access",
    })).toEqual({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1999999999000,
      scopes: ["openid", "profile", "email", "offline_access"],
      enabled: true,
    });
  });

  it("rejects invalid account IDs and missing tokens", () => {
    expect(() => createOpenAIAccountRecord({
      id: "bad id",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "1999999999000",
    })).toThrow(/Only letters/);

    expect(() => createOpenAIAccountRecord({
      id: "openai-primary",
      accessToken: "",
      refreshToken: "refresh",
      expiresAt: "1999999999000",
    })).toThrow(/Access token/);
  });
});
