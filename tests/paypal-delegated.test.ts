import { describe, expect, it } from "vitest";
import { PayPalOAuthClient, PayPalPaymentProvider } from "../src/paypal.js";
import { StoredPayPalPaymentProvider } from "../src/paypal-vault-bootstrap.js";

type Call = { url: string; body: unknown };
/** Records requests; answers OAuth, then fails the order call so we can inspect what was sent. */
function recorder() {
  const calls: Call[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/oauth2/token"))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "t",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    calls.push({
      url: String(url),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    });
    return Promise.reject(new Error("stop"));
  }) as typeof fetch;
  return { calls, fetcher };
}
const order = {
  amountValue: "84.00",
  currency: "USD",
  merchantReference: "ref-1",
  requestId: "11111111-1111-4111-8111-111111111111",
};

describe("M6 delegated PayPal instrument (Sandbox only)", () => {
  it("a pre-approved instrument replaces payer-action context and sends no return URLs", async () => {
    const { calls, fetcher } = recorder();
    const p = new PayPalPaymentProvider(
      new PayPalOAuthClient("id", "secret", fetcher),
      fetcher,
      "sandbox",
      undefined,
      { vaultId: "VAULT-1_ok" },
    );
    await p.createOrder(order).catch(() => undefined);
    const sent = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!
      .body as Record<string, unknown>;
    expect(sent.intent).toBe("CAPTURE");
    expect(sent.payment_source).toEqual({ paypal: { vault_id: "VAULT-1_ok" } });
    expect(JSON.stringify(sent)).not.toMatch(
      /return_url|cancel_url|experience_context/,
    );
  });
  it("stored owner instrument is loaded server-side at create time and never needed for observe/capture", async () => {
    const { calls, fetcher } = recorder();
    const store = {
      has: () => Promise.resolve(true),
      get: (principal: string) =>
        Promise.resolve(principal === "owner-1" ? "VAULT_STORED_1" : null),
    };
    const p = new StoredPayPalPaymentProvider(
      new PayPalOAuthClient("id", "secret", fetcher),
      store as never,
      "owner-1",
      fetcher,
    );
    expect(await p.connected()).toBe(true);
    await p.createOrder(order).catch(() => undefined);
    const sent = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!
      .body as { payment_source?: unknown };
    expect(sent.payment_source).toEqual({
      paypal: { vault_id: "VAULT_STORED_1" },
    });
    expect(JSON.stringify(sent)).not.toMatch(/return_url|cancel_url/);
  });
  it("stored provider fails before provider order creation when the owner has no approved instrument", async () => {
    const { calls, fetcher } = recorder();
    const p = new StoredPayPalPaymentProvider(
      new PayPalOAuthClient("id", "secret", fetcher),
      {
        has: () => Promise.resolve(false),
        get: () => Promise.resolve(null),
      } as never,
      "owner-1",
      fetcher,
    );
    expect(await p.connected()).toBe(false);
    await expect(p.createOrder(order)).rejects.toThrow(
      "PAYPAL_DELEGATED_INSTRUMENT_REQUIRED",
    );
    expect(calls.some((c) => c.url.endsWith("/v2/checkout/orders"))).toBe(
      false,
    );
  });
  it("without an instrument the accepted payer-return behavior is unchanged", async () => {
    const { calls, fetcher } = recorder();
    const p = new PayPalPaymentProvider(
      new PayPalOAuthClient("id", "secret", fetcher),
      fetcher,
      "sandbox",
      {
        returnUrl: "https://example.com/r",
        cancelUrl: "https://example.com/c",
      },
    );
    await p.createOrder(order).catch(() => undefined);
    const sent = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!
      .body as { payment_source: { paypal: { experience_context: unknown } } };
    expect(sent.payment_source.paypal.experience_context).toBeDefined();
  });
  it.each(["", " ", "a b", "x".repeat(256), "a/b", "a\nb", "a;b"])(
    "rejects malformed instrument %j",
    (vaultId) => {
      const { fetcher } = recorder();
      expect(
        () =>
          new PayPalPaymentProvider(
            new PayPalOAuthClient("id", "secret", fetcher),
            fetcher,
            "sandbox",
            undefined,
            { vaultId },
          ),
      ).toThrow("PAYPAL_DELEGATED_INSTRUMENT_INVALID");
    },
  );
  it("accepts PayPal vault ids through 255 characters and rejects larger ids", () => {
    const { fetcher } = recorder();
    expect(
      () =>
        new PayPalPaymentProvider(
          new PayPalOAuthClient("id", "secret", fetcher),
          fetcher,
          "sandbox",
          undefined,
          { vaultId: "A".repeat(255) },
        ),
    ).not.toThrow();
    expect(
      () =>
        new PayPalPaymentProvider(
          new PayPalOAuthClient("id", "secret", fetcher),
          fetcher,
          "sandbox",
          undefined,
          { vaultId: "A".repeat(256) },
        ),
    ).toThrow("PAYPAL_DELEGATED_INSTRUMENT_INVALID");
  });
  it("delegated instruments remain Sandbox-only", () => {
    const { fetcher } = recorder();
    expect(
      () =>
        new PayPalPaymentProvider(
          new PayPalOAuthClient("id", "secret", fetcher),
          fetcher,
          "live",
          undefined,
          { vaultId: "VAULT-1" },
        ),
    ).toThrow("PAYPAL_2D_SANDBOX_ONLY");
  });
});
