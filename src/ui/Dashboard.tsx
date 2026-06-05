import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { LogEntry } from "../proxy/stats.js";
import { createAccountsApi } from "./accountsApi.js";
import type { AccountsApi } from "./accountsApi.js";

const POLL_INTERVAL_MS = 2_000;
const LOG_VISIBLE = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountRateLimitsView {
  status: string;
  fiveHourUtil: number;
  fiveHourReset: number;
  sevenDayUtil: number;
  sevenDayReset: number;
  claim: string;
  plan: string;
  requestsLimit: number;
  lastUpdated: number;
}

interface AccountStat {
  id: string;
  provider?: "anthropic_subscription" | "openai_subscription";
  healthy: boolean;
  busy: boolean;
  requestCount: number;
  errorCount: number;
  expiresInMs: number;
  lastUsedMs: number;
  lastRefreshMs: number;
  rateLimits?: AccountRateLimitsView;
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

const EMPTY_RL: AccountRateLimitsView = {
  status: "unknown", fiveHourUtil: 0, fiveHourReset: 0,
  sevenDayUtil: 0, sevenDayReset: 0, claim: "", plan: "",
  requestsLimit: 0, lastUpdated: 0,
};

interface HealthData {
  status: "ok" | "degraded";
  mode: string;
  target: string;
  operational?: OperationalStatus;
  uptime: number;
  totalRequests: number;
  totalErrors: number;
  totalRefreshes: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalInputTokens: number;
  totalOutputTokens?: number;
  accounts: AccountStat[];
  recentLogs: LogEntry[];
}

interface OperationalStatus {
  auth: { required: boolean };
  providers: {
    anthropic: ProviderOperationalStatus;
    openai: ProviderOperationalStatus;
  };
  endpoints: {
    health: string;
    accounts: string;
    messages: string;
    responses: string;
    models: string;
  };
  routing: {
    anthropicDefaultModel?: string;
    openAIDefaultModel?: string;
    anthropicAliases: string[];
    openAIAliases: string[];
  };
  capabilities: {
    anthropicMessages: boolean;
    openAIResponses: boolean;
    crossProviderMessages: boolean;
    dynamicModels: boolean;
    accountManagement: boolean;
  };
}

interface ProviderOperationalStatus {
  configured: boolean;
  accounts: number;
  healthy: number;
  enabled: number;
}

type Focus = "logs" | "accounts";
type Mode = "view" | "editSession" | "editWeekly" | "confirmDelete";

// ─── Dashboard component ──────────────────────────────────────────────────────

export interface DashboardProps {
  port: number;
  baseUrl?: string;
  authToken?: string;
  /** Callback fired when the dashboard wants the outer shell to perform an
   *  action that can't run while Ink is rendering (e.g. OAuth flow). */
  onIntent?: (intent: "quit" | "addAccount") => void;
}

export function Dashboard({ port, baseUrl, authToken, onIntent }: DashboardProps) {
  const { exit } = useApp();
  const [data, setData] = useState<HealthData | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [retryCount, setRetryCount] = useState(0);

  const resolvedBase = baseUrl
    ? baseUrl.replace(/\/+$/, "")
    : `http://localhost:${port}`;

  const api = React.useMemo(
    () => createAccountsApi(resolvedBase, authToken),
    [resolvedBase, authToken],
  );

  // Only q to quit when no live data yet (no mode to cancel)
  useInput((input, key) => {
    if (!data && (input === "q" || key.escape)) exit();
  });

  useEffect(() => {
    let cancelled = false;

    const healthUrl = `${resolvedBase}/cc-router/health`;
    const headers: Record<string, string> = authToken
      ? { authorization: `Bearer ${authToken}` }
      : {};

    const poll = async () => {
      try {
        const res = await fetch(healthUrl, {
          headers,
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
        setConnectError(`Cannot connect to ${resolvedBase}`);
        setRetryCount(n => n + 1);
      }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [resolvedBase, authToken]);

  if (connectError) {
    return <ErrorScreen error={connectError} port={port} retries={retryCount} />;
  }

  if (!data) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">⠋ Connecting to {resolvedBase}...</Text>
      </Box>
    );
  }

  return (
    <LiveDashboard
      data={data}
      port={port}
      baseUrl={resolvedBase}
      lastUpdate={lastUpdate}
      api={api}
      onIntent={onIntent}
    />
  );
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

function LiveDashboard({
  data, port, baseUrl, lastUpdate, api, onIntent,
}: {
  data: HealthData; port: number; baseUrl: string; lastUpdate: number;
  api: AccountsApi; onIntent?: (intent: "quit" | "addAccount") => void;
}) {
  const { exit } = useApp();
  const healthyCount = data.accounts.filter(a => a.healthy).length;
  const updatedAgo = Math.round((Date.now() - lastUpdate) / 1000);
  const logs = data.recentLogs;

  // ── Focus / mode ──────────────────────────────────────────────────────────
  const [focus, setFocus] = useState<Focus>("logs");
  const [mode, setMode] = useState<Mode>("view");

  // Selected log by timestamp (existing)
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const selectedLogIndex = selectedTs !== null
    ? Math.max(0, logs.findIndex(l => l.ts === selectedTs))
    : 0;

  // Selected account by id
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const selectedAccountIndex = selectedAccountId !== null
    ? Math.max(0, data.accounts.findIndex(a => a.id === selectedAccountId))
    : 0;
  const selectedAccount = data.accounts[selectedAccountIndex] ?? null;
  const selectedAccountIsAnthropic = selectedAccount?.provider !== "openai_subscription";

  // Inline text input state (for w / s keys)
  const [editBuffer, setEditBuffer] = useState("");

  // Transient banner (error or success, cleared after 4s).
  // The timer handle is stored in a ref so new banners cancel the previous
  // timeout and component unmount also clears it — otherwise a deferred
  // setBanner can fire on an unmounted component after `n` exits Ink.
  const [banner, setBanner] = useState<{ text: string; color: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBanner = useCallback((text: string, color: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ text, color });
    bannerTimerRef.current = setTimeout(() => {
      setBanner(null);
      bannerTimerRef.current = null;
    }, 4_000);
  }, []);
  useEffect(() => () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  }, []);

  // Normalize any thrown value to a displayable string — rejections from
  // fetch/AbortSignal can be DOMException without .message, strings, or
  // even undefined.
  const errMsg = (err: unknown): string => {
    if (err instanceof Error && err.message) return err.message;
    const s = String(err ?? "");
    return s || "unknown error";
  };

  // ── Async helpers (fire-and-forget with error → banner) ──────────────────
  const doToggleEnabled = useCallback(async () => {
    if (!selectedAccount) return;
    if (selectedAccount.provider === "openai_subscription") {
      showBanner("OpenAI accounts are managed from the CLI", "yellow");
      return;
    }
    const newValue = !(selectedAccount.enabled !== false);
    try {
      await api.patch(selectedAccount.id, { enabled: newValue });
      showBanner(`${selectedAccount.id} → ${newValue ? "enabled" : "disabled"}`, newValue ? "green" : "yellow");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doSetLimit = useCallback(async (field: "sessionLimitPercent" | "weeklyLimitPercent", value: number) => {
    if (!selectedAccount) return;
    if (selectedAccount.provider === "openai_subscription") {
      showBanner("OpenAI accounts do not use Anthropic caps", "yellow");
      return;
    }
    try {
      await api.patch(selectedAccount.id, { [field]: value });
      const label = field === "sessionLimitPercent" ? "5h cap" : "7d cap";
      showBanner(`${selectedAccount.id} → ${label} = ${value}%`, "green");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doDelete = useCallback(async () => {
    if (!selectedAccount) return;
    if (selectedAccount.provider === "openai_subscription") {
      showBanner("Use cc-router accounts remove for OpenAI accounts", "yellow");
      return;
    }
    try {
      await api.remove(selectedAccount.id);
      showBanner(`Removed ${selectedAccount.id}`, "yellow");
      setSelectedAccountId(null);
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  // ── Keyboard handler ──────────────────────────────────────────────────────
  useInput((input, key) => {
    // ── Text editing mode (w / s) ───────────────────────────────────────
    if (mode === "editSession" || mode === "editWeekly") {
      if (key.escape) {
        setMode("view");
        setEditBuffer("");
        return;
      }
      if (key.return) {
        const parsed = parseInt(editBuffer, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          const field = mode === "editSession" ? "sessionLimitPercent" as const : "weeklyLimitPercent" as const;
          void doSetLimit(field, parsed);
        } else {
          showBanner("Invalid: enter a number 0–100", "red");
        }
        setMode("view");
        setEditBuffer("");
        return;
      }
      if (key.backspace || key.delete) {
        setEditBuffer(b => b.slice(0, -1));
        return;
      }
      if (/^[0-9]$/.test(input) && editBuffer.length < 3) {
        setEditBuffer(b => b + input);
      }
      return;
    }

    // ── Confirm delete (y/n) ────────────────────────────────────────────
    if (mode === "confirmDelete") {
      if (input === "y" || input === "Y") {
        void doDelete();
        setMode("view");
      } else {
        setMode("view");
        showBanner("Delete cancelled", "gray");
      }
      return;
    }

    // ── Normal view mode ────────────────────────────────────────────────
    // Always call exit() so Ink fully unmounts and releases stdin.
    // The outer dashboardLoop reads `pendingIntent` after waitUntilExit().
    if (input === "q") { onIntent?.("quit"); exit(); return; }
    if (key.escape) {
      if (focus === "accounts") { setFocus("logs"); return; }
      onIntent?.("quit"); exit();
      return;
    }

    if (key.tab) {
      setFocus(f => f === "logs" ? "accounts" : "logs");
      return;
    }

    // Navigation: ↑↓ move within the focused panel
    if (focus === "logs") {
      if (key.upArrow) {
        const next = Math.max(0, selectedLogIndex - 1);
        setSelectedTs(logs[next]?.ts ?? null);
      }
      if (key.downArrow) {
        const next = Math.min(logs.length - 1, selectedLogIndex + 1);
        setSelectedTs(logs[next]?.ts ?? null);
      }
    }

    if (focus === "accounts") {
      if (key.upArrow) {
        const next = Math.max(0, selectedAccountIndex - 1);
        setSelectedAccountId(data.accounts[next]?.id ?? null);
      }
      if (key.downArrow) {
        const next = Math.min(data.accounts.length - 1, selectedAccountIndex + 1);
        setSelectedAccountId(data.accounts[next]?.id ?? null);
      }

      // Account actions (only when focus = accounts)
      if (input === "e") { void doToggleEnabled(); return; }
      if (input === "w") {
        if (!selectedAccountIsAnthropic) { showBanner("OpenAI accounts do not use Anthropic caps", "yellow"); return; }
        setMode("editWeekly"); setEditBuffer(""); return;
      }
      if (input === "s") {
        if (!selectedAccountIsAnthropic) { showBanner("OpenAI accounts do not use Anthropic caps", "yellow"); return; }
        setMode("editSession"); setEditBuffer(""); return;
      }
      if (input === "d") {
        if (!selectedAccountIsAnthropic) { showBanner("Use cc-router accounts remove for OpenAI accounts", "yellow"); return; }
        setMode("confirmDelete"); return;
      }
    }

    // n = add account — works regardless of focus.
    // Requires an onIntent handler because the outer loop runs the OAuth
    // flow after Ink unmounts; if none is wired, this key is a no-op.
    if (input === "n") {
      if (onIntent) { onIntent("addAccount"); exit(); }
      return;
    }
  });

  const selectedLog = logs[selectedLogIndex] ?? null;
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
        <Text color="gray">  ·  updated {updatedAgo}s ago  ·  [q] quit</Text>
      </Box>

      <Box marginTop={1} />

      {data.operational && (
        <>
          <OperationsPanel operational={data.operational} baseUrl={baseUrl} />
          <Box marginTop={1} />
        </>
      )}

      {/* ── Accounts table ── */}
      <Box flexDirection="column">
        <Box>
          <Text bold>
            {" ACCOUNTS  "}
            <Text color={healthyCount === data.accounts.length ? "green" : "yellow"}>
              {healthyCount}/{data.accounts.length} healthy
            </Text>
          </Text>
          <Text color="gray">{"   "}</Text>
          <Text color={focus === "accounts" ? "white" : "gray"}>
            [Tab] focus  [e] toggle  [w] 7d cap  [s] 5h cap  [n] add  [d] delete
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          {data.accounts.map((a, i) => (
            <AccountRow
              key={a.id}
              account={a}
              selected={focus === "accounts" && i === selectedAccountIndex}
            />
          ))}
        </Box>
      </Box>

      {/* ── Inline prompt (edit / confirm) ── */}
      {mode === "editWeekly" && selectedAccount && (
        <Box marginTop={1} paddingLeft={2}>
          <Text color="cyan">Set 7d cap for </Text>
          <Text color="white" bold>{selectedAccount.id}</Text>
          <Text color="cyan"> (0–100%): </Text>
          <Text color="white" bold>{editBuffer}</Text>
          <Text color="gray">█  [Enter] save  [Esc] cancel</Text>
        </Box>
      )}
      {mode === "editSession" && selectedAccount && (
        <Box marginTop={1} paddingLeft={2}>
          <Text color="cyan">Set 5h cap for </Text>
          <Text color="white" bold>{selectedAccount.id}</Text>
          <Text color="cyan"> (0–100%): </Text>
          <Text color="white" bold>{editBuffer}</Text>
          <Text color="gray">█  [Enter] save  [Esc] cancel</Text>
        </Box>
      )}
      {mode === "confirmDelete" && selectedAccount && (
        <Box marginTop={1} paddingLeft={2}>
          <Text color="red" bold>Delete "{selectedAccount.id}"?  [y] yes  [n/Esc] cancel</Text>
        </Box>
      )}

      {/* ── Banner (transient action feedback) ── */}
      {banner && (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={banner.color as any}> {banner.text}</Text>
        </Box>
      )}

      <Box marginTop={1} />

      {/* ── Totals ── */}
      <Box flexDirection="column">
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
        <TokenSummary
          cacheRead={data.totalCacheReadTokens}
          cacheCreated={data.totalCacheCreationTokens}
          uncached={data.totalInputTokens}
          output={data.totalOutputTokens ?? 0}
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
                <LogRow key={`${log.ts}-${i}`} log={log} selected={focus === "logs" && i === selectedLogIndex} />
              ))
          }
        </Box>
      </Box>

      {/* ── Detail panel ── */}
      {focus === "logs" && selectedLog && (
        <>
          <Box marginTop={1} />
          <DetailPanel log={selectedLog} />
        </>
      )}

    </Box>
  );
}

function OperationsPanel({ operational, baseUrl }: { operational: OperationalStatus; baseUrl: string }) {
  const authLabel = operational.auth.required ? "protected" : "open";
  const authColor = operational.auth.required ? "green" : "yellow";
  const claudeReady = operational.capabilities.anthropicMessages;
  const openAIReady = operational.capabilities.openAIResponses;
  const crossReady = operational.capabilities.crossProviderMessages;
  const modelsReady = operational.capabilities.dynamicModels;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold> OPERATIONS  </Text>
        <Text color="gray">base </Text>
        <Text color="cyan">{baseUrl}</Text>
        <Text color="gray">  ·  auth </Text>
        <Text color={authColor}>{authLabel}</Text>
        <Text color="gray">  ·  models </Text>
        <Text color={modelsReady ? "green" : "red"}>{modelsReady ? "dynamic" : "off"}</Text>
      </Box>
      <Box paddingLeft={2}>
        <ProviderBadge label="Claude" status={operational.providers.anthropic} ready={claudeReady} />
        <Text color="gray">  </Text>
        <ProviderBadge label="OpenAI" status={operational.providers.openai} ready={openAIReady} />
        <Text color="gray">  ·  cross-route </Text>
        <Text color={crossReady ? "green" : "gray"}>{crossReady ? "ready" : "needs OpenAI"}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray">endpoints </Text>
        <Text color="white">{operational.endpoints.messages}</Text>
        <Text color="gray"> </Text>
        <Text color="white">{operational.endpoints.responses}</Text>
        <Text color="gray"> </Text>
        <Text color="white">{operational.endpoints.models}</Text>
        <Text color="gray"> </Text>
        <Text color="white">{operational.endpoints.accounts}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray">routing </Text>
        <Text color="white">claude={operational.routing.anthropicDefaultModel ?? "default"}</Text>
        <Text color="gray"> aliases[{operational.routing.anthropicAliases.join(",") || "-"}]</Text>
        <Text color="gray">  </Text>
        <Text color="white">openai={operational.routing.openAIDefaultModel ?? "default"}</Text>
        <Text color="gray"> aliases[{operational.routing.openAIAliases.join(",") || "-"}]</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray">models </Text>
        <Text color="cyan">cc-router models list</Text>
        <Text color="gray">  change </Text>
        <Text color="cyan">cc-router models set</Text>
      </Box>
    </Box>
  );
}

function ProviderBadge({
  label,
  status,
  ready,
}: {
  label: string;
  status: ProviderOperationalStatus;
  ready: boolean;
}) {
  const color = !status.configured ? "gray" : ready ? "green" : "yellow";
  const text = status.configured
    ? `${label} ${status.healthy}/${status.accounts} healthy`
    : `${label} not configured`;

  return <Text color={color}>{text}</Text>;
}

// ─── Account row (two-line: status + utilization bars) ───────────────────────

function AccountRow({ account: a, selected }: { account: AccountStat; selected: boolean }) {
  const rl = a.rateLimits ?? EMPTY_RL;
  const isLimited = rl.status === "rate_limited";
  const isDisabled = a.enabled === false;

  const dot = isDisabled ? "⊘" : isLimited ? "⊘" : a.busy ? "◌" : a.healthy ? "●" : "●";
  const dotColor = isDisabled ? "gray" : isLimited ? "red" : a.busy ? "yellow" : a.healthy ? "green" : "red";
  const statusLabel = isDisabled ? "OFF    " : isLimited ? "LIMITED" : a.busy ? "busy   " : a.healthy ? "ok     " : "ERROR  ";
  const statusColor = isDisabled ? "gray" : isLimited ? "red" : a.busy ? "yellow" : a.healthy ? "green" : "red";

  const expiryLabel = a.expiresInMs > 0 ? formatMs(a.expiresInMs) : "EXPIRED";
  const expiryColor = a.expiresInMs < 10 * 60 * 1000 ? "red"
    : a.expiresInMs < 30 * 60 * 1000 ? "yellow"
    : "white";

  const providerTag = a.provider === "openai_subscription"
    ? " [OpenAI]"
    : rl.plan ? ` [${rl.plan}]` : "";

  // User-defined caps hint
  const s5 = a.sessionLimitPercent ?? 100;
  const w7 = a.weeklyLimitPercent ?? 100;
  const hasCaps = s5 < 100 || w7 < 100;
  const capsHint = hasCaps
    ? ` cap${s5 < 100 ? ` 5h≤${s5}%` : ""}${w7 < 100 ? ` 7d≤${w7}%` : ""}`
    : "";

  const pointer = selected ? "▶" : " ";
  const nameColor = isDisabled ? "gray" : undefined;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? "cyan" : undefined}>{pointer}</Text>
        <Text color={dotColor}> {dot} </Text>
        <Text color={nameColor} dimColor={isDisabled}>{a.id.slice(0, 20).padEnd(20)}</Text>
        <Text color={statusColor}>{statusLabel}</Text>
        {providerTag && <Text color={a.provider === "openai_subscription" ? "cyan" : "magenta"}>{providerTag.padEnd(10)}</Text>}
        {!providerTag && <Text>{"".padEnd(10)}</Text>}
        <Text color="gray"> req </Text>
        <Text color="white">{String(a.requestCount).padStart(5)}</Text>
        <Text color="gray">  err </Text>
        <Text color={a.errorCount > 0 ? "red" : "gray"}>{String(a.errorCount).padStart(3)}</Text>
        <Text color="gray">  tok </Text>
        <Text color={expiryColor}>{expiryLabel.padEnd(8)}</Text>
        <Text color="gray">  last </Text>
        <Text color="gray">{formatAgo(a.lastUsedMs)}</Text>
        {capsHint && <Text color="yellow">{capsHint}</Text>}
      </Box>
      {rl.lastUpdated > 0 && (
        <Box paddingLeft={4}>
          <UtilBar label="5h" util={rl.fiveHourUtil} resetTs={rl.fiveHourReset} isActive={rl.claim === "five_hour"} cap={s5} />
          <Text>   </Text>
          <UtilBar label="7d" util={rl.sevenDayUtil} resetTs={rl.sevenDayReset} isActive={rl.claim === "seven_day"} cap={w7} />
        </Box>
      )}
    </Box>
  );
}

// ─── Utilization bar ─────────────────────────────────────────────────────────

function UtilBar({ label, util, resetTs, isActive, cap }: { label: string; util: number; resetTs: number; isActive: boolean; cap: number }) {
  const pct = Math.round(util * 100);
  const BAR_W = 12;
  const filled = Math.round(util * BAR_W);
  const capPos = Math.round((cap / 100) * BAR_W);
  const bar = "█".repeat(Math.min(filled, BAR_W)) + "░".repeat(Math.max(BAR_W - filled, 0));
  const color = pct >= cap ? "red" : pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";

  const resetLabel = resetTs > 0 ? formatResetIn(resetTs) : "";
  const capLabel = cap < 100 ? ` cap ${cap}%` : "";

  return (
    <Box>
      <Text color={isActive ? "white" : "gray"} bold={isActive}>{label} </Text>
      <Text color={color}>{bar}</Text>
      <Text color={color}>{String(pct).padStart(4)}%</Text>
      {capLabel && <Text color="yellow">{capLabel}</Text>}
      {resetLabel && <Text color="gray"> ↻{resetLabel}</Text>}
    </Box>
  );
}

function formatResetIn(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
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

  const sourceLabel = log.source === "cli" ? "cli"
    : log.source === "desktop" ? "dsk"
    : log.source === "api" ? "api"
    : "   ";
  const sourceColor = log.source === "cli" ? "blue"
    : log.source === "desktop" ? "magenta"
    : "gray";

  // Per-request token stats
  const inputTok = (log.cacheReadTokens ?? 0) + (log.cacheCreationTokens ?? 0) + (log.inputTokens ?? 0);
  const outputTok = log.outputTokens ?? 0;
  const cacheHitPct = inputTok > 0 ? Math.round(((log.cacheReadTokens ?? 0) / inputTok) * 100) : null;
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
      <Text backgroundColor={bg} color={fg(sourceColor)}>{sourceLabel} </Text>
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
      {(inputTok > 0 || outputTok > 0) && (
        <Text backgroundColor={bg} color={fg("gray")}> {fmtTok(inputTok)}↑ {fmtTok(outputTok)}↓</Text>
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
          <Field        label="Source"   value={sourceFullLabel(log.source)} />
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
              output={log.outputTokens ?? 0}
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

function CacheBreakdown({ read, created, input, output }: { read: number; created: number; input: number; output: number }) {
  const totalInput = read + created + input;
  const hitPct = totalInput > 0 ? (read / totalInput) * 100 : 0;
  const color = totalInput === 0 ? "gray" : hitPct >= 70 ? "green" : hitPct >= 30 ? "yellow" : "red";

  return (
    <>
      <FieldColored
        label="Cache hit"
        value={totalInput > 0 ? `${fmtTok(read)} tok  (${hitPct.toFixed(1)}%)` : "—"}
        color={color}
      />
      <Field label="Cache created" value={fmtTok(created) + " tok"} />
      <Field label="Uncached"      value={fmtTok(input) + " tok"} />
      <Field label="Total input"   value={fmtTok(totalInput) + " tok"} />
      <Field label="Output"        value={fmtTok(output) + " tok"} />
      <Field label="Total"         value={fmtTok(totalInput + output) + " tok"} />
    </>
  );
}

// ─── Token summary (aggregated totals) ──────────────────────────────────────

function TokenSummary({ cacheRead, cacheCreated, uncached, output }: { cacheRead: number; cacheCreated: number; uncached: number; output: number }) {
  const totalInput = cacheRead + cacheCreated + uncached;
  const totalAll = totalInput + output;
  if (totalAll === 0) return null;

  return (
    <Box paddingLeft={2}>
      <Text color="gray">input </Text>
      <Text color="white">{fmtTok(totalInput)}</Text>
      <Text color="gray"> (cached </Text>
      <Text color="green">{fmtTok(cacheRead)}</Text>
      <Text color="gray"> + new </Text>
      <Text color="yellow">{fmtTok(cacheCreated)}</Text>
      <Text color="gray"> + uncached </Text>
      <Text color="white">{fmtTok(uncached)}</Text>
      <Text color="gray">)  ·  output </Text>
      <Text color="white">{fmtTok(output)}</Text>
      <Text color="gray">  ·  total </Text>
      <Text color="cyan" bold>{fmtTok(totalAll)}</Text>
    </Box>
  );
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Source label ─────────────────────────────────────────────────────────────

function sourceFullLabel(source: LogEntry["source"]): string {
  if (source === "cli") return "Claude Code";
  if (source === "desktop") return "Claude Desktop";
  if (source === "api") return "API";
  return "—";
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
