import type { Command } from "commander";
import chalk from "chalk";
import { readConfig, writeConfig } from "../config/manager.js";
import { PROXY_PORT } from "../config/paths.js";
import { buildModelRoutingUpdate } from "../protocol/model-routing-config.js";
import { resolveStatusTarget } from "./cmd-status.js";

interface ModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
}

interface RouterModelsResponse {
  routing?: {
    anthropicDefaultModel?: string;
    openAIDefaultModel?: string;
    anthropicAliases?: Record<string, string>;
    openAIAliases?: Record<string, string>;
  };
  models?: ModelEntry[];
}

export interface ModelSetOptions {
  claudeModel?: string;
  openAIModel?: string;
}

export function groupModelsByProvider(models: ModelEntry[]): {
  anthropic: string[];
  openai: string[];
  aliases: string[];
} {
  const anthropic = new Set<string>();
  const openai = new Set<string>();
  const aliases = new Set<string>();

  for (const model of models) {
    if (model.id.startsWith("anthropic/")) anthropic.add(model.id);
    else if (model.id.startsWith("openai/")) openai.add(model.id);
    else aliases.add(model.id);
  }

  return {
    anthropic: [...anthropic].sort(),
    openai: [...openai].sort(),
    aliases: [...aliases].sort(),
  };
}

export function buildModelSetPayload(opts: ModelSetOptions): ModelSetOptions {
  return {
    claudeModel: opts.claudeModel?.replace(/^anthropic\//, ""),
    openAIModel: opts.openAIModel?.replace(/^openai\//, ""),
  };
}

export function registerModels(program: Command): void {
  const models = program
    .command("models")
    .description("List discovered provider models and update router model defaults");

  models
    .command("list")
    .description("List models discovered from provider APIs through the running proxy")
    .option("--port <port>", "Proxy port to connect to", String(PROXY_PORT))
    .option("--json", "Output raw model status JSON")
    .action(async (opts: { port: string; json?: boolean }) => {
      const status = await fetchRouterModels(parseInt(opts.port, 10));
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      printModels(status);
    });

  models
    .command("set")
    .description("Update Claude/OpenAI default models used by router aliases")
    .option("--port <port>", "Proxy port to connect to", String(PROXY_PORT))
    .option("--claude-model <model>", "Claude/Anthropic model id, with or without anthropic/ prefix")
    .option("--openai-model <model>", "OpenAI/Codex model id, with or without openai/ prefix")
    .action(async (opts: { port: string; claudeModel?: string; openaiModel?: string }) => {
      if (!opts.claudeModel && !opts.openaiModel) {
        console.error(chalk.red("Provide at least one model: --claude-model or --openai-model"));
        process.exit(1);
      }

      const payload = buildModelSetPayload({
        claudeModel: opts.claudeModel,
        openAIModel: opts.openaiModel,
      });

      try {
        const updated = await patchRouterModels(parseInt(opts.port, 10), payload);
        console.log(chalk.green("✓ Updated running router model defaults."));
        printRouting(updated.routing ?? {});
      } catch (err) {
        const cfg = readConfig();
        const modelRouting = buildModelRoutingUpdate(cfg.modelRouting, payload);
        writeConfig({ ...cfg, modelRouting });
        console.log(chalk.yellow("⚠ Could not update the running router; saved config for next start."));
        console.log(chalk.gray(`  ${(err as Error).message}`));
        printRouting(modelRouting);
      }
    });
}

async function fetchRouterModels(port: number): Promise<RouterModelsResponse> {
  const target = resolveStatusTarget(port);
  const res = await fetch(`${target.baseUrl}/cc-router/models`, {
    headers: target.headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status}`);
  return await res.json() as RouterModelsResponse;
}

async function patchRouterModels(port: number, payload: ModelSetOptions): Promise<RouterModelsResponse> {
  const target = resolveStatusTarget(port);
  const res = await fetch(`${target.baseUrl}/cc-router/models`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...target.headers,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status}`);
  return await res.json() as RouterModelsResponse;
}

function printModels(status: RouterModelsResponse): void {
  const groups = groupModelsByProvider(status.models ?? []);
  console.log(chalk.bold("\n  Models\n"));
  printRouting(status.routing ?? {});
  printGroup("Claude / Anthropic", groups.anthropic);
  printGroup("OpenAI / Codex", groups.openai);
  printGroup("Aliases", groups.aliases);
  console.log(chalk.gray("\n  Change defaults with:"));
  console.log(chalk.cyan("  cc-router models set --claude-model anthropic/<id> --openai-model openai/<id>\n"));
}

function printGroup(label: string, ids: string[]): void {
  console.log(chalk.bold(`\n  ${label}`));
  if (ids.length === 0) {
    console.log(chalk.gray("    (none discovered)"));
    return;
  }
  for (const id of ids) console.log(`    ${id}`);
}

function printRouting(routing: NonNullable<RouterModelsResponse["routing"]>): void {
  console.log(chalk.gray("  Current routing:"));
  console.log(`    Claude default: ${chalk.cyan(routing.anthropicDefaultModel ?? "(not set)")}`);
  console.log(`    OpenAI default: ${chalk.cyan(routing.openAIDefaultModel ?? "(not set)")}`);
}
