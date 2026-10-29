import { describe, expect, it } from "vitest";
import { ConsolePayPalVaultBootstrap } from "../src/paypal-vault-bootstrap.js";

const authorityId = "622fe9d7-fb08-4cde-8bb8-256e7a2cd94c";

describe("M6 PayPal vault return routing", () => {
  it("returns approval and cancellation to the same Authority detail", async () => {
    const requests: unknown[] = [];
    const setups: unknown[] = [];
    const fetcher = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          id: "SETUP-TOKEN-1",
          links: [
            {
              rel: "approve",
              href: "https://www.sandbox.paypal.com/checkoutnow?token=SETUP-TOKEN-1",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const bootstrap = new ConsolePayPalVaultBootstrap(
      {
        mutation: async () => ({ session: "ok" }),
        requirePrincipal: async () => "owner-1",
        ownerRef: () => "a".repeat(64),
      } as never,
      { accessToken: async () => "access-token" } as never,
      { putSetup: async (input: unknown) => setups.push(input) } as never,
      "https://payflow.test",
      fetcher,
    );

    const result = await bootstrap.start({} as never, { authorityId });
    expect(result.version).toBe("payflow.paypal-vault-start.v2");
    const sent = requests[0] as {
      payment_source: {
        paypal: {
          experience_context: { return_url: string; cancel_url: string };
        };
      };
    };
    const returnUrl = new URL(
      sent.payment_source.paypal.experience_context.return_url,
    );
    const cancelUrl = new URL(
      sent.payment_source.paypal.experience_context.cancel_url,
    );
    expect(returnUrl.origin).toBe("https://payflow.test");
    expect(returnUrl.pathname).toBe("/authorities/");
    expect(returnUrl.searchParams.get("id")).toBe(authorityId);
    expect(returnUrl.searchParams.get("paypal")).toBe("approved");
    expect(returnUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cancelUrl.searchParams.get("id")).toBe(authorityId);
    expect(cancelUrl.searchParams.get("paypal")).toBe("cancelled");
    expect(setups).toHaveLength(1);
  });

  it("rejects a malformed Authority selector before contacting PayPal", async () => {
    let called = false;
    const bootstrap = new ConsolePayPalVaultBootstrap(
      {} as never,
      {} as never,
      {} as never,
      "https://payflow.test",
      (async () => {
        called = true;
        throw new Error("must not call provider");
      }) as typeof fetch,
    );
    await expect(
      bootstrap.start({} as never, { authorityId: "not-an-authority" }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
