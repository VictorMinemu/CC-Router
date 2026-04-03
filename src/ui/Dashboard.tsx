import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { LogEntry } from "../proxy/stats.js";

const POLL_INTERVAL_MS = 2_000;

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

  return (
    <Box flexDirection="column">

      {/* ── Header bar ── */}
      <Box>
        <Text bold color="cyan"> CC-Router </Text>
        <Text color="gray">· </Text>
        <Text color="green">{data.mode}</Text>
        <Text color="gray"> → {data.target}  · </Text>
        <Text>up {formatUptime(data.uptime)}</Text>
        <Text color="gray">  ·  updated {updatedAgo}s ago  ·  [q] quit</Text>
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
      </Box>

      <Box marginTop={1} />

      {/* ── Recent activity ── */}
      <Box flexDirection="column">
        <Text bold> RECENT ACTIVITY</Text>
        <Box marginTop={1} flexDirection="column">
          {data.recentLogs.length === 0
            ? <Text color="gray">  No activity yet</Text>
            : data.recentLogs.slice(0, 10).map((log, i) => (
                <LogRow key={i} log={log} />
              ))
          }
        </Box>
      </Box>

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

function LogRow({ log }: { log: LogEntry }) {
  const time = new Date(log.ts).toLocaleTimeString("en-GB", { hour12: false });
  const typeColor = log.type === "error" ? "red" : log.type === "refresh" ? "yellow" : "gray";
  const typeIcon = log.type === "error" ? "✗" : log.type === "refresh" ? "↻" : "→";

  return (
    <Box>
      <Text color="gray">  {time}  </Text>
      <Text color={typeColor}>{typeIcon} </Text>
      <Text color="cyan">{log.accountId.slice(0, 22).padEnd(22)}</Text>
      <Text color={typeColor}> {log.type}</Text>
      {log.details && <Text color="gray">  {log.details}</Text>}
    </Box>
  );
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
