import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// vi.hoisted runs BEFORE vi.mock factories — the only way to pass dynamic
// values into a mock factory in ESM+vitest
// vi.hoisted runs before ESM imports resolve — can only use Node globals, no imported modules
const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  const id = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  return `${tmp}/cc-router-cfg-${id}`;
});

vi.mock("../config/paths.js", () => ({
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  CONFIG_DIR: MOCK_DIR,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import {
  writeClaudeSettings,
  removeClaudeSettings,
  readClaudeProxySettings,
} from "../utils/claude-config.js";

const settingsPath = () => `${MOCK_DIR}/settings.json`;

beforeEach(() => {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
});

// ─── writeClaudeSettings ─────────────────────────────────────────────────────

describe("writeClaudeSettings", () => {
  it("creates settings.json when it doesn't exist", () => {
    writeClaudeSettings(3456);
    expect(fs.existsSync(settingsPath())).toBe(true);
  });

  it("writes ANTHROPIC_BASE_URL without /v1 suffix", () => {
    writeClaudeSettings(3456);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
    expect(written.env.ANTHROPIC_BASE_URL).not.toContain("/v1");
  });

  it("sets ANTHROPIC_AUTH_TOKEN to proxy-managed", () => {
    writeClaudeSettings(3456);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("proxy-managed");
  });

  it("merges with existing settings — preserves other top-level keys", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      model: "claude-opus-4-6",
      theme: "dark",
      env: { SOME_OTHER_VAR: "preserved" },
    }));

    writeClaudeSettings(3456);

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("claude-opus-4-6");
    expect(written.theme).toBe("dark");
  });

  it("merges with existing env — preserves other env vars", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: { MY_VAR: "still-here", ANTHROPIC_BASE_URL: "old-value" },
    }));

    writeClaudeSettings(3456);

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.MY_VAR).toBe("still-here");
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
  });

  it("uses the port passed as argument", () => {
    writeClaudeSettings(9999);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:9999");
  });

  it("overwrites a previous cc-router config with a new port", () => {
    writeClaudeSettings(3456);
    writeClaudeSettings(4567);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:4567");
  });

  it("writes the selected Claude Code model when provided", () => {
    writeClaudeSettings(3456, undefined, undefined, "openai/default");

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("openai/default");
  });

  it("preserves an existing Claude Code model when no model is provided", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      model: "claude-opus-4-6",
      env: {},
    }));

    writeClaudeSettings(3456);

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("claude-opus-4-6");
  });
});

// ─── removeClaudeSettings ─────────────────────────────────────────────────────

describe("removeClaudeSettings", () => {
  it("does nothing when settings file does not exist", () => {
    expect(() => removeClaudeSettings()).not.toThrow();
  });

  it("removes ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN", () => {
    writeClaudeSettings(3456);
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(written.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("preserves other env vars after removal", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: { KEEP_ME: "yes", ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_AUTH_TOKEN: "proxy-managed" },
    }));
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.KEEP_ME).toBe("yes");
  });

  it("removes the env block entirely if it becomes empty", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_AUTH_TOKEN: "proxy-managed" },
    }));
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env).toBeUndefined();
  });

  it("preserves other top-level keys after removal", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      model: "claude-opus-4-6",
      env: { ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_AUTH_TOKEN: "x" },
    }));
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("claude-opus-4-6");
  });
});

// ─── readClaudeProxySettings ──────────────────────────────────────────────────

describe("readClaudeProxySettings", () => {
  it("returns empty object when file does not exist", () => {
    expect(readClaudeProxySettings()).toEqual({});
  });

  it("reads baseUrl and authToken correctly", () => {
    writeClaudeSettings(3456, undefined, undefined, "openai/default");
    const result = readClaudeProxySettings();
    expect(result.baseUrl).toBe("http://localhost:3456");
    expect(result.authToken).toBe("proxy-managed");
    expect(result.model).toBe("openai/default");
  });

  it("returns empty object when env block is missing", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ model: "claude-opus-4-6" }));
    expect(readClaudeProxySettings()).toEqual({});
  });
});
