import type {
  AnthropicContent,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types.js";
import type { OpenAIInputContent, OpenAIInputMessage, OpenAIResponsesRequest } from "./openai-responses-types.js";
import { parseModelRef } from "./model-ref.js";

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return { value: args };
  }
}

function textFromOpenAI(block: OpenAIInputContent): string | null {
  if (block.type === "input_text" || block.type === "output_text") return block.text;
  return null;
}

function messageContentToAnthropic(message: OpenAIInputMessage): AnthropicContent {
  const blocks = message.content.map((block): AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | null => {
    const text = textFromOpenAI(block);
    if (text !== null) return { type: "text", text };

    if (block.type === "function_call") {
      return {
        type: "tool_use",
        id: block.call_id,
        name: block.name,
        input: parseArguments(block.arguments),
      };
    }

    if (block.type === "function_call_output") {
      return {
        type: "tool_result",
        tool_use_id: block.call_id,
        content: block.output,
      };
    }

    return null;
  }).filter((block): block is AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock => block !== null);

  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
  return blocks;
}

function normalizeRole(role: OpenAIInputMessage["role"]): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

export function openAIResponsesToAnthropic(req: OpenAIResponsesRequest): AnthropicMessagesRequest {
  const parsed = parseModelRef(req.model);
  return {
    model: parsed.upstreamModel,
    system: req.instructions,
    messages: req.input.map(message => ({
      role: normalizeRole(message.role),
      content: messageContentToAnthropic(message),
    })),
    tools: req.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    max_tokens: req.max_output_tokens,
    stream: req.stream,
  };
}
