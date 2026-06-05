import { describe, expect, it, vi } from "vitest";
import {
  exchangeOpenAIDeviceCodeForTokens,
  loginOpenAIWithDeviceCode,
  requestOpenAIDeviceCode,
} from "../providers/openai/device-oauth.js";

function jwtWithExp(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("OpenAI device OAuth", () => {
  it("requests a device code from the OpenAI Codex auth endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        device_auth_id: "dev_123",
        user_code: "ABCD-1234",
        interval: "2",
      }),
    } as Response);

    const code = await requestOpenAIDeviceCode({ fetchImpl });

    expect(code).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      deviceAuthId: "dev_123",
      intervalSeconds: 2,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }),
      }),
    );
  });

  it("polls for authorization code and exchanges it for tokens", async () => {
    const accessToken = jwtWithExp(2_000_000_000);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_code: "auth_code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_token: "id.jwt.token",
          access_token: accessToken,
          refresh_token: "refresh",
        }),
      } as Response);

    const tokens = await exchangeOpenAIDeviceCodeForTokens({
      fetchImpl,
      sleep: async () => {},
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        deviceAuthId: "dev_123",
        intervalSeconds: 1,
      },
    });

    expect(tokens).toEqual({
      idToken: "id.jwt.token",
      accessToken,
      refreshToken: "refresh",
      expiresAt: 2_000_000_000_000,
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
  });

  it("logs in with device code and returns an OpenAI subscription account record", async () => {
    const accessToken = jwtWithExp(2_000_000_000);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_auth_id: "dev_123",
          user_code: "ABCD-1234",
          interval: "1",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_code: "auth_code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_token: "id.jwt.token",
          access_token: accessToken,
          refresh_token: "refresh",
        }),
      } as Response);

    const prompts: Array<{ url: string; code: string }> = [];
    const record = await loginOpenAIWithDeviceCode({
      accountId: "openai-primary",
      fetchImpl,
      sleep: async () => {},
      onDeviceCode: (code) => prompts.push({ url: code.verificationUrl, code: code.userCode }),
    });

    expect(prompts).toEqual([{ url: "https://auth.openai.com/codex/device", code: "ABCD-1234" }]);
    expect(record).toEqual({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken,
      refreshToken: "refresh",
      expiresAt: 2_000_000_000_000,
      scopes: ["openid", "profile", "email", "offline_access"],
      enabled: true,
    });
  });
});
