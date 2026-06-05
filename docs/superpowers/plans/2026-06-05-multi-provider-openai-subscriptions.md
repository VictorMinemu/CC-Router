# Multi-Provider OpenAI Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-grade multi-provider router that lets Codex CLI and Claude Code use OpenAI ChatGPT/Codex subscription accounts and Claude subscription accounts through one local router.

**Architecture:** Split the existing Anthropic-only proxy into provider transports behind protocol-specific ingress handlers. Codex CLI enters through an OpenAI Responses-compatible `/v1/responses` surface; Claude Code keeps using Anthropic Messages-compatible `/v1/messages`. A tested translation layer converts Anthropic Messages <-> OpenAI Responses for cross-provider routing.

**Tech Stack:** TypeScript, Node.js 20+, Express, Vitest, native `fetch`, existing CC-Router config/account persistence, no production dependency additions for the translation core.

---

## Scope

This plan intentionally builds the first shippable slice:

- Codex CLI can point at CC-Router as a custom Responses provider.
- Claude Code can continue using CC-Router normally.
- Model IDs select routing with prefixes: `anthropic/*`, `claude/*`, `openai/*`.
- Translation supports text, system instructions, tool definitions, tool calls, tool results, stop reasons, errors, and SSE event normalization.
- OpenAI subscription auth is represented by interfaces and account records first; the concrete OAuth browser/device login is implemented after the protocol core is stable.

Out of scope for this first PR:

- image/video/audio translation
- computer-use translation
- prompt caching parity across providers
- exact usage-cost accounting across both vendors
- UI polish beyond showing provider/account labels

## Branch

Current branch:

```bash
feature/multi-provider-openai-subscriptions
```

Baseline recorded before planning:

```bash
npm test
# 6 test files passed, 108 tests passed
```

## File Structure

Create:

- `src/protocol/anthropic-types.ts` - local minimal Anthropic Messages request/response/SSE types used by translators.
- `src/protocol/openai-responses-types.ts` - local minimal OpenAI Responses request/response/SSE types used by translators.
- `src/protocol/model-ref.ts` - model prefix parsing and upstream model resolution.
- `src/protocol/anthropic-to-openai.ts` - converts Anthropic Messages requests to OpenAI Responses requests.
- `src/protocol/openai-to-anthropic.ts` - converts OpenAI Responses requests to Anthropic Messages requests.
- `src/protocol/sse.ts` - small SSE line parser/encoder helpers.
- `src/providers/types.ts` - common provider account, route, transport, and normalized stream event contracts.
- `src/providers/route-selector.ts` - selects provider route from request model and available account pools.
- `src/providers/openai/codex-transport.ts` - OpenAI ChatGPT/Codex subscription transport interface and request forwarding implementation.
- `src/providers/openai/token-refresher.ts` - refresh lock and token lifecycle for OpenAI subscription tokens.
- `src/proxy/responses-server.ts` - `/v1/responses` ingress for Codex-compatible clients.

Modify:

- `src/proxy/server.ts` - mount `/v1/responses`; delegate `/v1/messages` through provider route selector when model prefix requires OpenAI.
- `src/proxy/types.ts` - add provider discriminator to persisted accounts without breaking existing Anthropic accounts.
- `src/config/manager.ts` - deserialize legacy accounts as `anthropic_subscription`.
- `src/cli/cmd-configure.ts` - add Codex configuration writer entry point.
- `src/cli/index.ts` - expose `cc-router configure codex`.
- `README.md` - document Codex setup and model prefix routing.
- `docs/oauth-tokens.md` - add OpenAI subscription token storage/security notes.

Tests:

- `src/__tests__/model-ref.test.ts`
- `src/__tests__/anthropic-to-openai.test.ts`
- `src/__tests__/openai-to-anthropic.test.ts`
- `src/__tests__/sse.test.ts`
- `src/__tests__/route-selector.test.ts`
- `src/__tests__/openai-token-refresher.test.ts`
- `src/__tests__/responses-server.test.ts`
- update existing `src/__tests__/token-pool.test.ts`, `src/__tests__/manager.test.ts`, `src/__tests__/claude-config.test.ts`

---

### Task 1: Model Reference Parser

