import { describe, expect, it, vi } from "vitest";
import { createServer } from "http";
import express from "express";
import { mountMessagesCrossProviderRoute } from "../proxy/messages-cross-route.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";

describe("mountMessagesCrossProviderRoute", () => {
  it("translates Claude Code openai/* messages into Responses and returns Anthropic-shaped JSON", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async ({ body }) => {
        forwardedBodies.push(body);
        return new Response(JSON.stringify({
          id: "resp_1",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 2 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
      expect(forwardedBodies).toEqual([
        {
          model: "gpt-5.5",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          max_output_tokens: 128,
          stream: false,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("passes non-openai models to later Anthropic proxy middleware with replayable raw body", async () => {
    const app = express();
    const nextSpy = vi.fn();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => null,
      forwardOpenAI: async () => new Response("unused"),
    });
    app.use("/v1/messages", (req, res) => {
      nextSpy();
      res.json({
        rawBody: req._ccRawBody?.toString("utf8"),
      });
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const body = {
        model: "claude/sonnet",
        messages: [{ role: "user", content: "hi" }],
      };
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rawBody: JSON.stringify(body) });
      expect(nextSpy).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});
