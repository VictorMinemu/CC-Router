/**
 * Manages the mitmproxy lifecycle for Claude Desktop interception.
 *
 * mitmproxy "local mode" uses OS-level network extensions to intercept traffic
 * from a specific process (Claude Desktop) and redirect it through a proxy addon
 * that rewrites api.anthropic.com → CC-Router.
 *
 * Platform mechanisms:
 *   macOS  → Network Extension (App Proxy Provider API)
 *   Windows → WinDivert (WFP kernel driver)
 *   Linux  → eBPF (requires kernel ≥ 6.8)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import os from "os";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { isMacos, isWindows } from "../utils/platform.js";
import { CONFIG_DIR } from "../config/paths.js";

const execFileP = promisify(execFile);

// ─── Paths ────────────────────────────────────────────────────────────────────

const ADDON_DIR = join(CONFIG_DIR, "interceptor");
const ADDON_PATH = join(ADDON_DIR, "addon.py");
const PID_PATH = join(ADDON_DIR, "mitmdump.pid");
const CA_PATH = join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");

// Bundled addon template lives next to this module in src/interceptor/addon.py;
// at runtime (dist/) it's NOT guaranteed to exist because the .py file is only
// included if package.json "files" lists it.  We write a copy to ~/.cc-router/
// on first desktop setup so the user always has a stable file to point at.
function addonSourcePath(): string {
  // __dirname in ESM is not available; use import.meta.url
  const thisFile = new URL(import.meta.url).pathname;
  return join(thisFile, "..", "..", "interceptor", "addon.py");
}

// ─── Process name ─────────────────────────────────────────────────────────────

export function getProcessName(): string {
  if (isMacos()) return "Claude";
  if (isWindows()) return "Claude.exe";
  return "claude"; // Linux (truncated to 16 chars by kernel)
}

// ─── mitmproxy detection ──────────────────────────────────────────────────────

export async function checkMitmproxyInstalled(): Promise<boolean> {
  try {
    await execFileP("which", ["mitmdump"]);
    return true;
  } catch {
    // On Windows, "which" doesn't exist — try "where"
    if (isWindows()) {
      try {
        await execFileP("where", ["mitmdump"]);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ─── CA certificate ───────────────────────────────────────────────────────────

export function isCaCertInstalled(): boolean {
  return existsSync(CA_PATH);
}

/**
 * Run mitmdump briefly to generate the CA certificate at ~/.mitmproxy/.
 * It auto-generates on first launch.
 */
export async function generateCaCert(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("mitmdump", ["--mode", "regular", "--set", "listen_port=0"], {
      stdio: "ignore",
    });
    // Give it 3 seconds to generate the cert, then kill
    setTimeout(() => {
      child.kill("SIGTERM");
      if (existsSync(CA_PATH)) resolve();
      else reject(new Error("CA certificate was not generated"));
    }, 3_000);
    child.on("error", reject);
  });
}

/**
 * Install the mitmproxy CA certificate into the OS trust store.
 * Requires elevated privileges (sudo on macOS/Linux, admin on Windows).
 * Returns true on success.
 */
export async function installCaCert(): Promise<boolean> {
  if (!existsSync(CA_PATH)) {
    await generateCaCert();
  }

  try {
    if (isMacos()) {
      // Uses `security` CLI — requires password via sudo
      await execFileP("sudo", [
        "security", "add-trusted-cert",
        "-d", "-r", "trustRoot",
        "-k", "/Library/Keychains/System.keychain",
        CA_PATH,
      ]);
    } else if (isWindows()) {
      // certutil on Windows
      await execFileP("certutil", ["-addstore", "root", CA_PATH]);
    } else {
      // Linux (Debian/Ubuntu)
      const destDir = "/usr/local/share/ca-certificates";
      const destFile = join(destDir, "mitmproxy.crt");
      await execFileP("sudo", ["cp", CA_PATH, destFile]);
      await execFileP("sudo", ["update-ca-certificates"]);
    }
    return true;
  } catch (e) {
    console.error(`CA install error: ${(e as Error).message}`);
    return false;
  }
}

// ─── Addon script ─────────────────────────────────────────────────────────────

/**
 * Write the redirect addon to ~/.cc-router/interceptor/addon.py.
 * Uses the bundled template as source.
 */
export function writeAddonScript(target: string): void {
  if (!existsSync(ADDON_DIR)) mkdirSync(ADDON_DIR, { recursive: true });

  // Try to copy from the bundled addon; if not found, generate inline
  const bundled = addonSourcePath();
  if (existsSync(bundled)) {
    const src = readFileSync(bundled, "utf-8");
    writeFileSync(ADDON_PATH, src, "utf-8");
  } else {
    // Inline fallback — minimal addon
    const script = `
import os
from mitmproxy import http
from urllib.parse import urlparse

_target = os.environ.get("CC_ROUTER_TARGET", ${JSON.stringify(target)}).rstrip("/")
_p = urlparse(_target)

def request(flow: http.HTTPFlow) -> None:
    if flow.request.pretty_host != "api.anthropic.com":
        return
    flow.request.scheme = _p.scheme
    flow.request.host = _p.hostname or "localhost"
    flow.request.port = _p.port or (443 if _p.scheme == "https" else 80)
    flow.request.headers["host"] = flow.request.host + (f":{flow.request.port}" if flow.request.port not in (80, 443) else "")
`.trimStart();
    writeFileSync(ADDON_PATH, script, "utf-8");
  }
}

// ─── Interceptor lifecycle ────────────────────────────────────────────────────

/**
 * Start mitmdump in local mode, intercepting the Claude process and redirecting
 * api.anthropic.com traffic to CC-Router via the addon script.
 */
export async function startInterceptor(target: string): Promise<void> {
  // Ensure addon exists
  if (!existsSync(ADDON_PATH)) writeAddonScript(target);

  const processName = getProcessName();
  const args = [
    "--mode", `local:${processName}`,
    "-s", ADDON_PATH,
    "--set", "connection_strategy=lazy",
    "--quiet",
  ];

  const child = spawn("mitmdump", args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CC_ROUTER_TARGET: target },
  });

  child.unref();

  if (child.pid) {
    if (!existsSync(ADDON_DIR)) mkdirSync(ADDON_DIR, { recursive: true });
    writeFileSync(PID_PATH, String(child.pid), "utf-8");
  }

  // Give it a moment to start and verify it's running
  await new Promise(r => setTimeout(r, 2_000));
  if (!await isInterceptorRunning()) {
    throw new Error("mitmdump started but exited immediately. Check mitmproxy installation and Network Extension approval.");
  }
}

/** Stop the running mitmdump interceptor. */
export async function stopInterceptor(): Promise<void> {
  const pid = readPid();
  if (!pid) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already dead
  }

  try {
    const { unlinkSync } = await import("fs");
    unlinkSync(PID_PATH);
  } catch {
    // ignore
  }
}

/** Check if the mitmproxy interceptor is currently running. */
export async function isInterceptorRunning(): Promise<boolean> {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const raw = readFileSync(PID_PATH, "utf-8").trim();
  const pid = parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
}
