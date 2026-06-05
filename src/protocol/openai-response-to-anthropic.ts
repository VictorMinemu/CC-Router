import type { OpenAIResponseCompleted } from "./openai-responses-types.js";

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<{ type: "text"; text: string }>;
  stop_reason: "end_turn";
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function openAIResponseToAnthropicMessage(response: OpenAIResponseCompleted): AnthropicMessageResponse {
  const content = (response.output ?? [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content)
    .filter(item => item.type === "output_text")
    .map(item => ({ type: "text" as const, text: item.text }));

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model ?? "",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}
