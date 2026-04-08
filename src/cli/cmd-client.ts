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

async function testRemoteConnection(url: string, secret?: string): Promise<{ ok: boolean; error?: string; accounts?: number }> {
  try {
    const headers: Record<string, string> = {};
    if (secret) headers["authorization"] = `Bearer ${secret}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(`${url}/cc-router/health`, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { status?: string; accounts?: unknown[] };
    return { ok: data.status === "ok" || data.status === "degraded", accounts: data.accounts?.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
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
      const test = await testRemoteConnection(url, secret);
      if (!test.ok) {
        console.error(chalk.red(`\n✗ Cannot reach CC-Router at ${url}`));
        console.error(chalk.yellow(`  Error: ${test.error}`));
        console.error(chalk.gray("  Make sure the server is running and accessible.\n"));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Connected — ${test.accounts ?? "?"} accounts on server\n`));

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

      // 6. Optionally configure Claude Desktop
      const wantsDesktop = opts?.desktop ?? (
        isClaudeDesktopInstalled() &&
        await confirm({ message: "Also route Claude Desktop (chat + Cowork) through the proxy?", default: false })
      );

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
    .description("Show client connection status")
    .action(async () => {
      const cfg = readConfig();
      const claude = readClaudeProxySettings();

      if (!cfg.client) {
        console.log(chalk.yellow("\n  Not connected to any CC-Router server."));
        console.log(chalk.gray("  Run: cc-router client connect <url>\n"));
        return;
      }

      console.log(chalk.bold("\n📡 CC-Router Client Status\n"));
      console.log(`  Remote:   ${chalk.cyan(cfg.client.remoteUrl)}`);
      console.log(`  Auth:     ${cfg.client.remoteSecret ? chalk.green("secret configured") : chalk.gray("no auth")}`);
      console.log(`  Claude:   ${claude.baseUrl ? chalk.green(claude.baseUrl) : chalk.red("not configured")}`);

      // Ping remote
      const test = await testRemoteConnection(cfg.client.remoteUrl, cfg.client.remoteSecret);
      if (test.ok) {
        console.log(`  Server:   ${chalk.green("online")} (${test.accounts} accounts)`);
      } else {
        console.log(`  Server:   ${chalk.red("unreachable")} — ${test.error}`);
      }

      // Desktop status
      if (cfg.client.desktopEnabled) {
        const running = await isInterceptorRunning();
        console.log(`  Desktop:  ${running ? chalk.green("intercepting") : chalk.yellow("configured but not running")}`);
      } else {
        console.log(`  Desktop:  ${chalk.gray("not configured")}`);
      }

      console.log();
    });

  // ── cc-router client start-desktop ──────────────────────────────────────────
  client
    .command("start-desktop")
    .description("Start mitmproxy interceptor for Claude Desktop")
    .action(async () => {
      const cfg = readConfig();
      if (!cfg.client) {
        console.error(chalk.red("Not connected. Run: cc-router client connect <url>"));
        process.exit(1);
      }

      if (!await checkMitmproxyInstalled()) {
        console.error(chalk.red("mitmproxy not found. Install it first:"));
        console.error(chalk.yellow(isMacos() ? "  brew install mitmproxy" : "  pip install mitmproxy"));
        process.exit(1);
      }

      if (!cfg.client.desktopEnabled) {
        await setupDesktopInterception(cfg.client.remoteUrl);
        cfg.client.desktopEnabled = true;
        writeConfig(cfg);
      }

      const target = cfg.client.remoteUrl;
      const processName = getProcessName();
      console.log(chalk.cyan(`\nStarting mitmproxy interceptor for "${processName}"...`));
      console.log(chalk.gray(`  Redirecting api.anthropic.com → ${target}\n`));

      await startInterceptor(target);

      console.log(chalk.green("✓ Claude Desktop interceptor running"));
      console.log(chalk.gray("  Open Claude Desktop and send a message to test.\n"));
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

async function setupDesktopInterception(target: string): Promise<void> {
  console.log(chalk.bold("\n🖥  Claude Desktop Setup\n"));

  // 1. Check mitmproxy
  if (!await checkMitmproxyInstalled()) {
    console.log(chalk.yellow("mitmproxy is required but not installed."));
    if (isMacos()) {
      console.log(chalk.cyan("  Install: brew install mitmproxy"));
    } else if (isWindows()) {
      console.log(chalk.cyan("  Install: pip install mitmproxy"));
    } else {
      console.log(chalk.cyan("  Install: pip install mitmproxy (requires kernel ≥ 6.8)"));
    }
    console.log();
    const proceed = await confirm({ message: "Have you installed mitmproxy?", default: false });
    if (!proceed || !await checkMitmproxyInstalled()) {
      console.log(chalk.red("mitmproxy not found. Skipping Desktop setup.\n"));
      return;
    }
  }
  console.log(chalk.green("✓ mitmproxy found"));

  // 2. Generate CA cert if needed
  if (!isCaCertInstalled()) {
    console.log(chalk.gray("Generating mitmproxy CA certificate..."));
    await generateCaCert();
  }

  // 3. Install CA cert (requires sudo)
  console.log(chalk.yellow("\nInstalling the mitmproxy CA certificate requires admin access."));
  console.log(chalk.gray("This is needed so Claude Desktop trusts the local interceptor."));
  const installCa = await confirm({ message: "Install CA certificate now? (requires password)", default: true });
  if (installCa) {
    const ok = await installCaCert();
    if (ok) {
      console.log(chalk.green("✓ CA certificate installed"));
    } else {
      console.log(chalk.red("✗ CA certificate install failed. You may need to install it manually."));
    }
  }

  // 4. Write addon script
  writeAddonScript(target);
  console.log(chalk.green("✓ Redirect addon configured"));

  // 5. macOS Network Extension note
  if (isMacos()) {
    console.log(chalk.yellow("\n⚠  On first run, macOS will ask to approve mitmproxy's Network Extension."));
    console.log(chalk.gray("   Go to System Settings → General → Login Items & Extensions → Network Extensions"));
    console.log(chalk.gray("   and toggle 'Mitmproxy Redirector' on.\n"));
  }
}
