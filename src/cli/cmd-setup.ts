import type { Command } from "commander";
import { select, input, confirm, password } from "@inquirer/prompts";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { detectPlatform, isMacos } from "../utils/platform.js";
import {
  extractFromKeychain,
  extractFromCredentialsFile,
  formatExpiry,
  redactToken,
} from "../utils/token-extractor.js";
import { validateToken } from "../utils/token-validator.js";
import { writeClaudeSettings, readClaudeProxySettings } from "../utils/claude-config.js";
import { saveAccounts } from "../proxy/token-refresher.js";
import { loadAccounts, accountsFileExists } from "../config/manager.js";
import { PROXY_PORT } from "../config/paths.js";
import type { Account, OAuthTokens } from "../proxy/types.js";

const execFileAsync = promisify(execFile);

// ─── Public registration ──────────────────────────────────────────────────────

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Interactive wizard: extract tokens and configure Claude Code automatically")
    .option("--add", "Add a new account to an existing configuration (skip intro questions)")
    .action(async (opts: { add?: boolean }) => {
      await runSetupWizard({ addMode: opts.add ?? false });
    });
}

// ─── Shared single-account setup (also used by `accounts add`) ───────────────

export async function setupSingleAccount(index: number): Promise<Account | null> {
  type ExtractionMethod = "keychain" | "credentials" | "manual";

  const choices: { name: string; value: ExtractionMethod }[] = [];
  if (isMacos()) {
    choices.push({ name: "Extract automatically from macOS Keychain  (recommended)", value: "keychain" });
  }
  choices.push({ name: "Read from ~/.claude/.credentials.json", value: "credentials" });
  choices.push({ name: "Paste tokens manually", value: "manual" });

  const method = await select<ExtractionMethod>({
    message: "How do you want to add the tokens?",
    choices,
  });

  let tokens: OAuthTokens | null = null;

  if (method === "keychain") {
    process.stdout.write(chalk.gray("  Extracting from Keychain... "));
    tokens = await extractFromKeychain();
    if (tokens) {
      console.log(chalk.green("✓"));
      console.log(chalk.gray(`  Token: ${redactToken(tokens.accessToken)}`));
      console.log(chalk.gray(`  Expiry: ${formatExpiry(tokens.expiresAt)}`));
    } else {
      console.log(chalk.red("✗"));
      console.log(chalk.yellow("  Could not find credentials in Keychain."));
      console.log(chalk.gray("  Make sure Claude Code is logged in: run `claude login` first."));
      const retry = await confirm({ message: "Try another extraction method?", default: true });
      if (!retry) return null;
      return setupSingleAccount(index);
    }
  }

  if (method === "credentials") {
    tokens = extractFromCredentialsFile();
    if (tokens) {
      console.log(chalk.green(`  ✓ Found credentials in ~/.claude/.credentials.json`));
      console.log(chalk.gray(`    Token: ${redactToken(tokens.accessToken)}`));
      console.log(chalk.gray(`    Expiry: ${formatExpiry(tokens.expiresAt)}`));
    } else {
      console.log(chalk.red("  ✗ ~/.claude/.credentials.json not found or unreadable."));
      console.log(chalk.gray("  Make sure Claude Code is installed and you've run `claude login`."));
      const retry = await confirm({ message: "Paste tokens manually instead?", default: true });
      if (!retry) return null;
      tokens = await promptManualTokens();
    }
  }

  if (method === "manual") {
    tokens = await promptManualTokens();
  }

  if (!tokens) return null;

  const defaultId = `max-account-${index}`;
  const accountId = await input({
    message: "Account ID (press Enter to accept default):",
    default: defaultId,
    validate: (v) => /^[a-zA-Z0-9_-]+$/.test(v) || "Only letters, numbers, _ and - allowed",
  });

  process.stdout.write(chalk.gray("  Validating tokens against Anthropic... "));
  const validation = await validateToken(tokens.accessToken);

  if (validation.valid) {
    console.log(chalk.green("✓ Valid"));
  } else {
    console.log(chalk.red("✗ Invalid"));
    console.log(chalk.yellow(`  Reason: ${validation.reason}`));
    console.log(chalk.gray("  The token will be saved but may not work until refreshed."));
    const keepAnyway = await confirm({ message: "Save this account anyway?", default: false });
    if (!keepAnyway) return null;
  }

  return {
    id: accountId,
    tokens,
    healthy: validation.valid,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
  };
}

// ─── Full wizard ──────────────────────────────────────────────────────────────

