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
      const provider = paypalProviderFromEnv(),
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
