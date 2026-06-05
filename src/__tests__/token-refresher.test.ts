import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { needsRefresh, refreshAccountToken } from "../proxy/token-refresher.js";
import type { Account } from "../proxy/types.js";

function makeAccount(expiresAt: number): Account {
  return {
    id: "test-account",
    tokens: {
      accessToken: "sk-ant-oat01-old",
      refreshToken: "sk-ant-ort01-old",
      expiresAt,
      scopes: ["user:inference", "user:profile"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
  };
}

// ─── needsRefresh ─────────────────────────────────────────────────────────────

describe("needsRefresh", () => {
  it("returns false when token expires in 2 hours", () => {
    expect(needsRefresh(makeAccount(Date.now() + 2 * 60 * 60 * 1000))).toBe(false);
  });

  it("returns false when token expires in exactly 11 minutes", () => {
    expect(needsRefresh(makeAccount(Date.now() + 11 * 60 * 1000))).toBe(false);
  });

  it("returns true when token expires in 9 minutes (within 10-min buffer)", () => {
    expect(needsRefresh(makeAccount(Date.now() + 9 * 60 * 1000))).toBe(true);
  });

  it("returns true when token expires in 5 minutes", () => {
    expect(needsRefresh(makeAccount(Date.now() + 5 * 60 * 1000))).toBe(true);
  });

  it("returns true when token already expired", () => {
    expect(needsRefresh(makeAccount(Date.now() - 1_000))).toBe(true);
  });

  it("returns true when token expired an hour ago", () => {
    expect(needsRefresh(makeAccount(Date.now() - 60 * 60 * 1000))).toBe(true);
  });
});

// ─── refreshAccountToken ─────────────────────────────────────────────────────

describe("refreshAccountToken", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("updates tokens on successful refresh response", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "sk-ant-oat01-NEW",
        refresh_token: "sk-ant-ort01-NEW",
        expires_in: 28800,
        scope: "user:inference user:profile",
        token_type: "Bearer",
      }),
    } as Response);

    const result = await refreshAccountToken(account);

    expect(result).toBe(true);
    expect(account.tokens.accessToken).toBe("sk-ant-oat01-NEW");
    expect(account.tokens.refreshToken).toBe("sk-ant-ort01-NEW");
    expect(account.tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(account.healthy).toBe(true);
    expect(account.consecutiveErrors).toBe(0);
  });

  it("parses scope string into scopes array", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "sk-ant-oat01-NEW",
        refresh_token: "sk-ant-ort01-NEW",
        expires_in: 28800,
        scope: "user:inference user:profile",
        token_type: "Bearer",
      }),
    } as Response);

    await refreshAccountToken(account);
    expect(account.tokens.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("increments consecutiveErrors on HTTP error response", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    } as Response);

    const result = await refreshAccountToken(account);

    expect(result).toBe(false);
    expect(account.consecutiveErrors).toBe(1);
  });

  it("marks account unhealthy immediately when OAuth refresh is rejected", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    } as Response);

    const result = await refreshAccountToken(account);

    expect(result).toBe(false);
    expect(account.healthy).toBe(false);
  });

  it("marks account unhealthy after 3 consecutive errors", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

    await refreshAccountToken(account);
    await refreshAccountToken(account);
    await refreshAccountToken(account);

    expect(account.consecutiveErrors).toBe(3);
    expect(account.healthy).toBe(false);
  });

  it("returns false and increments errors on network failure", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await refreshAccountToken(account);

    expect(result).toBe(false);
    expect(account.consecutiveErrors).toBe(1);
  });

  it("deduplicates concurrent refresh calls for the same account", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);
    let callCount = 0;

    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 10));
      return {
        ok: true,
        json: async () => ({
          access_token: "sk-ant-oat01-NEW",
          refresh_token: "sk-ant-ort01-NEW",
          expires_in: 28800,
          scope: "user:inference user:profile",
          token_type: "Bearer",
        }),
      } as Response;
    });

    // Fire 3 concurrent refreshes for the same account
    const [r1, r2, r3] = await Promise.all([
      refreshAccountToken(account),
      refreshAccountToken(account),
      refreshAccountToken(account),
    ]);

    // All return the same result but fetch was only called once
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(callCount).toBe(1);
  });
});
