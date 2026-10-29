import { describe, expect, it } from "vitest";
import type { ConsoleSessionPort } from "../src/console-session.js";
import type { PayPalOAuthClient } from "../src/paypal.js";
import {
  ConsolePayPalVaultBootstrap,
  type PayPalVaultStore,
} from "../src/paypal-vault-bootstrap.js";

const authorityId = "622fe9d7-fb08-4cde-8bb8-256e7a2cd94c";

const sessions = {
  mutation: () => Promise.resolve({ session: "ok" }),
  requirePrincipal: () => Promise.resolve("owner-1"),
  ownerRef: () => "a".repeat(64),
} as unknown as ConsoleSessionPort;
const oauth = {
  accessToken: () => Promise.resolve("access-token"),
} as unknown as PayPalOAuthClient;

describe("M6 PayPal vault return routing", () => {
  it("returns approval and cancellation to the same Authority detail", async () => {
    const requests: unknown[] = [];
    const setups: unknown[] = [];
    const fetcher: typeof fetch = (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      requests.push(JSON.parse(body));
      return Promise.resolve(
        new Response(
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
        ),
      );
    };
    const store = {
      putSetup: (input: unknown) => {
        setups.push(input);
        return Promise.resolve();
      },
    } as unknown as PayPalVaultStore;
    const bootstrap = new ConsolePayPalVaultBootstrap(
      sessions,
      oauth,
      store,
      "https://payflow.test",
      fetcher,
    );

    const result = await bootstrap.start({}, { authorityId });
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
    const fetcher: typeof fetch = () => {
      called = true;
      return Promise.reject(new Error("must not call provider"));
    };
    const bootstrap = new ConsolePayPalVaultBootstrap(
      sessions,
      oauth,
      {} as unknown as PayPalVaultStore,
      "https://payflow.test",
      fetcher,
    );
    await expect(
      bootstrap.start({}, { authorityId: "not-an-authority" }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
