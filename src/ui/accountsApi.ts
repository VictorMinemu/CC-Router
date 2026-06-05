/**
 * Tiny authenticated HTTP client for /cc-router/accounts.
 *
 * Used by the Ink dashboard to mutate account settings (enable/disable,
 * set per-account caps, delete) without exiting the TUI. The `addAccount`
 * flow is NOT in here — that runs inquirer and must exit Ink first; see
 * src/cli/cmd-status.ts `runAddAccountFlow`.
 */

const REQUEST_TIMEOUT_MS = 3_000;

export interface AccountPatch {
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

export interface AccountsApi {
  /** Apply a partial update to an account. Throws on non-2xx or network error. */
  patch(id: string, patch: AccountPatch): Promise<void>;
  /** Enable or disable every configured account for a provider. */
  setProviderEnabled(provider: "anthropic_subscription" | "openai_subscription", enabled: boolean): Promise<void>;
  /** Remove an account by id. Throws on non-2xx or network error. */
  remove(id: string): Promise<void>;
}

export function createAccountsApi(baseUrl: string, authToken?: string): AccountsApi {
  const base = baseUrl.replace(/\/+$/, "") + "/cc-router/accounts";

  const authHeaders: Record<string, string> = authToken
    ? { authorization: `Bearer ${authToken}` }
    : {};

  async function send(
    method: "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<void> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...authHeaders,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Try to surface the server's error message if we can read one
      let detail = "";
      try {
        const data = await res.json() as { error?: string };
        if (data?.error) detail = `: ${data.error}`;
      } catch { /* best effort */ }
      throw new Error(`HTTP ${res.status}${detail}`);
    }
  }

  return {
    patch(id, patch) {
      return send("PATCH", `/${encodeURIComponent(id)}`, patch);
    },
    setProviderEnabled(provider, enabled) {
      return send("PATCH", `/providers/${encodeURIComponent(provider)}`, { enabled });
    },
    remove(id) {
      return send("DELETE", `/${encodeURIComponent(id)}`);
    },
  };
}
