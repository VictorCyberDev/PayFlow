import {
  FakeIntentModelProvider,
  type IntentModelProvider,
} from "./intent-model.js";
import {
  IntentInterpretationSchema,
  type IntentCompileContext,
} from "./intent.js";
import { IntentReviewService } from "./intent-review.js";
import { DEMO_MERCHANT_ID } from "./commerce.js";

/** Recorded fixture, not an NL parser. Only this exact source has recorded spans. */
export function demoIntentSource(expiresAt: string): string {
  return `Buy a mechanical keyboard; KEYBOARD; at most 100.00 USD; NEW only; only ${DEMO_MERCHANT_ID}; quantity 1; autonomous purchase; no additional confirmation; ${expiresAt}; CREATE_ORDER CAPTURE_PAYMENT`;
}
export function recordedInterpretation(
  source: { reference: string; text: string },
  expiresAt: string,
) {
  const explicit = (value: unknown, quote: string) => {
    const start = source.text.indexOf(quote);
    return {
      state: "EXPLICIT",
      value,
      evidence: [{ start, end: start + quote.length, quote }],
    };
  };
  return IntentInterpretationSchema.parse({
    version: "payflow.intent.v1",
    sourceReference: source.reference,
    constraints: {
      item: explicit("mechanical keyboard", "mechanical keyboard"),
      category: explicit("KEYBOARD", "KEYBOARD"),
      maximum: explicit(
        { decimal: "100.00", bound: "INCLUSIVE" },
        "at most 100.00 USD",
      ),
      currency: explicit("USD", "USD"),
      conditions: explicit(["NEW"], "NEW only"),
      merchants: explicit(
        { mode: "ONLY", ids: [DEMO_MERCHANT_ID] },
        `only ${DEMO_MERCHANT_ID}`,
      ),
      quantity: explicit(1, "quantity 1"),
      autonomousPurchase: explicit(true, "autonomous purchase"),
      confirmationRequired: explicit(false, "no additional confirmation"),
      expiresAt: explicit(expiresAt, expiresAt),
      capabilities: explicit(
        ["CREATE_ORDER", "CAPTURE_PAYMENT"],
        "CREATE_ORDER CAPTURE_PAYMENT",
      ),
    },
    ambiguities: [],
    assumptions: [],
    unsupportedConstraints: [],
  });
}
export const demoReviewBounds = (
  now: Date,
): IntentCompileContext["reviewBounds"] => ({
  maximumMinor: 10000,
  currency: "USD",
  quantity: 1,
  conditions: ["NEW"],
  merchantIds: [DEMO_MERCHANT_ID],
  capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
  expiresAt: new Date(now.getTime() + 86400000).toISOString(),
});
/** No credentials are read, no network model is constructed, no auth is claimed. */
export function createDemoReview(clock: () => Date = () => new Date()) {
  const expiry = new Date(clock().getTime() + 3600000).toISOString();
  const sample = demoIntentSource(expiry);
  const provider: IntentModelProvider = {
    interpretIntent(source) {
      const candidate =
        source.text === sample
          ? recordedInterpretation(source, expiry)
          : IntentInterpretationSchema.parse({
              version: "payflow.intent.v1",
              sourceReference: source.reference,
              constraints: Object.fromEntries(
                [
                  "item",
                  "category",
                  "maximum",
                  "currency",
                  "conditions",
                  "merchants",
                  "quantity",
                  "autonomousPurchase",
                  "confirmationRequired",
                  "expiresAt",
                  "capabilities",
                ].map((field) => [
                  field,
                  {
                    state: "MISSING",
                    reason: "No recorded interpretation for this text",
                  },
                ]),
              ),
              ambiguities: [],
              assumptions: [],
              unsupportedConstraints: [],
            });
      return new FakeIntentModelProvider(candidate).interpretIntent();
    },
  };
  return {
    sample,
    service: new IntentReviewService(provider, demoReviewBounds, clock),
  };
}
