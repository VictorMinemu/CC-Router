import os from "os";
import path from "path";

// All paths support env var overrides so Docker can inject them via environment
export const CONFIG_DIR = path.join(os.homedir(), ".cc-router");

export const ACCOUNTS_PATH =
  process.env["ACCOUNTS_PATH"] ??
  path.join(CONFIG_DIR, "accounts.json");

export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

export const PROXY_PORT = parseInt(process.env["PORT"] ?? "3456", 10);
export const LITELLM_PORT = 4000;

// When set, the server forwards to LiteLLM instead of Anthropic directly
export const LITELLM_URL = process.env["LITELLM_URL"];

// Proxy-level config (password, future settings) — separate from accounts.json
export const CONFIG_PATH =
  process.env["CONFIG_PATH"] ??
  path.join(CONFIG_DIR, "config.json");

// Anonymous telemetry state — install id + opt-in flag
export const TELEMETRY_PATH =
  process.env["TELEMETRY_PATH"] ??
  path.join(CONFIG_DIR, "telemetry.json");
