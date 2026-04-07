import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { LogEntry } from "../proxy/stats.js";

const POLL_INTERVAL_MS = 2_000;
const LOG_VISIBLE = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountStat {
  id: string;
  healthy: boolean;
  busy: boolean;
  requestCount: number;
  errorCount: number;
  expiresInMs: number;
  lastUsedMs: number;
  lastRefreshMs: number;
}

interface HealthData {
  status: "ok" | "degraded";
  mode: string;
  target: string;
  uptime: number;
  totalRequests: number;
  totalErrors: number;
  totalRefreshes: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalInputTokens: number;
  accounts: AccountStat[];
  recentLogs: LogEntry[];
}

// ─── Dashboard component ──────────────────────────────────────────────────────

export function Dashboard({ port }: { port: number }) {
  const { exit } = useApp();
  const [data, setData] = useState<HealthData | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [retryCount, setRetryCount] = useState(0);

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
  });

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`http://localhost:${port}/cc-router/health`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (cancelled) return;
        if (res.ok) {
          setData(await res.json() as HealthData);
          setConnectError(null);
          setLastUpdate(Date.now());
          setRetryCount(0);
        } else {
          setConnectError(`Proxy returned HTTP ${res.status}`);
        }
      } catch {
        if (cancelled) return;
        setConnectError(`Cannot connect to http://localhost:${port}`);
        setRetryCount(n => n + 1);
      }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [port]);

  if (connectError) {
    return <ErrorScreen error={connectError} port={port} retries={retryCount} />;
  }

  if (!data) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">⠋ Connecting to http://localhost:{port}...</Text>
      </Box>
    );
  }

  return <LiveDashboard data={data} port={port} lastUpdate={lastUpdate} />;
}

// ─── Error screen ─────────────────────────────────────────────────────────────

function ErrorScreen({ error, port, retries }: { error: string; port: number; retries: number }) {
  return (
    <Box flexDirection="column" marginY={1} marginX={2}>
      <Text color="red" bold>✗ {error}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">Is the proxy running? Start it with:</Text>
        <Text color="cyan">  cc-router start</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Retrying every {POLL_INTERVAL_MS / 1000}s</Text>
        {retries > 0 && <Text color="gray">  (attempt {retries})</Text>}
        <Text color="gray">  ·  [q] quit</Text>
      </Box>
    </Box>
  );
}

// ─── Live dashboard ───────────────────────────────────────────────────────────

function LiveDashboard({ data, port, lastUpdate }: { data: HealthData; port: number; lastUpdate: number }) {
  const healthyCount = data.accounts.filter(a => a.healthy).length;
  const updatedAgo = Math.round((Date.now() - lastUpdate) / 1000);
  const logs = data.recentLogs;

  // Stable selection: track by timestamp so it survives log rotations
  const [selectedTs, setSelectedTs] = useState<number | null>(null);

  // Derive index from timestamp; default to 0 (newest)
  const selectedIndex = selectedTs !== null
    ? Math.max(0, logs.findIndex(l => l.ts === selectedTs))
    : 0;

  useInput((_input, key) => {
    if (key.upArrow) {
      const next = Math.max(0, selectedIndex - 1);
      setSelectedTs(logs[next]?.ts ?? null);
    }
    if (key.downArrow) {
      const next = Math.min(logs.length - 1, selectedIndex + 1);
      setSelectedTs(logs[next]?.ts ?? null);
    }
  });

  const selectedLog = logs[selectedIndex] ?? null;
  const visibleLogs = logs.slice(0, LOG_VISIBLE);

  return (
    <Box flexDirection="column">

      {/* ── Header bar ── */}
      <Box>
        <Text bold color="cyan"> CC-Router </Text>
        <Text color="gray">· </Text>
        <Text color="green">{data.mode}</Text>
        <Text color="gray"> → {data.target}  · </Text>
        <Text>up {formatUptime(data.uptime)}</Text>
        <Text color="gray">  ·  updated {updatedAgo}s ago  ·  [↑↓] navigate  ·  [q] quit</Text>
      </Box>

      <Box marginTop={1} />

      {/* ── Accounts table ── */}
      <Box flexDirection="column">
        <Text bold>
          {" ACCOUNTS  "}
          <Text color={healthyCount === data.accounts.length ? "green" : "yellow"}>
            {healthyCount}/{data.accounts.length} healthy
          </Text>
        </Text>

        <Box marginTop={1} flexDirection="column">
          {data.accounts.map(a => (
            <AccountRow key={a.id} account={a} />
          ))}
        </Box>
      </Box>

      <Box marginTop={1} />

      {/* ── Totals ── */}
      <Box>
        <Text bold> TOTALS  </Text>
        <Text>requests </Text>
        <Text color="cyan">{data.totalRequests}</Text>
        <Text color="gray">  ·  </Text>
        <Text>errors </Text>
        <Text color={data.totalErrors > 0 ? "red" : "green"}>{data.totalErrors}</Text>
        <Text color="gray">  ·  </Text>
        <Text>refreshes </Text>
        <Text color="yellow">{data.totalRefreshes}</Text>
        <CacheHealthBadge
          read={data.totalCacheReadTokens}
          created={data.totalCacheCreationTokens}
          input={data.totalInputTokens}
        />
      </Box>

      <Box marginTop={1} />

      {/* ── Recent activity ── */}
      <Box flexDirection="column">
        <Text bold> RECENT ACTIVITY</Text>
        <Box marginTop={1} flexDirection="column">
          {visibleLogs.length === 0
            ? <Text color="gray">  No activity yet</Text>
            : visibleLogs.map((log, i) => (
                <LogRow key={log.ts} log={log} selected={i === selectedIndex} />
              ))
          }
        </Box>
      </Box>

      {/* ── Detail panel ── */}
      {selectedLog && (
        <>
          <Box marginTop={1} />
          <DetailPanel log={selectedLog} />
        </>
      )}

    </Box>
  );
}

