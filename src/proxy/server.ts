import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import type { Request } from "express";
import { TokenPool } from "./token-pool.js";
import { needsRefresh, refreshAccountToken, saveAccounts, startRefreshLoop } from "./token-refresher.js";
import { loadAccounts, accountsFileExists, readAccountsFromPath, readConfig } from "../config/manager.js";
import { checkForUpdate, performUpdate, restartSelf } from "../utils/self-update.js";
import { logRoute, logError, logStartup } from "./logger.js";
import { stats } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { PROXY_PORT, LITELLM_URL } from "../config/paths.js";
import type { Account, AccountRateLimits } from "./types.js";
import chalk from "chalk";

// Augment Request to carry the selected account and pending log entry
declare module "express-serve-static-core" {
  interface Request {
    _ccAccount?: Account;
    _startTime?: number;
    _pendingLog?: Partial<LogEntry>;
  }
}

export interface ServerOptions {
  port?: number;
  /** Forward to LiteLLM. If not set, goes directly to Anthropic. */
  litellmUrl?: string;
  accountsPath?: string;
}

// Mutates entry and updates aggregate counters with token usage from Anthropic's
// response. Called asynchronously after the log entry is already stored,
// so the dashboard picks up the values on the next poll.
function applyInputUsage(entry: LogEntry, usage: Record<string, number>): void {
  entry.cacheReadTokens = usage["cache_read_input_tokens"] ?? 0;
  entry.cacheCreationTokens = usage["cache_creation_input_tokens"] ?? 0;
  entry.inputTokens = usage["input_tokens"] ?? 0;

  stats.totalCacheReadTokens += entry.cacheReadTokens;
  stats.totalCacheCreationTokens += entry.cacheCreationTokens;
  stats.totalInputTokens += entry.inputTokens;
}

function applyOutputUsage(entry: LogEntry, usage: Record<string, number>): void {
  entry.outputTokens = usage["output_tokens"] ?? 0;
  stats.totalOutputTokens += entry.outputTokens;
}

// ─── Rate limit header extraction ──────────────────────────────────────────

function inferPlan(requestsLimit: number): string {
  if (requestsLimit <= 0) return "";
  if (requestsLimit <= 100) return "Pro";
  if (requestsLimit <= 500) return "Max 5x";
  return "Max 20x";
}

