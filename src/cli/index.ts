#!/usr/bin/env node
import { Command } from "commander";
import { registerSetup } from "./cmd-setup.js";
import { registerStart } from "./cmd-start.js";
import { registerStop, registerRevert } from "./cmd-stop.js";
import { registerStatus } from "./cmd-status.js";
import { registerAccounts } from "./cmd-accounts.js";
import { registerService } from "./cmd-service.js";
import { registerConfigure } from "./cmd-configure.js";
import { registerDocker } from "./cmd-docker.js";
import { registerUpdate } from "./cmd-update.js";
import { registerClient } from "./cmd-client.js";
import { getCurrentVersion, checkForUpdate, printUpdateBanner } from "../utils/self-update.js";

const program = new Command();

program
  .name("cc-router")
  .description(
    "Round-robin proxy for Claude Max OAuth tokens.\n" +
    "Distributes Claude Code requests across multiple Claude Max accounts."
  )
  .version(getCurrentVersion())
  .addHelpText("after", `
Examples:
  $ cc-router setup              # First-time wizard: extract tokens + configure Claude Code
  $ cc-router start              # Start proxy on localhost:3456
  $ cc-router start --daemon     # Start in background via PM2
  $ cc-router status             # Live dashboard with account stats
  $ cc-router service install    # Auto-start on system boot
  $ cc-router accounts list      # Show all configured accounts
  $ cc-router revert             # Restore Claude Code to normal (remove proxy config)
  $ cc-router docker up          # Full stack: cc-router + LiteLLM in Docker
  $ cc-router docker down        # Stop Docker stack
  $ cc-router client connect <url>   # Route Claude Code through a remote CC-Router
  $ cc-router client start-desktop   # Route Claude Desktop via mitmproxy interceptor
`);

registerSetup(program);
registerStart(program);
registerStop(program);
registerRevert(program);
registerStatus(program);
registerAccounts(program);
registerService(program);
registerConfigure(program);
registerDocker(program);
registerUpdate(program);
registerClient(program);

// Background update check — fires on every CLI invocation, uses 6h disk cache
// so it's essentially free after the first check. Notify on process exit.
if (!process.env["NO_UPDATE_NOTIFIER"] && !process.env["CI"]) {
  checkForUpdate().then((check) => {
    if (check.updateAvailable) {
      process.on("exit", () => printUpdateBanner(check));
    }
  }).catch(() => { /* silent */ });
}

program.parse();
