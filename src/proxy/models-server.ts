import express, { type Express, type Request, type Response } from "express";
import {
  fetchAnthropicModels,
  fetchOpenAICodexModels,
} from "../providers/model-discovery.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import { buildModelRoutingUpdate } from "../protocol/model-routing-config.js";
import type { Account } from "./types.js";

type FetchAnthropicModels = typeof fetchAnthropicModels;
type FetchOpenAIModels = typeof fetchOpenAICodexModels;

interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: "anthropic_subscription" | "openai_subscription";
}

export interface ModelsRouteOptions {
  getAnthropicAccounts: () => Account[];
  getOpenAIAccounts: () => OpenAISubscriptionAccount[];
  getModelRouting?: () => ModelRoutingConfig;
  setModelRouting?: (next: ModelRoutingConfig) => Promise<void>;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  fetchAnthropicModels?: FetchAnthropicModels;
  fetchOpenAIModels?: FetchOpenAIModels;
  modelRouting?: ModelRoutingConfig;
}

export function mountModelsRoute(app: Express, opts: ModelsRouteOptions): void {
  const fetchAnthropic = opts.fetchAnthropicModels ?? fetchAnthropicModels;
  const fetchOpenAI = opts.fetchOpenAIModels ?? fetchOpenAICodexModels;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);

  app.get("/v1/models", async (_req: Request, res: Response) => {
    const models = await discoverModelList(opts, prepareOpenAIAccount, fetchAnthropic, fetchOpenAI);

    const body: OpenAIModelList = {
      object: "list",
      data: models,
    };
    res.json(body);
  });

  app.get("/cc-router/models", async (_req: Request, res: Response) => {
    res.json({
      routing: currentModelRouting(opts),
      models: await discoverModelList(opts, prepareOpenAIAccount, fetchAnthropic, fetchOpenAI),
    });
  });

  app.patch("/cc-router/models", express.json({ limit: "16kb" }), async (req: Request, res: Response) => {
    if (!opts.setModelRouting) {
      res.status(501).json({ error: "Model routing updates are not available" });
      return;
    }

    const body = (req.body ?? {}) as { claudeModel?: unknown; openAIModel?: unknown };
    if (body.claudeModel !== undefined && typeof body.claudeModel !== "string") {
      res.status(400).json({ error: "claudeModel must be a string" });
      return;
    }
    if (body.openAIModel !== undefined && typeof body.openAIModel !== "string") {
      res.status(400).json({ error: "openAIModel must be a string" });
      return;
    }

    const next = buildModelRoutingUpdate(currentModelRouting(opts), {
      claudeModel: body.claudeModel,
      openAIModel: body.openAIModel,
    });
    await opts.setModelRouting(next);
    res.json({ routing: next });
  });
}

async function discoverModelList(
  opts: ModelsRouteOptions,
  prepareOpenAIAccount: (account: OpenAISubscriptionAccount) => Promise<boolean>,
  fetchAnthropic: FetchAnthropicModels,
  fetchOpenAI: FetchOpenAIModels,
): Promise<OpenAIModel[]> {
  const discovered = await Promise.all([
    discoverAnthropicModels(opts.getAnthropicAccounts(), fetchAnthropic),
    discoverOpenAIModels(opts.getOpenAIAccounts(), prepareOpenAIAccount, fetchOpenAI),
  ]);

  const models = new Map<string, OpenAIModel>();
  for (const model of discovered.flat()) {
    models.set(model.id, model);
  }
  addConfiguredAliases(models, currentModelRouting(opts));

  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function currentModelRouting(opts: ModelsRouteOptions): ModelRoutingConfig {
  return opts.getModelRouting?.() ?? opts.modelRouting ?? {};
}

async function discoverAnthropicModels(
  accounts: Account[],
  fetchAnthropic: FetchAnthropicModels,
): Promise<OpenAIModel[]> {
  const enabledAccounts = accounts.filter(account => account.enabled !== false);
  const results = await Promise.allSettled(enabledAccounts.map(account => fetchAnthropic(account)));
  return results.flatMap(result => {
    if (result.status !== "fulfilled") return [];
    return result.value.map(id => modelEntry(`anthropic/${id}`, "anthropic_subscription"));
  });
}

async function discoverOpenAIModels(
  accounts: OpenAISubscriptionAccount[],
  prepareOpenAIAccount: (account: OpenAISubscriptionAccount) => Promise<boolean>,
  fetchOpenAI: FetchOpenAIModels,
): Promise<OpenAIModel[]> {
  const enabledAccounts = accounts.filter(account => account.enabled !== false);
  const results = await Promise.allSettled(enabledAccounts.map(async account => {
    const ready = await prepareOpenAIAccount(account);
    if (!ready) return [];
    return fetchOpenAI(account);
  }));

  return results.flatMap(result => {
    if (result.status !== "fulfilled") return [];
    return result.value.map(id => modelEntry(`openai/${id}`, "openai_subscription"));
  });
}

function addConfiguredAliases(models: Map<string, OpenAIModel>, config: ModelRoutingConfig | undefined): void {
  for (const [alias, upstream] of Object.entries(config?.openAIAliases ?? {})) {
    if (models.has(`openai/${upstream}`)) {
      models.set(`openai/${alias}`, modelEntry(`openai/${alias}`, "openai_subscription"));
    }
  }

  for (const [alias, upstream] of Object.entries(config?.anthropicAliases ?? {})) {
    if (models.has(`anthropic/${upstream}`)) {
      models.set(alias, modelEntry(alias, "anthropic_subscription"));
    }
  }

  if (config?.anthropicDefaultModel && models.has(`anthropic/${config.anthropicDefaultModel}`)) {
    models.set("claude/default", modelEntry("claude/default", "anthropic_subscription"));
  }
  if (config?.openAIDefaultModel && models.has(`openai/${config.openAIDefaultModel}`)) {
    models.set("openai/default", modelEntry("openai/default", "openai_subscription"));
  }
}

function modelEntry(
  id: string,
  ownedBy: OpenAIModel["owned_by"],
): OpenAIModel {
  return { id, object: "model", owned_by: ownedBy };
}
