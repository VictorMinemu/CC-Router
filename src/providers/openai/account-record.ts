import type { AccountRecord } from "../../proxy/types.js";

export type OpenAIAccountRecord = AccountRecord & {
  provider: "openai_subscription";
  enabled: boolean;
};

export interface CreateOpenAIAccountRecordInput {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string | number;
  scopes?: string[] | string;
  enabled?: boolean;
}

function parseExpiresAt(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("expiresAt must be a positive Unix timestamp in milliseconds");
  }
  return parsed;
}

function parseScopes(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return ["openid", "profile", "email", "offline_access"];
}

export function createOpenAIAccountRecord(input: CreateOpenAIAccountRecordInput): OpenAIAccountRecord {
  const id = input.id.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Only letters, numbers, _ and - allowed in account ID");
  }
  if (!input.accessToken.trim()) throw new Error("Access token is required");
  if (!input.refreshToken.trim()) throw new Error("Refresh token is required");

  return {
    id,
    provider: "openai_subscription",
    accessToken: input.accessToken.trim(),
    refreshToken: input.refreshToken.trim(),
    expiresAt: parseExpiresAt(input.expiresAt),
    scopes: parseScopes(input.scopes),
    enabled: input.enabled ?? true,
  };
}
