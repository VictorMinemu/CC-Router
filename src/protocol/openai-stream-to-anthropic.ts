interface OpenAIStreamEvent {
  type?: string;
  delta?: string;
  response?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

type AnthropicStreamEvent = Record<string, unknown>;

export interface OpenAIStreamToAnthropicNormalizer {
  convert(event: OpenAIStreamEvent): AnthropicStreamEvent[];
  reset(): void;
}

export function createOpenAIStreamToAnthropicNormalizer(): OpenAIStreamToAnthropicNormalizer {
  let textBlockStarted = false;

  const ensureTextBlockStarted = (): AnthropicStreamEvent[] => {
    if (textBlockStarted) return [];
    textBlockStarted = true;
    return [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ];
  };

  const reset = () => {
    textBlockStarted = false;
  };

  return {
    reset,
    convert(event: OpenAIStreamEvent): AnthropicStreamEvent[] {
      if (event.type === "response.created") {
        reset();
        return [
          {
            type: "message_start",
            message: {
              id: event.response?.id ?? "",
              type: "message",
              role: "assistant",
              model: event.response?.model ?? "",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        ];
      }

      if (event.type === "response.output_text.delta") {
        return [
          ...ensureTextBlockStarted(),
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: event.delta ?? "" },
          },
        ];
      }

      if (event.type === "response.completed") {
        const usage = event.response?.usage ?? {};
        const prefix = textBlockStarted
          ? [{ type: "content_block_stop", index: 0 }]
          : [];
        reset();
        return [
          ...prefix,
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: usage.output_tokens ?? 0 },
          },
          { type: "message_stop" },
        ];
      }

      return [];
    },
  };
}

const defaultNormalizer = createOpenAIStreamToAnthropicNormalizer();

export function resetOpenAIStreamNormalizer(): void {
  defaultNormalizer.reset();
}

export function openAIStreamEventToAnthropicEvents(event: OpenAIStreamEvent): AnthropicStreamEvent[] {
  return defaultNormalizer.convert(event);
}
