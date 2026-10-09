import { describe, expect, it, vi } from "vitest";
import {
  PayPalOAuthClient,
  PayPalPaymentProvider,
  PayPalProviderError,
  paypalMoney,
  withinPayPalRetryWindow,
} from "../src/paypal.js";

describe("Milestone 2D PayPal provider", () => {
  it("serializes integer minor units without floating point", () => {
    expect(paypalMoney(8900, "USD")).toBe("89.00");
    expect(paypalMoney(89, "JPY")).toBe("89");
    expect(() => paypalMoney(0, "USD")).toThrow("INVALID_MONEY_MINOR");
    expect(() => paypalMoney(-1, "USD")).toThrow("INVALID_MONEY_MINOR");
    expect(() => paypalMoney(100, "ZZZ")).toThrow(
      "UNSUPPORTED_PAYPAL_CURRENCY",
    );
  });

  it("acquires, caches and refreshes OAuth tokens without exposing credentials", async () => {
    let now = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "secret-token-1", expires_in: 60 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "secret-token-2", expires_in: 60 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const oauth = new PayPalOAuthClient(
      "client",
      "super-secret",
      fetcher,
      () => now,
    );
    expect(await oauth.accessToken()).toBe("secret-token-1");
    expect(await oauth.accessToken()).toBe("secret-token-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 31_001;
    expect(await oauth.accessToken()).toBe("secret-token-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent token refreshes", async () => {
    const fetcher = vi.fn(
      async () => (
        await Promise.resolve(),
        new Response(
          JSON.stringify({ access_token: "token", expires_in: 60 }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      ),
    );
    const oauth = new PayPalOAuthClient("client", "secret", fetcher);
    expect(
      await Promise.all([
        oauth.accessToken(),
        oauth.accessToken(),
        oauth.accessToken(),
      ]),
    ).toEqual(["token", "token", "token"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on OAuth rejection", async () => {
    const fetcher = vi.fn(
      async () => (
        await Promise.resolve(),
        new Response("no", { status: 401 })
      ),
    );
    const oauth = new PayPalOAuthClient("client", "secret", fetcher);
    await expect(oauth.accessToken()).rejects.toMatchObject({
      classification: "AUTHENTICATION",
      message: "PAYPAL_OAUTH_REJECTED",
    });
  });

  it("uses stable caller-provided request IDs for distinct create and capture operations", async () => {
    const calls: Array<{ url: string; requestId: string | null }> = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        await Promise.resolve();
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : input;
        if (url.endsWith("/v1/oauth2/token"))
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        calls.push({
          url,
          requestId: new Headers(init?.headers).get("PayPal-Request-Id"),
        });
        return new Response(
          JSON.stringify({
            id: "ORDER-1",
            status: "APPROVED",
            purchase_units: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const provider = new PayPalPaymentProvider(
      new PayPalOAuthClient("client", "secret", fetcher),
      fetcher,
    );
    await provider.createOrder({
      amountValue: "89.00",
      currency: "USD",
      merchantReference: "proposal-1",
      requestId: "create-stable",
    });
    await provider.createOrder({
      amountValue: "89.00",
      currency: "USD",
      merchantReference: "proposal-1",
      requestId: "create-stable",
    });
    await provider.captureOrder("ORDER-1", "capture-stable");
    expect(calls.map((c) => c.requestId)).toEqual([
      "create-stable",
      "create-stable",
      "capture-stable",
    ]);
  });

  it("classifies ambiguous 5xx after a side-effect request", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      await Promise.resolve();
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : input;
      return url.endsWith("/v1/oauth2/token")
        ? new Response(
            JSON.stringify({ access_token: "token", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("oops", { status: 503 });
    });
    const provider = new PayPalPaymentProvider(
      new PayPalOAuthClient("client", "secret", fetcher),
      fetcher,
    );
    await expect(
      provider.captureOrder("ORDER-1", "capture-stable"),
    ).rejects.toBeInstanceOf(PayPalProviderError);
    await expect(
      provider.captureOrder("ORDER-1", "capture-stable"),
    ).rejects.toMatchObject({ classification: "AMBIGUOUS" });
  });

  it("rejects live mode", () => {
    const fetcher = vi.fn();
    const oauth = new PayPalOAuthClient("client", "secret", fetcher);
    expect(() => new PayPalPaymentProvider(oauth, fetcher, "live")).toThrow(
      "PAYPAL_2D_SANDBOX_ONLY",
    );
  });
  it("preserves purchase-unit and capture bindings from Show Order and requests full representations", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        await Promise.resolve();
        const url = input instanceof Request ? input.url : String(input);
        if (!url.endsWith("/v1/oauth2/token"))
          expect(new Headers(init?.headers).get("Prefer")).toBe(
            "return=representation",
          );
        return new Response(
          JSON.stringify(
            url.endsWith("/v1/oauth2/token")
              ? { access_token: "token", expires_in: 3600 }
              : {
                  id: "ORDER-1",
                  status: "COMPLETED",
                  purchase_units: [
                    {
                      reference_id: "proposal-1",
                      amount: { value: "89.00", currency_code: "USD" },
                      payments: {
                        captures: [
                          {
                            id: "CAPTURE-1",
                            status: "COMPLETED",
                            amount: { value: "89.00", currency_code: "USD" },
                          },
                        ],
                      },
                    },
                  ],
                },
          ),
          { status: 200 },
        );
      },
    );
    const provider = new PayPalPaymentProvider(
      new PayPalOAuthClient("client", "secret", fetcher),
      fetcher,
    );
    const order = await provider.getOrder("ORDER-1");
    expect(order).toMatchObject({
      id: "ORDER-1",
      status: "COMPLETED",
      purchaseUnits: [
        { referenceId: "proposal-1", amountValue: "89.00", currency: "USD" },
      ],
      captures: [
        {
          id: "CAPTURE-1",
          status: "COMPLETED",
          amountValue: "89.00",
          currency: "USD",
        },
      ],
    });
    // Inspect the actual adapter HTTP request, not a mocked normalized view.
    const request = fetcher.mock.calls[1];
    expect(request?.[0]).toBe(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1",
    );
    expect(new Headers(request?.[1]?.headers).get("Prefer")).toBe(
      "return=representation",
    );
  });

  it("keeps malformed purchase-unit bindings ambiguous after capture and rejects them on GET", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      await Promise.resolve();
      const url = input instanceof Request ? input.url : String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/v1/oauth2/token")
            ? { access_token: "token", expires_in: 3600 }
            : {
                id: "ORDER-1",
                status: "COMPLETED",
                purchase_units: [{ reference_id: "" }],
              },
        ),
        { status: 200 },
      );
    });
    const provider = new PayPalPaymentProvider(
      new PayPalOAuthClient("client", "secret", fetcher),
      fetcher,
    );
    await expect(provider.getOrder("ORDER-1")).rejects.toMatchObject({
      classification: "MALFORMED",
    });
    await expect(
      provider.captureOrder("ORDER-1", "persisted-capture-key"),
    ).rejects.toMatchObject({ classification: "AMBIGUOUS" });
  });
});

describe("2E provider uncertainty, retention and redaction", () => {
  it.each([
    [-1, false],
    [0, true],
    [21599999, true],
    [21600000, false],
    [21600001, false],
  ])("retry window offset %i is safe=%s", (offset, safe) => {
    const origin = new Date("2026-10-09T12:00:00.123Z");
    expect(
      withinPayPalRetryWindow(
        origin,
        new Date(origin.getTime() + offset).toISOString(),
      ),
    ).toBe(safe);
  });
  it.each(["invalid", "infinity", null])(
    "invalid persisted retry origin %s cannot authorize a retry",
    (origin) => {
      expect(withinPayPalRetryWindow(origin, "2026-10-09T12:00:00.000Z")).toBe(
        false,
      );
    },
  );
  it("malformed reconciliation clock cannot authorize a retry", () => {
    expect(withinPayPalRetryWindow(new Date(), "invalid")).toBe(false);
  });
  it.each(["network", "malformed JSON", "5xx", "401"])(
    "capture %s never exposes credentials or provider bodies",
    async (failure) => {
      const sentinel = "SECRET_SENTINEL_DO_NOT_PERSIST";
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        await Promise.resolve();
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : input;
        if (path.includes("oauth2"))
          return new Response(
            JSON.stringify({ access_token: sentinel, expires_in: 60 }),
          );
        if (failure === "network") throw new Error(sentinel);
        if (failure === "malformed JSON")
          return new Response(sentinel, { status: 200 });
        return new Response(sentinel, {
          status: failure === "5xx" ? 503 : 401,
        });
      });
      const provider = new PayPalPaymentProvider(
        new PayPalOAuthClient("client", sentinel, fetcher),
        fetcher,
      );
      const result = await provider
        .captureOrder("order", "persisted-key")
        .catch((error) => error as PayPalProviderError);
      expect(result).toBeInstanceOf(PayPalProviderError);
      if (!(result instanceof PayPalProviderError))
        throw new Error("EXPECTED_PROVIDER_ERROR");
      expect(JSON.stringify(result) + result.message).not.toContain(sentinel);
      expect(result.classification).toBe(
        failure === "401" ? "AUTHENTICATION" : "AMBIGUOUS",
      );
    },
  );
});
