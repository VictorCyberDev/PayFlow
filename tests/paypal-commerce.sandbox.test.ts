import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { paypalProviderFromEnv } from "../src/paypal.js";
import {
  paypalCommerceRequest,
  verifyPayPalCommerce,
} from "../src/paypal-commerce.js";
import { CheckoutManifestSchema } from "../src/checkout-contracts.js";
import { checkoutFixture } from "./checkout-fixture.js";
import { requireSmokeConfiguration } from "./provider-smoke-guard.js";

const enabled = process.env.RUN_PAYPAL_SANDBOX_SMOKE === "true";

function boundedText(value: unknown, maximum = 256): string | undefined {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

async function diagnosticFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!response.ok && url.includes("/v2/checkout/orders")) {
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      body = undefined;
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const details = Array.isArray(record.details)
      ? record.details.slice(0, 10).map((entry) => {
          const detail = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          return {
            issue: boundedText(detail.issue, 128),
            description: boundedText(detail.description),
            field: boundedText(detail.field, 256),
            location: boundedText(detail.location, 64),
          };
        })
      : [];
    console.error("PAYPAL_SANDBOX_REJECTION_DIAGNOSTIC", {
      status: response.status,
      debugId: boundedText(response.headers.get("paypal-debug-id"), 128),
      name: boundedText(record.name, 128),
      message: boundedText(record.message),
      details,
    });
  }
  return response;
}

(enabled ? describe : describe.skip)(
  "real PayPal commerce conformance (explicit opt-in)",
  () => {
    it("verifies operator recipient and exact Show Order terms; capture acceptance requires a completed existing order", async () => {
      requireSmokeConfiguration("PAYPAL_SANDBOX", process.env);
      const recipient = process.env.PAYPAL_EXPECTED_MERCHANT_ID;
      if (
        !recipient ||
        !/^[A-Z0-9]{13}$/.test(recipient) ||
        recipient.startsWith("DEMOACCOUNT")
      )
        throw new Error("REAL_SANDBOX_RECIPIENT_CONFIGURATION_REQUIRED");
      const manifest = CheckoutManifestSchema.parse({
        ...checkoutFixture().manifest,
        expectedPayPalMerchantId: recipient,
      });
      const provider = paypalProviderFromEnv(process.env, diagnosticFetch),
        existing = process.env.PAYPAL_CONFORMANCE_ORDER_ID;
      const reference = "payflow-sandbox-commerce-conformance";
      const orderId =
        existing ??
        (
          await provider.createOrder({
            amountValue: "84.00",
            currency: "USD",
            merchantReference: reference,
            requestId: randomUUID(),
            commerce: paypalCommerceRequest(manifest),
          })
        ).id;
      const shown = await provider.getOrder(orderId);
      expect(shown.id).toBe(orderId);
      verifyPayPalCommerce(manifest, shown, !!existing);
      expect(shown.purchaseUnits[0]!.referenceId).toBe(reference);
      if (existing) {
        expect(shown.status).toBe("COMPLETED");
        expect(shown.captures).toHaveLength(1);
        expect(shown.captures[0]!.status).toBe("COMPLETED");
      }
      // This test never bypasses PayFlow authority to capture. Operator completes
      // an approved order through the financial rail, then uses readonly GET acceptance.
      console.log({
        orderId,
        orderConformance: "VERIFIED",
        captureConformance: existing
          ? "VERIFIED"
          : "PENDING_REAL_CAPTURE_ACCEPTANCE",
      });
    });
  },
);
