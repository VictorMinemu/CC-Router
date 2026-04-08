import type { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "fs";
import { input, confirm } from "@inquirer/prompts";
import { readConfig, writeConfig, type ClientConfig } from "../config/manager.js";
import { writeClaudeSettings, removeClaudeSettings, readClaudeProxySettings } from "../utils/claude-config.js";
import { isMacos, isWindows } from "../utils/platform.js";
import {
  checkMitmproxyInstalled,
  isCaCertInstalled,
  generateCaCert,
  installCaCert,
  writeAddonScript,
  startInterceptor,
  stopInterceptor,
  isInterceptorRunning,
  getProcessName,
  getNetworkExtensionStatus,
  openNetworkExtensionSettings,
} from "../interceptor/mitmproxy-manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isClaudeDesktopInstalled(): boolean {
  if (isMacos()) {
    return existsSync("/Applications/Claude.app");
  }
  if (isWindows()) {
    const localAppData = process.env["LOCALAPPDATA"];
    return !!localAppData && existsSync(`${localAppData}\\AnthropicClaude\\Claude.exe`);
  }
  return false;
}

interface RemoteHealth {
  status?: string;
  uptime?: number;
  totalRequests?: number;
  totalErrors?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  accounts?: Array<{ id: string; healthy?: boolean; requestCount?: number; errorCount?: number }>;
  recentLogs?: Array<{
    ts: number;
    accountId: string;
    method?: string;
    path?: string;
    statusCode?: number;
    durationMs?: number;
    type?: string;
  }>;
}

