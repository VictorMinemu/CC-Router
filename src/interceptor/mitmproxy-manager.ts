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

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import os from "os";
import { execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import { isMacos, isWindows, detectPlatform } from "../utils/platform.js";
import { CONFIG_DIR } from "../config/paths.js";

const execFileP = promisify(execFile);

// ─── Paths ────────────────────────────────────────────────────────────────────

const ADDON_DIR = join(CONFIG_DIR, "interceptor");
const ADDON_PATH = join(ADDON_DIR, "addon.py");
const PID_PATH = join(ADDON_DIR, "mitmdump.pid");
const LOG_PATH = join(ADDON_DIR, "mitmdump.log");
const CA_PATH = join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");

// ─── Service paths ────────────────────────────────────────────────────────────

const LAUNCHD_LABEL = "com.cc-router.interceptor";
const LAUNCHD_PLIST = join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_DIR = join(os.homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE = join(SYSTEMD_DIR, "cc-router-interceptor.service");
const WINDOWS_REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_REG_NAME = "CC-Router-Interceptor";

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

// ─── Network Extension status (macOS) ────────────────────────────────────────

/**
 * Status of mitmproxy's macOS Network Extension.
 *   "enabled"       — ready to use
 *   "waiting"       — installed but not approved by the user yet
 *   "not_installed" — mitmdump has never been run, or the extension was removed
 *   "unknown"       — we couldn't query systemextensionsctl
 */
export type NetworkExtensionStatus = "enabled" | "waiting" | "not_installed" | "unknown";

/**
 * Check the approval status of the mitmproxy macOS Network Extension.
 * No-op on Windows/Linux (returns "enabled").
 *
 * Parses `systemextensionsctl list` output, looking for the mitmproxy entry.
 * Status comes from the flags column:
 *   "* *"   → enabled + active
 *   "  *"   → active but waiting for user approval
 */
export async function getNetworkExtensionStatus(): Promise<NetworkExtensionStatus> {
  if (!isMacos()) return "enabled"; // Only macOS needs this check

  try {
    const { stdout } = await execFileP("systemextensionsctl", ["list"]);
    const mitmLine = stdout
      .split("\n")
      .find((l) => l.toLowerCase().includes("mitmproxy"));

    if (!mitmLine) return "not_installed";

    // systemextensionsctl flags are the first two columns; "*" means set.
    // Order is "enabled active" — both must be "*" for the extension to work.
    // Example strings seen in the wild:
    //   "*\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector..." → enabled
    //   "\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector..."  → waiting
    //
    // We also accept the human-readable "[activated enabled]" / "[activated waiting for user]"
    // suffix that newer macOS versions append.
    if (mitmLine.includes("[activated enabled]")) return "enabled";
    if (mitmLine.includes("waiting for user")) return "waiting";

    const cols = mitmLine.split("\t").map((s) => s.trim());
    const enabled = cols[0] === "*";
    const active = cols[1] === "*";
    if (enabled && active) return "enabled";
    if (!enabled && active) return "waiting";
    return "not_installed";
  } catch {
    return "unknown";
  }
}

/** Open the macOS "Login Items & Extensions" settings pane. Best-effort. */
export async function openNetworkExtensionSettings(): Promise<void> {
  if (!isMacos()) return;
  try {
    // The x-apple.systempreferences URL opens the right pane in System Settings.
    // Extensions pane is not directly deep-linkable, so we open the closest one.
    await execFileP("open", ["x-apple.systempreferences:com.apple.LoginItems-Settings.extension"]);
  } catch {
    // If that fails, fall back to opening plain System Settings
    await execFileP("open", ["/System/Applications/System Settings.app"]).catch(() => {});
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

  // Try to use the bundled addon as template; fall back to a minimal inline version.
  // In BOTH cases we inject the actual target URL so the addon is self-contained
  // and doesn't depend on the CC_ROUTER_TARGET env var being present at runtime.
  const bundled = addonSourcePath();
  let src: string;
  if (existsSync(bundled)) {
    src = readFileSync(bundled, "utf-8");
  } else {
    // Inline fallback — minimal addon (only redirects /v1/messages and /v1/models)
    src = `
import os
from mitmproxy import http
from urllib.parse import urlparse

_target_raw = os.environ.get("CC_ROUTER_TARGET", "http://localhost:3456")
_target = _target_raw.rstrip("/")
_target_parsed = urlparse(_target)

if not _target_parsed.scheme or not _target_parsed.netloc:
    raise RuntimeError(f"CC_ROUTER_TARGET is not a valid URL: {_target_raw!r}")

_REDIRECT_PREFIXES = ("/v1/messages", "/v1/models")

def request(flow: http.HTTPFlow) -> None:
    if flow.request.pretty_host != "api.anthropic.com":
        return
    if not flow.request.path.startswith(_REDIRECT_PREFIXES):
        return
    flow.request.scheme = _target_parsed.scheme
    flow.request.host = _target_parsed.hostname or "localhost"
    flow.request.port = _target_parsed.port or (443 if _target_parsed.scheme == "https" else 80)
    flow.request.headers["host"] = flow.request.host + (f":{flow.request.port}" if flow.request.port not in (80, 443) else "")
`.trimStart();
  }

  // Inject the actual target URL into the default so the addon works even
  // without the CC_ROUTER_TARGET env var (e.g. manual mitmdump restarts).
  src = src.replace('"http://localhost:3456"', JSON.stringify(target));
  writeFileSync(ADDON_PATH, src, "utf-8");
}

// ─── Interceptor lifecycle ────────────────────────────────────────────────────

/**
 * Start mitmdump in local mode, intercepting the Claude process and redirecting
 * api.anthropic.com traffic to CC-Router via the addon script.
 */
export async function startInterceptor(target: string): Promise<void> {
  // On macOS, verify the Network Extension is enabled before attempting to start.
  // If it's "waiting", mitmdump starts silently but captures zero traffic.
  if (isMacos()) {
    const status = await getNetworkExtensionStatus();
    if (status === "waiting") {
      throw new Error(
        "Mitmproxy Network Extension is installed but not yet approved.\n" +
        "  Open: System Settings → General → Login Items & Extensions → Network Extensions\n" +
        '  Toggle "Mitmproxy Redirector" ON and enter your admin password.\n' +
        "  Then re-run this command."
      );
    }
    if (status === "not_installed") {
      throw new Error(
        "Mitmproxy Network Extension is not installed.\n" +
        "  Run mitmdump once manually to trigger the installation:\n" +
        '    mitmdump --mode "local:Claude" --set connection_strategy=lazy\n' +
        "  macOS will prompt you to approve it in System Settings.\n" +
        "  Then re-run this command."
      );
    }
  }

  // Always (re)write the addon script so package updates and target-URL
  // changes are picked up automatically without requiring a fresh setup.
  writeAddonScript(target);

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

// ─── Interceptor OS service (auto-start on boot) ────────────────────────────

/** Resolve the absolute path to mitmdump so launchd/systemd can find it. */
async function resolveMitmdumpPath(): Promise<string> {
  try {
    const cmd = isWindows() ? "where" : "which";
    const { stdout } = await execFileP(cmd, ["mitmdump"]);
    return stdout.trim().split("\n")[0]!;
  } catch {
    return "mitmdump"; // fallback — hope it's on PATH at boot time
  }
}

function buildInterceptorPlist(mitmdumpPath: string, target: string): string {
  const processName = getProcessName();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${mitmdumpPath}</string>
        <string>--mode</string>
        <string>local:${processName}</string>
        <string>-s</string>
        <string>${ADDON_PATH}</string>
        <string>--set</string>
        <string>connection_strategy=lazy</string>
        <string>--quiet</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>WorkingDirectory</key>
    <string>${os.homedir()}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env["PATH"] ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"}</string>
        <key>CC_ROUTER_TARGET</key>
        <string>${target}</string>
    </dict>
</dict>
</plist>
`;
}

function buildInterceptorSystemdUnit(mitmdumpPath: string, target: string): string {
  const processName = getProcessName();
  return `[Unit]
Description=CC-Router Interceptor — mitmproxy for Claude Desktop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${mitmdumpPath} --mode local:${processName} -s ${ADDON_PATH} --set connection_strategy=lazy --quiet
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
Environment=PATH=${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}
Environment=CC_ROUTER_TARGET=${target}

[Install]
WantedBy=default.target
`;
}

/**
 * Install the mitmproxy interceptor as an OS service so it starts on boot.
 * Stops any existing detached mitmdump process first — the OS service takes over.
 */
export async function installInterceptorService(target: string): Promise<boolean> {
  // Ensure the addon script is up-to-date with the target URL
  writeAddonScript(target);

  // Stop any manually-spawned mitmdump — OS service will manage it now
  await stopInterceptor();

  const mitmdumpPath = await resolveMitmdumpPath();
  const platform = detectPlatform();

  switch (platform) {
    case "macos":  return installInterceptorMacOS(mitmdumpPath, target);
    case "linux":  return installInterceptorLinux(mitmdumpPath, target);
    case "windows": return installInterceptorWindows(mitmdumpPath, target);
  }
}

export async function uninstallInterceptorService(): Promise<void> {
  const platform = detectPlatform();
  switch (platform) {
    case "macos":  return uninstallInterceptorMacOS();
    case "linux":  return uninstallInterceptorLinux();
    case "windows": return uninstallInterceptorWindows();
  }
}

export function isInterceptorServiceInstalled(): boolean {
  const platform = detectPlatform();
  switch (platform) {
    case "macos":  return existsSync(LAUNCHD_PLIST);
    case "linux":  return existsSync(SYSTEMD_SERVICE);
    case "windows": return isInterceptorWindowsServiceInstalled();
  }
}

// ─── macOS LaunchAgent ──────────────────────────────────────────────────────

async function installInterceptorMacOS(mitmdumpPath: string, target: string): Promise<boolean> {
  const launchAgentsDir = dirname(LAUNCHD_PLIST);
  if (!existsSync(launchAgentsDir)) mkdirSync(launchAgentsDir, { recursive: true });

  // Unload existing if present
  if (existsSync(LAUNCHD_PLIST)) {
    await interceptorLaunchctlUnload();
  }

  writeFileSync(LAUNCHD_PLIST, buildInterceptorPlist(mitmdumpPath, target), "utf-8");

  // Load — try modern `bootstrap` first, fallback to legacy `load`
  const uid = String(process.getuid?.() ?? 501);
  try {
    await execFileP("launchctl", ["bootstrap", `gui/${uid}`, LAUNCHD_PLIST]);
  } catch {
    try {
      await execFileP("launchctl", ["load", LAUNCHD_PLIST]);
    } catch (err) {
      console.log(`⚠ Could not auto-load the interceptor LaunchAgent: ${(err as Error).message}`);
      console.log(`  Load manually: launchctl load ${LAUNCHD_PLIST}`);
      return false;
    }
  }
  return true;
}

async function uninstallInterceptorMacOS(): Promise<void> {
  if (!existsSync(LAUNCHD_PLIST)) return;
  await interceptorLaunchctlUnload();
  try { unlinkSync(LAUNCHD_PLIST); } catch { /* ok */ }
}

async function interceptorLaunchctlUnload(): Promise<void> {
  const uid = String(process.getuid?.() ?? 501);
  try {
    await execFileP("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  } catch {
    try {
      await execFileP("launchctl", ["unload", LAUNCHD_PLIST]);
    } catch { /* already unloaded */ }
  }
}

// ─── Linux systemd user service ─────────────────────────────────────────────

async function installInterceptorLinux(mitmdumpPath: string, target: string): Promise<boolean> {
  if (!existsSync(SYSTEMD_DIR)) mkdirSync(SYSTEMD_DIR, { recursive: true });

  writeFileSync(SYSTEMD_SERVICE, buildInterceptorSystemdUnit(mitmdumpPath, target), "utf-8");

  try {
    await execFileP("systemctl", ["--user", "daemon-reload"]);
    await execFileP("systemctl", ["--user", "enable", "cc-router-interceptor"]);
    await execFileP("systemctl", ["--user", "start", "cc-router-interceptor"]);
    return true;
  } catch (err) {
    console.log(`⚠ systemd setup issue: ${(err as Error).message}`);
    console.log("  Enable manually: systemctl --user enable --now cc-router-interceptor");
    return false;
  }
}

async function uninstallInterceptorLinux(): Promise<void> {
  if (!existsSync(SYSTEMD_SERVICE)) return;
  try {
    await execFileP("systemctl", ["--user", "stop", "cc-router-interceptor"]);
    await execFileP("systemctl", ["--user", "disable", "cc-router-interceptor"]);
  } catch { /* may already be stopped */ }
  try { unlinkSync(SYSTEMD_SERVICE); } catch { /* ok */ }
  try { await execFileP("systemctl", ["--user", "daemon-reload"]); } catch { /* ok */ }
}

// ─── Windows Registry ───────────────────────────────────────────────────────

async function installInterceptorWindows(mitmdumpPath: string, target: string): Promise<boolean> {
  const processName = getProcessName();
  const cmd = `cmd /c "set CC_ROUTER_TARGET=${target} && "${mitmdumpPath}" --mode local:${processName} -s "${ADDON_PATH}" --set connection_strategy=lazy --quiet"`;

  try {
    await execFileP("reg", [
      "add", WINDOWS_REG_KEY,
      "/v", WINDOWS_REG_NAME,
      "/t", "REG_SZ",
      "/d", cmd,
      "/f",
    ]);
    return true;
  } catch (err) {
    console.log(`⚠ Registry write failed: ${(err as Error).message}`);
    return false;
  }
}

async function uninstallInterceptorWindows(): Promise<void> {
  try {
    await execFileP("reg", [
      "delete", WINDOWS_REG_KEY,
      "/v", WINDOWS_REG_NAME,
      "/f",
    ]);
  } catch { /* not installed */ }
}

function isInterceptorWindowsServiceInstalled(): boolean {
  try {
    execFileSync("reg", ["query", WINDOWS_REG_KEY, "/v", WINDOWS_REG_NAME]);
    return true;
  } catch {
    return false;
  }
}
