import type { OpenAISubscriptionAccount } from "./token-refresher.js";

export function createOpenAIAccountPicker(
  accounts: OpenAISubscriptionAccount[],
): () => OpenAISubscriptionAccount | null {
  let index = 0;

  return () => {
    const enabled = accounts.filter(account => account.enabled);
    if (enabled.length === 0) return null;

    const account = enabled[index % enabled.length];
    index = (index + 1) % enabled.length;
    return account;
  };
}
