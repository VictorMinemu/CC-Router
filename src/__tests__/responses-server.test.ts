import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import { mountResponsesRoutes } from "../proxy/responses-server.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";

describe("forwardOpenAICodexResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards Responses requests to the ChatGPT Codex backend with account bearer token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "{\"id\":\"resp_1\"}",
    } as Response);

    const upstream = await forwardOpenAICodexResponse({
      account: {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      },
      body: { model: "gpt-5.5", input: [] },
      stream: false,
    });

    expect(upstream.status).toBe(200);
    expect(await upstream.text()).toBe("{\"id\":\"resp_1\"}");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer access",
          "content-type": "application/json",
        }),
      }),
    );
  });
});

describe("mountResponsesRoutes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts Codex Responses requests and strips the openai model prefix before forwarding", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const app = express();

    mountResponsesRoutes(app, {
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
        return new Response(JSON.stringify({ id: "resp_1" }), {
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
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "resp_1" });
      expect(forwardedBodies).toEqual([
        {
          model: "gpt-5.5",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          stream: false,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});
