import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";

const START = "# cc-router:start";
const END = "# cc-router:end";

interface CodexConfigFs {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string, encoding: BufferEncoding) => void;
  mkdirSync: (path: string, opts: { recursive: true }) => unknown;
}

export interface WriteCodexRouterConfigOptions {
  homeDir?: string;
  baseUrl: string;
  tokenEnvKey?: string;
  fs?: CodexConfigFs;
}

export interface WriteCodexRouterConfigResult {
  path: string;
}

function managedBlock(baseUrl: string, tokenEnvKey: string): string {
  return [
    START,
    "model_provider = \"cc-router\"",
    "",
    "[model_providers.cc-router]",
    "name = \"CC-Router\"",
    `base_url = "${baseUrl}"`,
    "wire_api = \"responses\"",
    `env_key = "${tokenEnvKey}"`,
    END,
  ].join("\n");
}

function replaceManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start >= 0 && end >= start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + END.length).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n") + "\n";
  }

  return [existing.trimEnd(), block].filter(Boolean).join("\n\n") + "\n";
}

export function writeCodexRouterConfig(opts: WriteCodexRouterConfigOptions): WriteCodexRouterConfigResult {
  const fs = opts.fs ?? { existsSync, readFileSync, writeFileSync, mkdirSync };
  const homeDir = opts.homeDir ?? os.homedir();
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const tokenEnvKey = opts.tokenEnvKey ?? "CC_ROUTER_TOKEN";

  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf-8")
    : "";
  const next = replaceManagedBlock(existing, managedBlock(opts.baseUrl, tokenEnvKey));
  fs.writeFileSync(configPath, next, "utf-8");

  return { path: configPath };
}
