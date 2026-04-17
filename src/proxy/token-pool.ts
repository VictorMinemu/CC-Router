import type { Account, AccountRecord } from "./types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, clampPercent } from "./types.js";

export class EmptyPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPoolError";
  }
}

/** Returns the earliest non-zero reset timestamp (seconds) for an account. */
function earliestReset(a: Account): number {
  const r = a.rateLimits;
  if (r.fiveHourReset && r.sevenDayReset) return Math.min(r.fiveHourReset, r.sevenDayReset);
  return r.fiveHourReset || r.sevenDayReset || Infinity;
}

/**
 * Returns the reset timestamp (seconds) that must pass before the account
 * stops being rate_limited. Prefers the `claim` window (the one Anthropic
 * said was actually limiting); falls back to the earliest non-zero reset.
 * Returns 0 when no reset is known.
 */
function limitingReset(a: Account): number {
  const r = a.rateLimits;
  if (r.claim === "five_hour" && r.fiveHourReset) return r.fiveHourReset;
  if (r.claim === "seven_day" && r.sevenDayReset) return r.sevenDayReset;
  const earliest = earliestReset(a);
  return Number.isFinite(earliest) ? earliest : 0;
}

/**
 * Roll over any rate-limit window whose reset timestamp has passed.
 *
 * `rateLimits` is a snapshot of Anthropic's response headers — utilization
 * values only refresh when a new response arrives. That creates a stuck
 * state in two scenarios:
 *
 *   1. `status: "rate_limited"` — the pool refuses to route to the account,
 *      so no new response ever updates the status.
 *   2. `fiveHourUtil` / `sevenDayUtil` at or above the user cap — `overUserCap`
 *      evicts the account from rotation, so the util stays stale at its last
 *      recorded value instead of dropping to ~0 when Anthropic's window resets.
 *
 * This sweep resolves both: when `now >= reset` for a window, the util is
 * zeroed and the window's reset timestamp is cleared. When the limiting
 * window expires, `status` flips back to `"allowed"`. The callback fires
 * once per recovery so the dashboard can surface it.
 */
function clearExpiredCooldown(a: Account, onExpired?: (a: Account) => void): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const r = a.rateLimits;
  let changed = false;
  let recovered = false;

  if (r.fiveHourReset > 0 && nowSec >= r.fiveHourReset) {
    r.fiveHourUtil = 0;
    r.fiveHourReset = 0;
    changed = true;
  }
  if (r.sevenDayReset > 0 && nowSec >= r.sevenDayReset) {
    r.sevenDayUtil = 0;
    r.sevenDayReset = 0;
    changed = true;
  }

  // If the account was rate_limited and its claimed window just reset,
  // return it to rotation. If we can't tell which window was limiting
  // (empty claim) but all known windows have rolled over, clear the flag.
  if (r.status === "rate_limited") {
    const stillBlocked =
      (r.claim === "five_hour" && r.fiveHourReset > 0) ||
      (r.claim === "seven_day" && r.sevenDayReset > 0) ||
      (r.claim === "" && (r.fiveHourReset > 0 || r.sevenDayReset > 0));
    if (!stillBlocked) {
      r.status = "allowed";
      recovered = true;
      changed = true;
    }
  }

  if (changed) r.lastUpdated = Date.now();
  if (recovered && onExpired) onExpired(a);
}

/** True when the account's user-defined caps have been reached. */
function overUserCap(a: Account): boolean {
  return (
    a.rateLimits.fiveHourUtil * 100 >= a.sessionLimitPercent ||
    a.rateLimits.sevenDayUtil * 100 >= a.weeklyLimitPercent
  );
}

/** Filter out accounts the user has taken out of the rotation. */
function isUsable(a: Account): boolean {
  return a.enabled && !overUserCap(a);
}

export interface AccountPatch {
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

export class TokenPool {
  private accounts: Account[];
  private currentIndex = 0;

  constructor(accounts: Account[]) {
    this.accounts = accounts;
  }

  /**
   * Round-robin selection among accounts that are:
   *   • healthy
   *   • not busy
   *   • not rate-limited by Anthropic
   *   • enabled (user toggle)
   *   • under the user-configured 5h/7d caps
   *
   * Fallback chain when nothing is available:
   *   1. Any healthy+usable (enabled & under caps) account — pick earliest reset.
   *   2. Any healthy account — pick earliest reset. This intentionally ignores
   *      user caps when every option is capped; limits are advisory, not a hard
   *      ban that would leave Claude Code with no working account. The fallback
   *      is logged via the optional onCapBypass callback so the dashboard can
   *      surface it instead of silently exceeding the cap.
   *   3. accounts[0] as a last resort (only if every account is unhealthy).
   *
   * Throws `EmptyPoolError` when there are no accounts at all — callers in
   * the request path should map this to a 503. The DELETE endpoint guards
   * against this state by refusing to remove the last account.
   */
  getNext(): Account {
    if (this.accounts.length === 0) {
      throw new EmptyPoolError("token pool is empty — add an account first");
    }

    // Sweep expired cooldowns before filtering — otherwise rate_limited accounts
    // whose reset window has passed would never re-enter rotation.
    for (const a of this.accounts) clearExpiredCooldown(a, this.onCooldownExpired);

    const available = this.accounts.filter(a =>
      a.healthy &&
      !a.busy &&
      a.rateLimits.status !== "rate_limited" &&
      isUsable(a)
    );

    if (available.length === 0) {
      const healthyUsable = this.accounts.filter(a => a.healthy && isUsable(a));
      if (healthyUsable.length > 0) {
        return healthyUsable.reduce((best, a) =>
          earliestReset(a) < earliestReset(best) ? a : best
        );
      }
      const healthy = this.accounts.filter(a => a.healthy);
      if (healthy.length === 0) {
        return this.accounts[0];
      }
      // All healthy accounts are either busy, rate-limited, or over user caps.
      // Fall back to the one that'll reset soonest — see docstring. Notify
      // the listener so the bypass becomes visible in the dashboard.
      const fallback = healthy.reduce((best, a) =>
        earliestReset(a) < earliestReset(best) ? a : best
      );
      const someCapped = this.accounts.some(a => a.healthy && overUserCap(a));
      if (someCapped && this.onCapBypass) {
        this.onCapBypass(fallback);
      }
      return fallback;
    }

    const account = available[this.currentIndex % available.length];
    this.currentIndex = (this.currentIndex + 1) % available.length;
    account.requestCount++;
    account.lastUsed = Date.now();
    return account;
  }

