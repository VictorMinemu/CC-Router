import { spawn } from "child_process";
import { openSync, closeSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import chalk from "chalk";
import { LOG_PATH, PROXY_PORT } from "../config/paths.js";
import { ensureConfigDir } from "../config/manager.js";
import { writePid, getRunningPid, isProcessAlive, removePid, isProxyRunning } from "./pid.js";
import { isWindows } from "../utils/platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ENTRY = join(__dirname, "..", "cli", "index.js");

export interface LaunchOptions {
  port?: number;
  litellmUrl?: string;
  accountsPath?: string;
  serverMode?: boolean;
}

/** Launch cc-router as a detached background process. */
export async function launchDaemon(opts: LaunchOptions = {}): Promise<boolean> {
  const port = opts.port ?? PROXY_PORT;

  // Already running?
  if (await isProxyRunning(port)) {
    console.log(chalk.green(`✓ CC-Router is already running on port ${port}`));
    console.log(chalk.gray(`  Logs: cc-router logs  |  Stop: cc-router stop`));
    return true;
  }

  ensureConfigDir();

  // Build args
  const args = [CLI_ENTRY, "start", "--foreground", "--port", String(port)];
  if (opts.litellmUrl) args.push("--litellm", opts.litellmUrl);
  if (opts.accountsPath) args.push("--accounts", opts.accountsPath);

  // Build env
  const env: Record<string, string | undefined> = { ...process.env, CC_ROUTER_DAEMON: "1" };
  if (opts.serverMode) env["HOST"] = "0.0.0.0";

  // Open log file (append mode) for stdout+stderr redirection
  let logFd: number;
  try {
    logFd = openSync(LOG_PATH, "a");
  } catch (err) {
    console.error(chalk.red(`✗ Cannot open log file: ${LOG_PATH}`));
    console.error(chalk.gray(`  ${(err as Error).message}`));
    return false;
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
    windowsHide: true,
  });

  if (!child.pid) {
    console.error(chalk.red("✗ Failed to start background process"));
    return false;
  }

  writePid(child.pid);
  child.unref();
  closeSync(logFd);

  // Wait for health endpoint to respond
  console.log(chalk.gray("  Starting CC-Router in background..."));
  const healthy = await waitForHealth(port, 5_000);

  if (healthy) {
    console.log(chalk.green(`✓ CC-Router running in background on port ${port}`));
    return true;
  } else {
    console.log(chalk.yellow(`⚠ Process started (PID ${child.pid}) but not yet responding.`));
    console.log(chalk.gray(`  Check logs: cc-router logs`));
    return false;
  }
}

/** Stop the cc-router daemon process. */
export async function stopDaemon(port = PROXY_PORT): Promise<boolean> {
  // Try PID-based stop first
  const pid = getRunningPid();
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
      removePid();
      return true;
    }

    // Wait for graceful shutdown (up to 5s)
    const died = await waitForDeath(pid, 5_000);
    if (!died) {
      // Force kill
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      // Verify it actually died
      await new Promise(r => setTimeout(r, 500));
      if (isProcessAlive(pid)) {
        console.log(chalk.yellow(`  ⚠ Could not kill process ${pid}`));
        return false; // don't remove PID file — process is still alive
      }
    }
    removePid();
    return true;
  }

  // Fallback: kill by port (handles foreground processes or legacy PM2)
  return killByPort(port);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/cc-router/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(300);
  }
  return false;
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }
  return false;
}

async function killByPort(port: number): Promise<boolean> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    if (isWindows()) {
      const { stdout } = await execFileAsync("netstat", ["-ano"]);
      const match = stdout
        .split("\n")
        .find(line => line.includes(`:${port}`) && line.includes("LISTENING"));
      if (!match) return false;
      const pid = match.trim().split(/\s+/).at(-1);
      if (!pid || isNaN(Number(pid))) return false;
      await execFileAsync("taskkill", ["/PID", pid, "/F"]);
      return true;
    } else {
      const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`]);
      const pids = stdout.trim().split("\n").filter(Boolean);
      if (pids.length === 0) return false;
      for (const p of pids) {
        await execFileAsync("kill", ["-TERM", p]);
      }
      return true;
    }
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
