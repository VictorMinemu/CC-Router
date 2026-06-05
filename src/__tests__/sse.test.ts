import { describe, expect, it } from "vitest";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";

describe("SSE helpers", () => {
  it("parses complete data events and keeps partial line remainder", () => {
    const parsed = parseSseLines("data: {\"type\":\"one\"}\n\ndata: {\"type\"");

    expect(parsed.events).toEqual([{ type: "one" }]);
    expect(parsed.remainder).toBe("data: {\"type\"");
  });

  it("encodes JSON events in SSE data format", () => {
    expect(encodeSseEvent({ type: "response.completed" })).toBe(
      "data: {\"type\":\"response.completed\"}\n\n",
    );
  });
});
