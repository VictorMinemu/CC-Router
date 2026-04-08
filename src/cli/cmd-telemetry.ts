import type { Command } from "commander";
import chalk from "chalk";
import { loadTelemetryState, writeTelemetryState, isTelemetryEnabled } from "../config/telemetry.js";
import { trackEvent } from "../utils/telemetry.js";

export function registerTelemetry(program: Command): void {
  program
    .command("telemetry [action]")
    .description("Manage anonymous usage analytics: on, off, status (default: status)")
    .action(async (action?: string) => {
      const resolved = action ?? "status";

      if (resolved === "status") {
        showStatus();
        return;
      }

      if (resolved === "on") {
        const state = loadTelemetryState();
        state.enabled = true;
        writeTelemetryState(state);
        console.log(chalk.green("Telemetry enabled."));
        console.log(chalk.dim(`Install ID: ${state.installId}`));
        return;
      }

      if (resolved === "off") {
        // Send one last event so we know about opt-out rates
        await trackEvent("telemetry_disabled");
        const state = loadTelemetryState();
        state.enabled = false;
        writeTelemetryState(state);
        console.log(chalk.yellow("Telemetry disabled. No data will be sent."));
        console.log(chalk.dim("Re-enable anytime with: cc-router telemetry on"));
        return;
      }

      console.error(chalk.red(`Unknown action "${resolved}". Use: on, off, status`));
      process.exitCode = 1;
    });
}

function showStatus(): void {
  const state = loadTelemetryState();
  const envDisabled =
    process.env["DO_NOT_TRACK"] === "1" || process.env["CC_ROUTER_TELEMETRY"] === "0";

  console.log(chalk.bold("Telemetry"));
  console.log();

  if (envDisabled) {
    console.log(`  Status:     ${chalk.yellow("disabled")} (by environment variable)`);
  } else if (state.enabled) {
    console.log(`  Status:     ${chalk.green("enabled")}`);
  } else {
    console.log(`  Status:     ${chalk.yellow("disabled")}`);
  }

  console.log(`  Active:     ${isTelemetryEnabled() ? chalk.green("yes") : chalk.yellow("no")}`);
  console.log(`  Install ID: ${chalk.dim(state.installId)}`);
  console.log(`  Since:      ${chalk.dim(state.firstRunAt)}`);
  console.log();
  console.log(chalk.dim("  What we send:  version, OS, locale, lifecycle events (start, heartbeat)"));
  console.log(chalk.dim("  What we DON'T: IPs, tokens, prompts, request content, account names"));
  console.log(chalk.dim("  Source code:   src/utils/telemetry.ts"));
  console.log();
  console.log(chalk.dim("  Disable:  cc-router telemetry off"));
  console.log(chalk.dim("  Or set:   DO_NOT_TRACK=1  |  CC_ROUTER_TELEMETRY=0"));
}
