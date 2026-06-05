# CC-Router

**Local multi-account router for Claude Max and OpenAI ChatGPT/Codex subscriptions.**  
Distribute Claude Code requests across Claude subscriptions, and expose an OpenAI Responses-compatible route for Codex CLI through the same proxy.

[![npm](https://img.shields.io/npm/v/ai-cc-router)](https://www.npmjs.com/package/ai-cc-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![CC-Router Dashboard](assets/dashboard.png)

### Features

- **Round-robin token rotation** — distribute requests across 2-20 Claude Max accounts automatically
- **Multi-provider routing** — route `openai/*` models to OpenAI ChatGPT/Codex subscription accounts and Claude models to Claude subscriptions
- **Transparent Claude proxy** — Claude Code works normally; streaming, thinking, tool use, prompt caching all pass through
- **Codex CLI support** — configure Codex to use CC-Router as a Responses-compatible provider
- **Automatic token refresh** — OAuth tokens are refreshed before they expire, saved atomically to disk
- **Rate limit awareness** — detects 429/529 responses and coolsdown accounts; picks the least-loaded one
- **Client mode** — connect to a remote CC-Router from any machine with one command (`cc-router client connect <url>`)
- **Claude Desktop support** — route Cowork / Agent-mode traffic through CC-Router via mitmproxy interception (macOS, Windows, Linux)
- **Guided setup wizard** — interactive `cc-router setup` extracts tokens from Keychain or credentials file, configures everything
- **Live dashboard** — real-time terminal UI showing account health, request counts, token usage, recent activity
- **Proxy authentication** — optional Bearer / x-api-key secret for internet-exposed deployments
- **Auto-update** — patch/minor releases install automatically (opt-out available)
- **Multiple deployment modes** — background daemon, native OS auto-start (launchd/systemd), foreground, Docker Compose
- **Cross-platform** — macOS, Linux, Windows; Node.js 20+

---

> **Warning**  
> Read the [disclaimer](#disclaimer) before using this tool.

---

## How it works

```
Claude Code  (terminal)  ─┐
                          │  ANTHROPIC_BASE_URL=http://localhost:3456
                          │
Claude Desktop  ─[mitmproxy]─┐  (optional — intercepts api.anthropic.com)
                             │
                             ▼
┌─────────────────────────────────────┐
│  CC-Router  :3456                   │
│                                     │
│  1. Receives /v1/messages or        │
│     /v1/responses                   │
│  2. Parses model provider prefix    │
│  3. Picks a Claude or OpenAI account│
│  4. Refreshes token if expiring     │
│  5. Injects Authorization: Bearer   │
│  6. Forwards to Anthropic, OpenAI   │
│     Codex backend, or LiteLLM       │
└──────────────┬──────────────────────┘
               │
               ▼
        api.anthropic.com
        (authenticated with
         OAuth token of account N)
```

All standard Claude Code features work transparently on the Claude route: streaming, extended thinking, tool use, prompt caching. OpenAI subscription routing is available for Codex-compatible Responses requests and Claude Code cross-routing with the limitations documented below.

**Claude Desktop support** is opt-in and requires a small interceptor (mitmproxy) because Claude Desktop doesn't expose a custom API endpoint setting. See [Claude Desktop support](#claude-desktop-support).

---

## Use cases

### Heavy user — one account isn't enough

Claude Max has rate limits per account. If you hit them regularly mid-session — waiting for cooldowns, getting 429s — you're a good candidate.

With two accounts you double your effective rate limit. With three, you triple it. The proxy distributes requests automatically; you don't change how you use Claude Code at all.

```text
1 account  →  hit limit, wait 60s, continue
3 accounts →  request rotates across all three, limit effectively tripled
```

---

### Team sharing accounts — fewer subscriptions, same throughput

A team of five doesn't need five Max subscriptions. In practice, developers don't all peak at the same time. Three accounts can comfortably serve five people working normal hours.

#### Example setup: 5 devs, 3 accounts

```text
cc-router (hosted on a shared machine or VPS)
     │
     ├── max-account-1   ← alice's subscription
     ├── max-account-2   ← bob's subscription
     └── max-account-3   ← carol's subscription
           │
           └── serves: alice, bob, carol, dave, eve
```

Each developer sets their `ANTHROPIC_BASE_URL` to the shared proxy. Done. The proxy handles routing and token refresh invisibly.

#### Cost example

| Setup | Monthly cost |
|-------|-------------|
| 5 individual Max subscriptions | 5 × $100 = **$500/mo** |
| 3 shared via cc-router | 3 × $100 = **$300/mo** |

You save $200/mo without any loss in capability for a typical team workload.

---

### Hosting cc-router on a shared machine

Run cc-router on a machine everyone on the team can reach — a home server, a VPS, or a spare machine on the office network.

#### On the server

```bash
npm install -g ai-cc-router
cc-router setup          # configure the 3 shared accounts
cc-router start          # first run asks: background/boot/server mode — choose "server mode"
```

When you enable server mode during `cc-router start`, the proxy automatically binds to all interfaces (`0.0.0.0`) and prints instructions for connecting clients.

#### On each developer's machine

No installation needed. Just set two environment variables in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://192.168.1.50:3456",
    "ANTHROPIC_AUTH_TOKEN": "proxy-managed"
  }
}
```

Replace `192.168.1.50` with the server's IP or hostname. Then run `claude` normally.

Or use the CLI to write the settings automatically:

```bash
cc-router configure --port 3456
# Then manually update ANTHROPIC_BASE_URL to the remote IP
```

---

### Hosting on a VPS (internet-accessible)

If your team is distributed or works remotely, run cc-router on a VPS and expose it over HTTPS via a reverse proxy.

#### Recommended nginx config

```nginx
server {
    listen 443 ssl;
    server_name cc-router.yourcompany.com;

    # ... SSL cert config (e.g. Let's Encrypt) ...

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_buffering off;          # required for SSE streaming
        proxy_read_timeout 300s;      # required for long thinking requests
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

For longer requests, set `proxyRequestTimeoutMs` in `~/.cc-router/config.json` (milliseconds) and keep `proxy_read_timeout` at least as high.

Each developer then points to:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://cc-router.yourcompany.com",
    "ANTHROPIC_AUTH_TOKEN": "proxy-managed"
  }
}
```

**Security note:** if the proxy is internet-accessible, add authentication at the nginx level (basic auth, mTLS, or IP allowlist) so only your team can use it. cc-router does not implement user authentication itself.

---

## Quickstart

```bash
# 1. Install
npm install -g ai-cc-router

