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

export interface ProxyConfig {
  proxySecret?: string;
  /** When true, the proxy auto-updates itself on patch/minor releases. Default: false. */
  autoUpdate?: boolean;
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
