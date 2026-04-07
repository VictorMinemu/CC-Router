import { spawn, execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { createRequire } from "module";
import chalk from "chalk";
import { CONFIG_DIR } from "../config/paths.js";

const PKG_NAME = "ai-cc-router";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const CHECK_CACHE_PATH = join(CONFIG_DIR, "update-check.json");
const LAST_GOOD_PATH = join(CONFIG_DIR, "last-good-version.json");
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Version helpers ─────────────────────────────────────────────────────────

export function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json") as { version: string };
  return pkg.version;
}

/** Simple semver diff: returns "major" | "minor" | "patch" | null */
function semverDiff(current: string, latest: string): "major" | "minor" | "patch" | null {
  const c = current.split(".").map(Number);
  const l = latest.split(".").map(Number);
  if (l[0] > c[0]) return "major";
  if (l[1] > c[1]) return "minor";
  if (l[2] > c[2]) return "patch";
  return null;
}

// ─── Check for update ────────────────────────────────────────────────────────

interface UpdateCheckResult {
  current: string;
  latest: string;
  diff: "major" | "minor" | "patch" | null;
  updateAvailable: boolean;
}

interface CachedCheck {
  latest: string;
  checkedAt: number;
}

function readCache(): CachedCheck | null {
  try {
    if (!existsSync(CHECK_CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CHECK_CACHE_PATH, "utf-8")) as CachedCheck;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CHECK_CACHE_PATH, JSON.stringify({ latest, checkedAt: Date.now() }), "utf-8");
  } catch { /* non-critical */ }
}

/** Check npm registry for a newer version. Uses a 6h disk cache. */
export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const current = getCurrentVersion();

  // Use cache if fresh enough
  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
      const diff = semverDiff(current, cached.latest);
      return { current, latest: cached.latest, diff, updateAvailable: diff !== null };
    }
  }

  // Fetch from registry
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { current, latest: current, diff: null, updateAvailable: false };
    const data = (await res.json()) as { version: string };
    writeCache(data.version);
    const diff = semverDiff(current, data.version);
    return { current, latest: data.version, diff, updateAvailable: diff !== null };
  } catch {
    return { current, latest: current, diff: null, updateAvailable: false };
  }
}

// ─── Install prefix detection ────────────────────────────────────────────────
// Detect from process.argv[1] (the actual script), NOT from `npm config get prefix`
// which can return a wrong path under nvm/volta/fnm.

function detectInstallPrefix(): string {
  try {
    const scriptPath = realpathSync(process.argv[1]);
    // scriptPath is like: /prefix/lib/node_modules/ai-cc-router/dist/cli/index.js
    // We need to walk up to the prefix root.
    const marker = join("node_modules", PKG_NAME);
    const idx = scriptPath.indexOf(marker);
    if (idx !== -1) {
      // Walk up from .../lib/node_modules/ai-cc-router → .../
      const libDir = scriptPath.slice(0, idx); // .../lib/
      return resolve(libDir, "..");
    }
  } catch { /* fallback */ }

  // Fallback: ask npm (less reliable but better than nothing)
  try {
    return execFileSync("npm", ["config", "get", "prefix"], { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local";
  }
}

// ─── Perform update ──────────────────────────────────────────────────────────

export async function performUpdate(targetVersion: string): Promise<boolean> {
  const prefix = detectInstallPrefix();

  console.log(chalk.cyan(`\nUpdating ${PKG_NAME} to v${targetVersion}...`));
  console.log(chalk.gray(`  prefix: ${prefix}`));

  return new Promise((resolve) => {
    const child = spawn(
      "npm",
      ["install", "-g", `${PKG_NAME}@${targetVersion}`, `--prefix=${prefix}`],
      { stdio: "inherit", shell: process.platform === "win32" },
    );

    child.on("error", (err) => {
      console.error(chalk.red(`✗ Update failed: ${err.message}`));
      resolve(false);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        console.log(chalk.green(`✓ Updated to v${targetVersion}`));
        writeLastGood(targetVersion);
        resolve(true);
      } else {
        console.error(chalk.red(`✗ npm install exited with code ${code}`));
        resolve(false);
      }
    });
  });
}

// ─── Restart ─────────────────────────────────────────────────────────────────

function isRunningUnderPm2(): boolean {
  return !!process.env["PM2_HOME"] || !!process.env["pm_id"];
}

/** Restart the process. Under PM2 → SIGTERM (let PM2 restart). Standalone → detached respawn. */
export function restartSelf(): void {
  if (isRunningUnderPm2()) {
    console.log(chalk.gray("Restarting via PM2..."));
    process.kill(process.pid, "SIGTERM");
    return;
  }

  console.log(chalk.gray("Restarting..."));
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CC_ROUTER_UPDATED: "1" },
  });
  child.unref();
  process.exit(0);
}

// ─── Last good version (rollback safety) ─────────────────────────────────────

function writeLastGood(version: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(LAST_GOOD_PATH, JSON.stringify({ version, ts: Date.now() }), "utf-8");
  } catch { /* non-critical */ }
}

export function getLastGoodVersion(): string | null {
  try {
    if (!existsSync(LAST_GOOD_PATH)) return null;
    const data = JSON.parse(readFileSync(LAST_GOOD_PATH, "utf-8")) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

// ─── High-level: check + update + restart ────────────────────────────────────

/** Background auto-update check. Only patches/minor. Returns true if update was started. */
export async function autoUpdateIfAvailable(): Promise<boolean> {
  const check = await checkForUpdate();
  if (!check.updateAvailable || check.diff === "major") return false;

  console.log(chalk.cyan(`\nNew version available: v${check.current} → v${check.latest}`));
  const ok = await performUpdate(check.latest);
  if (ok) {
    restartSelf();
    return true;
  }
  return false;
}

// ─── Notification banner (for interactive CLI) ──────────────────────────────

export function printUpdateBanner(check: UpdateCheckResult): void {
  if (!check.updateAvailable) return;

  const border = "─".repeat(50);
  console.log();
  console.log(chalk.yellow(border));
  console.log(
    chalk.yellow("  Update available: ") +
    chalk.gray(`v${check.current}`) +
    chalk.yellow(" → ") +
    chalk.green.bold(`v${check.latest}`),
  );
  console.log(
    chalk.yellow("  Run: ") +
    chalk.cyan("cc-router update") +
    chalk.yellow("  or  ") +
    chalk.cyan(`npm i -g ${PKG_NAME}@${check.latest}`),
  );
  console.log(chalk.yellow(border));
  console.log();
}