# 2. Wizard: extract tokens + configure Claude Code automatically
cc-router setup

# 3. Start the proxy
cc-router start

# 4. Use Claude Code normally — the proxy is transparent
claude
```

That's it. Claude Code will route through the proxy without any further changes.

On first run, `cc-router start` asks how you want to run (background/foreground, auto-start on boot, server mode) and remembers your choice. Next time, it just starts. To change preferences later:
```bash
cc-router start --reconfigure
```

---

## Installation

**Requirements:** Node.js 20 or 22.

```bash
npm install -g ai-cc-router
```

Verify:
```bash
cc-router --version
```

---

## Setup by platform

### macOS

cc-router can extract OAuth tokens directly from the macOS Keychain — no manual copy-pasting needed.

```bash
cc-router setup
# Select "Extract automatically from macOS Keychain"
```

For multiple accounts, you need to switch accounts in Claude Code between extractions:
```bash
# Account 1 is already logged in — run setup and extract
cc-router setup

# To add account 2:
claude logout && claude login   # log in with account 2
cc-router setup --add           # extract and merge
claude logout && claude login   # log back in with account 1
```

### Linux

Tokens are read from `~/.claude/.credentials.json`:
```bash
cc-router setup
# Select "Read from ~/.claude/.credentials.json"
```

Make sure Claude Code is installed and you have run `claude login` at least once.

### Windows

Same as Linux — tokens are read from `~/.claude/.credentials.json` (Windows path: `%USERPROFILE%\.claude\.credentials.json`).

```bash
cc-router setup
```

---

## CLI Reference

```text
cc-router setup              Interactive wizard: extract tokens + configure Claude Code
cc-router setup --add        Add another account to an existing configuration

