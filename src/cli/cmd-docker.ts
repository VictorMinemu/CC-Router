import type { Command } from "commander";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import chalk from "chalk";
import { ACCOUNTS_PATH, LITELLM_PORT, PROXY_PORT } from "../config/paths.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const COMPOSE_FILE = join(dirname(__filename), "..", "..", "docker-compose.yml");

export function registerDocker(program: Command): void {
  const docker = program
    .command("docker")
    .description("Manage the full Docker stack (cc-router + LiteLLM)");

  docker
    .command("up")
    .description("Start cc-router + LiteLLM with Docker Compose")
    .option("--build", "Rebuild the cc-router image before starting")
    .action(async (opts: { build?: boolean }) => {
      await ensureDockerAvailable();
      await ensureAccountsExist();

      console.log(chalk.cyan("\nStarting cc-router + LiteLLM via Docker Compose...\n"));

      const args = ["compose", "-f", COMPOSE_FILE, "up", "-d"];
      if (opts.build) args.push("--build");

      try {
        await spawnInherited("docker", args);
        await waitForHealthy();
        printDockerInfo();
      } catch (err) {
        console.error(chalk.red("\n✗ docker compose up failed:"), (err as Error).message);
        console.error(chalk.gray("  Check logs with: cc-router docker logs"));
        process.exit(1);
      }
    });

  docker
    .command("down")
    .description("Stop and remove Docker containers")
    .option("-v, --volumes", "Also remove named volumes")
    .action(async (opts: { volumes?: boolean }) => {
      const args = ["compose", "-f", COMPOSE_FILE, "down"];
      if (opts.volumes) args.push("-v");
      await spawnInherited("docker", args);
      console.log(chalk.green("\n✓ Containers stopped.\n"));
    });

  docker
    .command("logs")
    .description("Tail Docker Compose logs")
    .option("-f, --follow", "Follow log output", true)
    .option("--service <name>", "Show logs for a specific service (cc-router or litellm)")
    .action(async (opts: { follow?: boolean; service?: string }) => {
      const args = ["compose", "-f", COMPOSE_FILE, "logs"];
      if (opts.follow) args.push("-f");
      args.push("--tail=100");
      if (opts.service) args.push(opts.service);
      await spawnInherited("docker", args);
    });

  docker
    .command("ps")
    .description("Show running container status")
    .action(async () => {
      await spawnInherited("docker", ["compose", "-f", COMPOSE_FILE, "ps"]);
    });

  docker
    .command("restart")
    .description("Restart a service without rebuilding")
    .argument("[service]", "Service to restart (cc-router or litellm)", "cc-router")
    .action(async (service: string) => {
      await spawnInherited("docker", ["compose", "-f", COMPOSE_FILE, "restart", service]);
      console.log(chalk.green(`\n✓ ${service} restarted.\n`));
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDockerAvailable(): Promise<void> {
  try {
    await execFileAsync("docker", ["info"]);
  } catch {
    console.error(chalk.red("✗ Docker is not running or not installed."));
    console.error(chalk.gray("  Install Docker Desktop: https://docs.docker.com/get-docker/"));
    process.exit(1);
  }
}

async function ensureAccountsExist(): Promise<void> {
  if (!existsSync(ACCOUNTS_PATH)) {
    console.error(chalk.red(`✗ accounts.json not found at ${ACCOUNTS_PATH}`));
    console.error(chalk.yellow("  Run: cc-router setup"));
    process.exit(1);
  }
}

/** Wait until the cc-router health endpoint responds OK (max 60s) */
async function waitForHealthy(): Promise<void> {
  process.stdout.write(chalk.gray("  Waiting for services to be healthy"));
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PROXY_PORT}/cc-router/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) {
        console.log(chalk.green(" ✓"));
        return;
      }
    } catch {
      // not ready yet
    }
    process.stdout.write(".");
    await sleep(2_000);
  }

  console.log(chalk.yellow(" timed out"));
  console.log(chalk.gray("  Services may still be starting. Check: cc-router docker ps"));
}

function printDockerInfo(): void {
  console.log(chalk.bold("\n  Stack is running:\n"));
  console.log(`  Proxy:      ${chalk.cyan(`http://localhost:${PROXY_PORT}`)}`);
  console.log(`  LiteLLM UI: ${chalk.cyan(`http://localhost:${LITELLM_PORT}/ui`)}`);
  console.log(`  Health:     ${chalk.cyan(`http://localhost:${PROXY_PORT}/cc-router/health`)}`);
  console.log();
  console.log(chalk.gray("  Logs:   cc-router docker logs"));
  console.log(chalk.gray("  Stop:   cc-router docker down\n"));
}

/** Spawn a command with inherited stdio (user sees output in real time) */
function spawnInherited(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", code => {
      code === 0 ? resolve() : reject(new Error(`exited with code ${code}`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
