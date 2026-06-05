import type { ProviderKind } from "../protocol/model-ref.js";

export type IngressProtocol = "anthropic_messages" | "responses";

export interface ProviderRoute {
  provider: ProviderKind;
  publicModel: string;
  upstreamModel: string;
  ingressProtocol: IngressProtocol;
}

export interface ProviderAccount {
  id: string;
  provider: ProviderKind;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: number;
  enabled: boolean;
}