**Files:**
- Create: `src/protocol/model-ref.ts`
- Test: `src/__tests__/model-ref.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseModelRef } from "../protocol/model-ref.js";

describe("parseModelRef", () => {
  it("routes openai-prefixed models to OpenAI subscription transport", () => {
    expect(parseModelRef("openai/gpt-5.5")).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/gpt-5.5",
      upstreamModel: "gpt-5.5",
    });
  });

  it("routes claude-prefixed models to Anthropic subscription transport", () => {
    expect(parseModelRef("claude/sonnet")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude/sonnet",
      upstreamModel: "claude-sonnet-4-5",
    });
  });

  it("keeps unprefixed models on the current Anthropic default path", () => {
    expect(parseModelRef("claude-3-5-sonnet-latest")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude-3-5-sonnet-latest",
      upstreamModel: "claude-3-5-sonnet-latest",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/model-ref.test.ts
```

Expected: FAIL because `src/protocol/model-ref.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export type ProviderKind = "anthropic_subscription" | "openai_subscription" | "openai_api_key";

export interface ParsedModelRef {
  provider: ProviderKind;
  publicModel: string;
  upstreamModel: string;
}

const CLAUDE_ALIASES: Record<string, string> = {
  "claude/sonnet": "claude-sonnet-4-5",
  "claude/opus": "claude-opus-4-1",
};

export function parseModelRef(model: string | undefined): ParsedModelRef {
  const publicModel = model && model.trim() ? model.trim() : "claude/sonnet";

  if (publicModel.startsWith("openai/")) {
    return {
      provider: "openai_subscription",
      publicModel,
      upstreamModel: publicModel.slice("openai/".length),
    };
  }

  if (publicModel.startsWith("anthropic/")) {
    return {
      provider: "anthropic_subscription",
      publicModel,
      upstreamModel: publicModel.slice("anthropic/".length),
    };
  }

  return {
    provider: "anthropic_subscription",
    publicModel,
    upstreamModel: CLAUDE_ALIASES[publicModel] ?? publicModel,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/model-ref.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/model-ref.ts src/__tests__/model-ref.test.ts
git commit -m "feat: parse multi-provider model references"
```

---

### Task 2: Protocol Type Contracts

**Files:**
- Create: `src/protocol/anthropic-types.ts`
- Create: `src/protocol/openai-responses-types.ts`
- Test: `src/__tests__/anthropic-to-openai.test.ts`

- [ ] **Step 1: Write the failing translator shape test**

```ts
import { describe, expect, it } from "vitest";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";

describe("anthropicToOpenAIResponses", () => {
  it("maps a simple Anthropic message request to an OpenAI Responses request", () => {
    const result = anthropicToOpenAIResponses({
      model: "openai/gpt-5.5",
      max_tokens: 256,
      system: "You are concise.",
      messages: [
        { role: "user", content: "Write a test." },
      ],
      stream: true,
    });

    expect(result).toEqual({
      model: "gpt-5.5",
      instructions: "You are concise.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Write a test." }],
        },
      ],
      max_output_tokens: 256,
      stream: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/anthropic-to-openai.test.ts
```

Expected: FAIL because translator/types do not exist.

- [ ] **Step 3: Add minimal protocol types**

Add to `src/protocol/anthropic-types.ts`:

```ts
export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
}

export type AnthropicContent = string | Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock>;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: AnthropicContent;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
}
```

Add to `src/protocol/openai-responses-types.ts`:

```ts
export type OpenAIInputRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIInputText {
  type: "input_text";
  text: string;
}

export interface OpenAIOutputText {
  type: "output_text";
  text: string;
}

export interface OpenAIFunctionCall {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface OpenAIFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type OpenAIInputContent = OpenAIInputText | OpenAIOutputText | OpenAIFunctionCall | OpenAIFunctionCallOutput;

export interface OpenAIInputMessage {
  role: OpenAIInputRole;
  content: OpenAIInputContent[];
}

export interface OpenAITool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: OpenAIInputMessage[];
  tools?: OpenAITool[];
  max_output_tokens?: number;
  stream?: boolean;
}
```

- [ ] **Step 4: Add the minimal translator**

Add to `src/protocol/anthropic-to-openai.ts`:

