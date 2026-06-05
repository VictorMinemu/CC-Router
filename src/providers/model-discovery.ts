import type { OpenAISubscriptionAccount } from "./openai/token-refresher.js";
import type { Account } from "../proxy/types.js";

export const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
export const OPENAI_CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
export const MODEL_DISCOVERY_TIMEOUT_MS = 3_000;

export type FetchLike = typeof fetch;

export function normalizeModelIds(payload: unknown): string[] {
  const values = getModelValues(payload);
  const ids = new Set<string>();

  for (const value of values) {
    const id = getModelId(value);
    if (id) ids.add(id);
  }

  return [...ids];
}

export async function fetchAnthropicModels(
  account: Account,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  return fetchModels(ANTHROPIC_MODELS_ENDPOINT, {
    method: "GET",
    headers: {
      "x-api-key": account.tokens.accessToken,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
  }, fetchImpl);
}

export async function fetchOpenAICodexModels(
  account: OpenAISubscriptionAccount,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  return fetchModels(OPENAI_CODEX_MODELS_ENDPOINT, {
    method: "GET",
    headers: {
      authorization: `Bearer ${account.accessToken}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
  }, fetchImpl);
}

async function fetchModels(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<string[]> {
  try {
    const res = await fetchImpl(url, init);
    if (!res.ok) return [];
    return normalizeModelIds(await res.json());
  } catch {
    return [];
  }
}

function getModelValues(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  return [];
}

function getModelId(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeId(value);
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  return normalizeId(record.id) ?? normalizeId(record.slug) ?? normalizeId(record.name);
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
