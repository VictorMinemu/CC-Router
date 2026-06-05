import { describe, expect, it } from "vitest";
import { openAIResponsesToAnthropic } from "../protocol/openai-to-anthropic.js";

describe("openAIResponsesToAnthropic", () => {
  it("maps a Responses request to Anthropic Messages", () => {
    const result = openAIResponsesToAnthropic({
      model: "claude/sonnet",
      instructions: "Be direct.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize this." }],
        },
      ],
      max_output_tokens: 512,
      stream: true,
    });

    expect(result).toEqual({
      model: "claude-sonnet-4-5",
      system: "Be direct.",
      messages: [
        { role: "user", content: "Summarize this." },
      ],
      max_tokens: 512,
      stream: true,
    });
  });

  it("maps function calls and outputs to Anthropic tool blocks", () => {
    const result = openAIResponsesToAnthropic({
      model: "anthropic/claude-opus-4-1",
      input: [
        {
          role: "assistant",
          content: [
            { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "function_call_output", call_id: "call_1", output: "CC-Router" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "CC-Router" }],
      },
    ]);
    expect(result.tools).toEqual([
      {
        name: "read_file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });
});
