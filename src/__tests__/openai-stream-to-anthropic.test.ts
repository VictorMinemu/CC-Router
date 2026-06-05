import { describe, expect, it } from "vitest";
import { openAIStreamEventToAnthropicEvents } from "../protocol/openai-stream-to-anthropic.js";

describe("openAIStreamEventToAnthropicEvents", () => {
  it("converts common Responses stream events to Anthropic message stream events", () => {
    const events = [
      ...openAIStreamEventToAnthropicEvents({
        type: "response.created",
        response: { id: "resp_1", model: "gpt-5.5" },
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.output_text.delta",
        delta: "Hel",
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.output_text.delta",
        delta: "lo",
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-5.5",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ];

    expect(events).toEqual([
      {
        type: "message_start",
        message: {
          id: "resp_1",
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      {
        type: "message_stop",
      },
    ]);
  });
});
