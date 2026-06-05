import { describe, expect, it } from "vitest";
import { createOpenAIAccountPicker } from "../providers/openai/account-pool.js";

describe("createOpenAIAccountPicker", () => {
  it("returns enabled OpenAI accounts in round-robin order", () => {
    const pick = createOpenAIAccountPicker([
      {
        id: "disabled",
        provider: "openai_subscription",
        accessToken: "access-0",
        refreshToken: "refresh-0",
        expiresAt: 1,
        enabled: false,
      },
      {
        id: "one",
        provider: "openai_subscription",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 1,
        enabled: true,
      },
      {
        id: "two",
        provider: "openai_subscription",
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 1,
        enabled: true,
      },
    ]);

    expect(pick()?.id).toBe("one");
    expect(pick()?.id).toBe("two");
    expect(pick()?.id).toBe("one");
  });

  it("returns null when no OpenAI account is enabled", () => {
    const pick = createOpenAIAccountPicker([]);
    expect(pick()).toBeNull();
  });
});
