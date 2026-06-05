export interface OAuthTokens {
  accessToken: string;   // sk-ant-oat01-...
  refreshToken: string;  // sk-ant-ort01-...
  expiresAt: number;     // Unix timestamp in ms
  scopes: string[];      // ["user:inference", "user:profile"]
}

export interface AccountRateLimits {
  status: "allowed" | "rate_limited" | "unknown";
  fiveHourUtil: number;      // 0.0 – 1.0
  fiveHourReset: number;     // Unix timestamp in seconds
  sevenDayUtil: number;      // 0.0 – 1.0
  sevenDayReset: number;     // Unix timestamp in seconds
  claim: string;             // "five_hour" | "seven_day" — which window is limiting
  plan: string;              // "Pro" | "Max 5x" | "Max 20x" | ""
  requestsLimit: number;     // per-minute RPM from anthropic-ratelimit-requests-limit
  lastUpdated: number;       // Unix timestamp in ms
}

export const DEFAULT_RATE_LIMITS: AccountRateLimits = {
  status: "unknown",
  fiveHourUtil: 0,
  fiveHourReset: 0,
  sevenDayUtil: 0,
  sevenDayReset: 0,
  claim: "",
  plan: "",
  requestsLimit: 0,
  lastUpdated: 0,
};

export interface Account {
  id: string;
  tokens: OAuthTokens;
  healthy: boolean;
  busy: boolean;
  requestCount: number;
  errorCount: number;
  lastUsed: number;      // Unix timestamp in ms
  lastRefresh: number;   // Unix timestamp in ms
  consecutiveErrors: number;
  rateLimits: AccountRateLimits;
  /** When false, the pool skips this account entirely. Default: true. */
  enabled: boolean;
  /** Cap for the 5-hour window utilization (0–100). Account is skipped once
   *  rateLimits.fiveHourUtil * 100 >= this value. Default: 100 (no cap). */
  sessionLimitPercent: number;
  /** Cap for the 7-day window utilization (0–100). Account is skipped once
   *  rateLimits.sevenDayUtil * 100 >= this value. Default: 100 (no cap). */
  weeklyLimitPercent: number;
}

export interface RefreshResponse {
  token_type: string;      // "Bearer"
  access_token: string;
  expires_in: number;      // seconds, typically 28800 (8h)
  refresh_token: string;   // ROTATES on every refresh — must save immediately
  scope: string;           // "user:inference user:profile"
}

// Shape of each entry in accounts.json
export interface AccountRecord {
  id: string;
  provider?: "anthropic_subscription" | "openai_subscription" | "openai_api_key";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  // The following three fields are optional for backwards compatibility with
  // accounts.json files created before the interactive management feature.
  // Missing values are filled in by deserialize() with sensible defaults.
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

/**
 * Single source of truth for the default values of user-controllable
 * account fields. Used by deserialize(), TokenPool.addAccount(),
 * setupSingleAccount(), and the PATCH validation path.
 */
export const ACCOUNT_USER_DEFAULTS = {
  enabled: true,
  sessionLimitPercent: 100,
  weeklyLimitPercent: 100,
} as const;

/**
 * Coerce any unknown value into a valid percent in [0, 100].
 * Non-numbers, NaN, and out-of-range values collapse to the fallback (100).
 */
export function clampPercent(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}
