import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { PID_PATH, PROXY_PORT } from "../config/paths.js";
import { ensureConfigDir } from "../config/manager.js";

/** Write the current process PID to the PID file. */
export function writePid(pid: number): void {
  try {
    ensureConfigDir();
    writeFileSync(PID_PATH, String(pid), "utf-8");
  } catch (err) {
    console.warn(`Warning: cannot write PID file ${PID_PATH}: ${(err as Error).message}`);
    console.warn(`  Daemon is running as PID ${pid} but may not be stoppable via cc-router stop`);
  }
}

/** Read PID from file. Returns null if missing or unreadable. */
export function readPid(): number | null {
  try {
    if (!existsSync(PID_PATH)) return null;
    const raw = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch (err) {
    // File exists but can't be read — likely a permissions issue
    console.warn(`Warning: cannot read PID file ${PID_PATH}: ${(err as Error).message}`);
    return null;
  }
}

/** Remove the PID file. */
export function removePid(): void {
  try {
    if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
  } catch (err) {
    console.warn(`Warning: cannot remove PID file ${PID_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Check if a process with the given PID is alive.
 * Uses signal 0 — doesn't actually kill the process, just checks existence.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process — it's dead
    // EPERM = exists but no permission — it's alive
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read PID and verify the process is actually alive.
 * Cleans up stale PID files where the process has died.
 */
export function getRunningPid(): number | null {
  const pid = readPid();
  if (pid === null) return null;
  if (isProcessAlive(pid)) return pid;
  // Stale PID — process died without cleanup
  removePid();
  return null;
}

/**
 * Double-check: PID is alive AND health endpoint responds.
 * Prevents false positives from recycled PIDs (a different process
 * reusing the same PID number).
 */
export async function isProxyRunning(port = PROXY_PORT): Promise<boolean> {
  const pid = getRunningPid();
  if (pid !== null) {
    // PID exists — verify it's actually cc-router via health endpoint
    try {
      const res = await fetch(`http://localhost:${port}/cc-router/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  // No PID file — try health endpoint directly (foreground/legacy processes)
  try {
    const res = await fetch(`http://localhost:${port}/cc-router/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
