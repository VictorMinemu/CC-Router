import type { Command } from "commander";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import chalk from "chalk";
import { detectPlatform } from "../utils/platform.js";

const execFileAsync = promisify(execFile);

// Resolve the path to the compiled CLI entry point
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ENTRY = join(__dirname, "index.js");

export function registerService(program: Command): void {
  const service = program
    .command("service")
    .description("Manage cc-router as a system service (auto-start on boot via PM2)");

  service
    .command("install")
    .description("Register cc-router to start automatically on system boot")
    .action(async () => {
      console.log(chalk.cyan("\nInstalling cc-router as a system service...\n"));

      // 1. Verify PM2 is installed
      const pm2Version = await getPm2Version();
      if (!pm2Version) {
        console.log(chalk.yellow("PM2 not found. Installing globally..."));
        try {
          await execFileAsync("npm", ["install", "-g", "pm2"]);
          console.log(chalk.green("✓ PM2 installed"));
        } catch (err) {
          console.error(chalk.red("✗ Failed to install PM2:"), (err as Error).message);
          console.error(chalk.gray("  Try manually: npm install -g pm2"));
          process.exit(1);
        }
      } else {
        console.log(chalk.green(`✓ PM2 ${pm2Version} found`));
      }

      // 2. Register cc-router in PM2
      console.log(chalk.gray("\nRegistering cc-router in PM2..."));
      try {
        await execFileAsync("pm2", [
          "start", CLI_ENTRY,
          "--name", "cc-router",
          "--interpreter", process.execPath,
          "--max-memory-restart", "500M", // restart if memory exceeds 500MB
          "--",
          "start",
        ]);
        console.log(chalk.green("✓ cc-router registered in PM2"));
      } catch (err) {
        const msg = (err as Error).message;
        // PM2 may already have the process — try restart instead
        if (msg.includes("already")) {
          await execFileAsync("pm2", ["restart", "cc-router"]);
          console.log(chalk.green("✓ cc-router restarted in PM2"));
        } else {
          console.error(chalk.red("✗ Failed to start in PM2:"), msg);
          process.exit(1);
        }
      }

      // 3. Save process list so it survives reboots
      await execFileAsync("pm2", ["save"]);
      console.log(chalk.green("✓ PM2 process list saved"));

      // 4. Generate and apply startup hook
      console.log(chalk.gray("\nConfiguring system startup hook..."));
      console.log(chalk.gray("(may ask for your password on Linux/macOS)\n"));

      try {
        const { stdout, stderr } = await execFileAsync("pm2", ["startup"]);
        const output = stdout + stderr;

        // PM2 prints a sudo command to run if it can't apply it automatically
        const sudoMatch = output.match(/sudo\s+.+/);
        if (sudoMatch) {
          console.log(chalk.yellow("Run this command to complete startup registration:"));
          console.log(chalk.white(`  ${sudoMatch[0]}`));
          console.log(chalk.gray("\nThen run:  pm2 save"));
        } else {
          console.log(chalk.green("✓ System startup hook configured"));
        }
      } catch (err) {
        const msg = (err as Error & { stdout?: string; stderr?: string });
        const combined = (msg.stdout ?? "") + (msg.stderr ?? "");
        const sudoMatch = combined.match(/sudo\s+.+/);
        if (sudoMatch) {
          console.log(chalk.yellow("\nRun this command to complete startup registration:"));
          console.log(chalk.white(`  ${sudoMatch[0]}`));
          console.log(chalk.gray("\nThen run:  pm2 save"));
        } else {
          console.log(chalk.yellow("⚠ Could not configure startup hook automatically."));
          printManualStartupInstructions();
        }
      }

      printServiceInfo();
    });

  service
    .command("uninstall")
    .description("Remove cc-router from system startup")
    .action(async () => {
      let removed = false;

      try {
        await execFileAsync("pm2", ["stop", "cc-router"]);
        await execFileAsync("pm2", ["delete", "cc-router"]);
        await execFileAsync("pm2", ["save"]);
        console.log(chalk.green("✓ cc-router removed from PM2"));
        removed = true;
      } catch {
        console.log(chalk.gray("cc-router was not registered in PM2."));
      }

      // Remove Claude Code proxy config too
      const { removeClaudeSettings } = await import("../utils/claude-config.js");
      const { readClaudeProxySettings } = await import("../utils/claude-config.js");
      if (readClaudeProxySettings().baseUrl) {
        removeClaudeSettings();
        console.log(chalk.green("✓ Removed proxy settings from ~/.claude/settings.json"));
        removed = true;
      }

      if (removed) {
        console.log(chalk.green("\n✓ Service uninstalled. Claude Code will use normal authentication.\n"));
      } else {
        console.log(chalk.gray("\nNothing to uninstall.\n"));
      }
    });

  service
    .command("status")
    .description("Show the service status in PM2")
    .action(async () => {
      try {
        const { stdout } = await execFileAsync("pm2", ["info", "cc-router"]);
        console.log(stdout);
      } catch {
        console.log(chalk.yellow("cc-router is not registered as a PM2 service."));
        console.log(chalk.gray("  Install it with: cc-router service install"));
      }
    });

  service
    .command("logs")
    .description("Tail the proxy logs from PM2")
    .option("--lines <n>", "Number of lines to show", "50")
    .action(async (opts: { lines: string }) => {
      try {
        // pm2 logs streams continuously — spawn it directly so it inherits stdio
        const { spawn } = await import("child_process");
        const child = spawn("pm2", ["logs", "cc-router", "--lines", opts.lines], {
          stdio: "inherit",
        });
        child.on("error", () => {
          console.log(chalk.yellow("PM2 not found. Is cc-router installed as a service?"));
        });
      } catch {
        console.error(chalk.red("Could not tail logs."));
      }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getPm2Version(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pm2", ["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

function printServiceInfo(): void {
  console.log(chalk.bold("\n━━━ Service installed ━━━━━━━━━━━━━━━━━━━━━━━━\n"));
  console.log(`  Check status:   ${chalk.cyan("cc-router service status")}`);
  console.log(`  View logs:      ${chalk.cyan("cc-router service logs")}`);
  console.log(`  Stop & remove:  ${chalk.cyan("cc-router service uninstall")}`);
  console.log(`  Restart:        ${chalk.cyan("pm2 restart cc-router")}`);
  console.log();
}

function printManualStartupInstructions(): void {
  const platform = detectPlatform();
  console.log(chalk.gray("\n  To configure auto-start manually:"));

  if (platform === "macos") {
    console.log(chalk.gray("  macOS (launchd): pm2 startup launchd && pm2 save"));
  } else if (platform === "linux") {
    console.log(chalk.gray("  Linux (systemd): pm2 startup systemd && pm2 save"));
    console.log(chalk.gray("  Then: sudo systemctl enable pm2-$(whoami)"));
  } else {
    console.log(chalk.gray("  Windows: see https://github.com/jessety/pm2-installer"));
  }
}
