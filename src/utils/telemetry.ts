import os from "os";
import { isTelemetryEnabled, loadTelemetryState } from "../config/telemetry.js";
import { detectPlatform } from "./platform.js";
import { getCurrentVersion } from "./self-update.js";

// ─── Aptabase configuration ──────────────────────────────────────────────────
// Aptabase is a privacy-first, open source analytics service.
// The full payload we send is documented below — search for "trackEvent" calls
// in the codebase to audit every event.  Nothing here contains PII.
const APTABASE_APP_KEY = "A-EU-1060569594";
const APTABASE_ENDPOINT = "https://eu.aptabase.com/api/v0/event";
const TIMEOUT_MS = 3_000;

// ─── System properties (sent with every event) ──────────────────────────────

interface SystemProps {
  isDebug: boolean;
  locale: string;
  osName: string;
  osVersion: string;
  appVersion: string;
  engineName: string;
  engineVersion: string;
  sdkVersion: string;
}

function getOsName(): string {
  switch (detectPlatform()) {
    case "macos": return "macOS";
    case "linux": return "Linux";
    case "windows": return "Windows";
  }
}

function getLocale(): string {
  try {
    // Aptabase limits locale to 10 characters — truncate extended subtags
    const raw = Intl.DateTimeFormat().resolvedOptions().locale;
    return raw.length <= 10 ? raw : raw.slice(0, 10);
  } catch {
    return process.env["LANG"]?.split(".")[0]?.slice(0, 10) ?? "unknown";
  }
}

function getSystemProps(): SystemProps {
  return {
    isDebug: false,
    locale: getLocale(),
    osName: getOsName(),
    osVersion: os.release(),
    appVersion: getCurrentVersion(),
    engineName: "node",
    engineVersion: process.versions.node,
    sdkVersion: `cc-router@${getCurrentVersion()}`,
  };
}

// Session ID groups events from the same install within an hourly window,
// without leaking timing precision finer than 1h.
// Aptabase limits sessionId to 36 characters. A UUID with dashes is already 36,
// so we strip dashes and take the first 24 hex chars + epochHours (~6-7 digits).
function getSessionId(installId: string): string {
  const epochHours = Math.floor(Date.now() / 3_600_000);
  const shortId = installId.replace(/-/g, "").slice(0, 24);
  return `${shortId}${epochHours}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Fire-and-forget: never throws, never blocks the caller.  If telemetry is
// disabled (env var or opt-out) this is a synchronous no-op.
export async function trackEvent(
  eventName: string,
  props?: Record<string, string | number | boolean>,
): Promise<void> {
  try {
    if (!isTelemetryEnabled()) return;

    const state = loadTelemetryState();
    const body = {
      timestamp: new Date().toISOString(),
      sessionId: getSessionId(state.installId),
      eventName,
      systemProps: getSystemProps(),
      props: props ?? {},
    };

    await fetch(APTABASE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "App-Key": APTABASE_APP_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Silently swallow — telemetry must never disrupt the proxy
  }
}

// Start a heartbeat that fires every 6 hours while the proxy is running.
// Uses .unref() so the timer does not prevent Node from exiting.
export function startHeartbeat(accountCount: number): void {
  const startTime = Date.now();
  const timer = setInterval(() => {
    const uptimeHours = Math.floor((Date.now() - startTime) / 3_600_000);
    trackEvent("proxy_heartbeat", {
      uptime_hours: uptimeHours,
      account_count: accountCount,
    });
  }, 6 * 60 * 60 * 1000);
  timer.unref();
}