```ts
import type { AnthropicContent, AnthropicMessagesRequest } from "./anthropic-types.js";
import type { OpenAIInputContent, OpenAIResponsesRequest } from "./openai-responses-types.js";
import { parseModelRef } from "./model-ref.js";

function stringifySystem(system: AnthropicMessagesRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map(block => block.text).join("\n");
}

function contentToOpenAI(content: AnthropicContent): OpenAIInputContent[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];

  return content.map(block => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    if (block.type === "tool_use") {
      return {
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      };
    }
    const output = typeof block.content === "string"
      ? block.content
      : block.content.map(item => item.text).join("\n");
    return {
      type: "function_call_output",
      call_id: block.tool_use_id,
      output,
    };
  });
}

export function anthropicToOpenAIResponses(req: AnthropicMessagesRequest): OpenAIResponsesRequest {
  const parsed = parseModelRef(req.model);
  return {
    model: parsed.upstreamModel,
    instructions: stringifySystem(req.system),
    input: req.messages.map(message => ({
      role: message.role,
      content: contentToOpenAI(message.content),
    })),
    tools: req.tools?.map(tool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    })),
    max_output_tokens: req.max_tokens,
    stream: req.stream,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/anthropic-to-openai.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/anthropic-types.ts src/protocol/openai-responses-types.ts src/protocol/anthropic-to-openai.ts src/__tests__/anthropic-to-openai.test.ts
git commit -m "feat: translate Anthropic messages to OpenAI responses"
```

---

### Task 3: Anthropic Tool Translation Coverage

**Files:**
- Modify: `src/__tests__/anthropic-to-openai.test.ts`
- Modify: `src/protocol/anthropic-to-openai.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("maps Anthropic tools, assistant tool_use, and user tool_result", () => {
  const result = anthropicToOpenAIResponses({
    model: "openai/gpt-5.5",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "CC-Router" },
        ],
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  });

  expect(result.tools).toEqual([
    {
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ]);
  expect(result.input[0].content).toEqual([
    { type: "input_text", text: "I will inspect it." },
    { type: "function_call", call_id: "toolu_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
  ]);
  expect(result.input[1].content).toEqual([
    { type: "function_call_output", call_id: "toolu_1", output: "CC-Router" },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails or exposes gaps**

Run:

```bash
npm test -- src/__tests__/anthropic-to-openai.test.ts
```

Expected: FAIL only if Task 2 minimal implementation missed tool details; otherwise PASS and proceed to commit this coverage.

- [ ] **Step 3: Implement only missing behavior**

If the failure is caused by different text block mapping, update `contentToOpenAI()` to keep assistant text as `output_text` only when Responses rejects `input_text` for assistant messages in integration tests. Unit behavior remains intentionally stable for the first slice.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/anthropic-to-openai.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/anthropic-to-openai.ts src/__tests__/anthropic-to-openai.test.ts
git commit -m "test: cover Anthropic tool conversion to Responses"
```

---

### Task 4: OpenAI Responses to Anthropic Messages Translator

**Files:**
- Create: `src/protocol/openai-to-anthropic.ts`
- Test: `src/__tests__/openai-to-anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { openAIResponsesToAnthropic } from "../protocol/openai-to-anthropic.js";

describe("openAIResponsesToAnthropic", () => {
  it("maps a Responses request to Anthropic Messages", () => {
    const result = openAIResponsesToAnthropic({
      model: "claude/sonnet",
      instructions: "Be direct.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize this." }],
        },
      ],
      max_output_tokens: 512,
      stream: true,
    });

    expect(result).toEqual({
      model: "claude-sonnet-4-5",
      system: "Be direct.",
      messages: [
        { role: "user", content: "Summarize this." },
      ],
      max_tokens: 512,
      stream: true,
    });
  });

  it("maps function calls and outputs to Anthropic tool blocks", () => {
    const result = openAIResponsesToAnthropic({
      model: "anthropic/claude-opus-4-1",
      input: [
        {
          role: "assistant",
          content: [
            { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "function_call_output", call_id: "call_1", output: "CC-Router" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "CC-Router" }],
      },
    ]);
    expect(result.tools).toEqual([
      {
        name: "read_file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/openai-to-anthropic.test.ts
```

Expected: FAIL because `openai-to-anthropic.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement `openAIResponsesToAnthropic()` with:

- model resolution via `parseModelRef()`
- `instructions` -> `system`
- text input blocks -> string content when a message has only one text block
- `function_call` -> `tool_use`
- `function_call_output` -> user `tool_result`
- `tools[].parameters` -> `tools[].input_schema`

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/openai-to-anthropic.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/openai-to-anthropic.ts src/__tests__/openai-to-anthropic.test.ts
git commit -m "feat: translate OpenAI responses to Anthropic messages"
```

