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
});