cc-router start              Start proxy (asks preferences on first run, then remembers)
cc-router start --foreground Run in the foreground (stays in terminal)
cc-router start --reconfigure  Re-ask run preferences (background/service/server mode)
cc-router start --litellm    Start with LiteLLM in Docker (advanced mode)

cc-router stop               Stop proxy (offers to remove auto-start / config)
cc-router stop --keep-config Stop proxy only (keep settings.json)
cc-router stop --full        Stop + remove auto-start + revert Claude Code (no prompts)
cc-router revert             Same as stop --full

cc-router status             Live dashboard (updates every 2s, press q to quit)
cc-router status --json      Print current stats as JSON and exit

cc-router models list        List models discovered live from provider APIs
cc-router models list --json Print discovered models + routing as JSON
cc-router models set --claude-model anthropic/claude-sonnet-4-6
cc-router models set --openai-model openai/gpt-5-codex

cc-router logs               View proxy logs (background mode)
cc-router logs -f            Follow log output in real time
cc-router logs --lines 100   Show last 100 lines

cc-router accounts list      List configured accounts (live stats if proxy is running)
cc-router accounts add       Add an account interactively
cc-router accounts login-openai  Sign in to OpenAI subscription auth with device code
cc-router accounts add-openai  Add an OpenAI subscription account manually (experimental)
cc-router accounts remove <id>  Remove a Claude or OpenAI account

cc-router configure          (Re)write ~/.claude/settings.json
cc-router configure codex    (Re)write ~/.codex/config.toml for Codex CLI
cc-router configure codex --model openai/gpt-5-codex
cc-router configure models --claude-model claude-sonnet-4-6 --openai-model gpt-5-codex
cc-router configure --show   Show current Claude Code proxy settings
cc-router configure --remove Remove cc-router settings (same as revert without stopping)

cc-router client connect <url>       Connect Claude Code to a remote CC-Router
cc-router client connect --desktop   Also configure Claude Desktop interception
cc-router client disconnect          Revert all client configuration
cc-router client status              Show connection + remote server health
cc-router client start-desktop       Start mitmproxy interceptor for Claude Desktop
cc-router client stop-desktop        Stop mitmproxy interceptor

cc-router docker up          Start full Docker stack (cc-router + LiteLLM)
cc-router docker up --build  Rebuild cc-router image before starting
cc-router docker down        Stop Docker containers
cc-router docker logs        Tail all Docker logs
cc-router docker ps          Show container status
cc-router docker restart [service]  Restart a service
```

---

## Modes of operation

### Standalone (default — no Docker)

```text
Claude Code → cc-router:3456 → api.anthropic.com
```

Best for personal use. No Docker required. Runs in the background by default, auto-starts on boot if you choose.

```bash
cc-router start
```

### Full mode with LiteLLM (optional — requires Docker)

```text
Claude Code → cc-router:3456 → LiteLLM:4000 → api.anthropic.com
```

Adds a LiteLLM layer for usage logging, rate limiting, and a web dashboard at `http://localhost:4000/ui`.

```bash
cc-router docker up
# or: cc-router start --litellm
```

See [docs/litellm-setup.md](docs/litellm-setup.md) for details.

---

## Codex CLI support (experimental)

CC-Router exposes an OpenAI Responses-compatible endpoint for Codex CLI at `/v1/responses`. This lets Codex use OpenAI ChatGPT/Codex subscription accounts through the same local router that Claude Code uses for Claude subscriptions.

Configure Codex:

```bash
cc-router configure codex --model openai/gpt-5-codex
```

This writes a managed provider block to `~/.codex/config.toml`:

```toml
model = "openai/gpt-5-codex"
model_provider = "cc-router"

[model_providers.cc-router]
name = "CC-Router"
base_url = "http://localhost:3456/v1"
wire_api = "responses"
env_key = "CC_ROUTER_TOKEN"
```

