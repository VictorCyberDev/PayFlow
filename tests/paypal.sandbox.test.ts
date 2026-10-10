import { describe, expect, it } from "vitest";
import { paypalProviderFromEnv } from "../src/paypal.js";

const enabled =
  process.env.PAYPAL_CLIENT_ID &&
  process.env.PAYPAL_CLIENT_SECRET &&
  process.env.PAYPAL_ENVIRONMENT === "sandbox";
const run = enabled ? describe : describe.skip;

run("PayPal Sandbox smoke (opt-in)", () => {
  it("acquires OAuth and creates a CAPTURE order without automating payer credentials", async () => {
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
