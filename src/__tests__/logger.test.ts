import { describe, expect, it, vi } from "vitest";
import { logStartup } from "../proxy/logger.js";

describe("logStartup", () => {
  it("shows total and provider account counts", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      logStartup(45692, "127.0.0.1", "direct", "anthropic", {
        anthropic: 1,
        openai: 2,
      } as never);

      expect(logSpy.mock.calls[0]?.[0]).toContain("Accounts : 3 (Claude 1, OpenAI 2)");
    } finally {
      logSpy.mockRestore();
    }
  });
});