async function runSetupWizard({ addMode }: { addMode: boolean }): Promise<void> {
  const platform = detectPlatform();
  const hasExisting = accountsFileExists();

  printBanner();
  console.log(chalk.gray(`Platform: ${platform}\n`));

  if (hasExisting && !addMode) {
    const existing = loadAccounts();
    console.log(chalk.yellow(`  Found ${existing.length} existing account(s).\n`));
    const action = await select({
      message: "What do you want to do?",
      choices: [
        { name: "Add more accounts to the existing configuration", value: "add" },
        { name: "Start fresh (replace all accounts)", value: "replace" },
        { name: "Cancel", value: "cancel" },
      ],
    });
    if (action === "cancel") {
      console.log(chalk.gray("\nCancelled.\n"));
      return;
    }
    if (action === "replace") {
      const sure = await confirm({
        message: chalk.red("This will delete all existing accounts. Are you sure?"),
        default: false,
      });
      if (!sure) { console.log(chalk.gray("\nCancelled.\n")); return; }
    }
  }

  if (!addMode && isMacos()) {
    console.log(chalk.cyan("  Tip: to add multiple accounts, you need to:"));
    console.log(chalk.gray("  1. Log in to Claude Code with account 1 (already done if you use CC normally)"));
    console.log(chalk.gray("  2. Extract tokens → log out → log in with account 2 → extract → repeat\n"));
  }

  let numAccounts = 1;
  if (!addMode) {
    const { number } = await import("@inquirer/prompts");
    numAccounts = await number({
      message: "How many accounts do you want to configure now?",
      default: 1,
      min: 1,
      max: 20,
    }) ?? 1;
  }

  const newAccounts: Account[] = [];

  for (let i = 0; i < numAccounts; i++) {
    const label = numAccounts > 1 ? `${i + 1}/${numAccounts}` : "";
    console.log(chalk.bold(`\n${"━".repeat(40)}\n  Account ${label}\n${"━".repeat(40)}\n`));

    if (i > 0 && isMacos()) {
      console.log(chalk.yellow(
        `  Before extracting account ${i + 1}:\n` +
        `  1. Run: ${chalk.white("claude logout")}\n` +
        `  2. Run: ${chalk.white("claude login")}  (log in with your next Max account)\n`
      ));
      await confirm({ message: "Ready?", default: true });
    }

    const existingCount = hasExisting ? loadAccounts().length : 0;
    const account = await setupSingleAccount(i + 1 + existingCount);
    if (account) {
      newAccounts.push(account);
      console.log(chalk.green(`\n  ✓ Account "${account.id}" ready.\n`));
    } else {
      console.log(chalk.yellow(`  ↷ Skipped account ${i + 1}.\n`));
    }
  }

  if (newAccounts.length === 0) {
    console.log(chalk.red("\n✗ No accounts configured. Run cc-router setup again.\n"));
    return;
  }

  // Merge: existing accounts minus any overwritten by ID, plus new ones
  const existingAccounts = (hasExisting && !addMode) ? [] : (hasExisting ? loadAccounts() : []);
  const merged = [
    ...existingAccounts.filter(a => !newAccounts.some(n => n.id === a.id)),
    ...newAccounts,
  ];

  console.log(chalk.bold(`\n${"━".repeat(40)}\n  Saving\n${"━".repeat(40)}\n`));

  saveAccounts(merged);
  console.log(chalk.green(`  ✓ ${merged.length} account(s) saved to ~/.cc-router/accounts.json`));

  // ─── Post-setup interactive flow ─────────────────────────────────────────
  await runPostSetupFlow(merged.length);
}

// ─── Post-setup interactive flow ─────────────────────────────────────────────

