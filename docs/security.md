# Security

## Token storage

OAuth tokens are stored in `~/.cc-router/accounts.json` on your local machine — **never in the repository**.

The file contains:
```json
[
  {
    "id": "max-account-1",
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1748658860000,
    "scopes": ["user:inference", "user:profile"]
  }
]
```

OpenAI subscription records use the same file but are tagged with a provider:

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

**Protect this file:** anyone with access to it can make API requests on behalf of your Claude Max or OpenAI ChatGPT/Codex subscription accounts.

### File permissions

On Linux, the file is created with mode `0600` (owner read/write only). On macOS, standard user-directory permissions apply.

### Never commit tokens

`accounts.json` is in `.gitignore`. Double-check before any commit:
```bash
git status  # accounts.json should not appear
```

---

## Atomic writes

When tokens are refreshed, cc-router writes to a temporary file first and then renames it to `accounts.json`. This prevents file corruption if the process is killed mid-write — a corrupted `accounts.json` would lock you out of all accounts permanently.

---

## System call security

When extracting tokens on macOS, cc-router calls:
```
security find-generic-password -s "Claude Code-credentials" -w
```

This uses `execFile` (not `exec` or `execSync`), passing arguments as a fixed array — **no shell interpolation, no injection risk**. The command only reads from the Keychain; it does not modify anything.

---

## Network

cc-router only makes outbound connections to:

| Host | Purpose |
|------|---------|
| `api.anthropic.com` | Forwarding Claude Code requests (standalone mode) |
| `console.anthropic.com` | OAuth token refresh |
| `chatgpt.com` | OpenAI Codex subscription Responses route |
| `auth.openai.com` | OpenAI subscription OAuth token refresh |
| `localhost:4000` | LiteLLM (full mode only) |

No telemetry, no analytics, no external logging.

---

## Docker

In Docker mode, `accounts.json` is mounted from the host into the container. The container runs as the `node` user (non-root). The Dockerfile uses a minimal `node:22-alpine` image.

**Do not push a custom Docker image containing accounts.json** — the `.dockerignore` excludes it, but verify before any custom builds.

---

## Threat model

| Threat | Mitigation |
|--------|-----------|
| accounts.json leaked | `.gitignore`, `0600` permissions, stored outside repo |
| Process killed mid-refresh | Atomic write (tmp + rename) |
| Concurrent refresh calls | Per-account lock (`Map<id, Promise>`) |
| Shell injection in Keychain read | `execFile` with fixed arg array |
| Malicious body parsing | No `express.json()` on proxy routes |
| OpenAI and Anthropic tokens mixed | Provider-tagged records; OpenAI accounts are loaded outside the Anthropic pool |
| OpenAI refresh token rotation loss | Refreshes persist the rotated token immediately while preserving other providers |
