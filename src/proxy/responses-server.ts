import express from "express";
import type { Express, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface ResponsesRoutesOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  forwardOpenAI?: ForwardOpenAI;
}

function isResponsesRequest(value: unknown): value is OpenAIResponsesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model?: unknown }).model === "string" &&
    Array.isArray((value as { input?: unknown }).input)
  );
}

async function sendUpstreamResponse(upstream: globalThis.Response, res: Response): Promise<void> {
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("content-type", contentType);

  res.status(upstream.status);
  if (!upstream.body) {
    res.end();
    return;
  }

  const text = await upstream.text();
  res.send(text);
}

export function mountResponsesRoutes(app: Express, opts: ResponsesRoutesOptions): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;

  app.post("/v1/responses", express.json({ limit: "10mb" }), async (req: Request, res: Response) => {
    if (!isResponsesRequest(req.body)) {
      res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "Expected Responses request with string model and input array",
        },
      });
      return;
    }

    const route = selectRoute(req.body.model);
    if (route.provider !== "openai_subscription") {
      res.status(501).json({
        error: {
          type: "unsupported_provider",
          message: `Responses ingress for ${route.provider} is not implemented yet`,
        },
      });
      return;
    }

    const account = opts.getOpenAIAccount();
    if (!account) {
      res.status(503).json({
        error: {
          type: "no_accounts",
          message: "No OpenAI subscription accounts are configured",
        },
      });
      return;
    }

    const body: OpenAIResponsesRequest = {
      ...req.body,
      model: route.upstreamModel,
    };
    const upstream = await forwardOpenAI({
      account,
      body,
      stream: body.stream === true,
    });
    await sendUpstreamResponse(upstream, res);
  });
}
