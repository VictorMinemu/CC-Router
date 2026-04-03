import type { Command } from "commander";
import chalk from "chalk";
import { PROXY_PORT } from "../config/paths.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Live dashboard: account health, request counts, recent routing log")
    .option("--port <port>", "Proxy port to connect to", String(PROXY_PORT))
    .option("--json", "Output current stats as JSON and exit (non-interactive)")
    .action(async (opts: { port: string; json?: boolean }) => {
      const port = parseInt(opts.port, 10);

      if (opts.json) {
        await jsonOutput(port);
        return;
      }

      await launchDashboard(port);
    });
}

async function jsonOutput(port: number): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${port}/cc-router/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      console.error(chalk.red(`Proxy returned HTTP ${res.status}`));
      process.exit(1);
    }
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch {
    console.error(chalk.red(`Cannot connect to proxy at http://localhost:${port}`));
    console.error(chalk.gray("Is it running? Start with: cc-router start"));
    process.exit(1);
  }
}

async function launchDashboard(port: number): Promise<void> {
  // Dynamic imports keep these heavy deps out of the cold-start path
  const [{ render }, { createElement }, { Dashboard }] = await Promise.all([
    import("ink"),
    import("react"),
    import("../ui/Dashboard.js"),
  ]);

  render(createElement(Dashboard, { port }), {
    // Let Ink handle Ctrl+C — it calls exit() which cleanly unmounts
    exitOnCtrlC: true,
  });
}
