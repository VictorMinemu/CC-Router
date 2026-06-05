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

  it("preserves unrelated Codex config while replacing an existing managed block", () => {
    const writeFileSync = vi.fn();
    const mkdirSync = vi.fn();
    const existing = [
      "model = \"gpt-5\"",
      "",
      "# cc-router:start",
      "model_provider = \"old-router\"",
      "",
      "[model_providers.cc-router]",
      "base_url = \"http://localhost:9999/v1\"",
      "# cc-router:end",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync,
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("model = \"gpt-5\"");
    expect(written).toContain("[profiles.work]");
    expect(written).toContain("base_url = \"http://localhost:3456/v1\"");
    expect(written).not.toContain("http://localhost:9999/v1");
    expect(written.match(/# cc-router:start/g)).toHaveLength(1);
  });

  it("writes the selected Codex model into the managed block", () => {
    const writeFileSync = vi.fn();

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      defaultModel: "openai/gpt-5-codex",
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    expect(writeFileSync.mock.calls[0][1]).toContain("model = \"openai/gpt-5-codex\"");
  });
});