Configure router-side model defaults and aliases:

```bash
cc-router configure models \
  --claude-model claude-sonnet-4-6 \
  --openai-model gpt-5-codex
```

This writes `modelRouting` to `~/.cc-router/config.json`. It sets the Claude default, the OpenAI default, and practical aliases so `claude/sonnet`, `sonnet`, `openai/default`, and `openai/codex` resolve to the models you selected. Restart the router after changing these values.

Model discovery is dynamic. `GET /v1/models` returns an OpenAI-compatible model list by querying the configured Anthropic and OpenAI subscription APIs live:

```bash
curl http://localhost:3456/v1/models
```

Results are provider-prefixed, for example `anthropic/claude-sonnet-4-6` and `openai/gpt-5-codex`. Configured aliases such as `openai/codex` are added when their upstream model is available. If one provider is temporarily unavailable, CC-Router still returns the models discovered from the other providers.

Then run Codex with the proxy secret in `CC_ROUTER_TOKEN` when your router is password-protected:

```bash
CC_ROUTER_TOKEN=cc-rtr-your-secret codex -m openai/gpt-5.5
```

Model prefixes:

| Prefix | Upstream |
|--------|----------|
| `openai/*` | OpenAI ChatGPT/Codex subscription route |
| `claude/*` | Claude subscription route |
| `anthropic/*` | Claude subscription route |

Examples after the configuration above:

| Public model | Routed upstream model |
|--------------|----------------------|
| `openai/codex` | `gpt-5-codex` |
| `openai/default` | `gpt-5-codex` |
| `claude/sonnet` | `claude-sonnet-4-6` |

Claude Code can also send a `/v1/messages` request with an `openai/*` model. CC-Router translates that Anthropic Messages request into an OpenAI Responses request and converts JSON or basic text SSE responses back into Anthropic-shaped message responses.

Current limitation: OpenAI-to-Anthropic streaming currently covers text deltas and final usage. Streaming tool-call normalization is still experimental.

OpenAI subscription account records are separated from Claude accounts with `provider: "openai_subscription"` so they do not enter the Anthropic token pool:

```json
{
  "id": "openai-primary",
  "provider": "openai_subscription",
  "accessToken": "eyJ...",
  "refreshToken": "...",
  "expiresAt": 1999999999000,
  "scopes": ["openid", "profile", "email", "offline_access"]
}
```

Recommended OpenAI subscription login:

```bash
cc-router accounts login-openai
```

This uses the Codex device-code auth flow: the CLI prints a verification URL and one-time code, you approve the login in your browser, and CC-Router saves the resulting OpenAI subscription account record.

Manual account entry is also available for debugging:

```bash
cc-router accounts add-openai
```

This prompts for the OpenAI access token, refresh token, expiry timestamp, and scopes, validates the record shape, and saves it without overwriting Claude accounts.

---

## Client mode — connecting to an existing CC-Router

If someone on your team already hosts a CC-Router instance (on a VPS, home server, or another machine on the LAN), you don't need to install accounts locally. You just point your Claude Code at the remote proxy.

The setup wizard asks about this at the very first step:

```bash
cc-router setup
# → What do you want to do?
#   • Host CC-Router on this machine
#   • Connect to an existing CC-Router server  ← pick this
```

Or use the dedicated command directly:

```bash
# Quick connect — just point Claude Code at the remote proxy
cc-router client connect http://192.168.1.50:3456 --secret cc-rtr-abc123...

# Check status
cc-router client status

# Disconnect (restores Claude Code defaults)
cc-router client disconnect
```

Client mode writes `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` into `~/.claude/settings.json`, so Claude Code talks directly to the remote proxy. Nothing runs locally — no accounts, no proxy process, no resources.

### CLI reference

```text
cc-router client connect <url>       Connect Claude Code to a CC-Router server
cc-router client connect --desktop   Also configure Claude Desktop interception
cc-router client connect -s <secret> Pass the proxy secret inline (or use --secret)
cc-router client disconnect          Revert all client configuration
cc-router client status              Show current connection + remote server health
cc-router client start-desktop       Start the Claude Desktop mitmproxy interceptor
cc-router client stop-desktop        Stop the Claude Desktop interceptor
```