// ─── Account row ──────────────────────────────────────────────────────────────

function AccountRow({ account: a }: { account: AccountStat }) {
  const dot = a.busy ? "◌" : a.healthy ? "●" : "●";
  const dotColor = a.busy ? "yellow" : a.healthy ? "green" : "red";
  const statusLabel = a.busy ? "busy   " : a.healthy ? "ok     " : "ERROR  ";
  const statusColor = a.busy ? "yellow" : a.healthy ? "green" : "red";

  const expiryLabel = a.expiresInMs > 0 ? formatMs(a.expiresInMs) : "EXPIRED";
  const expiryColor = a.expiresInMs < 10 * 60 * 1000 ? "red"
    : a.expiresInMs < 30 * 60 * 1000 ? "yellow"
    : "white";

  return (
    <Box>
      <Text color={dotColor}> {dot} </Text>
      <Text>{a.id.slice(0, 22).padEnd(22)}</Text>
      <Text color={statusColor}>{statusLabel}</Text>
      <Text color="gray"> req </Text>
      <Text color="white">{String(a.requestCount).padStart(5)}</Text>
      <Text color="gray">  err </Text>
      <Text color={a.errorCount > 0 ? "red" : "gray"}>{String(a.errorCount).padStart(3)}</Text>
      <Text color="gray">  expires </Text>
      <Text color={expiryColor}>{expiryLabel.padEnd(10)}</Text>
      <Text color="gray">  last </Text>
      <Text color="gray">{formatAgo(a.lastUsedMs)}</Text>
    </Box>
  );
}

// ─── Log row ──────────────────────────────────────────────────────────────────

