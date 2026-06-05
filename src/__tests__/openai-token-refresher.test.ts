import { afterEach, describe, expect, it, vi } from "vitest";
import { needsOpenAIRefresh, prepareOpenAIAccountForRequest, refreshOpenAISubscriptionToken, startOpenAIRefreshLoop } from "../providers/openai/token-refresher.js";

describe("OpenAI subscription token refresher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes expiring OpenAI subscription tokens and stores rotated refresh token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };

    expect(needsOpenAIRefresh(account)).toBe(true);
    const ok = await refreshOpenAISubscriptionToken(account);

    expect(ok).toBe(true);
    expect(account.accessToken).toBe("new-access");
    expect(account.refreshToken).toBe("new-refresh");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refreshes and persists an expiring account before request forwarding", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const accounts = [
      {
        id: "openai-victor",
        provider: "openai_subscription" as const,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      },
    ];
    const save = vi.fn();

    const ok = await prepareOpenAIAccountForRequest(accounts[0], accounts, save);

    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledWith(accounts);
    expect(accounts[0].accessToken).toBe("new-access");
  });

  it("does not persist when the account is still fresh", async () => {
    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      enabled: true,
    };
    const save = vi.fn();

    const ok = await prepareOpenAIAccountForRequest(account, [account], save);

    expect(ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("starts a background refresh loop and returns a stopper", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);
    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const save = vi.fn();

    const stop = startOpenAIRefreshLoop([account], save);
    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(save).toHaveBeenCalled();
    expect(account.accessToken).toBe("new-access");
    vi.useRealTimers();
  });
});
