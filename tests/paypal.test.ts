import { describe, expect, it, vi } from "vitest";
import { PayPalOAuthClient, PayPalPaymentProvider, PayPalProviderError, paypalMoney } from "../src/paypal.js";

describe("Milestone 2D PayPal provider", () => {
  it("serializes integer minor units without floating point", () => {
    expect(paypalMoney(8900, "USD")).toBe("89.00");
    expect(paypalMoney(89, "JPY")).toBe("89");
    expect(() => paypalMoney(0, "USD")).toThrow("INVALID_MONEY_MINOR");
    expect(() => paypalMoney(-1, "USD")).toThrow("INVALID_MONEY_MINOR");
    expect(() => paypalMoney(100, "ZZZ")).toThrow("UNSUPPORTED_PAYPAL_CURRENCY");
  });

  it("acquires, caches and refreshes OAuth tokens without exposing credentials", async () => {
    let now = 0;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "secret-token-1", expires_in: 60 }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "secret-token-2", expires_in: 60 }), { status: 200, headers: { "content-type": "application/json" } }));
    const oauth = new PayPalOAuthClient("client", "super-secret", fetcher as typeof fetch, () => now);
    expect(await oauth.accessToken()).toBe("secret-token-1");
    expect(await oauth.accessToken()).toBe("secret-token-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 31_001;
    expect(await oauth.accessToken()).toBe("secret-token-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent token refreshes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: "token", expires_in: 60 }), { status: 200, headers: { "content-type": "application/json" } }));
    const oauth = new PayPalOAuthClient("client", "secret", fetcher as typeof fetch);
    expect(await Promise.all([oauth.accessToken(), oauth.accessToken(), oauth.accessToken()])).toEqual(["token", "token", "token"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on OAuth rejection", async () => {
    const fetcher = vi.fn(async () => new Response("no", { status: 401 }));
    const oauth = new PayPalOAuthClient("client", "secret", fetcher as typeof fetch);
    await expect(oauth.accessToken()).rejects.toMatchObject({ classification: "AUTHENTICATION", message: "PAYPAL_OAUTH_REJECTED" });
  });

  it("uses stable caller-provided request IDs for distinct create and capture operations", async () => {
    const calls: Array<{ url: string; requestId: string | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
      calls.push({ url, requestId: new Headers(init?.headers).get("PayPal-Request-Id") });
      return new Response(JSON.stringify({ id: "ORDER-1", status: "APPROVED", purchase_units: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new PayPalPaymentProvider(new PayPalOAuthClient("client", "secret", fetcher as typeof fetch), fetcher as typeof fetch);
    await provider.createOrder({ amountValue: "89.00", currency: "USD", merchantReference: "proposal-1", requestId: "create-stable" });
    await provider.createOrder({ amountValue: "89.00", currency: "USD", merchantReference: "proposal-1", requestId: "create-stable" });
    await provider.captureOrder("ORDER-1", "capture-stable");
    expect(calls.map((c) => c.requestId)).toEqual(["create-stable", "create-stable", "capture-stable"]);
  });

  it("classifies ambiguous 5xx after a side-effect request", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/v1/oauth2/token")
      ? new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("oops", { status: 503 }));
    const provider = new PayPalPaymentProvider(new PayPalOAuthClient("client", "secret", fetcher as typeof fetch), fetcher as typeof fetch);
    await expect(provider.captureOrder("ORDER-1", "capture-stable")).rejects.toBeInstanceOf(PayPalProviderError);
    await expect(provider.captureOrder("ORDER-1", "capture-stable")).rejects.toMatchObject({ classification: "AMBIGUOUS" });
  });

  it("rejects live mode", () => {
    const fetcher = vi.fn();
    const oauth = new PayPalOAuthClient("client", "secret", fetcher as typeof fetch);
    expect(() => new PayPalPaymentProvider(oauth, fetcher as typeof fetch, "live")).toThrow("PAYPAL_2D_SANDBOX_ONLY");
  });
});
