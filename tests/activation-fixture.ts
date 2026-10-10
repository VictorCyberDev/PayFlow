import type {
  IntentInterpretation,
  IntentCompileContext,
} from "../src/intent.js";
const source =
  "wireless keyboard; KEYBOARD; under 100.00 USD; NEW only; only Amazon; quantity 1; autonomous purchase; no additional confirmation; 2026-11-01T00:00:00.000Z; SEARCH_PRODUCTS EVALUATE_PRODUCTS CREATE_ORDER CAPTURE_PAYMENT";
export function activationFixture(text = source): {
  candidate: IntentInterpretation;
  context: IntentCompileContext;
} {
  function explicit<T>(value: T, quote: string) {
    const start = text.indexOf(quote);
    return {
      state: "EXPLICIT" as const,
      value,
      evidence: [{ start, end: start + quote.length, quote }],
    };
  }
  return {
    context: {
      source: { reference: "message-1", text },
      now: "2026-10-10T00:00:00.000Z",
      reviewBounds: {
        maximumMinor: 9999,
        currency: "USD",
        quantity: 1,
        conditions: ["NEW"],
        merchantIds: ["Amazon"],
        autonomousPurchase: true,
        confirmationRequired: false,
        capabilities: [
          "SEARCH_PRODUCTS",
          "EVALUATE_PRODUCTS",
          "CREATE_ORDER",
          "CAPTURE_PAYMENT",
        ],
        expiresAt: "2026-11-01T00:00:00.000Z",
      },
    },
    candidate: {
      version: "payflow.intent.v1",
      sourceReference: "message-1",
      constraints: {
        item: explicit("wireless keyboard", "wireless keyboard"),
        category: explicit("KEYBOARD", "KEYBOARD"),
        maximum: explicit(
          { decimal: "100.00", bound: "EXCLUSIVE" },
          "under 100.00 USD",
        ),
        currency: explicit("USD", "USD"),
        conditions: explicit(["NEW"], "NEW only"),
        merchants: explicit({ mode: "ONLY", ids: ["Amazon"] }, "only Amazon"),
        quantity: explicit(1, "quantity 1"),
        autonomousPurchase: explicit(true, "autonomous purchase"),
        confirmationRequired: explicit(false, "no additional confirmation"),
        expiresAt: explicit(
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:00.000Z",
        ),
        capabilities: explicit(
          [
            "SEARCH_PRODUCTS",
            "EVALUATE_PRODUCTS",
            "CREATE_ORDER",
            "CAPTURE_PAYMENT",
          ],
          "SEARCH_PRODUCTS EVALUATE_PRODUCTS CREATE_ORDER CAPTURE_PAYMENT",
        ),
      },
      ambiguities: [],
      assumptions: [],
      unsupportedConstraints: [],
    },
  };
}
