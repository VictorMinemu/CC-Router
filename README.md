# CC-Router

**Round-robin proxy for multiple Claude Max accounts.**  
Distribute Claude Code requests across N subscriptions to multiply your throughput.

[![CI](https://github.com/VictorMinemu/CC-Router/actions/workflows/ci.yml/badge.svg)](https://github.com/VictorMinemu/CC-Router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ai-cc-router)](https://www.npmjs.com/package/ai-cc-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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
│  1. Receives request  /v1/messages  │
│  2. Round-robin → picks account N   │
│  3. Refreshes token if expiring     │
│  4. Injects  Authorization: Bearer  │
│  5. Forwards to Anthropic (or       │
│     LiteLLM for advanced mode)      │
└──────────────┬──────────────────────┘
               │
               ▼
        api.anthropic.com
        (authenticated with
         OAuth token of account N)
```

All standard Claude Code features work transparently: streaming, extended thinking, tool use, prompt caching.

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
cc-router service install # auto-start on boot
```

By default cc-router binds to `localhost`. To accept connections from other machines, set the `HOST` environment variable:

```bash
# Listen on all interfaces (team LAN or VPS)
HOST=0.0.0.0 cc-router start

# Or configure it permanently in the service
```

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

**Optional:** install as a system service so it starts automatically on boot:
```bash
cc-router service install
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

cc-router start              Start proxy on localhost:3456 (foreground)
cc-router start --daemon     Start in background via PM2
cc-router start --litellm    Start with LiteLLM in Docker (advanced mode)

cc-router stop               Stop proxy + restore Claude Code to normal auth
cc-router stop --keep-config Stop proxy only (keep settings.json)
cc-router revert             Restore Claude Code to normal authentication

cc-router status             Live dashboard (updates every 2s, press q to quit)
cc-router status --json      Print current stats as JSON and exit

cc-router accounts list      List configured accounts (live stats if proxy is running)
cc-router accounts add       Add an account interactively
cc-router accounts remove <id>  Remove an account

cc-router service install    Register cc-router to start on system boot (PM2)
cc-router service uninstall  Remove from system startup
cc-router service status     Show PM2 service status
cc-router service logs       Tail proxy logs from PM2

cc-router configure          (Re)write ~/.claude/settings.json
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

Best for personal use. No Docker required.

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

This stops the proxy process and removes cc-router's settings from `~/.claude/settings.json`. Claude Code will use its own authentication on the next launch.

---

## Status dashboard

```bash
cc-router status
```

```text
 CC-Router  ·  standalone → api.anthropic.com  ·  up 2h 14m  ·  [q] quit

 ACCOUNTS  2/2 healthy

  ● max-account-1    ok      req   142  err   0  expires  6h 48m  last  2s ago
  ● max-account-2    ok      req   139  err   0  expires  6h 51m  last  5s ago

 TOTALS  requests 281  ·  errors 0  ·  refreshes 2

 RECENT ACTIVITY
  14:23:01  → max-account-1    route
  14:22:58  → max-account-2    route
  14:22:45  ↻ max-account-1    refresh
```

Press `q` to quit. Run with `--json` for non-interactive output.

---

## Security

- Tokens are stored locally in `~/.cc-router/accounts.json`, **never in the repository**
- The file is excluded by `.gitignore`
- Writes are atomic (write to `.tmp`, then rename) — no corruption on crash
- Keychain reads use `execFile` with a fixed argument array — no shell injection
- No telemetry, no external logging

See [docs/security.md](docs/security.md) for details.

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
