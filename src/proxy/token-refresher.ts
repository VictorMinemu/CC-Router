import type { Account, RefreshResponse } from "./types.js";
import { writeAnthropicAccountsPreservingOtherProviders, serialize } from "../config/manager.js";
import { logRefresh } from "./logger.js";
import { stats } from "./stats.js";

/**
 * Official Claude Code CLI client_id for the OAuth PKCE flow.
 * Source: extracted from Claude Code auth flow.
 * Update this if Anthropic changes it in a future Claude Code version.
 */
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Primary OAuth token endpoint.
 * Alternative: https://claude.ai/v1/oauth/token
 */
const TOKEN_ENDPOINT = "https://claude.ai/v1/oauth/token";

/** Refresh 10 minutes before expiry */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** Check every 5 minutes */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Per-account refresh locks — prevent concurrent refreshes for the same account */
const refreshLocks = new Map<string, Promise<boolean>>();

export function needsRefresh(account: Account): boolean {
  return (account.tokens.expiresAt - Date.now()) < REFRESH_BUFFER_MS;
}

export async function refreshAccountToken(account: Account): Promise<boolean> {
  // Deduplicate concurrent refresh calls for the same account
  const existing = refreshLocks.get(account.id);
  if (existing) return existing;

  const promise = _doRefresh(account);
  refreshLocks.set(account.id, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(account.id);
  }
}

async function _doRefresh(account: Account): Promise<boolean> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.tokens.refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      logRefresh(account.id, false);
      console.error(`  Status: ${res.status} — ${body}`);
      account.consecutiveErrors++;
      account.healthy = false;
      return false;
    }

    const data: RefreshResponse = await res.json() as RefreshResponse;

    // CRITICAL: refresh_token ROTATES — save the new one immediately or lose access permanently
    account.tokens.accessToken = data.access_token;
    account.tokens.refreshToken = data.refresh_token;
    account.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    account.tokens.scopes = data.scope.split(" ");
    account.healthy = true;
    account.consecutiveErrors = 0;
    account.lastRefresh = Date.now();

    stats.totalRefreshes++;
    stats.addLog({ ts: Date.now(), accountId: account.id, model: "-", type: "refresh" });

    const expiresInMin = Math.round(data.expires_in / 60);
    logRefresh(account.id, true, expiresInMin);
    return true;
  } catch (err) {
    logRefresh(account.id, false);
    console.error(`  Error:`, err);
    account.consecutiveErrors++;
    account.healthy = false;
    return false;
  }
}

/**
 * Persist all accounts to disk.
 * Uses atomic write (tmp + rename) to prevent corruption if process dies mid-write.
 * Must be called after every successful refresh since refresh_token ROTATES.
 */
export function saveAccounts(accounts: Account[]): void {
  writeAnthropicAccountsPreservingOtherProviders(serialize(accounts));
}

/**
 * Background refresh loop: checks every 5 minutes and refreshes any
 * token expiring within the REFRESH_BUFFER_MS window.
 */
export function startRefreshLoop(accounts: Account[]): void {
  const check = async () => {
    for (const account of accounts) {
      if (needsRefresh(account)) {
        const ok = await refreshAccountToken(account);
        if (ok) saveAccounts(accounts);
      }
    }
  };

  // Run immediately on startup (catches already-expired tokens)
  check().catch(console.error);

  setInterval(() => { check().catch(console.error); }, CHECK_INTERVAL_MS);
}