async function runPostSetupFlow(accountCount: number): Promise<void> {
  console.log(chalk.bold(`\n${"━".repeat(40)}\n  Configure this machine\n${"━".repeat(40)}\n`));

  // 1. Configure Claude Code on this machine
  const currentSettings = readClaudeProxySettings();
  const alreadyConfigured = currentSettings.baseUrl?.includes("localhost");

  const configureLocal = await confirm({
    message: alreadyConfigured
      ? `Claude Code is already pointing to ${currentSettings.baseUrl}. Reconfigure?`
      : "Configure Claude Code on this machine to use the proxy?",
    default: true,
  });

  if (configureLocal) {
    // Ask if this is a local proxy or a remote one
    const proxyLocation = await select({
      message: "Where will cc-router run?",
      choices: [
        { name: `On this machine  (localhost:${PROXY_PORT})`, value: "local" },
        { name: "On another machine / VPS  (I'll enter the address)", value: "remote" },
      ],
    });

    let proxyHost = `http://localhost:${PROXY_PORT}`;

    if (proxyLocation === "remote") {
      const remoteHost = await input({
        message: "Proxy URL (e.g. http://192.168.1.50:3456 or https://cc-router.example.com):",
        validate: (v) => {
          try { new URL(v); return true; }
          catch { return "Enter a valid URL (http:// or https://)"; }
        },
      });
      proxyHost = remoteHost.replace(/\/$/, ""); // strip trailing slash
    }

    const port = proxyLocation === "local"
      ? PROXY_PORT
      : parseInt(new URL(proxyHost).port || "80", 10);

    writeClaudeSettings(port, proxyHost);
    console.log(chalk.green(`\n  ✓ ~/.claude/settings.json updated`));
    console.log(chalk.gray(`      ANTHROPIC_BASE_URL  = ${proxyHost}`));
    console.log(chalk.gray(`      ANTHROPIC_AUTH_TOKEN = proxy-managed`));

    if (proxyLocation === "remote") {
      console.log(chalk.cyan(`\n  On the remote machine, start cc-router with:`));
      console.log(chalk.white(`    HOST=0.0.0.0 cc-router start`));
      console.log(chalk.cyan(`  Or as a service:`));
      console.log(chalk.white(`    cc-router service install\n`));
      // Nothing more to do on this machine
      printDone(accountCount);
      return;
    }
  }

  // 2. Only ask about starting the proxy if it's local
  console.log(chalk.bold(`\n${"━".repeat(40)}\n  Start the proxy\n${"━".repeat(40)}\n`));

  // Check if it's already running
  const alreadyRunning = await isProxyRunning();
  if (alreadyRunning) {
    console.log(chalk.green(`  ✓ Proxy is already running on http://localhost:${PROXY_PORT}`));
    printDone(accountCount);
    return;
  }

  const startChoice = await select({
    message: "How do you want to run the proxy?",
    choices: [
      { name: "Install as system service  (auto-start on boot — recommended)", value: "service" },
      { name: "Start in background now  (current session only, via PM2)", value: "daemon" },
      { name: "Start in foreground now  (this terminal, Ctrl+C to stop)", value: "foreground" },
      { name: "I'll start it manually later", value: "skip" },
    ],
  });

  if (startChoice === "service") {
    await installService();
  } else if (startChoice === "daemon") {
    await startDaemon();
  } else if (startChoice === "foreground") {
    printDone(accountCount);
    console.log(chalk.cyan("\nStarting proxy in foreground...\n"));
    // Launch start as child — it blocks until Ctrl+C
    await startForeground();
    return; // startForeground never returns normally
  }

  printDone(accountCount);
}

// ─── Proxy launch helpers ─────────────────────────────────────────────────────

async function isProxyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${PROXY_PORT}/cc-router/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function installService(): Promise<void> {
  console.log(chalk.cyan("\n  Installing as system service via PM2..."));
  try {
    // Ensure PM2 is installed
    await execFileAsync("pm2", ["--version"]).catch(async () => {
      console.log(chalk.gray("  Installing PM2..."));
      await execFileAsync("npm", ["install", "-g", "pm2"]);
    });

    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const cliEntry = join(__dirname, "index.js");

    // Start in PM2
    await execFileAsync("pm2", [
      "start", cliEntry,
      "--name", "cc-router",
      "--interpreter", process.execPath,
      "--max-memory-restart", "500M",
      "--", "start",
    ]).catch(async (err) => {
      // Already registered — restart instead
      if ((err as Error).message?.includes("already")) {
        await execFileAsync("pm2", ["restart", "cc-router"]);
      } else {
        throw err;
      }
    });

    await execFileAsync("pm2", ["save"]);
    console.log(chalk.green("  ✓ cc-router registered in PM2 and saved"));

    // Generate startup hook
    try {
      const { stdout, stderr } = await execFileAsync("pm2", ["startup"]);
      const combined = stdout + stderr;
      const sudoMatch = combined.match(/sudo\s+\S.+/);
      if (sudoMatch) {
        console.log(chalk.yellow("\n  Run this command to complete auto-start setup:"));
        console.log(chalk.white(`    ${sudoMatch[0]}`));
        console.log(chalk.gray("  Then run: pm2 save"));
      } else {
        console.log(chalk.green("  ✓ Auto-start on boot configured"));
      }
    } catch (err) {
      const combined = ((err as Error & { stdout?: string; stderr?: string }).stdout ?? "") +
                       ((err as Error & { stdout?: string; stderr?: string }).stderr ?? "");
      const sudoMatch = combined.match(/sudo\s+\S.+/);
      if (sudoMatch) {
        console.log(chalk.yellow("\n  Run this command to complete auto-start setup:"));
        console.log(chalk.white(`    ${sudoMatch[0]}`));
        console.log(chalk.gray("  Then run: pm2 save"));
      }
    }

    // Wait a moment and confirm it started
    await new Promise(r => setTimeout(r, 1500));
    const running = await isProxyRunning();
    if (running) {
      console.log(chalk.green(`  ✓ Proxy is running on http://localhost:${PROXY_PORT}`));
    } else {
      console.log(chalk.yellow("  ⚠ Service registered but proxy not yet responding — it may still be starting."));
      console.log(chalk.gray("    Check: cc-router service status"));
    }
  } catch (err) {
    console.log(chalk.red(`  ✗ Service install failed: ${(err as Error).message}`));
    console.log(chalk.gray("  Try manually: cc-router service install"));
  }
}

