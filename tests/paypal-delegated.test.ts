import { describe, expect, it } from "vitest";
import {
  PayPalOAuthClient,
  PayPalPaymentProvider,
  paypalDelegatedProviderFromEnv,
} from "../src/paypal.js";

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
  it.each(["", " ", "a b", "x".repeat(65), "a/b", "a\nb", "a;b"])(
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
  it("is Sandbox-only and requires an explicit instrument and credentials", () => {
    const base = {
      PAYPAL_ENVIRONMENT: "sandbox",
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "s",
      PAYPAL_DELEGATED_VAULT_ID: "VAULT-1",
    };
    expect(() =>
      paypalDelegatedProviderFromEnv({ ...base, PAYPAL_ENVIRONMENT: "live" }),
    ).toThrow("PAYPAL_2D_SANDBOX_ONLY");
    expect(() =>
      paypalDelegatedProviderFromEnv({
        ...base,
        PAYPAL_ENVIRONMENT: undefined,
      }),
    ).toThrow("PAYPAL_2D_SANDBOX_ONLY");
    expect(() =>
      paypalDelegatedProviderFromEnv({
        ...base,
        PAYPAL_DELEGATED_VAULT_ID: undefined,
      }),
    ).toThrow("PAYPAL_DELEGATED_INSTRUMENT_REQUIRED");
    expect(() =>
      paypalDelegatedProviderFromEnv({
        ...base,
        PAYPAL_CLIENT_SECRET: undefined,
      }),
    ).toThrow("PAYPAL_CREDENTIALS_REQUIRED");
    expect(paypalDelegatedProviderFromEnv(base)).toBeInstanceOf(
      PayPalPaymentProvider,
    );
  });
});