---

### Task 5: SSE Parser and Event Encoder

**Files:**
- Create: `src/protocol/sse.ts`
- Test: `src/__tests__/sse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";

describe("SSE helpers", () => {
  it("parses complete data events and keeps partial line remainder", () => {
    const parsed = parseSseLines("data: {\"type\":\"one\"}\n\ndata: {\"type\"");

    expect(parsed.events).toEqual([{ type: "one" }]);
    expect(parsed.remainder).toBe("data: {\"type\"");
  });

  it("encodes JSON events in SSE data format", () => {
    expect(encodeSseEvent({ type: "response.completed" })).toBe(
      "data: {\"type\":\"response.completed\"}\n\n",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/sse.test.ts
```

Expected: FAIL because `src/protocol/sse.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface ParsedSse {
  events: unknown[];
  remainder: string;
}

export function parseSseLines(input: string): ParsedSse {
  const lines = input.split("\n");
  const remainder = lines.pop() ?? "";
  const events: unknown[] = [];

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    events.push(JSON.parse(payload));
  }

  return { events, remainder };
}

export function encodeSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/sse.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/sse.ts src/__tests__/sse.test.ts
git commit -m "feat: add SSE protocol helpers"
```

---

### Task 6: Normalized Provider Contracts

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/route-selector.ts`
- Test: `src/__tests__/route-selector.test.ts`

- [ ] **Step 1: Write the failing route selector test**

```ts
import { describe, expect, it } from "vitest";
import { selectRoute } from "../providers/route-selector.js";

