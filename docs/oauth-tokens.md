# OAuth Tokens — How they work

## API keys vs OAuth tokens

Claude Code supports two types of credentials:

| Type | Prefix | Set via | Sent as |
|------|--------|---------|---------|
| API key | `sk-ant-api03-` | `ANTHROPIC_API_KEY` | `X-Api-Key` header |
| OAuth token | `sk-ant-oat01-` | `ANTHROPIC_AUTH_TOKEN` or login | `Authorization: Bearer` header |

**Claude Max subscriptions use OAuth tokens**, not API keys. When you run `claude login`, Claude Code performs an OAuth PKCE flow and stores the resulting access and refresh tokens.

## Token lifetime

| Token | Lifetime | What happens when it expires |
|-------|----------|------------------------------|
| Access token | ~8 hours | Must be refreshed using the refresh token |
| Refresh token | Weeks/months | Requires full re-login (`claude login`) |

**Critical:** refresh tokens **rotate** on every use. Each time cc-router refreshes an access token, the old refresh token is invalidated and replaced with a new one. If the new refresh token is not saved immediately, you lose access permanently.

cc-router handles this automatically with atomic file writes.

## Where Claude Code stores tokens

### macOS
Tokens are stored in the encrypted macOS Keychain:
```bash
security find-generic-password -s 'Claude Code-credentials' -w
```

Output (JSON):
```json
{
  "accessToken": "sk-ant-oat01-...",
  "refreshToken": "sk-ant-ort01-...",
  "expiresAt": "2026-04-04T06:23:45.000Z",
  "scopes": ["user:inference", "user:profile"]
}
```

### Linux / Windows
Tokens are stored in `~/.claude/.credentials.json`:
```bash
cat ~/.claude/.credentials.json | python3 -m json.tool
```

Output:
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1748658860000,
    "scopes": ["user:inference", "user:profile"]
  }
}
```

## Adding multiple accounts

To add a second Claude Max account on macOS:

```bash
# 1. Log out of your current account
claude logout

# 2. Log in with the second account
claude login

# 3. Extract the tokens
security find-generic-password -s 'Claude Code-credentials' -w

# 4. Paste them when prompted by: cc-router setup --add

# 5. Log back in with your primary account
claude logout && claude login
```

On Linux/Windows, the flow is identical — `~/.claude/.credentials.json` will contain the credentials of whichever account is currently logged in.

## Token scopes

cc-router requires these scopes:
- `user:inference` — make API requests
- `user:profile` — identify the account

If a refresh returns a token without `user:inference`, requests will fail with `403 Forbidden`.

## How cc-router refreshes tokens

cc-router uses the official Claude Code OAuth client ID to refresh tokens:

```
POST https://console.anthropic.com/api/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "sk-ant-ort01-...",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

The refresh loop runs every 5 minutes and refreshes any token expiring within 10 minutes. New tokens are written atomically (write to `.tmp`, rename) to prevent file corruption.

## OpenAI ChatGPT/Codex subscription tokens

Codex subscription auth is a separate provider path from Claude auth. OpenAI subscription records in CC-Router are tagged with:

```json
{
  "provider": "openai_subscription"
}
```

These records are not loaded into the Anthropic token pool. They are used only by the OpenAI Responses-compatible `/v1/responses` route.

Recommended login:

```bash
cc-router accounts login-openai
```

This uses the Codex device-code flow documented by OpenAI's Codex app-server auth surface: CC-Router requests a one-time code from `https://auth.openai.com/api/accounts/deviceauth/usercode`, polls for authorization, exchanges the authorization code at `https://auth.openai.com/oauth/token`, and saves the resulting OpenAI subscription tokens.

To add one manually for debugging:

```bash
cc-router accounts add-openai
```

The command validates the record shape and appends or replaces only the matching OpenAI account. Anthropic token refreshes preserve OpenAI records in `accounts.json`.

OpenAI subscription refreshes use:

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
```

with `grant_type=refresh_token`. Refreshes are also deduplicated per account so two simultaneous requests cannot spend the same rotating refresh token at the same time.

Treat OpenAI Codex refresh tokens as account credentials. Do not copy `~/.codex/auth.json` into bug reports, commits, logs, screenshots, or shared chat threads.
