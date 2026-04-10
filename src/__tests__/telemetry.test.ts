import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";

// ─── Isolated temp directory for every run ───────────────────────────────────
const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  return `${tmp}/cc-router-telemetry-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
});

vi.mock("../config/paths.js", () => ({
  CONFIG_DIR: MOCK_DIR,
  TELEMETRY_PATH: `${MOCK_DIR}/telemetry.json`,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import {
  loadTelemetryState,
  writeTelemetryState,
  isTelemetryEnabled,
  type TelemetryState,
} from "../config/telemetry.js";

beforeEach(() => {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
  // Reset env vars
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

afterEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

// ─── TelemetryState persistence ──────────────────────────────────────────────

describe("loadTelemetryState", () => {
  it("creates fresh state with UUID and persists on first call", () => {
    const state = loadTelemetryState();
    expect(state.enabled).toBe(true);
    expect(state.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(new Date(state.firstRunAt).getTime()).toBeGreaterThan(0);

    // Was persisted to disk
    const onDisk = JSON.parse(
      fs.readFileSync(`${MOCK_DIR}/telemetry.json`, "utf-8"),
    ) as TelemetryState;
    expect(onDisk.installId).toBe(state.installId);
  });

  it("returns the same installId on subsequent calls", () => {
    const first = loadTelemetryState();
    const second = loadTelemetryState();
    expect(second.installId).toBe(first.installId);
  });

  it("recovers from corrupted JSON", () => {
    fs.writeFileSync(`${MOCK_DIR}/telemetry.json`, "NOT_JSON{}", "utf-8");
    const state = loadTelemetryState();
    expect(state.enabled).toBe(true);
    expect(state.installId).toBeDefined();
  });
});

describe("writeTelemetryState", () => {
  it("atomically writes state", () => {
    const state: TelemetryState = {
      enabled: false,
      installId: "test-uuid",
      firstRunAt: "2026-01-01T00:00:00.000Z",
      disclosureShown: true,
    };
    writeTelemetryState(state);
    const raw = JSON.parse(
      fs.readFileSync(`${MOCK_DIR}/telemetry.json`, "utf-8"),
    ) as TelemetryState;
    expect(raw).toEqual(state);
    // .tmp was cleaned up (rename replaces)
    expect(fs.existsSync(`${MOCK_DIR}/telemetry.json.tmp`)).toBe(false);
  });
});

// ─── isTelemetryEnabled ──────────────────────────────────────────────────────

describe("isTelemetryEnabled", () => {
  it("returns true by default", () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("returns false when DO_NOT_TRACK=1", () => {
    process.env["DO_NOT_TRACK"] = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("returns false when CC_ROUTER_TELEMETRY=0", () => {
    process.env["CC_ROUTER_TELEMETRY"] = "0";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("returns false when state.enabled is false", () => {
    const state = loadTelemetryState();
    state.enabled = false;
    writeTelemetryState(state);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("env var takes precedence even when state.enabled is true", () => {
    const state = loadTelemetryState();
    state.enabled = true;
    writeTelemetryState(state);
    process.env["DO_NOT_TRACK"] = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });
});

// ─── trackEvent (HTTP client) ────────────────────────────────────────────────

describe("trackEvent", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // Import after mocks are in place
  let trackEvent: typeof import("../utils/telemetry.js").trackEvent;

  beforeEach(async () => {
    // Dynamic import so the module picks up our mocked paths
    const mod = await import("../utils/telemetry.js");
    trackEvent = mod.trackEvent;
  });

  it("sends event to Aptabase EU endpoint", async () => {
    // Ensure telemetry state exists (enabled by default)
    loadTelemetryState();

    await trackEvent("test_event", { key: "value" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://eu.aptabase.com/api/v0/event");
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as RequestInit).headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "App-Key": "A-EU-1060569594",
      }),
    );

    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.eventName).toBe("test_event");
    expect(body.props.key).toBe("value");
    expect(body.systemProps.osName).toMatch(/^(macOS|Linux|Windows)$/);
    expect(body.systemProps.engineName).toBe("node");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // sessionId = first 24 hex chars of installId (no dashes) + epochHours
    const installHex = loadTelemetryState().installId.replace(/-/g, "").slice(0, 24);
    expect(body.sessionId).toContain(installHex);
    expect(body.sessionId.length).toBeLessThanOrEqual(36);
  });

  it("does not call fetch when telemetry is disabled", async () => {
    process.env["DO_NOT_TRACK"] = "1";
    await trackEvent("should_not_send");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws, even if fetch rejects", async () => {
    loadTelemetryState();
    fetchSpy.mockRejectedValue(new Error("network down"));
    await expect(trackEvent("crash_test")).resolves.toBeUndefined();
  });

  it("never throws if fetch times out", async () => {
    loadTelemetryState();
    fetchSpy.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10)),
    );
    await expect(trackEvent("timeout_test")).resolves.toBeUndefined();
  });
});
