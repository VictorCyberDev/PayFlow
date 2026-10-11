import { describe, expect, it, vi } from "vitest";
import {
  paymentResumeDigest,
  sandboxPayerActionUrl,
} from "../src/payment-resume.js";
import { HumanConfirmationBoundary } from "../src/intent-activation.js";
import { PayPalOAuthClient, PayPalPaymentProvider } from "../src/paypal.js";

const now = new Date("2026-10-11T00:00:00.000Z");
const binding = {
  action: "RESUME_PAYMENT" as const,
  agentId: "a",
  paymentAttemptId: "attempt-a",
  proposalId: "proposal-a",
  paypalOrderId: "ORDER-A",
  challengeHash: paymentResumeDigest("a".repeat(64)),
};
function boundary() {
  return new HumanConfirmationBoundary(
    {
      verify: async (_, exact) => {
        await Promise.resolve();
        expect(exact).toEqual(binding);
        expect(Object.isFrozen(exact)).toBe(true);
        return {
          principalId: "p",
          actor: "HUMAN",
          authenticatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60000).toISOString(),
        };
      },
    },
    () => now,
  );
}
describe("M4D resume authentication and navigation", () => {
  it("domain-separates stored secret digest", () => {
    expect(paymentResumeDigest("a".repeat(64))).toMatch(/^[a-f0-9]{64}$/);
    expect(paymentResumeDigest("a".repeat(64))).not.toBe("a".repeat(64));
    expect(paymentResumeDigest("b".repeat(64))).not.toBe(
      paymentResumeDigest("a".repeat(64)),
    );
  });
  it("permits documented Sandbox payer navigation", () => {
    expect(
      sandboxPayerActionUrl(
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-A",
      ),
    ).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER-A");
  });
  it.each([
    "http://www.sandbox.paypal.com/checkoutnow",
    "https://www.sandbox.paypal.com.evil.test/",
    "https://evil.test/?next=www.sandbox.paypal.com",
    "https://user:secret@www.sandbox.paypal.com/",
    "https://www.paypal.com/",
    "https://www.sandbox.paypal.com:444/",
    "javascript:alert(1)",
    "https://www.sandbox.paypal.com/#secret",
    "x".repeat(2049),
    null,
  ])("rejects unsafe navigation %s", (raw) => {
    expect(() => sandboxPayerActionUrl(raw)).toThrow();
  });
  it.each([
    "paymentAttemptId",
    "proposalId",
    "paypalOrderId",
    "agentId",
    "challengeHash",
    "action",
  ])("authentication cannot be reused after %s substitution", async (field) => {
    const b = boundary(),
      context = await b.authenticate("host-assertion", binding);
    expect(() =>
      b.require(context, {
        ...binding,
        [field]: field === "action" ? "PREPARE_PAYMENT_RESUME" : "other",
      }),
    ).toThrow("AUTHENTICATION_REQUIRED");
  });
  it("caller cannot manufacture an authenticated resume context", () => {
    expect(() =>
      boundary().require({ kind: "AUTHENTICATED_HUMAN_ACTION" }, binding),
    ).toThrow("AUTHENTICATION_REQUIRED");
  });
  it("operator return configuration is frozen and caller overrides never enter provider request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "test-token", expires_in: 300 }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ORDER-A",
            status: "CREATED",
            purchase_units: [
              {
                reference_id: "proposal-a",
                amount: { value: "84.00", currency_code: "USD" },
              },
            ],
          }),
        ),
      );
    const config = {
      returnUrl: "https://host.test/paypal/return",
      cancelUrl: "https://host.test/paypal/cancel",
    };
    const provider = new PayPalPaymentProvider(
      new PayPalOAuthClient("test-id", "test-secret", fetcher),
      fetcher,
      "sandbox",
      config,
    );
    config.returnUrl = "https://evil.test/";
    await provider.createOrder({
      amountValue: "84.00",
      currency: "USD",
      merchantReference: "proposal-a",
      requestId: "stable-create",
    });
    const request = JSON.parse(fetcher.mock.calls[1]![1]!.body as string) as {
      payment_source: unknown;
    };
    expect(request.payment_source).toEqual({
      paypal: {
        experience_context: {
          return_url: "https://host.test/paypal/return",
          cancel_url: "https://host.test/paypal/cancel",
          user_action: "PAY_NOW",
        },
      },
    });
  });
  it.each([
    "http://host.test/return",
    "https://user:secret@host.test/return",
    "https://host.test/return?secret=x",
    "https://host.test/return#x",
  ])("rejects unsafe operator return configuration %s", (returnUrl) => {
    expect(
      () =>
        new PayPalPaymentProvider(
          new PayPalOAuthClient("test", "test"),
          fetch,
          "sandbox",
          { returnUrl, cancelUrl: "https://host.test/cancel" },
        ),
    ).toThrow("PAYPAL_RETURN_CONFIGURATION_INVALID");
  });
});
