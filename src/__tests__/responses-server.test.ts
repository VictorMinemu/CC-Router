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

  it("refreshes the selected OpenAI account before forwarding", async () => {
    const prepare = vi.fn().mockResolvedValue(true);
    const forward = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const app = express();

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      prepareOpenAIAccount: prepare,
      forwardOpenAI: forward,
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(200);
      expect(prepare).toHaveBeenCalledOnce();
      expect(forward).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("streams upstream Responses SSE chunks without waiting for the full body", async () => {
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
      forwardOpenAI: async () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("data: {\"type\":\"response.created\"}\n\n"));
            setTimeout(() => {
              controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\"}\n\n"));
              controller.close();
            }, 100);
          },
        }) as BodyInit,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await Promise.race([
        fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("response headers were buffered")), 50)),
      ]);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body?.getReader();
      if (!reader) throw new Error("response body is missing");

      const firstChunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first chunk was buffered")), 50)),
      ]);
      expect(new TextDecoder().decode(firstChunk.value)).toContain("response.created");
      await reader.cancel();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});
