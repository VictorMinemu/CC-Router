/**
 * Authenticated HTTP client for /cc-router/models.
 *
 * Used by the dashboard so local and remote client mode can inspect discovered
 * provider models and change router defaults through the same management API.
 */

const REQUEST_TIMEOUT_MS = 5_000;

export interface ModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface ModelRoutingView {
  anthropicDefaultModel?: string;
  openAIDefaultModel?: string;
  anthropicAliases?: Record<string, string>;
  openAIAliases?: Record<string, string>;
}

export interface ModelsStatus {
  routing: ModelRoutingView;
  models: ModelEntry[];
}

export interface ModelDefaultsPatch {
  claudeModel?: string;
  openAIModel?: string;
}

export interface ModelsApi {
  list(): Promise<ModelsStatus>;
  setDefaults(patch: ModelDefaultsPatch): Promise<ModelsStatus>;
}

export function createModelsApi(baseUrl: string, authToken?: string): ModelsApi {
  const endpoint = baseUrl.replace(/\/+$/, "") + "/cc-router/models";
  const authHeaders: Record<string, string> = authToken
    ? { authorization: `Bearer ${authToken}` }
    : {};

  async function send(method: "GET" | "PATCH", body?: unknown): Promise<ModelsStatus> {
    const res = await fetch(endpoint, {
      method,
      headers: {
        ...authHeaders,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const data = await res.json() as { error?: string };
        if (data?.error) detail = `: ${data.error}`;
      } catch { /* best effort */ }
      throw new Error(`HTTP ${res.status}${detail}`);
    }

    const data = await res.json() as Partial<ModelsStatus>;
    return {
      routing: data.routing ?? {},
      models: data.models ?? [],
    };
  }

  return {
    list() {
      return send("GET");
    },
    setDefaults(patch) {
      return send("PATCH", patch);
    },
  };
}