  /** Optional listener fired when a request is routed to a capped account
   *  because every account in the pool was over its user-configured cap. */
  public onCapBypass?: (account: Account) => void;

  /** Optional listener fired when a rate-limited account's cooldown expires
   *  and it is automatically returned to the rotation. */
  public onCooldownExpired?: (account: Account) => void;

  /**
   * Sweep the pool for accounts whose rate_limited cooldown has passed and
   * clear the flag in place. Intended for periodic calls from the dashboard
   * poll loop so the UI reflects recovery without waiting for a new request.
   */
  sweepExpiredCooldowns(): void {
    for (const a of this.accounts) clearExpiredCooldown(a, this.onCooldownExpired);
  }

  getAll(): Account[] {
    return this.accounts;
  }

  getHealthy(): Account[] {
    return this.accounts.filter(a => a.healthy);
  }

  getStats() {
    return this.accounts.map(a => ({
      id: a.id,
      healthy: a.healthy,
      busy: a.busy,
      requestCount: a.requestCount,
      errorCount: a.errorCount,
      expiresInMs: a.tokens.expiresAt - Date.now(),
      lastUsedMs: a.lastUsed,
      lastRefreshMs: a.lastRefresh,
      rateLimits: a.rateLimits,
      enabled: a.enabled,
      sessionLimitPercent: a.sessionLimitPercent,
      weeklyLimitPercent: a.weeklyLimitPercent,
    }));
  }

  // ─── Mutation API (used by the authenticated HTTP endpoints) ───────────────

  findById(id: string): Account | null {
    return this.accounts.find(a => a.id === id) ?? null;
  }

  /**
   * Apply a partial update to an account's user-controlled fields.
   * Only `enabled`, `sessionLimitPercent`, and `weeklyLimitPercent` are
   * touched — token fields are never accepted via this API.
   * Returns the updated account, or null if the id was not found.
   */
  updateAccount(id: string, patch: AccountPatch): Account | null {
    const a = this.findById(id);
    if (!a) return null;
    if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
    if (patch.sessionLimitPercent !== undefined) {
      a.sessionLimitPercent = clampPercent(patch.sessionLimitPercent);
    }
    if (patch.weeklyLimitPercent !== undefined) {
      a.weeklyLimitPercent = clampPercent(patch.weeklyLimitPercent);
    }
    return a;
  }

  /**
   * Append a new account built from a persisted AccountRecord.
   * Rejects duplicates by id — callers should pre-check with findById().
   */
  addAccount(record: AccountRecord): Account {
    if (this.findById(record.id)) {
      throw new Error(`Account "${record.id}" already exists`);
    }
    const account: Account = {
      id: record.id,
      tokens: {
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        expiresAt: record.expiresAt,
        scopes: record.scopes ?? ["user:inference", "user:profile"],
      },
      healthy: true,
      busy: false,
      requestCount: 0,
      errorCount: 0,
      lastUsed: 0,
      lastRefresh: 0,
      consecutiveErrors: 0,
      rateLimits: { ...DEFAULT_RATE_LIMITS },
      enabled: record.enabled !== false,
      sessionLimitPercent: record.sessionLimitPercent !== undefined
        ? clampPercent(record.sessionLimitPercent)
        : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
      weeklyLimitPercent: record.weeklyLimitPercent !== undefined
        ? clampPercent(record.weeklyLimitPercent)
        : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
    };
    this.accounts.push(account);
    return account;
  }

  /**
   * Remove an account by id. Returns true if something was removed.
   *
   * CRITICAL: mutates `this.accounts` IN PLACE via splice() rather than
   * reassigning it. The server passes the same array reference to
   * `startRefreshLoop()` at startup; reassigning would desynchronize the
   * refresh loop from the pool, and the loop's `saveAccounts(accounts)` call
   * would later resurrect the deleted account on disk.
   */
  removeAccount(id: string): boolean {
    const idx = this.accounts.findIndex(a => a.id === id);
    if (idx === -1) return false;
    this.accounts.splice(idx, 1);
    if (this.accounts.length > 0) {
      this.currentIndex = this.currentIndex % this.accounts.length;
    } else {
      this.currentIndex = 0;
    }
    return true;
  }
}