describe("selectRoute", () => {
  it("selects OpenAI subscription route for openai model refs", () => {
    const route = selectRoute("openai/gpt-5.5");
    expect(route).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/gpt-5.5",
      upstreamModel: "gpt-5.5",
      ingressProtocol: "responses",
    });
  });

  it("selects Anthropic subscription route for claude model refs", () => {
    const route = selectRoute("claude/sonnet");
    expect(route.provider).toBe("anthropic_subscription");
    expect(route.upstreamModel).toBe("claude-sonnet-4-5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/route-selector.test.ts
```

Expected: FAIL because provider files do not exist.

- [ ] **Step 3: Add provider contracts**

Add to `src/providers/types.ts`:

```ts
import type { ProviderKind } from "../protocol/model-ref.js";

export type IngressProtocol = "anthropic_messages" | "responses";

export interface ProviderRoute {
  provider: ProviderKind;
  publicModel: string;
  upstreamModel: string;
  ingressProtocol: IngressProtocol;
}

export interface ProviderAccount {
  id: string;
  provider: ProviderKind;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: number;
  enabled: boolean;
}
```

Add to `src/providers/route-selector.ts`:

```ts
import { parseModelRef } from "../protocol/model-ref.js";
import type { ProviderRoute } from "./types.js";

export function selectRoute(model: string | undefined): ProviderRoute {
  const parsed = parseModelRef(model);
  return {
    ...parsed,
    ingressProtocol: parsed.provider === "openai_subscription" ? "responses" : "anthropic_messages",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/route-selector.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/providers/route-selector.ts src/__tests__/route-selector.test.ts
git commit -m "feat: add provider route selection contracts"
```

---

### Task 7: OpenAI Subscription Token Refresher

**Files:**
- Create: `src/providers/openai/token-refresher.ts`
- Test: `src/__tests__/openai-token-refresher.test.ts`

- [ ] **Step 1: Write the failing refresh test**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { needsOpenAIRefresh, refreshOpenAISubscriptionToken } from "../providers/openai/token-refresher.js";

describe("OpenAI subscription token refresher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes expiring OpenAI subscription tokens and stores rotated refresh token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };

    expect(needsOpenAIRefresh(account)).toBe(true);
    const ok = await refreshOpenAISubscriptionToken(account);

    expect(ok).toBe(true);
    expect(account.accessToken).toBe("new-access");
    expect(account.refreshToken).toBe("new-refresh");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/openai-token-refresher.test.ts
```

Expected: FAIL because refresher does not exist.

- [ ] **Step 3: Implement minimal refresh with per-account lock**

Implementation requirements:

- `needsOpenAIRefresh(account)` returns true when `expiresAt - Date.now() < 10 minutes`.
- `refreshOpenAISubscriptionToken(account)` posts form-encoded `grant_type=refresh_token`.
- Endpoint is `https://auth.openai.com/oauth/token`.
- The function mutates only the provided account after a successful response.
- Concurrent refreshes for the same `account.id` share one in-flight promise.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/openai-token-refresher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai/token-refresher.ts src/__tests__/openai-token-refresher.test.ts
git commit -m "feat: refresh OpenAI subscription tokens"
```

---

### Task 8: OpenAI Codex Subscription Transport

**Files:**
- Create: `src/providers/openai/codex-transport.ts`
- Test: `src/__tests__/responses-server.test.ts`

- [ ] **Step 1: Write the failing transport test**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/responses-server.test.ts
```

Expected: FAIL because transport does not exist.

- [ ] **Step 3: Implement minimal transport**

Implementation requirements:

- `forwardOpenAICodexResponse({ account, body, stream })` uses `fetch`.
- It posts JSON to `https://chatgpt.com/backend-api/codex/responses`.
- It sets `Authorization: Bearer ${account.accessToken}`.
- It returns the upstream `Response` without buffering.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/responses-server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai/codex-transport.ts src/__tests__/responses-server.test.ts
git commit -m "feat: add OpenAI Codex subscription transport"
```

---

### Task 9: Responses Ingress for Codex CLI

**Files:**
- Create: `src/proxy/responses-server.ts`
- Modify: `src/proxy/server.ts`
- Test: `src/__tests__/responses-server.test.ts`

- [ ] **Step 1: Write the failing ingress behavior test**

Add a test that starts a test Express app with the Responses handler and posts:

```json
{
  "model": "openai/gpt-5.5",
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }
  ],
  "stream": false
}
```

Expected request sent upstream:

```json
{
  "model": "gpt-5.5",
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }
  ],
  "stream": false
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/responses-server.test.ts
```

Expected: FAIL because `mountResponsesRoutes()` does not exist.

- [ ] **Step 3: Implement minimal route mounting**

Implementation requirements:

- Mount `app.post("/v1/responses", express.json({ limit: "10mb" }), handler)`.
- Validate body is an object and model is a string.
- Select route with `selectRoute(body.model)`.
- For `openai_subscription`, strip `openai/` prefix before forwarding.
- Return upstream status, content-type, and body.
- Keep proxy auth middleware in `server.ts` before this route.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/responses-server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/responses-server.ts src/proxy/server.ts src/__tests__/responses-server.test.ts
git commit -m "feat: expose Responses ingress for Codex"
```

---

### Task 10: Claude Code Cross-Routing to OpenAI Models

**Files:**
- Modify: `src/proxy/server.ts`
- Test: `src/__tests__/anthropic-to-openai.test.ts`

- [ ] **Step 1: Write the failing behavior test**

Add a server-level test or handler-level test proving:

- request enters as `POST /v1/messages`
- body has `model: "openai/gpt-5.5"`
- router converts the body using `anthropicToOpenAIResponses()`
- upstream OpenAI Codex transport receives `model: "gpt-5.5"`

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/anthropic-to-openai.test.ts src/__tests__/responses-server.test.ts
```

Expected: FAIL because `/v1/messages` still always proxies to Anthropic.

- [ ] **Step 3: Implement the OpenAI branch in `/v1/messages`**

Implementation requirements:

- Before current Anthropic proxy middleware, inspect JSON only for requests whose body starts as JSON and can be safely buffered.
- If `model` resolves to `openai_subscription`, translate to Responses and call OpenAI transport.
- If `model` resolves to Anthropic, preserve current streaming proxy path exactly.
- On malformed JSON, return Anthropic-compatible 400 error.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/server.ts src/__tests__/anthropic-to-openai.test.ts src/__tests__/responses-server.test.ts
git commit -m "feat: route Claude Code OpenAI models through Responses"
```

---

### Task 11: Codex Configuration Writer

**Files:**
- Create: `src/utils/codex-config.ts`
- Test: `src/__tests__/codex-config.test.ts`
- Modify: `src/cli/cmd-configure.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write the failing config writer test**

```ts
import { describe, expect, it, vi } from "vitest";
import { writeCodexRouterConfig } from "../utils/codex-config.js";

describe("writeCodexRouterConfig", () => {
  it("writes a user-level Codex provider profile for CC-Router", () => {
    const writeFileSync = vi.fn();
    const mkdirSync = vi.fn();

    const output = writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      fs: { writeFileSync, mkdirSync },
    });

    expect(output.path).toBe("/tmp/home/.codex/config.toml");
    expect(writeFileSync.mock.calls[0][1]).toContain("[model_providers.cc-router]");
    expect(writeFileSync.mock.calls[0][1]).toContain("base_url = \"http://localhost:3456/v1\"");
    expect(writeFileSync.mock.calls[0][1]).toContain("wire_api = \"responses\"");
    expect(writeFileSync.mock.calls[0][1]).toContain("env_key = \"CC_ROUTER_TOKEN\"");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/codex-config.test.ts
```

Expected: FAIL because `codex-config.ts` does not exist.

- [ ] **Step 3: Implement config writer**

Implementation requirements:

- Create `~/.codex` if missing.
- Write or merge a minimal config block.
- Do not overwrite unrelated existing config without tests.
- First implementation may append a managed block delimited by `# cc-router:start` and `# cc-router:end`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/__tests__/codex-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire CLI command**

Add:

```bash
cc-router configure codex
```

Expected output includes:

```txt
CODEX provider configured:
  model_provider = cc-router
  base_url       = http://localhost:3456/v1
```

- [ ] **Step 6: Run all tests**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/utils/codex-config.ts src/__tests__/codex-config.test.ts src/cli/cmd-configure.ts src/cli/index.ts
git commit -m "feat: configure Codex to use CC-Router"
```

---

### Task 12: Documentation and Security Notes

**Files:**
- Modify: `README.md`
- Modify: `docs/oauth-tokens.md`
- Modify: `docs/security.md`

- [ ] **Step 1: Write documentation before release**

Add README sections:

````md
## Codex CLI support

CC-Router can expose an OpenAI Responses-compatible endpoint for Codex CLI.

```toml
model_provider = "cc-router"
model = "openai/gpt-5.5"

[model_providers.cc-router]
name = "CC-Router"
base_url = "http://localhost:3456/v1"
wire_api = "responses"
env_key = "CC_ROUTER_TOKEN"
```

Model prefixes:

| Prefix | Upstream |
|--------|----------|
| `openai/*` | ChatGPT/Codex subscription account |
| `claude/*` | Claude subscription account |
| `anthropic/*` | Claude subscription account |
```
````

Add security notes:

- OpenAI Codex refresh tokens are account credentials.
- Store tokens in the router account store only.
- Do not copy `~/.codex/auth.json` as the primary multi-account mechanism.
- Prefer OS keychain support in a follow-up PR.

- [ ] **Step 2: Run docs-adjacent checks**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/oauth-tokens.md docs/security.md
git commit -m "docs: document Codex and OpenAI subscription routing"
```

---

## Final Verification

- [ ] Run unit test suite:

```bash
npm test
```

- [ ] Run TypeScript build:

```bash
npm run build
```

- [ ] Manual Codex smoke test after implementation:

```bash
cc-router start
cc-router configure codex
CC_ROUTER_TOKEN=proxy-managed codex -m openai/gpt-5.5 "Reply with one sentence."
```

- [ ] Manual Claude Code smoke test after implementation:

```bash
cc-router start
claude
# Ask Claude Code to use model openai/gpt-5.5 through project/user settings once model selection support is documented.
```

- [ ] Inspect final diff:

```bash
git status --short
git diff --stat main...HEAD
```

## Open Questions Before OAuth Login Implementation

1. Whether the first OAuth PR should use OpenAI's Codex app-server as the login host or implement PKCE/device-code directly in CC-Router.
2. Whether to store OpenAI subscription tokens in `accounts.json` first for parity with Anthropic, or introduce keychain storage before public release.
3. Whether the public npm package should label subscription-routing as experimental until OpenAI backend compatibility is verified across Plus, Pro, Business, Edu, and Enterprise plans.

## Self-Review

Spec coverage:

- OpenAI subscriptions: represented by provider kind, account contracts, token refresher, and Codex backend transport.
- Codex CLI: covered by `/v1/responses` ingress and `configure codex`.
- Claude Code: covered by `/v1/messages` cross-routing to OpenAI models.
- Mixed models: covered by model prefix parser and route selector.
- Translation system: covered by bidirectional translators and SSE helpers.
- TDD: every implementation task starts with a failing test and explicit test command.

Known deliberate gaps:

- Full OAuth login UX is planned after protocol routing because token handling must be validated against the official Codex surfaces.
- Advanced multimodal features are excluded from the first PR to keep the open-source review surface defensible.
