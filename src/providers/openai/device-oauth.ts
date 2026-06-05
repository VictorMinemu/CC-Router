import { createOpenAIAccountRecord, type OpenAIAccountRecord } from "./account-record.js";

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type FetchImpl = typeof fetch;

export interface OpenAIDeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
}

export interface OpenAIDeviceTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface OpenAIDeviceOAuthOptions {
  issuer?: string;
  clientId?: string;
  fetchImpl?: FetchImpl;
}

interface RequestDeviceCodeResponse {
  device_auth_id: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface PollDeviceCodeResponse {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export interface ExchangeOpenAIDeviceCodeOptions extends OpenAIDeviceOAuthOptions {
  deviceCode: OpenAIDeviceCode;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

export interface LoginOpenAIWithDeviceCodeOptions extends OpenAIDeviceOAuthOptions {
  accountId: string;
  onDeviceCode?: (code: OpenAIDeviceCode) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

function issuerOf(opts: OpenAIDeviceOAuthOptions): string {
  return (opts.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
}

function clientIdOf(opts: OpenAIDeviceOAuthOptions): string {
  return opts.clientId ?? DEFAULT_CLIENT_ID;
}

function fetchOf(opts: OpenAIDeviceOAuthOptions): FetchImpl {
  return opts.fetchImpl ?? fetch;
}

function parseAccessTokenExpiry(accessToken: string): number {
  const [, payload] = accessToken.split(".");
  if (!payload) throw new Error("OpenAI access token is not a JWT");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { exp?: unknown };
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("OpenAI access token JWT does not contain a numeric exp claim");
  }
  return claims.exp * 1000;
}

async function readError(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function requestOpenAIDeviceCode(opts: OpenAIDeviceOAuthOptions = {}): Promise<OpenAIDeviceCode> {
  const issuer = issuerOf(opts);
  const res = await fetchOf(opts)(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientIdOf(opts) }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI device code request failed (${res.status}): ${await readError(res)}`);
  }

  const body = await res.json() as RequestDeviceCodeResponse;
  const userCode = body.user_code ?? body.usercode;
  if (!body.device_auth_id || !userCode) {
    throw new Error("OpenAI device code response is missing device_auth_id or user_code");
  }

  return {
    verificationUrl: `${issuer}/codex/device`,
    userCode,
    deviceAuthId: body.device_auth_id,
    intervalSeconds: Number(body.interval ?? 5),
  };
}

async function pollAuthorizationCode(opts: ExchangeOpenAIDeviceCodeOptions): Promise<PollDeviceCodeResponse> {
  const issuer = issuerOf(opts);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();

  while (now() - started <= timeoutMs) {
    const res = await fetchOf(opts)(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: opts.deviceCode.deviceAuthId,
        user_code: opts.deviceCode.userCode,
      }),
    });

    if (res.ok) return await res.json() as PollDeviceCodeResponse;
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`OpenAI device authorization failed (${res.status}): ${await readError(res)}`);
    }

    await sleep(Math.max(1, opts.deviceCode.intervalSeconds) * 1000);
  }

  throw new Error("OpenAI device authorization timed out");
}

export async function exchangeOpenAIDeviceCodeForTokens(
  opts: ExchangeOpenAIDeviceCodeOptions,
): Promise<OpenAIDeviceTokens> {
  const issuer = issuerOf(opts);
  const code = await pollAuthorizationCode(opts);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: code.authorization_code,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: clientIdOf(opts),
    code_verifier: code.code_verifier,
  });

  const res = await fetchOf(opts)(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    throw new Error(`OpenAI token exchange failed (${res.status}): ${await readError(res)}`);
  }

  const tokens = await res.json() as TokenResponse;
  return {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: parseAccessTokenExpiry(tokens.access_token),
  };
}

export async function loginOpenAIWithDeviceCode(
  opts: LoginOpenAIWithDeviceCodeOptions,
): Promise<OpenAIAccountRecord> {
  const deviceCode = await requestOpenAIDeviceCode(opts);
  opts.onDeviceCode?.(deviceCode);
  const tokens = await exchangeOpenAIDeviceCodeForTokens({ ...opts, deviceCode });
  return createOpenAIAccountRecord({
    id: opts.accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: DEFAULT_SCOPE,
  });
}
