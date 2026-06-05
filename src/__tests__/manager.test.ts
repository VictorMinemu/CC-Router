import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  return `${tmp}/cc-router-mgr-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
});

vi.mock("../config/paths.js", () => ({
  CONFIG_DIR: MOCK_DIR,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import {
  ensureConfigDir,
  accountsFileExists,
  writeAccountsAtomic,
  writeAnthropicAccountsPreservingOtherProviders,
  upsertAccountRecord,
  loadAccounts,
  loadOpenAIAccounts,
  readAccountsFromPath,
  writeConfig,
  getProxyRequestTimeoutMs,
} from "../config/manager.js";

const accountsPath = () => `${MOCK_DIR}/accounts.json`;

const sampleRecord = {
  id: "max-account-1",
  accessToken: "sk-ant-oat01-abc",
  refreshToken: "sk-ant-ort01-xyz",
  expiresAt: 1999999999000,
  scopes: ["user:inference", "user:profile"],
};

beforeEach(() => {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
});

describe("ensureConfigDir", () => {
  it("creates the config directory if it doesn't exist", () => {
    fs.rmSync(MOCK_DIR, { recursive: true, force: true });
    ensureConfigDir();
    expect(fs.existsSync(MOCK_DIR)).toBe(true);
  });

  it("does not throw when directory already exists", () => {
    expect(() => ensureConfigDir()).not.toThrow();
  });
});

describe("accountsFileExists", () => {
  it("returns false when file does not exist", () => {
    expect(accountsFileExists()).toBe(false);
  });

  it("returns true after writing accounts", () => {
    writeAccountsAtomic([sampleRecord]);
    expect(accountsFileExists()).toBe(true);
  });

  it("accepts a custom path override", () => {
    const customPath = `${MOCK_DIR}/custom.json`;
    expect(accountsFileExists(customPath)).toBe(false);
    fs.writeFileSync(customPath, "[]");
    expect(accountsFileExists(customPath)).toBe(true);
  });
});

describe("writeAccountsAtomic", () => {
  it("writes valid JSON to the accounts file", () => {
    writeAccountsAtomic([sampleRecord]);
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("max-account-1");
  });

  it("does not leave a .tmp file after successful write", () => {
    writeAccountsAtomic([sampleRecord]);
    expect(fs.existsSync(`${accountsPath()}.tmp`)).toBe(false);
  });

  it("overwrites existing content on second write", () => {
    writeAccountsAtomic([sampleRecord]);
    writeAccountsAtomic([{ ...sampleRecord, id: "updated" }]);
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed[0].id).toBe("updated");
  });

  it("writes an empty array without error", () => {
    expect(() => writeAccountsAtomic([])).not.toThrow();
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toEqual([]);
  });

  it("writes multiple records correctly", () => {
    const records = [
      { ...sampleRecord, id: "account-1" },
      { ...sampleRecord, id: "account-2" },
      { ...sampleRecord, id: "account-3" },
    ];
    writeAccountsAtomic(records);
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toHaveLength(3);
    expect(parsed.map((r: { id: string }) => r.id)).toEqual(["account-1", "account-2", "account-3"]);
  });
});

describe("writeAnthropicAccountsPreservingOtherProviders", () => {
  it("replaces Anthropic records while preserving OpenAI subscription records", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
      },
    ]);

    writeAnthropicAccountsPreservingOtherProviders([
      {
        ...sampleRecord,
        id: "max-account-updated",
        accessToken: "sk-ant-oat01-updated",
      },
    ]);

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed.map((record: { id: string }) => record.id)).toEqual([
      "max-account-updated",
      "openai-victor",
    ]);
    expect(parsed[1].provider).toBe("openai_subscription");
  });
});

describe("upsertAccountRecord", () => {
  it("adds or replaces a provider-tagged OpenAI record without changing Anthropic records", () => {
    writeAccountsAtomic([sampleRecord]);

    upsertAccountRecord({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: 1999999999000,
      scopes: ["openid"],
      enabled: true,
    });

    upsertAccountRecord({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access-updated",
      refreshToken: "openai-refresh",
      expiresAt: 1999999999000,
      scopes: ["openid"],
      enabled: true,
    });

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("max-account-1");
    expect(parsed[1].accessToken).toBe("openai-access-updated");
  });
});

describe("loadAccounts", () => {
  it("returns empty array when file does not exist", () => {
    expect(loadAccounts()).toEqual([]);
  });

  it("deserializes AccountRecord[] into Account[] with runtime defaults", () => {
    writeAccountsAtomic([sampleRecord]);
    const accounts = loadAccounts();

    expect(accounts).toHaveLength(1);
    const a = accounts[0];
    expect(a.id).toBe("max-account-1");
    expect(a.tokens.accessToken).toBe("sk-ant-oat01-abc");
    expect(a.tokens.refreshToken).toBe("sk-ant-ort01-xyz");
    expect(a.tokens.expiresAt).toBe(1999999999000);
    expect(a.tokens.scopes).toEqual(["user:inference", "user:profile"]);
    // Runtime defaults
    expect(a.healthy).toBe(true);
    expect(a.busy).toBe(false);
    expect(a.requestCount).toBe(0);
    expect(a.errorCount).toBe(0);
    expect(a.consecutiveErrors).toBe(0);
    expect(a.lastUsed).toBe(0);
    expect(a.lastRefresh).toBe(0);
  });

  it("defaults scopes to user:inference user:profile when missing", () => {
    const noScopes = { ...sampleRecord } as Record<string, unknown>;
    delete noScopes["scopes"];
    writeAccountsAtomic([noScopes]);
    const accounts = loadAccounts();
    expect(accounts[0].tokens.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("does not include OpenAI subscription records in the Anthropic token pool", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
      },
    ]);

    expect(loadAccounts().map(a => a.id)).toEqual(["max-account-1"]);
  });
});

describe("loadOpenAIAccounts", () => {
  it("loads OpenAI subscription records separately from Anthropic accounts", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
        enabled: true,
      },
    ]);

    expect(loadOpenAIAccounts()).toEqual([
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        enabled: true,
      },
    ]);
  });
});

describe("readAccountsFromPath", () => {
  it("reads from an explicit path", () => {
    const customPath = `${MOCK_DIR}/custom-accounts.json`;
    fs.writeFileSync(customPath, JSON.stringify([sampleRecord]));
    const accounts = readAccountsFromPath(customPath);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("max-account-1");
  });

  it("returns empty array for a non-existent path", () => {
    const missing = `${MOCK_DIR}/does-not-exist.json`;
    expect(readAccountsFromPath(missing)).toEqual([]);
  });
});

describe("getProxyRequestTimeoutMs", () => {
  it("reads proxyRequestTimeoutMs from config.json", () => {
    writeConfig({ proxyRequestTimeoutMs: 120_000 });

    expect(getProxyRequestTimeoutMs()).toBe(120_000);
  });

  it("defaults to five minutes when config.json does not define a timeout", () => {
    expect(getProxyRequestTimeoutMs()).toBe(300_000);
  });

  it("accepts proxyRequesTime as a backward-compatible alias", () => {
    writeConfig({ proxyRequesTime: 180_000 });

    expect(getProxyRequestTimeoutMs()).toBe(180_000);
  });

  it("writes proxyRequestTimeoutMs when creating config.json", () => {
    writeConfig({ proxySecret: "secret" });

    const parsed = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(parsed.proxySecret).toBe("secret");
    expect(parsed.proxyRequestTimeoutMs).toBe(300_000);
    expect(parsed.proxyRequesTime).toBeUndefined();
  });

  it("migrates proxyRequesTime to proxyRequestTimeoutMs when writing config.json", () => {
    writeConfig({ proxyRequesTime: 180_000 });

    const parsed = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(parsed.proxyRequestTimeoutMs).toBe(180_000);
    expect(parsed.proxyRequesTime).toBeUndefined();
  });
});