async function fetchRemoteHealth(
  url: string,
  secret?: string,
): Promise<{ ok: boolean; error?: string; data?: RemoteHealth }> {
  try {
    const headers: Record<string, string> = {};
    if (secret) headers["authorization"] = `Bearer ${secret}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(`${url}/cc-router/health`, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as RemoteHealth;
    return { ok: data.status === "ok" || data.status === "degraded", data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function formatUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`;
  }
  return url;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export function registerClient(program: Command): void {
  const client = program
    .command("client")
    .description("Connect to an existing CC-Router server (client mode)");

  // ── cc-router client connect [url] ──────────────────────────────────────────
  client
    .command("connect [url]")
    .description("Connect Claude Code to a CC-Router server")
    .option("-s, --secret <secret>", "Proxy authentication secret")
    .option("-d, --desktop", "Also configure Claude Desktop interception via mitmproxy")
    .action(async (rawUrl?: string, opts?: { secret?: string; desktop?: boolean }) => {
      console.log(chalk.bold("\n🔗 CC-Router Client Setup\n"));

      // 1. Get remote URL
      let url = rawUrl
        ? formatUrl(rawUrl)
        : formatUrl(await input({ message: "Remote CC-Router URL (e.g. 192.168.1.50:3456):" }));

      // 2. Get secret (optional)
      let secret = opts?.secret;
      if (!secret) {
        secret = await input({
          message: "Proxy secret (leave empty if none):",
          transformer: (v) => v ? "•".repeat(v.length) : "",
        }) || undefined;
      }

      // 3. Test connection
      console.log(chalk.gray(`\nTesting connection to ${url}...`));
      const test = await fetchRemoteHealth(url, secret);
      if (!test.ok) {
        console.error(chalk.red(`\n✗ Cannot reach CC-Router at ${url}`));
        console.error(chalk.yellow(`  Error: ${test.error}`));
        console.error(chalk.gray("  Make sure the server is running and accessible.\n"));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Connected — ${test.data?.accounts?.length ?? "?"} accounts on server\n`));

      // 4. Save client config
      const cfg = readConfig();
      const clientCfg: ClientConfig = { remoteUrl: url };
      if (secret) clientCfg.remoteSecret = secret;
      cfg.client = clientCfg;
      writeConfig(cfg);

      // 5. Configure Claude Code
      writeClaudeSettings(0, url, secret ?? "proxy-managed");
      console.log(chalk.green("✓ Claude Code configured to route through CC-Router"));
      console.log(chalk.gray(`  ANTHROPIC_BASE_URL → ${url}`));

      // 6. Optionally configure Claude Desktop (Cowork / Agent mode only)
      let wantsDesktop = opts?.desktop ?? false;
      if (!opts?.desktop && isClaudeDesktopInstalled()) {
        printDesktopSupportExplainer();
        wantsDesktop = await confirm({
          message: "Route Claude Desktop's Cowork / Agent-mode traffic through CC-Router?",
          default: false,
        });
      }

      if (wantsDesktop) {
        await setupDesktopInterception(url);
        cfg.client!.desktopEnabled = true;
        writeConfig(cfg);
      }

      console.log(chalk.bold.green("\n✓ Client mode active\n"));
      console.log("  Next steps:");
      console.log("  • Restart Claude Code for the new settings to take effect");
      if (wantsDesktop) {
        console.log("  • Run " + chalk.cyan("cc-router client start-desktop") + " to begin intercepting Claude Desktop");
      }
      console.log("  • Run " + chalk.cyan("cc-router client status") + " to check connection\n");
    });

  // ── cc-router client disconnect ─────────────────────────────────────────────
  client
    .command("disconnect")
    .description("Disconnect from CC-Router and restore Claude Code defaults")
    .action(async () => {
      const cfg = readConfig();

      if (cfg.client?.desktopEnabled) {
        console.log(chalk.yellow("Stopping Claude Desktop interceptor..."));
        await stopInterceptor();
      }

      removeClaudeSettings();

      delete cfg.client;
      writeConfig(cfg);

      console.log(chalk.green("\n✓ Disconnected from CC-Router"));
      console.log(chalk.gray("  Claude Code will use direct Anthropic connection on next restart.\n"));
    });

  // ── cc-router client status ─────────────────────────────────────────────────
  client
    .command("status")
    .description("Show client connection status with live stats from the remote")
    .option("--json", "Output raw remote health JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = readConfig();
      const claude = readClaudeProxySettings();

      if (!cfg.client) {
        console.log(chalk.yellow("\n  Not connected to any CC-Router server."));
        console.log(chalk.gray("  Run: cc-router client connect <url>\n"));
        return;
      }

      // Fetch live health from remote
      const test = await fetchRemoteHealth(cfg.client.remoteUrl, cfg.client.remoteSecret);

      if (opts.json) {
        console.log(JSON.stringify(test.data ?? { error: test.error }, null, 2));
        return;
      }

      console.log(chalk.bold("\n📡 CC-Router Client Status\n"));
      console.log(`  Remote:   ${chalk.cyan(cfg.client.remoteUrl)}`);
      console.log(`  Auth:     ${cfg.client.remoteSecret ? chalk.green("secret configured") : chalk.gray("no auth")}`);
      console.log(`  Claude:   ${claude.baseUrl ? chalk.green(claude.baseUrl) : chalk.red("not configured")}`);

      if (!test.ok) {
        console.log(`  Server:   ${chalk.red("unreachable")} — ${test.error}`);
        console.log(chalk.gray("\n  The remote proxy isn't responding. Your requests may be failing."));
        console.log();
        return;
      }

      const d = test.data!;
      console.log(`  Server:   ${chalk.green("online")}  ·  up ${chalk.gray(formatUptime(d.uptime ?? 0))}`);

      // ── Totals ─────────────────────────────────────────────────────────
      console.log(chalk.bold("\n  TOTALS"));
      console.log(
        `    Requests: ${chalk.cyan(formatNumber(d.totalRequests))}` +
        `   Errors: ${((d.totalErrors ?? 0) > 0 ? chalk.red : chalk.gray)(formatNumber(d.totalErrors))}`,
      );
      console.log(
        `    Input:    ${chalk.gray(formatNumber(d.totalInputTokens))} tok` +
        `   Output: ${chalk.gray(formatNumber(d.totalOutputTokens))} tok` +
        `   Cache read: ${chalk.gray(formatNumber(d.totalCacheReadTokens))} tok`,
      );

      // ── Accounts ───────────────────────────────────────────────────────
      if (d.accounts && d.accounts.length > 0) {
        console.log(chalk.bold("\n  ACCOUNTS"));
        for (const a of d.accounts) {
          const dot = a.healthy ? chalk.green("●") : chalk.red("●");
          console.log(
            `    ${dot} ${a.id.padEnd(20)}  req ${String(a.requestCount ?? 0).padStart(5)}  ` +
            `err ${String(a.errorCount ?? 0).padStart(3)}`,
          );
        }
      }

      // ── Recent activity ────────────────────────────────────────────────
      if (d.recentLogs && d.recentLogs.length > 0) {
        console.log(chalk.bold("\n  RECENT ACTIVITY  (last 5)"));
        for (const log of d.recentLogs.slice(0, 5)) {
          const status = log.statusCode ?? 0;
          const statusColor = status >= 500 || status === 0 ? chalk.red : status >= 400 ? chalk.yellow : chalk.green;
          const duration = log.durationMs ? ` ${chalk.gray(log.durationMs + "ms")}` : "";
          console.log(
            `    ${chalk.gray(formatTime(log.ts))}  ${log.accountId.padEnd(18)}  ` +
            `${(log.method ?? "?").padEnd(5)} ${(log.path ?? "?").padEnd(22)}  ` +
            `${statusColor(String(status))}${duration}`,
          );
        }
      } else {
        console.log(chalk.gray("\n  No recent activity on the remote proxy."));
      }

      // ── Desktop status ─────────────────────────────────────────────────
      console.log(chalk.bold("\n  DESKTOP INTERCEPTOR  (Cowork / Agent mode)"));
      if (cfg.client.desktopEnabled) {
        const running = await isInterceptorRunning();
        if (running) {
          console.log(`    ${chalk.green("● running")}`);
        } else {
          console.log(`    ${chalk.yellow("○ configured but stopped")}`);
          console.log(chalk.gray("    Start with: cc-router client start-desktop"));
        }
        // Check Network Extension on macOS
        if (isMacos()) {
          const extStatus = await getNetworkExtensionStatus();
          if (extStatus === "waiting") {
            console.log(chalk.red("    ⚠  Network Extension NOT approved — interceptor won't capture traffic!"));
            console.log(chalk.gray("    Fix: System Settings → General → Login Items & Extensions → Network Extensions"));
          } else if (extStatus === "not_installed") {
            console.log(chalk.yellow("    ⚠  Network Extension not installed — will be triggered on first start"));
          } else if (extStatus === "enabled") {
            console.log(`    ${chalk.green("✓")} ${chalk.gray("Network Extension: enabled")}`);
          }
        }
        console.log(chalk.gray("    Scope: /v1/messages + /v1/models  (normal chat NOT routed)"));
      } else {
        console.log(`    ${chalk.gray("not configured — enable with: cc-router client connect --desktop")}`);
      }

      console.log();
      console.log(chalk.gray("  Live dashboard: cc-router status\n"));
    });

  // ── cc-router client start-desktop ──────────────────────────────────────────
  client
    .command("start-desktop")
    .description("Start mitmproxy interceptor for Claude Desktop (Cowork / Agent mode)")
    .action(async () => {
      const cfg = readConfig();
      if (!cfg.client) {
        console.error(chalk.red("Not connected. Run: cc-router client connect <url>"));
        process.exit(1);
      }

      if (!(await checkMitmproxyInstalled())) {
        console.error(chalk.red("\n✗ mitmproxy not found. Install it first:"));
        console.error(chalk.cyan(isMacos() ? "    brew install mitmproxy" : "    pip install mitmproxy"));
        console.error();
        process.exit(1);
      }

      if (!cfg.client.desktopEnabled) {
        await setupDesktopInterception(cfg.client.remoteUrl);
        cfg.client.desktopEnabled = true;
        writeConfig(cfg);
      }

      // Pre-flight check: verify Network Extension is ready on macOS.
      // startInterceptor does the same check and throws; we catch and show
      // a friendlier block here with the open-settings shortcut.
      if (isMacos()) {
        const status = await getNetworkExtensionStatus();
        if (status === "waiting") {
          console.error(chalk.red("\n✗ Mitmproxy Network Extension is NOT yet approved.\n"));
          printNetworkExtensionInstructions();
          const openNow = await confirm({
            message: "Open System Settings now?",
            default: true,
          });
          if (openNow) await openNetworkExtensionSettings();
          console.error(chalk.yellow("\n  Re-run `cc-router client start-desktop` after approving.\n"));
          process.exit(1);
        }
        if (status === "not_installed") {
          console.error(chalk.yellow("\n⚠  Mitmproxy Network Extension is not installed yet."));
          console.error(chalk.gray("  The first mitmdump run will trigger installation."));
          console.error(chalk.gray("  Approve it in System Settings when macOS prompts you, then re-run this command.\n"));
        }
      }

      const target = cfg.client.remoteUrl;
      const processName = getProcessName();
      console.log(chalk.cyan(`\nStarting mitmproxy interceptor for "${processName}"...`));
      console.log(chalk.gray(`  Redirecting api.anthropic.com/v1/messages → ${target}`));

      try {
        await startInterceptor(target);
      } catch (e) {
        console.error(chalk.red(`\n✗ Failed to start interceptor:\n`));
        console.error(chalk.yellow("  " + (e as Error).message.split("\n").join("\n  ")));
        console.error();
        process.exit(1);
      }

      console.log(chalk.green("\n✓ Claude Desktop interceptor running"));
      console.log();
      console.log(chalk.bold.yellow("  Next steps:"));
      console.log("    " + chalk.cyan("1.") + " Quit Claude Desktop completely (⌘Q)");
      console.log("    " + chalk.cyan("2.") + " Reopen Claude Desktop");
      console.log("    " + chalk.cyan("3.") + " Use Cowork / Agent mode (Claude Code in Desktop)");
      console.log();
      console.log(chalk.gray("  Check routing with:  ") + chalk.cyan("cc-router client status"));
      console.log(chalk.gray("  Stop interceptor:    ") + chalk.cyan("cc-router client stop-desktop"));
      console.log();
    });

  // ── cc-router client stop-desktop ───────────────────────────────────────────
  client
    .command("stop-desktop")
    .description("Stop the Claude Desktop mitmproxy interceptor")
    .action(async () => {
      await stopInterceptor();
      console.log(chalk.green("\n✓ Claude Desktop interceptor stopped\n"));
    });
}

// ─── Desktop setup flow ───────────────────────────────────────────────────────

/**
 * Printed before asking the user whether to enable Desktop interception.
 * The copy is deliberately explicit about WHAT works and WHAT doesn't — users
 * who expect the normal chat to go through CC-Router will hit confusion fast,
 * and we can head it off here by framing this as a "Cowork / Agent mode" feature.
 */
export function printDesktopSupportExplainer(): void {
  console.log(chalk.bold.cyan("\n  🖥  Claude Desktop — what CC-Router can route\n"));
  console.log(
    "  Claude Desktop does NOT expose ANTHROPIC_BASE_URL, so CC-Router uses\n" +
    "  mitmproxy to selectively intercept only the traffic it can handle:\n"
  );
  console.log(chalk.green("  ✓ Cowork / Agent mode       ") + chalk.gray("— /v1/messages (this is what gets routed)"));
  console.log(chalk.green("  ✓ Claude Code inside Desktop") + chalk.gray("— /v1/messages (same as CLI)"));
  console.log(chalk.red("  ✗ Normal chat               ") + chalk.gray("— goes to claude.ai webview, NOT redirectable"));
  console.log();
  console.log(chalk.gray(
    "  TL;DR: Your LLM-heavy workflows (Cowork, agent tasks, in-Desktop\n" +
    "  Claude Code) will rotate across your Max accounts via CC-Router.\n" +
    "  The regular chat sidebar keeps going directly through claude.ai."
  ));
  console.log();
}

/**
 * Prints the macOS Network Extension approval walkthrough.
 * This is the #1 gotcha — mitmdump starts silently but captures nothing
 * until the user flips the toggle in System Settings.
 */
export function printNetworkExtensionInstructions(): void {
  if (!isMacos()) return;
  console.log(chalk.bold.yellow("\n  ⚠  IMPORTANT — macOS Network Extension approval\n"));
  console.log("  The first time mitmproxy runs in local mode, macOS installs a");
  console.log("  Network Extension (" + chalk.cyan("Mitmproxy Redirector") + ") that must be approved");
  console.log("  manually. " + chalk.red("Without this step, mitmproxy captures ZERO traffic.") + "\n");
  console.log(chalk.bold("  Steps:"));
  console.log("    " + chalk.cyan("1.") + " Open " + chalk.bold("System Settings"));
  console.log("    " + chalk.cyan("2.") + " Go to " + chalk.bold("General → Login Items & Extensions"));
  console.log("    " + chalk.cyan("3.") + " Scroll to " + chalk.bold("Network Extensions") + " and click the " + chalk.bold("ⓘ") + " button");
  console.log("    " + chalk.cyan("4.") + " Toggle " + chalk.bold("Mitmproxy Redirector") + " ON");
  console.log("    " + chalk.cyan("5.") + " Enter your Mac admin password when prompted\n");
  console.log(chalk.gray("  You only need to do this ONCE per machine.\n"));
}

async function setupDesktopInterception(target: string): Promise<void> {
  console.log(chalk.bold("\n🖥  Claude Desktop Setup\n"));

  // 0. Explain what actually works before anything else
  printDesktopSupportExplainer();
  const proceedWithSetup = await confirm({
    message: "Continue with Cowork / Agent-mode interception setup?",
    default: true,
  });
  if (!proceedWithSetup) {
    console.log(chalk.gray("Skipping Desktop setup. You can run it later with: cc-router client start-desktop\n"));
    return;
  }

  // 1. Check mitmproxy
  if (!(await checkMitmproxyInstalled())) {
    console.log(chalk.yellow("\nmitmproxy is required but not installed."));
    if (isMacos()) {
      console.log(chalk.cyan("  Install:  brew install mitmproxy"));
    } else if (isWindows()) {
      console.log(chalk.cyan("  Install:  pip install mitmproxy  (or download the installer from mitmproxy.org)"));
    } else {
      console.log(chalk.cyan("  Install:  pip install mitmproxy  (Linux local mode requires kernel ≥ 6.8)"));
    }
    console.log();
    const proceed = await confirm({ message: "Have you installed mitmproxy now?", default: false });
    if (!proceed || !(await checkMitmproxyInstalled())) {
      console.log(chalk.red("\nmitmproxy still not found. Skipping Desktop setup.\n"));
      console.log(chalk.gray("Re-run later with:  cc-router client start-desktop\n"));
      return;
    }
  }
  console.log(chalk.green("✓ mitmproxy found"));

  // 2. Generate CA cert if missing
  if (!isCaCertInstalled()) {
    console.log(chalk.gray("Generating mitmproxy CA certificate (one-time)..."));
    try {
      await generateCaCert();
      console.log(chalk.green("✓ CA certificate generated"));
    } catch (e) {
      console.log(chalk.red(`✗ CA generation failed: ${(e as Error).message}`));
      return;
    }
  } else {
    console.log(chalk.green("✓ CA certificate already present"));
  }

  // 3. Install CA cert (requires sudo)
  console.log();
  console.log(chalk.yellow("The mitmproxy CA certificate must be trusted by your OS so that"));
  console.log(chalk.yellow("Claude Desktop accepts the local interceptor. This requires sudo."));
  const installCa = await confirm({ message: "Install CA certificate now? (asks for admin password)", default: true });
  if (installCa) {
    const ok = await installCaCert();
    if (ok) {
      console.log(chalk.green("✓ CA certificate installed in system trust store"));
    } else {
      console.log(chalk.red("✗ CA certificate install failed."));
      console.log(chalk.gray("  Install manually later with:"));
      console.log(chalk.gray("    sudo security add-trusted-cert -d -r trustRoot \\"));
      console.log(chalk.gray("      -k /Library/Keychains/System.keychain \\"));
      console.log(chalk.gray("      ~/.mitmproxy/mitmproxy-ca-cert.pem"));
    }
  }

  // 4. Write addon script
  writeAddonScript(target);
  console.log(chalk.green("✓ Redirect addon configured"));

  // 5. macOS Network Extension — THIS is the step people miss
  if (isMacos()) {
    printNetworkExtensionInstructions();

    // Check current status and guide the user if it's not enabled
    const status = await getNetworkExtensionStatus();

    if (status === "not_installed") {
      console.log(chalk.gray(
        "  The Network Extension hasn't been installed yet — it'll be triggered\n" +
        "  automatically the first time you run `cc-router client start-desktop`.\n" +
        "  macOS will show a popup — approve it and follow the steps above.\n"
      ));
    } else if (status === "waiting") {
      console.log(chalk.red("  ⚠  Network Extension is installed but NOT yet approved.\n"));
      const openNow = await confirm({
        message: "Open System Settings now so you can approve it?",
        default: true,
      });
      if (openNow) {
        await openNetworkExtensionSettings();
        console.log(chalk.gray("\n  System Settings should now be open."));
        console.log(chalk.gray("  Toggle 'Mitmproxy Redirector' ON, then come back here.\n"));
        await confirm({ message: "Done? Press Enter when the toggle is ON", default: true });
        const newStatus = await getNetworkExtensionStatus();
        if (newStatus === "enabled") {
          console.log(chalk.green("✓ Network Extension is enabled"));
        } else {
          console.log(chalk.yellow(`  Still not enabled (status: ${newStatus})`));
          console.log(chalk.gray("  You can re-check later with: cc-router client status"));
        }
      }
    } else if (status === "enabled") {
      console.log(chalk.green("  ✓ Network Extension is already enabled — you're all set"));
    }
  }

  // 6. Remind that Claude Desktop must be restarted for mitmproxy to hook into it
  console.log();
  console.log(chalk.bold.yellow("  One more thing:"));
  console.log(chalk.gray("  After starting the interceptor, you must " + chalk.bold("quit and relaunch Claude Desktop") ));
  console.log(chalk.gray("  (⌘Q in Claude Desktop, then reopen it). mitmproxy only captures"));
  console.log(chalk.gray("  traffic from processes started AFTER it begins listening."));
  console.log();
}