function LogRow({ log, selected }: { log: LogEntry; selected: boolean }) {
  const time = new Date(log.ts).toLocaleTimeString("en-GB", { hour12: false });
  const isError = log.type === "error";
  const isRefresh = log.type === "refresh";
  const typeColor = isError ? "red" : isRefresh ? "yellow" : "gray";
  const typeIcon = isError ? "✗" : isRefresh ? "↻" : "→";

  const statusColor = log.statusCode === undefined ? undefined
    : log.statusCode >= 500 ? "red"
    : log.statusCode >= 400 ? "yellow"
    : log.statusCode >= 200 ? "green"
    : "gray";

  const bg = selected ? "white" : undefined;
  const fg = (c: string | undefined) => selected ? "black" : c;

  // Per-request cache hit rate
  const totalTok = (log.cacheReadTokens ?? 0) + (log.cacheCreationTokens ?? 0) + (log.inputTokens ?? 0);
  const cacheHitPct = totalTok > 0 ? Math.round(((log.cacheReadTokens ?? 0) / totalTok) * 100) : null;
  const cacheColor = cacheHitPct === null ? undefined
    : cacheHitPct >= 70 ? "green"
    : cacheHitPct >= 30 ? "yellow"
    : "red";

  return (
    <Box>
      <Text backgroundColor={bg} color={fg(undefined)}>
        {selected ? "▶" : " "}{" "}{time}{"  "}
      </Text>
      <Text backgroundColor={bg} color={fg(typeColor)}>{typeIcon} </Text>
      <Text backgroundColor={bg} color={fg("cyan")}>{log.accountId.slice(0, 22).padEnd(22)}</Text>
      {log.method && log.path
        ? <Text backgroundColor={bg} color={fg("white")}> {log.method} {log.path.padEnd(14)}</Text>
        : <Text backgroundColor={bg} color={fg(typeColor)}> {log.type.padEnd(9)}</Text>
      }
      {log.statusCode !== undefined && (
        <Text backgroundColor={bg} color={fg(statusColor)}> {log.statusCode}</Text>
      )}
      {log.durationMs !== undefined && (
        <Text backgroundColor={bg} color={fg("gray")}> {log.durationMs}ms</Text>
      )}
      {cacheHitPct !== null && (
        <Text backgroundColor={bg} color={fg(cacheColor)}> ↑{cacheHitPct}%</Text>
      )}
      {log.details && (
        <Text backgroundColor={bg} color={fg("gray")}>  {log.details}</Text>
      )}
    </Box>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ log }: { log: LogEntry }) {
  const time = new Date(log.ts).toLocaleString("en-GB", {
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const isError = log.type === "error";
  const statusLabel = log.statusCode === undefined ? "—"
    : log.statusCode === 0 ? "connection error"
    : `${log.statusCode} ${httpStatusText(log.statusCode)}`;
  const statusColor = log.statusCode === undefined ? "gray"
    : log.statusCode === 0 ? "red"
    : log.statusCode >= 500 ? "red"
    : log.statusCode >= 400 ? "yellow"
    : "green";

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color={isError ? "red" : "cyan"}> DETAILS </Text>
      <Box marginTop={1} flexDirection="column" gap={0}>
        <Box gap={2}>
          <Field label="Time"    value={time} />
          <Field label="Account" value={log.accountId} />
        </Box>
        <Box gap={2}>
          <Field label="Method"  value={log.method ?? "—"} />
          <Field label="Path"    value={log.path ?? "—"} />
        </Box>
        <Box gap={2}>
          <FieldColored label="Status"   value={statusLabel} color={statusColor} />
          <Field        label="Duration" value={log.durationMs !== undefined ? `${log.durationMs}ms` : "—"} />
          <Field        label="Type"     value={log.type} />
        </Box>
        {log.details && (
          <Box>
            <Field label="Details" value={log.details} />
          </Box>
        )}
        {log.cacheReadTokens !== undefined && (
          <Box gap={2}>
            <CacheBreakdown
              read={log.cacheReadTokens}
              created={log.cacheCreationTokens ?? 0}
              input={log.inputTokens ?? 0}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text color="gray">{label}: </Text>
      <Text color="white">{value}</Text>
    </Box>
  );
}

function FieldColored({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Box>
      <Text color="gray">{label}: </Text>
      <Text color={color}>{value}</Text>
    </Box>
  );
}

// ─── Cache health badge (aggregated) ─────────────────────────────────────────

function CacheHealthBadge({ read, created, input }: { read: number; created: number; input: number }) {
  const total = read + created + input;
  if (total === 0) return null;

  const hitPct = Math.round((read / total) * 100);
  const color = hitPct >= 70 ? "green" : hitPct >= 30 ? "yellow" : "red";
  const label = hitPct >= 70 ? "healthy" : hitPct >= 30 ? "fair" : "poor";

  return (
    <>
      <Text color="gray">  ·  </Text>
      <Text>cache </Text>
      <Text color={color}>{hitPct}% hit </Text>
      <Text color="gray">({label})</Text>
    </>
  );
}

// ─── Cache breakdown (per-request detail) ────────────────────────────────────

function CacheBreakdown({ read, created, input }: { read: number; created: number; input: number }) {
  const total = read + created + input;
  const hitPct = total > 0 ? (read / total) * 100 : 0;
  const color = total === 0 ? "gray" : hitPct >= 70 ? "green" : hitPct >= 30 ? "yellow" : "red";

  return (
    <>
      <FieldColored
        label="Cache hit"
        value={total > 0 ? `${fmtTok(read)} tok  (${hitPct.toFixed(1)}%)` : "—"}
        color={color}
      />
      <Field label="Cache created" value={fmtTok(created) + " tok"} />
      <Field label="Uncached"      value={fmtTok(input) + " tok"} />
      <Field label="Total input"   value={fmtTok(total) + " tok"} />
    </>
  );
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── HTTP status text ─────────────────────────────────────────────────────────

function httpStatusText(code: number): string {
  const map: Record<number, string> = {
    200: "OK", 201: "Created", 204: "No Content",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway",
    503: "Service Unavailable", 529: "Overloaded",
  };
  return map[code] ?? "";
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatMs(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin >= 60) return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
  return `${totalMin}m`;
}

function formatAgo(ts: number): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}
