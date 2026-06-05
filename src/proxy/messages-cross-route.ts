import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIResponseCompleted } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
  }
}

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface MessagesCrossProviderRouteOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  forwardOpenAI?: ForwardOpenAI;
}

function isAnthropicMessagesRequest(value: unknown): value is AnthropicMessagesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

async function sendOpenAIAsAnthropic(upstream: globalThis.Response, res: Response): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return;
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  res.status(upstream.status).json(openAIResponseToAnthropicMessage(json));
}

export function mountMessagesCrossProviderRoute(
  app: Express,
  opts: MessagesCrossProviderRouteOptions,
): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;

  app.post(
    "/v1/messages",
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as Request)._ccRawBody = Buffer.from(buf);
      },
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      if (!isAnthropicMessagesRequest(req.body)) {
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Expected Anthropic Messages request with messages array",
          },
        });
        return;
      }

      const route = selectRoute(req.body.model);
      if (route.provider !== "openai_subscription") {
        next();
        return;
      }

      const account = opts.getOpenAIAccount();
      if (!account) {
        res.status(503).json({
          type: "error",
          error: {
            type: "no_accounts",
            message: "No OpenAI subscription accounts are configured",
          },
        });
        return;
      }

      const body = anthropicToOpenAIResponses(req.body);
      const upstream = await forwardOpenAI({
        account,
        body,
        stream: body.stream === true,
      });
      await sendOpenAIAsAnthropic(upstream, res);
    },
  );
}
