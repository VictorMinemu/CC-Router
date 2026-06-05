import type { ProviderAccount } from "../types.js";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

const refreshLocks = new Map<string, Promise<boolean>>();

interface OpenAIRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export type OpenAISubscriptionAccount = ProviderAccount & {
  provider: "openai_subscription";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export function needsOpenAIRefresh(account: Pick<OpenAISubscriptionAccount, "expiresAt">): boolean {
  return account.expiresAt - Date.now() < REFRESH_BUFFER_MS;
}

export async function refreshOpenAISubscriptionToken(account: OpenAISubscriptionAccount): Promise<boolean> {
  const existing = refreshLocks.get(account.id);
  if (existing) return existing;

  const promise = doRefresh(account);
  refreshLocks.set(account.id, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(account.id);
  }
}

async function doRefresh(account: OpenAISubscriptionAccount): Promise<boolean> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) return false;

  const data = await res.json() as OpenAIRefreshResponse;
  account.accessToken = data.access_token;
  account.refreshToken = data.refresh_token ?? account.refreshToken;
  account.expiresAt = Date.now() + data.expires_in * 1000;
  return true;
}
