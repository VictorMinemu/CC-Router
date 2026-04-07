import type { Command } from "commander";
import chalk from "chalk";
import { checkForUpdate, performUpdate, restartSelf, getCurrentVersion } from "../utils/self-update.js";

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Check for updates and install the latest version")
    .option("--check", "Only check, don't install")
    .action(async (opts: { check?: boolean }) => {
      console.log(chalk.gray(`Current version: v${getCurrentVersion()}\n`));

      const check = await checkForUpdate(true);

      if (!check.updateAvailable) {
        console.log(chalk.green("✓ Already on the latest version."));
        return;
      }

      console.log(
        chalk.cyan("New version available: ") +
        chalk.gray(`v${check.current}`) +
        chalk.cyan(" → ") +
        chalk.green.bold(`v${check.latest}`) +
        chalk.gray(` (${check.diff})`),
      );

      if (opts.check) return;

      if (check.diff === "major") {
        console.log(chalk.yellow("\n⚠ Major version update — may contain breaking changes."));
        console.log(chalk.yellow(`  Install manually: npm i -g ai-cc-router@${check.latest}`));
        return;
      }

      const ok = await performUpdate(check.latest);
      if (!ok) {
        console.log(chalk.red("\nUpdate failed. Try manually:"));
        console.log(chalk.cyan(`  npm i -g ai-cc-router@${check.latest}`));
        return;
      }

      console.log(chalk.green("\n✓ Update complete."));
      console.log(chalk.gray("  Restart the proxy to use the new version:"));
      console.log(chalk.cyan("  cc-router stop && cc-router start"));
    });
}
