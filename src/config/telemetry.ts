import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import { TELEMETRY_PATH } from "./paths.js";
import { ensureConfigDir } from "./manager.js";

// Anonymous telemetry state persisted at ~/.cc-router/telemetry.json.
// The installId is a random UUID with no link to any user identity — it exists
// only so we can count unique installations instead of raw event volume.
export interface TelemetryState {
  enabled: boolean;
  installId: string;
  firstRunAt: string;
  disclosureShown: boolean;
}

function defaultState(): TelemetryState {
  return {
    enabled: true,
    installId: randomUUID(),
    firstRunAt: new Date().toISOString(),
    disclosureShown: false,
  };
}

// Read the telemetry state, creating and persisting a fresh one on first run.
// Malformed files are treated as missing so a corrupted file can't crash the CLI.
export function loadTelemetryState(): TelemetryState {
  if (!existsSync(TELEMETRY_PATH)) {
    const state = defaultState();
    writeTelemetryState(state);
    return state;
  }
  try {
    const raw = JSON.parse(readFileSync(TELEMETRY_PATH, "utf-8")) as Partial<TelemetryState>;
    // Fill any missing fields to keep the file forward-compatible
    const state: TelemetryState = {
      enabled: raw.enabled ?? true,
      installId: raw.installId ?? randomUUID(),
      firstRunAt: raw.firstRunAt ?? new Date().toISOString(),
      disclosureShown: raw.disclosureShown ?? false,
    };
    if (!raw.installId || raw.disclosureShown === undefined) {
      writeTelemetryState(state);
    }
    return state;
  } catch {
    const state = defaultState();
    writeTelemetryState(state);
    return state;
  }
}

// Atomic write: .tmp + rename, same pattern as writeAccountsAtomic
export function writeTelemetryState(state: TelemetryState): void {
  ensureConfigDir();
  const tmp = TELEMETRY_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, TELEMETRY_PATH);
}

// Returns true only if the user has not opted out through any mechanism:
//   - DO_NOT_TRACK=1     (de-facto standard)
//   - CC_ROUTER_TELEMETRY=0  (project-specific override)
//   - `cc-router telemetry off` (persisted enabled: false)
export function isTelemetryEnabled(): boolean {
  if (process.env["DO_NOT_TRACK"] === "1") return false;
  if (process.env["CC_ROUTER_TELEMETRY"] === "0") return false;
  try {
    return loadTelemetryState().enabled;
  } catch {
    return false;
  }
}