function extractRateLimits(headers: Record<string, string | string[] | undefined>): AccountRateLimits | null {
  const h = (name: string) => String(headers[name] ?? "");
  const status = h("anthropic-ratelimit-unified-status");
  if (!status) return null; // No unified headers in this response

  const requestsLimit = parseInt(h("anthropic-ratelimit-requests-limit"), 10) || 0;

  return {
    status: status === "rate_limited" ? "rate_limited" : "allowed",
    fiveHourUtil: parseFloat(h("anthropic-ratelimit-unified-5h-utilization")) || 0,
    fiveHourReset: parseInt(h("anthropic-ratelimit-unified-5h-reset"), 10) || 0,
    sevenDayUtil: parseFloat(h("anthropic-ratelimit-unified-7d-utilization")) || 0,
    sevenDayReset: parseInt(h("anthropic-ratelimit-unified-7d-reset"), 10) || 0,
    claim: h("anthropic-ratelimit-unified-representative-claim"),
    plan: inferPlan(requestsLimit),
    requestsLimit,
    lastUpdated: Date.now(),
  };
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const port = opts.port ?? PROXY_PORT;

  // Direct-to-Anthropic (standalone) or via LiteLLM (full mode).
  // Priority: explicit option > LITELLM_URL env var > direct to Anthropic
  const litellmUrl = opts.litellmUrl ?? LITELLM_URL;
  const target = litellmUrl ?? "https://api.anthropic.com";
  const mode = litellmUrl ? "litellm" : "standalone";

  const accountsPath = opts.accountsPath;

  if (!accountsFileExists(accountsPath)) {
    console.error(chalk.red("\n✗ accounts.json not found."));
    console.error(chalk.yellow("  Run: cc-router setup\n"));
    process.exit(1);
  }

  const accounts = accountsPath ? readAccountsFromPath(accountsPath) : loadAccounts();
  if (accounts.length === 0) {
    console.error(chalk.red("\n✗ No accounts found in accounts.json."));
    console.error(chalk.yellow("  Run: cc-router setup\n"));
    process.exit(1);
  }

  const pool = new TokenPool(accounts);
  startRefreshLoop(accounts);

  const app = express();

  // ─── Proxy auth middleware ─────────────────────────────────────────────────
  // If a proxySecret is configured, all requests must present it as EITHER
  //   "Authorization: Bearer <secret>" (Claude Code CLI, HTTP clients)
  //   OR "x-api-key: <secret>" (Claude Desktop via mitmproxy, Anthropic SDK)
  // The /cc-router/health endpoint is always exempt so monitoring and PM2
  // healthchecks keep working.
  const { proxySecret } = readConfig();
  if (proxySecret) {
    const secretBuf = Buffer.from(proxySecret, "utf-8");
    app.use((req, res, next) => {
      if (req.path === "/cc-router/health") return next();

      const auth = (req.headers["authorization"] as string | undefined) ?? "";
      const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const apiKey = (req.headers["x-api-key"] as string | undefined) ?? "";
      const presented = bearerToken || apiKey;
      const presentedBuf = Buffer.from(presented, "utf-8");

      if (
        presentedBuf.length !== secretBuf.length ||
        !timingSafeEqual(presentedBuf, secretBuf)
      ) {
        res.status(401).json({
          type: "error",
          error: { type: "authentication_error", message: "Invalid or missing proxy authentication token" },
        });
        return;
      }
      next();
    });
  }

  // ─── Health endpoint (cc-router internal, NOT proxied) ────────────────────
  app.get("/cc-router/health", (_req, res) => {
    res.json({
      status: pool.getHealthy().length > 0 ? "ok" : "degraded",
      mode,
      target,
      uptime: stats.getUptimeSeconds(),
      totalRequests: stats.totalRequests,
      totalErrors: stats.totalErrors,
      totalRefreshes: stats.totalRefreshes,
      totalCacheReadTokens: stats.totalCacheReadTokens,
      totalCacheCreationTokens: stats.totalCacheCreationTokens,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      accounts: pool.getStats(),
      recentLogs: stats.getRecentLogs(50),
    });
  });

  // ─── Proxy middleware ──────────────────────────────────────────────────────
  // IMPORTANT: selfHandleResponse must be false (default) for SSE streaming to
  // work transparently. Setting it to true breaks streaming.
  const proxy = createProxyMiddleware<Request, ServerResponse>({
    target,
    changeOrigin: true,
    // Express strips the /v1 mount prefix from req.url before passing it to middleware.
    // pathRewrite restores it so the proxy forwards /v1/messages, not /messages.
    pathRewrite: (path) => `/v1${path}`,
    // Long timeouts — Claude Code requests can be >5min (thinking, agents)
    proxyTimeout: 5 * 60 * 1000,
    timeout: 5 * 60 * 1000,
    on: {
      proxyReq: (proxyReq, req) => {
        const account = (req as Request)._ccAccount;
        if (!account) return;

        // Replace the placeholder/proxy auth token with the real OAuth token.
        // Claude Code sends ANTHROPIC_AUTH_TOKEN as "Authorization: Bearer proxy-managed".
        // We replace it with the real OAuth token for this account.
        proxyReq.setHeader("authorization", `Bearer ${account.tokens.accessToken}`);

        // Remove x-api-key if present — OAuth authentication uses Authorization Bearer,
        // not x-api-key. Having both set can cause conflicts at Anthropic's side.
        proxyReq.removeHeader("x-api-key");

        // CRITICAL: api.anthropic.com requires the "oauth-2025-04-20" beta flag to
        // accept OAuth tokens (sk-ant-oat01-*). Without it the request is rejected
        // with "OAuth authentication is currently not supported."
        // APPEND — do NOT replace — so existing betas (tools, computer-use, etc.) are preserved.
        const existingBeta = proxyReq.getHeader("anthropic-beta");
        const betas = existingBeta
          ? String(existingBeta).split(",").map(b => b.trim()).filter(Boolean)
          : [];
        if (!betas.includes("oauth-2025-04-20")) {
          betas.push("oauth-2025-04-20");
          proxyReq.setHeader("anthropic-beta", betas.join(","));
        }

        // All other headers are forwarded automatically by http-proxy-middleware:
        //   anthropic-version         — required by Anthropic API
        //   X-Claude-Code-Session-Id  — session aggregation header sent by Claude Code
        //   content-type              — always application/json
      },

      proxyRes: (proxyRes, req) => {
        const account = (req as Request)._ccAccount;
        if (!account) return;

        const status = proxyRes.statusCode ?? 0;
        const durationMs = (req as Request)._startTime
          ? Date.now() - (req as Request)._startTime!
          : undefined;

        // Complete the pending log entry with response info
        const pendingLog = (req as Request)._pendingLog ?? {
          ts: Date.now(),
          accountId: account.id,
          model: "-",
          type: "route" as const,
        };
        pendingLog.statusCode = status;
        if (durationMs !== undefined) pendingLog.durationMs = durationMs;

        if (status === 401) {
          // Token invalid or expired mid-request.
          // Forward the 401 to the client (Claude Code will retry on 401).
          // Schedule a background refresh so the next request succeeds.
          stats.totalErrors++;
          account.errorCount++;
          pendingLog.type = "error";
          pendingLog.details = "token invalid";
          logError(account.id, 401, "Token invalid — scheduling background refresh");

          refreshAccountToken(account).then(ok => {
            if (ok) saveAccounts(pool.getAll());
          }).catch(console.error);
        } else if (status === 429) {
          // Rate limited — put account on cooldown for Retry-After seconds.
          stats.totalErrors++;
          account.errorCount++;
          const retryAfter = Number(proxyRes.headers["retry-after"] ?? 60);
          pendingLog.type = "error";
          pendingLog.details = `rate limited — cooldown ${retryAfter}s`;
          logError(account.id, 429, `Rate limited — cooldown ${retryAfter}s`);

          account.busy = true;
          setTimeout(() => { account.busy = false; }, retryAfter * 1_000);
        } else if (status === 529) {
          // Anthropic service overloaded — short cooldown on this account.
          stats.totalErrors++;
          account.errorCount++;
          pendingLog.type = "error";
          pendingLog.details = "service overloaded — cooldown 30s";
          logError(account.id, 529, "Service overloaded — cooldown 30s");

          account.busy = true;
          setTimeout(() => { account.busy = false; }, 30_000);
        }

        // ── Capture rate limit utilization from response headers ────────────
        const rl = extractRateLimits(proxyRes.headers as Record<string, string | string[] | undefined>);
        if (rl) account.rateLimits = rl;

        const entry = pendingLog as LogEntry;
        stats.addLog(entry);

        // ── Capture token usage from Anthropic response body ─────────────────
        // SSE streams carry usage across two events:
        //   message_start  → input_tokens, cache_read/creation_input_tokens
        //   message_delta   → output_tokens
        // Non-streaming JSON carries all fields in a single usage object.
        // We use incremental line parsing (not buffering) so we can capture
        // both events without holding the full stream in memory.
        const contentType = String(proxyRes.headers["content-type"] ?? "");
        const encoding = String(proxyRes.headers["content-encoding"] ?? "");
        const isCompressed = /gzip|br|deflate/.test(encoding);

        if (!isCompressed && (contentType.includes("text/event-stream") || contentType.includes("application/json"))) {
          const isSSE = contentType.includes("text/event-stream");

          if (isSSE) {
            let lineBuf = "";
            let gotInput = false;
            let gotOutput = false;

            proxyRes.on("data", (chunk: Buffer) => {
              if (gotInput && gotOutput) return;
              lineBuf += chunk.toString("utf8");
              const lines = lineBuf.split("\n");
              lineBuf = lines.pop() ?? ""; // keep incomplete last line

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const evt = JSON.parse(line.slice(6)) as {
                    type?: string;
                    message?: { usage?: Record<string, number> };
                    usage?: Record<string, number>;
                  };
                  if (!gotInput && evt.type === "message_start" && evt.message?.usage) {
                    applyInputUsage(entry, evt.message.usage);
                    gotInput = true;
                  }
                  if (!gotOutput && evt.type === "message_delta" && evt.usage) {
                    applyOutputUsage(entry, evt.usage);
                    gotOutput = true;
                  }
                } catch { /* partial JSON across chunk boundary — next chunk will complete it */ }
              }
            });
          } else {
            // Non-streaming JSON: buffer full body then parse once
            let buf = "";
            proxyRes.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
            proxyRes.on("end", () => {
              try {
                const body = JSON.parse(buf) as { usage?: Record<string, number> };
                if (body.usage) {
                  applyInputUsage(entry, body.usage);
                  applyOutputUsage(entry, body.usage);
                }
              } catch { /* ignore */ }
            });
          }
        }
      },

      error: (err: Error, _req: IncomingMessage, res: ServerResponse | Socket) => {
        stats.totalErrors++;
        logError("proxy", 0, err.message);

        // Complete the pending log entry for connection-level errors
        const pendingLog = (_req as Request)._pendingLog;
        if (pendingLog) {
          pendingLog.type = "error";
          pendingLog.statusCode = 0;
          pendingLog.details = err.message;
          if ((_req as Request)._startTime) {
            pendingLog.durationMs = Date.now() - (_req as Request)._startTime!;
          }
          stats.addLog(pendingLog as LogEntry);
        }

        // res may be a Socket (WebSocket upgrade) — only respond on HTTP ServerResponse
        if (res instanceof ServerResponse && !res.headersSent) {
          // Match Anthropic's error response format so Claude Code handles it gracefully
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            type: "error",
            error: { type: "proxy_error", message: err.message },
          }));
        }
      },
    },
  });

  // ─── /v1/* — select account, refresh if needed, then proxy ───────────────
  // CRITICAL: Do NOT use express.json() here — it consumes the body stream
  // and breaks SSE streaming passthrough.
  app.use("/v1", async (req, _res, next) => {
    const account = pool.getNext();

    // Synchronous refresh if token expires within the buffer window
    if (needsRefresh(account)) {
      const ok = await refreshAccountToken(account);
      if (ok) saveAccounts(pool.getAll());
    }

    req._ccAccount = account;
    req._startTime = Date.now();
    req._pendingLog = {
      ts: Date.now(),
      accountId: account.id,
      model: "-",
      type: "route",
      method: req.method,
      path: req.path,
    };
    stats.totalRequests++;

    logRoute(
      account.id,
      account.requestCount,
      Math.round((account.tokens.expiresAt - Date.now()) / 60_000),
    );

    next();
  }, proxy);

  // ─── Catch-all — forward everything else (LiteLLM UI, /v1/models, etc.) ──
  app.use("/", createProxyMiddleware<Request, ServerResponse>({
    target,
    changeOrigin: true,
  }));

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = () => {
    console.log(chalk.yellow("\nShutting down — saving tokens..."));
    saveAccounts(pool.getAll());
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Auto-update (opt-in via config or CC_ROUTER_AUTO_UPDATE=1) ───────────
  // Auto-update enabled by default — users can disable via config or env var
  const cfg = readConfig();
  const autoUpdate = cfg.autoUpdate !== false && process.env["CC_ROUTER_NO_AUTO_UPDATE"] !== "1";
  if (autoUpdate) {
    const AUTO_UPDATE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const runAutoUpdate = async () => {
      try {
        const check = await checkForUpdate();
        if (!check.updateAvailable || check.diff === "major") return;
        console.log(chalk.cyan(`[auto-update] v${check.current} → v${check.latest} (${check.diff})`));
        const ok = await performUpdate(check.latest);
        if (ok) {
          console.log(chalk.green("[auto-update] Restarting with new version..."));
          saveAccounts(pool.getAll());
          restartSelf();
        }
      } catch (err) {
        console.error(chalk.gray(`[auto-update] Check failed: ${(err as Error).message}`));
      }
    };
    // First check 60s after startup, then every 6h
    setTimeout(runAutoUpdate, 60_000).unref();
    setInterval(runAutoUpdate, AUTO_UPDATE_INTERVAL).unref();
  }

  // ─── Start ────────────────────────────────────────────────────────────────
  // HOST env var lets teams bind to 0.0.0.0 for LAN/VPS shared access.
  // Defaults to 127.0.0.1 (localhost-only) for single-user safety.
  const host = process.env["HOST"] ?? "127.0.0.1";
  app.listen(port, host, () => {
    logStartup(port, host, mode, target, accounts.length);
    if (autoUpdate) console.log(chalk.gray("  Auto-update: enabled (patch/minor)"));
  });
}
