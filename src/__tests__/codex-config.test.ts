import { describe, expect, it, vi } from "vitest";
import { writeCodexRouterConfig } from "../utils/codex-config.js";

describe("writeCodexRouterConfig", () => {
  it("writes a user-level Codex provider profile for CC-Router", () => {
    const writeFileSync = vi.fn();
    const mkdirSync = vi.fn();

    const output = writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync,
      },
    });

    expect(output.path).toBe("/tmp/home/.codex/config.toml");
    expect(writeFileSync.mock.calls[0][1]).toContain("[model_providers.cc-router]");
    expect(writeFileSync.mock.calls[0][1]).toContain("base_url = \"http://localhost:3456/v1\"");
    expect(writeFileSync.mock.calls[0][1]).toContain("wire_api = \"responses\"");
    expect(writeFileSync.mock.calls[0][1]).toContain("env_key = \"CC_ROUTER_TOKEN\"");
  });
});
