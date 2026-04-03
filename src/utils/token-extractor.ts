import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";
import type { OAuthTokens } from "../proxy/types.js";

const execFileAsync = promisify(execFile);

/**
 * macOS: extract OAuth tokens from the macOS Keychain.
 * Uses execFile (not exec/execSync) — args are passed as an array,
 * preventing any shell injection.
 */
export async function extractFromKeychain(): Promise<OAuthTokens | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", "Claude Code-credentials",
      "-w",
    ]);
    const raw = JSON.parse(stdout.trim());
    // Keychain JSON can be either:
    //   { claudeAiOauth: { accessToken, refreshToken, ... }, mcpOAuth: {...} }
    //   { accessToken, refreshToken, ... }  (direct, older versions)
    const oauth = raw.claudeAiOauth ?? raw;
    return parseCredentialJson(oauth);
  } catch {
    return null;
  }
}

/**
 * Linux / Windows: read from ~/.claude/.credentials.json.
 * Claude Code writes credentials here on non-macOS platforms.
 * No shell — pure Node.js file read.
 */
export function extractFromCredentialsFile(): OAuthTokens | null {
  const credPath = join(os.homedir(), ".claude", ".credentials.json");
  if (!existsSync(credPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(credPath, "utf-8"));
    // The file can have two shapes:
    //   { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes } }
    //   { accessToken, refreshToken, expiresAt, scopes }  (direct)
    const oauth = raw.claudeAiOauth ?? raw;
    return parseCredentialJson(oauth);
  } catch {
    return null;
  }
}

/** Parse and normalise either a raw JSON string or an already-parsed object. */
function parseCredentialJson(raw: unknown): OAuthTokens | null {
  try {
    const obj: Record<string, unknown> =
      typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);

    const accessToken = obj["accessToken"];
    const refreshToken = obj["refreshToken"];
    const expiresAt = obj["expiresAt"];

    if (
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string" ||
      !accessToken.startsWith("sk-ant-")
    ) {
      return null;
    }

    const scopes = Array.isArray(obj["scopes"])
      ? (obj["scopes"] as string[])
      : ["user:inference", "user:profile"];

    let expiresAtMs: number;
    if (typeof expiresAt === "number") {
      expiresAtMs = expiresAt;
    } else if (typeof expiresAt === "string") {
      expiresAtMs = new Date(expiresAt).getTime();
    } else {
      // No expiry info — assume 8h from now (standard OAuth token lifetime)
      expiresAtMs = Date.now() + 8 * 60 * 60 * 1000;
    }

    return { accessToken, refreshToken, expiresAt: expiresAtMs, scopes };
  } catch {
    return null;
  }
}

/** Format a token expiry timestamp as a human-readable string */
export function formatExpiry(expiresAtMs: number): string {
  const ms = expiresAtMs - Date.now();
  if (ms <= 0) return "EXPIRED";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Redact a token for safe display: show first 20 chars + "..." */
export function redactToken(token: string): string {
  return token.length > 20 ? `${token.slice(0, 20)}...` : token;
}
