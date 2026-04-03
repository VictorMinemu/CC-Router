import type { Command } from "commander";
import { PROXY_PORT, ACCOUNTS_PATH } from "../config/paths.js";

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start the proxy server")
    .option("--port <port>", "Port to listen on", String(PROXY_PORT))
    .option("--daemon", "Run in background via PM2")
    .option("--litellm [url]", "Forward to LiteLLM (default: http://localhost:4000)")
    .option("--accounts <path>", "Path to accounts.json", ACCOUNTS_PATH)
    .action(async (opts: { port: string; daemon?: boolean; litellm?: string | boolean; accounts: string }) => {
      if (opts.daemon) {
        // Phase 5 — PM2 background launch
        console.log("--daemon flag coming in Phase 5 (service install)");
        process.exit(0);
      }

      const { startServer } = await import("../proxy/server.js");

      await startServer({
        port: parseInt(opts.port, 10),
        litellmUrl: opts.litellm
          ? (typeof opts.litellm === "string" ? opts.litellm : "http://localhost:4000")
          : undefined,
        accountsPath: opts.accounts !== ACCOUNTS_PATH ? opts.accounts : undefined,
      });
    });
}
