import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountsApi } from "../ui/accountsApi.js";

describe("createAccountsApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("updates all accounts for a provider through the management endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      provider: "openai_subscription",
      enabled: false,
      changed: 2,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const api = createAccountsApi("http://router.local/", "secret");

    await api.setProviderEnabled("openai_subscription", false);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts/providers/openai_subscription",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
