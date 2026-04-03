import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { ServerResponse } from "http";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import type { Request } from "express";
import { TokenPool } from "./token-pool.js";
import { needsRefresh, refreshAccountToken, saveAccounts, startRefreshLoop } from "./token-refresher.js";
import { loadAccounts, accountsFileExists, readAccountsFromPath } from "../config/manager.js";
import { logRoute, logError, logStartup } from "./logger.js";
import { stats } from "./stats.js";
import { PROXY_PORT } from "../config/paths.js";
import type { Account } from "./types.js";
import chalk from "chalk";

// Augment Request to carry the selected account
declare module "express-serve-static-core" {
  interface Request {
    _ccAccount?: Account;
  }
}

export interface ServerOptions {
  port?: number;
  /** Forward to LiteLLM. If not set, goes directly to Anthropic. */
  litellmUrl?: string;
  accountsPath?: string;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const port = opts.port ?? PROXY_PORT;

  // Direct-to-Anthropic (standalone) or via LiteLLM (full mode)
  const target = opts.litellmUrl ?? "https://api.anthropic.com";
  const mode = opts.litellmUrl ? "litellm" : "standalone";

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
      accounts: pool.getStats(),
      recentLogs: stats.getRecentLogs(),
    });
  });

  // ─── Proxy middleware ──────────────────────────────────────────────────────
  // IMPORTANT: selfHandleResponse must be false (default) for SSE streaming to
  // work transparently. Setting it to true breaks streaming.
  const proxy = createProxyMiddleware<Request, ServerResponse>({
    target,
    changeOrigin: true,
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

        // All other headers are forwarded automatically by http-proxy-middleware:
        //   anthropic-version     — required by Anthropic API
        //   anthropic-beta        — MUST be forwarded: controls features (tools,
        //                           computer use, extended thinking, prompt caching)
        //   X-Claude-Code-Session-Id — session aggregation header sent by Claude Code
        //   content-type          — always application/json
      },

      proxyRes: (proxyRes, req) => {
        const account = (req as Request)._ccAccount;
        if (!account) return;

        const status = proxyRes.statusCode ?? 0;

        if (status === 401) {
          // Token invalid or expired mid-request.
          // Forward the 401 to the client (Claude Code will retry on 401).
          // Schedule a background refresh so the next request succeeds.
          stats.totalErrors++;
          account.errorCount++;
          logError(account.id, 401, "Token invalid — scheduling background refresh");
          stats.addLog({ ts: Date.now(), accountId: account.id, model: "-", type: "error", details: "401" });

          refreshAccountToken(account).then(ok => {
            if (ok) saveAccounts(pool.getAll());
          }).catch(console.error);
        }

        if (status === 429) {
          // Rate limited — put account on cooldown for Retry-After seconds.
          stats.totalErrors++;
          account.errorCount++;
          const retryAfter = Number(proxyRes.headers["retry-after"] ?? 60);
          logError(account.id, 429, `Rate limited — cooldown ${retryAfter}s`);
          stats.addLog({ ts: Date.now(), accountId: account.id, model: "-", type: "error", details: "429" });

          account.busy = true;
          setTimeout(() => { account.busy = false; }, retryAfter * 1_000);
        }

        if (status === 529) {
          // Anthropic service overloaded — short cooldown on this account.
          stats.totalErrors++;
          account.errorCount++;
          logError(account.id, 529, "Service overloaded — cooldown 30s");
          stats.addLog({ ts: Date.now(), accountId: account.id, model: "-", type: "error", details: "529" });

          account.busy = true;
          setTimeout(() => { account.busy = false; }, 30_000);
        }
      },

      error: (err: Error, _req: IncomingMessage, res: ServerResponse | Socket) => {
        stats.totalErrors++;
        logError("proxy", 0, err.message);
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
    stats.totalRequests++;
    stats.addLog({ ts: Date.now(), accountId: account.id, model: "?", type: "route" });

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

  // ─── Start ────────────────────────────────────────────────────────────────
  app.listen(port, () => {
    logStartup(port, mode, target, accounts.length);
  });
}
