import { describe, expect, it } from "vitest";
import {
  assertPayPalTransitions,
  paypalTransitionOracle,
} from "./helpers/paypal-state-oracle.js";
describe("M3F bounded PayPal state-machine oracle", () => {
  it("enumerates legal transitions and rejects every unlisted edge", () => {
    for (const [from, legal] of Object.entries(paypalTransitionOracle))
      for (const to of Object.keys(paypalTransitionOracle)) {
        if (legal.includes(to))
          expect(() => assertPayPalTransitions([from, to])).not.toThrow();
        else
          expect(() => assertPayPalTransitions([from, to])).toThrow(
            "ILLEGAL_PAYMENT_TRANSITION",
          );
      }
  });
  it("models persisted-key recovery and terminal observation without resurrecting dispatch", () => {
    assertPayPalTransitions([
      "NOT_STARTED",
      "ORDER_CREATING",
      "ORDER_CREATE_UNKNOWN",
      "ORDER_CREATING",
      "ORDER_CREATED",
      "CAPTURE_IN_FLIGHT",
      "CAPTURE_UNKNOWN",
      "CAPTURE_IN_FLIGHT",
      "CAPTURE_UNKNOWN",
      "CAPTURED",
      "CAPTURED",
    ]);
    expect(() =>
      assertPayPalTransitions(["CAPTURED", "CAPTURE_IN_FLIGHT"]),
    ).toThrow();
    expect(() =>
      assertPayPalTransitions(["NOT_STARTED", "CAPTURED"]),
    ).toThrow();
    expect(() => assertPayPalTransitions(["FUTURE_STATE"])).toThrow(
      "UNKNOWN_PAYMENT_STATE",
    );
    expect(() => assertPayPalTransitions([])).toThrow("UNKNOWN_PAYMENT_STATE");
  });
});