async function startDaemon(): Promise<void> {
  console.log(chalk.cyan("\n  Starting in background via PM2..."));
  try {
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const cliEntry = join(__dirname, "index.js");

    await execFileAsync("pm2", [
      "start", cliEntry,
      "--name", "cc-router",
      "--interpreter", process.execPath,
      "--max-memory-restart", "500M",
      "--", "start",
    ]).catch(async (err) => {
      if ((err as Error).message?.includes("already")) {
        await execFileAsync("pm2", ["restart", "cc-router"]);
      } else {
        throw err;
      }
    });

    await new Promise(r => setTimeout(r, 1500));
    const running = await isProxyRunning();
    if (running) {
      console.log(chalk.green(`  ✓ Proxy running in background on http://localhost:${PROXY_PORT}`));
      console.log(chalk.gray("    Logs: pm2 logs cc-router  |  Stop: cc-router stop"));
    } else {
      console.log(chalk.yellow("  ⚠ PM2 registered but proxy not yet responding."));
      console.log(chalk.gray("    Check: pm2 logs cc-router"));
    }
  } catch (err) {
    console.log(chalk.red(`  ✗ Failed to start via PM2: ${(err as Error).message}`));
    console.log(chalk.gray("  PM2 not installed? Run: npm install -g pm2"));
    console.log(chalk.gray("  Or start manually: cc-router start"));
  }
}

async function startForeground(): Promise<void> {
  const { fileURLToPath } = await import("url");
  const { dirname, join } = await import("path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const cliEntry = join(__dirname, "index.js");

  const child = spawn(process.execPath, [cliEntry, "start"], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    child.on("close", resolve);
    child.on("error", (err) => {
      console.error(chalk.red(`  ✗ ${err.message}`));
      resolve();
    });
  });
}

// ─── Done banner ──────────────────────────────────────────────────────────────

function printDone(accountCount: number): void {
  console.log(chalk.bold(`\n${"━".repeat(40)}\n  All done — ${accountCount} account(s) ready\n${"━".repeat(40)}\n`));
  console.log(`  Dashboard:         ${chalk.cyan("cc-router status")}`);
  console.log(`  Add more accounts: ${chalk.cyan("cc-router setup --add")}`);
  console.log(`  Stop & revert:     ${chalk.cyan("cc-router revert")}\n`);
}

// ─── Manual token input ───────────────────────────────────────────────────────

async function promptManualTokens(): Promise<OAuthTokens | null> {
  console.log(chalk.gray(
    "\n  You can find your tokens by running:\n" +
    "    macOS:         security find-generic-password -s 'Claude Code-credentials' -w\n" +
    "    Linux/Windows: cat ~/.claude/.credentials.json\n"
  ));

  const accessToken = await password({
    message: "Paste accessToken (sk-ant-oat01-...):",
    mask: "•",
    validate: (v) =>
      v.startsWith("sk-ant-oat01-") || v.startsWith("sk-ant-")
        ? true
        : "Must start with sk-ant-oat01-",
  });

  const refreshToken = await password({
    message: "Paste refreshToken (sk-ant-ort01-...):",
    mask: "•",
    validate: (v) =>
      v.startsWith("sk-ant-ort01-") || v.startsWith("sk-ant-")
        ? true
        : "Must start with sk-ant-ort01-",
  });

  const useDefaultExpiry = await confirm({
    message: "Use default expiry (8 hours from now)?",
    default: true,
  });

  const expiresAt = useDefaultExpiry
    ? Date.now() + 8 * 60 * 60 * 1000
    : new Date(await input({ message: "Paste expiresAt (ISO date or ms timestamp):" })).getTime();

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: ["user:inference", "user:profile"],
  };
}

function printBanner(): void {
  console.log(chalk.cyan(
    "\n╔══════════════════════════════════════════╗\n" +
    "║  CC-Router — Setup                       ║\n" +
    "╚══════════════════════════════════════════╝\n"
  ));
}
