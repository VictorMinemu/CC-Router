import { describe, expect, it } from "vitest";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";

describe("openAIResponseToAnthropicMessage", () => {
  it("maps a completed OpenAI Responses JSON body to an Anthropic message JSON body", () => {
    expect(openAIResponseToAnthropicMessage({
      id: "resp_1",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Done." },
          ],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    })).toEqual({
      id: "resp_1",
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [
        { type: "text", text: "Done." },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    });
  });
});
