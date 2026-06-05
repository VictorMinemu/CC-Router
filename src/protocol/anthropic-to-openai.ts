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
