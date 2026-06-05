import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "fs";
import { randomBytes } from "crypto";
import { CONFIG_DIR, ACCOUNTS_PATH, CONFIG_PATH } from "./paths.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, clampPercent } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

export const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function accountsFileExists(path?: string): boolean {
  return existsSync(path ?? ACCOUNTS_PATH);
}

export function readAccountsRaw(): unknown[] {
  return readRawFromPath(ACCOUNTS_PATH);
}

function readRawFromPath(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

/** Deserialize Account[] from an explicit file path */
export function readAccountsFromPath(path: string): Account[] {
  return deserialize(readRawFromPath(path) as AccountRecord[]);
}

// Escritura atómica: escribe a .tmp y renombra — evita JSON corrupto si el proceso muere mid-write
export function writeAccountsAtomic(data: unknown[]): void {
  ensureConfigDir();
  writeAccountsAtomicToPath(ACCOUNTS_PATH, data);
}

function writeAccountsAtomicToPath(path: string, data: unknown[]): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function writeAnthropicAccountsPreservingOtherProviders(data: AccountRecord[]): void {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const nonAnthropic = existing.filter(a =>
    a.provider !== undefined && a.provider !== "anthropic_subscription"
  );
  writeAccountsAtomicToPath(ACCOUNTS_PATH, [...data, ...nonAnthropic]);
}

/** Deserialize flat AccountRecord[] from the default path into runtime Account[] */
export function loadAccounts(): Account[] {
  return deserialize(readAccountsRaw() as AccountRecord[]);
}

/** Load OpenAI ChatGPT/Codex subscription accounts without mixing them into the Anthropic pool. */
export function loadOpenAIAccounts(path?: string): OpenAISubscriptionAccount[] {
  const records = readRawFromPath(path ?? ACCOUNTS_PATH) as AccountRecord[];
  return records
    .filter(a => a.provider === "openai_subscription")
    .map(a => ({
      id: a.id,
      provider: "openai_subscription" as const,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      enabled: a.enabled !== false,
    }));
}

// ─── Proxy config (password, future settings) ─────────────────────────────────

/**
 * Client mode config — when present, this machine is acting as a CLIENT to a
 * remote (or local) CC-Router instance instead of running its own proxy.
 * Claude Code's ANTHROPIC_BASE_URL points at `remoteUrl`; Claude Desktop
 * (optionally) is intercepted via mitmproxy and redirected to the same URL.
 */
export interface ClientConfig {
  /** Full URL of the CC-Router server, e.g. "http://192.168.1.50:3456" or "https://proxy.example.com" */
  remoteUrl: string;
  /** Optional Bearer secret for authenticating against the remote proxy */
  remoteSecret?: string;
  /** True once `cc-router client connect --desktop` has successfully provisioned mitmproxy */
  desktopEnabled?: boolean;
  /** True when the mitmproxy interceptor is installed as an OS service (auto-starts on boot) */
  desktopAutoStart?: boolean;
}

/** Persisted run preferences — asked once on first `cc-router start`, reused afterwards. */
export interface RunPreferences {
  /** How the proxy runs: foreground terminal, detached background, or OS-level auto-start service */
  mode: "foreground" | "background" | "service";
  /** Bind to 0.0.0.0 (true) vs 127.0.0.1 (false) — true when serving other devices on the network */
  serverMode: boolean;
  /** Port to listen on (default 3456) */
  port: number;
  /** Automatically configure Claude Code (~/.claude/settings.json) to use the proxy on start */
  configureClaudeCode?: boolean;
}

export interface ProxyConfig {
  proxySecret?: string;
  /** Upstream proxy request timeout in milliseconds. Default: 300000 (5 minutes). */
  proxyRequestTimeoutMs?: number;
  /** Deprecated typo-compatible alias for proxyRequestTimeoutMs. */
  proxyRequesTime?: number;
  /** Auto-update on patch/minor releases. Default: true (enabled). Set to false to disable. */
  autoUpdate?: boolean;
  /** Present only when this machine is in "client" mode (connected to a remote CC-Router) */
  client?: ClientConfig;
  /** Run preferences — asked once on first start, reused on subsequent starts */
  runPreferences?: RunPreferences;
}

export function readConfig(): ProxyConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig;
  } catch (err) {
    console.warn(`Warning: ${CONFIG_PATH} contains invalid JSON: ${(err as Error).message}`);
    try {
      const backupPath = CONFIG_PATH + ".bak";
      copyFileSync(CONFIG_PATH, backupPath);
      console.warn(`  Backup saved to ${backupPath}`);
    } catch { /* best-effort backup */ }
    console.warn(`  Using default configuration for this session.`);
    return {};
  }
}

export function getProxyRequestTimeoutMs(): number {
  const { proxyRequestTimeoutMs, proxyRequesTime } = readConfig();
  const timeoutMs = proxyRequestTimeoutMs ?? proxyRequesTime;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
}

function normalizeProxyConfig(cfg: ProxyConfig): ProxyConfig {
  const { proxyRequesTime, ...normalized } = cfg;
  const timeoutMs = normalized.proxyRequestTimeoutMs ?? proxyRequesTime;
  normalized.proxyRequestTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
  return normalized;
}

export function writeConfig(cfg: ProxyConfig): void {
  ensureConfigDir();
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(normalizeProxyConfig(cfg), null, 2), "utf-8");
  renameSync(tmp, CONFIG_PATH);
}

export function generateProxySecret(): string {
  return "cc-rtr-" + randomBytes(16).toString("hex");
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

function deserialize(records: AccountRecord[]): Account[] {
  return records.filter(a => a.provider === undefined || a.provider === "anthropic_subscription").map(a => ({
    id: a.id,
    tokens: {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      scopes: a.scopes ?? ["user:inference", "user:profile"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: a.enabled !== false,                         // default true
    sessionLimitPercent: a.sessionLimitPercent !== undefined
      ? clampPercent(a.sessionLimitPercent)
      : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent !== undefined
      ? clampPercent(a.weeklyLimitPercent)
      : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
  }));
}

/** Serialize runtime Account[] back to the flat on-disk AccountRecord[] shape. */
export function serialize(accounts: Account[]): AccountRecord[] {
  return accounts.map(a => ({
    id: a.id,
    accessToken: a.tokens.accessToken,
    refreshToken: a.tokens.refreshToken,
    expiresAt: a.tokens.expiresAt,
    scopes: a.tokens.scopes,
    enabled: a.enabled,
    sessionLimitPercent: a.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent,
  }));
}
