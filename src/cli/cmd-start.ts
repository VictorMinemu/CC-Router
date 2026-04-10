import type { Command } from "commander";
import { execFile } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { PROXY_PORT, LITELLM_PORT, ACCOUNTS_PATH } from "../config/paths.js";
const execFileAsync = promisify(execFile);

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start the proxy server")
    .option("--port <port>", "Port to listen on", String(PROXY_PORT))
    .option("--daemon", "Run in background via PM2 (requires: cc-router service install)")
    .option("--litellm [url]", "Forward to LiteLLM instead of Anthropic directly (default URL: http://localhost:4000)")
    .option("--accounts <path>", "Path to accounts.json", ACCOUNTS_PATH)
    .action(async (opts: { port: string; daemon?: boolean; litellm?: string | boolean; accounts: string }) => {
      if (opts.daemon) {
        await startDaemon();
        return;
      }

      const litellmUrl = opts.litellm
        ? (typeof opts.litellm === "string" ? opts.litellm : `http://localhost:${LITELLM_PORT}`)
        : undefined;

      // If --litellm is set and no URL is provided, try to start LiteLLM via Docker
      if (opts.litellm && typeof opts.litellm !== "string") {
        await ensureLiteLLMRunning();
      }

      const { startServer } = await import("../proxy/server.js");

      await startServer({
        port: parseInt(opts.port, 10),
        litellmUrl,
        accountsPath: opts.accounts !== ACCOUNTS_PATH ? opts.accounts : undefined,
      });
    });
}

async function startDaemon(): Promise<void> {
  try {
    await execFileAsync("pm2", ["restart", "cc-router"]);
    console.log(chalk.green("✓ cc-router restarted via PM2"));
  } catch {
    console.error(chalk.red("✗ cc-router is not registered as a PM2 service."));
    console.error(chalk.gray("  Set it up first: cc-router service install"));
    process.exit(1);
  }
}

/** Start only the LiteLLM container if it's not already responding */
async function ensureLiteLLMRunning(): Promise<void> {
  const litellmUrl = `http://localhost:${LITELLM_PORT}`;
  try {
    const res = await fetch(`${litellmUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    if (res.ok) {
      console.log(chalk.green(`✓ LiteLLM already running at ${litellmUrl}`));
      return;
    }
  } catch {
    // Not running — start it
  }

  console.log(chalk.cyan("Starting LiteLLM via Docker..."));
  try {
    await execFileAsync("docker", ["info"]);
  } catch {
    console.error(chalk.red("✗ Docker is not running. Start Docker Desktop first."));
    console.error(chalk.gray("  Or pass a custom LiteLLM URL: cc-router start --litellm http://your-host:4000"));
    process.exit(1);
  }

  try {
    const { spawn } = await import("child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["compose", "up", "-d", "litellm"], { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    console.log(chalk.green(`✓ LiteLLM starting at ${litellmUrl}/ui`));
  } catch (err) {
    console.error(chalk.red("✗ Failed to start LiteLLM:"), (err as Error).message);
    process.exit(1);
  }
}
