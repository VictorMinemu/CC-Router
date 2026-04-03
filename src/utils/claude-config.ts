import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { CLAUDE_SETTINGS_PATH } from "../config/paths.js";

/**
 * Write ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into ~/.claude/settings.json.
 *
 * Rules from official Claude Code docs:
 *   - ANTHROPIC_AUTH_TOKEN is sent as "Authorization: Bearer <value>"
 *   - Do NOT append /v1 to ANTHROPIC_BASE_URL — Claude Code adds it automatically
 *   - Merges with existing settings, preserving all other keys
 */
/**
 * @param port - proxy port (used only when baseUrl is not provided)
 * @param baseUrl - full proxy URL e.g. "http://192.168.1.50:3456" or "https://cc-router.example.com"
 *                  If omitted, defaults to http://localhost:<port>
 */
export function writeClaudeSettings(port: number, baseUrl?: string): void {
  const dir = dirname(CLAUDE_SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const existingEnv = (existing["env"] as Record<string, unknown>) ?? {};
  // ANTHROPIC_BASE_URL: no trailing /v1 — Claude Code appends it automatically
  const resolvedUrl = baseUrl ?? `http://localhost:${port}`;

  const updated = {
    ...existing,
    env: {
      ...existingEnv,
      ANTHROPIC_BASE_URL: resolvedUrl,
      // ANTHROPIC_AUTH_TOKEN has higher precedence than ANTHROPIC_API_KEY in Claude Code.
      // The proxy replaces this placeholder with the real OAuth token per request.
      ANTHROPIC_AUTH_TOKEN: "proxy-managed",
    },
  };

  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * Remove cc-router settings from ~/.claude/settings.json.
 * Called when uninstalling cc-router so Claude Code goes back to its default auth.
 */
export function removeClaudeSettings(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return;
  try {
    const existing = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    const env = existing["env"] as Record<string, unknown> | undefined;
    if (env) {
      delete env["ANTHROPIC_BASE_URL"];
      delete env["ANTHROPIC_AUTH_TOKEN"];
      if (Object.keys(env).length === 0) delete existing["env"];
    }
    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(existing, null, 2), "utf-8");
  } catch {
    // If we can't parse it, leave it alone
  }
}

/** Read current Claude Code proxy settings (for display) */
export function readClaudeProxySettings(): { baseUrl?: string; authToken?: string } {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    const env = raw["env"] as Record<string, unknown> | undefined;
    return {
      baseUrl: env?.["ANTHROPIC_BASE_URL"] as string | undefined,
      authToken: env?.["ANTHROPIC_AUTH_TOKEN"] as string | undefined,
    };
  } catch {
    return {};
  }
}
