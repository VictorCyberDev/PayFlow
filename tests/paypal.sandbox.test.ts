import { describe, expect, it } from "vitest";
import { paypalProviderFromEnv } from "../src/paypal.js";

import {
  smokeTestEnabled,
  requireSmokeConfiguration,
} from "./provider-smoke-guard.js";

const enabled = smokeTestEnabled("PAYPAL_SANDBOX", process.env);
const run = enabled ? describe : describe.skip;

run("PayPal Sandbox smoke (opt-in)", () => {
  it("acquires OAuth and creates a CAPTURE order without automating payer credentials", async () => {
    requireSmokeConfiguration("PAYPAL_SANDBOX", process.env);
    const provider = paypalProviderFromEnv();
    const order = await provider.createOrder({
      amountValue: "1.00",
      currency: "USD",
      merchantReference: `sandbox-smoke-${Date.now()}`,
      requestId: `payflow-sandbox-${Date.now()}`,
    });
    expect(order.id.length).toBeGreaterThan(0);
    expect(order.status.length).toBeGreaterThan(0);
    const shown = await provider.getOrder(order.id);
    expect(shown.id).toBe(order.id);
    // PayPal normally requires manual Sandbox payer approval before capture.
    // This smoke test intentionally never stores or automates a payer password.
  });
});
