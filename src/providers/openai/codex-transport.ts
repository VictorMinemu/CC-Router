import type { OpenAIResponsesRequest } from "../../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";

const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export interface ForwardOpenAICodexResponseOptions {
  account: OpenAISubscriptionAccount;
  body: OpenAIResponsesRequest;
  stream: boolean;
}

export async function forwardOpenAICodexResponse(
  opts: ForwardOpenAICodexResponseOptions,
): Promise<Response> {
  return fetch(CODEX_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.account.accessToken}`,
      "content-type": "application/json",
      accept: opts.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(opts.body),
  });
}
