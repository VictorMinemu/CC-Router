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
