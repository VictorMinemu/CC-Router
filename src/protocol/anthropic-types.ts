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

export type AnthropicContent =
  | string
  | Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock>;

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