---

## Claude Desktop support

Claude Desktop (chat + Cowork) **can be routed through CC-Router**, but unlike Claude Code it does not respect `ANTHROPIC_BASE_URL`. It talks directly to `api.anthropic.com` via an embedded Anthropic SDK. To redirect its traffic, CC-Router uses [mitmproxy](https://mitmproxy.org/) in *local redirect mode* — a process-scoped interceptor that only captures Claude Desktop's network traffic and forwards it to the proxy.

This is **opt-in** — the setup wizard will ask if you want it.

### Requirements

- **mitmproxy ≥ 10.1.5** (macOS, Windows) or **≥ 11.1** (Linux — requires kernel ≥ 6.8)
- Admin access to install the mitmproxy CA certificate
- On macOS: manual approval of mitmproxy's Network Extension (one time, via System Settings)

### Installing mitmproxy

```bash
# macOS
brew install mitmproxy

# Windows
# Download the installer from https://mitmproxy.org/downloads/
# (or: pip install mitmproxy)

# Linux
pip install mitmproxy        # kernel 6.8+ required for local mode
```

### Enabling Desktop interception

During `cc-router setup` or `cc-router client connect`, answer **Yes** when asked about Claude Desktop. The wizard will:

1. Check that mitmproxy is installed
2. Generate the mitmproxy CA certificate (if not already present)
3. Install the CA into the OS trust store (requires sudo/admin)
4. Write the redirect addon to `~/.cc-router/interceptor/addon.py`
5. On macOS, prompt you to approve the Network Extension

Then start the interceptor:

```bash
cc-router client start-desktop
```

Open Claude Desktop and send a message. The request will be intercepted, redirected to CC-Router, and round-robinned across your accounts just like Claude Code traffic.

### Stopping / removing Desktop interception

```bash
cc-router client stop-desktop    # Stop the interceptor (keep configuration)
cc-router client disconnect      # Stop + remove all client config
```

### How it works under the hood

```
Claude Desktop
     │
     │  tries to connect to api.anthropic.com:443
     ▼
mitmproxy (local mode)
     │  addon.py rewrites scheme/host to CC-Router
     ▼
CC-Router :3456 ──► api.anthropic.com  (with OAuth Bearer token)
```

mitmproxy's local mode is *process-scoped* — it only intercepts traffic from the Claude process, not your browser, curl, or any other app. The OS-level interception uses:

| Platform | Mechanism |
|----------|-----------|
| macOS    | Network Extension (App Proxy Provider API) |
| Windows  | WinDivert (WFP kernel driver) |
| Linux    | eBPF (kernel ≥ 6.8) |

### Troubleshooting

- **macOS: "provider rejected new flow"** — re-enable Mitmproxy Redirector in System Settings → General → Login Items & Extensions → Network Extensions, then restart mitmproxy.
- **Windows: UAC prompt every start** — expected; mitmproxy's redirector needs admin at runtime.
- **Linux: "eBPF program failed to load"** — check your kernel version with `uname -r`. You need ≥ 6.8.
- **Chat shows "failed to connect"** — make sure CC-Router is reachable from the mitmproxy process. Run `curl http://localhost:3456/cc-router/health` to verify the proxy is up.

---

## Reverting to normal Claude Code

To stop using cc-router and go back to normal Claude Code authentication:

```bash
cc-router revert
```

This stops the proxy process, removes the auto-start service (if installed), and removes cc-router's settings from `~/.claude/settings.json`. Claude Code will use its own authentication on the next launch.

For a gentler approach, `cc-router stop` interactively asks what you want to clean up.

---

## Status dashboard

```bash
cc-router status
```

```text
 CC-Router  ·  standalone → api.anthropic.com  ·  up 2h 14m  ·  [q] quit

 OPERATIONS  base http://localhost:3456  ·  auth protected  ·  models dynamic
  Claude 2/2 healthy  OpenAI 1/1 healthy  ·  cross-route ready
  endpoints /v1/messages /v1/responses /v1/models /cc-router/accounts
  routing claude=claude-sonnet-4-6 aliases[sonnet]  openai=gpt-5-codex aliases[codex]
  models cc-router models list  change cc-router models set

 ACCOUNTS  2/2 healthy

  ● max-account-1    ok      req   142  err   0  expires  6h 48m  last  2s ago
  ● max-account-2    ok      req   139  err   0  expires  6h 51m  last  5s ago

 TOTALS  requests 281  ·  errors 0  ·  refreshes 2

 RECENT ACTIVITY
  14:23:01  → max-account-1    route
  14:22:58  → max-account-2    route
  14:22:45  ↻ max-account-1    refresh
```

Press `q` to quit. Run with `--json` for non-interactive output; the JSON includes an `operational` block with capabilities, endpoints, provider readiness, auth status, and model routing. Secrets and account tokens are never included.

List and change models without waiting for a package update:

```bash
cc-router models list
cc-router models set --claude-model anthropic/claude-sonnet-4-6
cc-router models set --openai-model openai/gpt-5-codex
```

When the proxy is running, `models set` updates the live router and persists the new defaults. If the proxy is offline, it writes the configuration for the next start.

---

## Security

- Tokens are stored locally in `~/.cc-router/accounts.json`, **never in the repository**
- The file is excluded by `.gitignore`
- Writes are atomic (write to `.tmp`, then rename) — no corruption on crash
- Keychain reads use `execFile` with a fixed argument array — no shell injection
- Anonymous opt-out telemetry via [Aptabase](https://aptabase.com) (see [Telemetry](#telemetry) below)

See [docs/security.md](docs/security.md) for details.

---

## Telemetry

CC-Router sends a handful of anonymous lifecycle events to [Aptabase](https://aptabase.com) (privacy-first, open source, EU-hosted). The goal is simple: know how many people use the project, which versions are live, and roughly how many instances are running — so we can prioritize fixes and features.

**What we send** — the entire payload lives in [`src/utils/telemetry.ts`](src/utils/telemetry.ts), audit it yourself:

| Event                | When                                            | Custom props                             |
| -------------------- | ------------------------------------------------ | ---------------------------------------- |
| `app_started`        | First proxy start after install                 | `first_run: true`                        |
| `setup_completed`    | Setup wizard finishes successfully               | `account_count`                          |
| `proxy_started`      | Each `cc-router start`                           | `account_count`, `mode`                  |
| `proxy_heartbeat`    | Every hour while the proxy is running              | `uptime_minutes`, `account_count`        |
| `telemetry_disabled` | When you run `cc-router telemetry off`           | —                                        |

Plus anonymous system props with every event: `appVersion`, `osName` (macOS/Linux/Windows), `osVersion`, `locale`, `engineVersion` (Node), and an anonymous `installId` (random UUID generated on first run, stored in `~/.cc-router/telemetry.json`).

**What we never send**: IPs, OAuth tokens, account names, request content, prompts, responses, URLs, hostnames, usernames, file paths — nothing that could identify you or your usage patterns.

**Disable it** — three ways, any one works:

```bash
# 1. Persistent opt-out (recommended)
cc-router telemetry off

# 2. Respect the de-facto standard (honored by many OSS tools)
export DO_NOT_TRACK=1

# 3. Project-specific override
export CC_ROUTER_TELEMETRY=0
```

Check status anytime: `cc-router telemetry status`.

---

## Disclaimer

> CC-Router uses the OAuth tokens of your own Claude Max subscriptions.
>
> **Read Anthropic's Terms of Service before using this tool.**  
> Using multiple Max subscriptions to increase throughput may violate the ToS. Anthropic has been known to ban accounts for unusual OAuth usage patterns.
>
> The authors are not responsible for any account bans, loss of access, or other consequences resulting from the use of this software. Use at your own risk.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Bug reports → [GitHub Issues](https://github.com/VictorMinemu/CC-Router/issues)

---

## License

[MIT](LICENSE)
