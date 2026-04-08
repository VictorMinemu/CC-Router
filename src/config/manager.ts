import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { randomBytes } from "crypto";
import { CONFIG_DIR, ACCOUNTS_PATH, CONFIG_PATH } from "./paths.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

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
  const tmp = ACCOUNTS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, ACCOUNTS_PATH);
}

/** Deserialize flat AccountRecord[] from the default path into runtime Account[] */
export function loadAccounts(): Account[] {
  return deserialize(readAccountsRaw() as AccountRecord[]);
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
}

export interface ProxyConfig {
  proxySecret?: string;
  /** Auto-update on patch/minor releases. Default: true (enabled). Set to false to disable. */
  autoUpdate?: boolean;
  /** Present only when this machine is in "client" mode (connected to a remote CC-Router) */
  client?: ClientConfig;
}

export function readConfig(): ProxyConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: ProxyConfig): void {
  ensureConfigDir();
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  renameSync(tmp, CONFIG_PATH);
}

export function generateProxySecret(): string {
  return "cc-rtr-" + randomBytes(16).toString("hex");
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

function deserialize(records: AccountRecord[]): Account[] {
  return records.map(a => ({
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
  }));
}
