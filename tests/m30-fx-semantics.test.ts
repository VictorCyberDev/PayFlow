import { describe, expect, it } from "vitest";
import {
  FinancialActionSchema,
  MonetaryBoundarySchema,
  convertMinorHalfUp,
  evaluateMonetaryBoundary,
} from "../src/network/financial-action.js";

const boundary = MonetaryBoundarySchema.parse({
  settlementCurrencies: ["USD"],
  maxAmountMinor: 1_000_000,
  maxFeesMinor: 500,
  maxTaxesMinor: 1_000,
  maxFxSlippageBps: 50,
  allowFx: true,
});

function action(
  overrides: Record<string, unknown> = {},
  fx: Record<string, unknown> | null = {},
) {
  return FinancialActionSchema.parse({
    version: "financial-action/v1",
    id: "fx-1",
    kind: "PURCHASE",
    principalId: "p1",
    agentId: "a1",
    counterparty: { id: "vendor-1" },
    amount: { currency: "USD", minor: 10_800 },
    purpose: "fx purchase",
    proposedAt: "2026-10-28T03:00:00.000Z",
    idempotencyKey: "fx-idempotency-key-001",
    ...(fx === null
      ? {}
      : {
          fx: {
            sourceCurrency: "EUR",
            settlementCurrency: "USD",
            rateNumerator: 108,
            rateDenominator: 100,
            observedSlippageBps: 0,
            sourceAmountMinor: 10_000,
            ...fx,
          },
        }),
    ...overrides,
  });
}

describe("M30 deterministic conversion", () => {
  it("rounds half up with integers only", () => {
    expect(convertMinorHalfUp(10_000, 108, 100)).toBe(10_800);
    expect(convertMinorHalfUp(1, 1, 2)).toBe(1); // 0.5 -> 1
    expect(convertMinorHalfUp(1, 1, 3)).toBe(0); // 0.333 -> 0
    expect(convertMinorHalfUp(2, 1, 3)).toBe(1); // 0.667 -> 1
    expect(convertMinorHalfUp(3, 1, 2)).toBe(2); // 1.5 -> 2
    // 0.1 + 0.2 style float traps do not exist.
    expect(convertMinorHalfUp(10, 3, 10)).toBe(3);
  });

  it("returns null instead of an unsafe integer", () => {
    expect(
      convertMinorHalfUp(Number.MAX_SAFE_INTEGER, 1_000_000, 1),
    ).toBeNull();
  });

  it("accepts an honest conversion within the slippage allowance", () => {
    expect(evaluateMonetaryBoundary(action(), boundary)).toEqual([]);
    // 50 bps of 10,800 = 54 minor units of allowed deviation.
    expect(
      evaluateMonetaryBoundary(
        action({ amount: { currency: "USD", minor: 10_854 } }),
        boundary,
      ),
    ).toEqual([]);
  });

  it("rejects a settlement that deviates beyond the allowance even if the agent reports 0 slippage", () => {
    const violations = evaluateMonetaryBoundary(
      action(
        { amount: { currency: "USD", minor: 10_855 } },
        { observedSlippageBps: 0 },
      ),
      boundary,
    );
    expect(violations).toEqual(["FX_CONVERSION_MISMATCH"]);
  });

  it("without a trusted reference rate only internal consistency can be checked", () => {
    // Rate and amount agree with each other, so nothing contradicts them locally.
    expect(
      evaluateMonetaryBoundary(
        action(
          { amount: { currency: "USD", minor: 20_000 } },
          { rateNumerator: 200, rateDenominator: 100 },
        ),
        boundary,
      ),
    ).toEqual([]);
    // A lie that contradicts the declared rate is still caught.
    expect(
      evaluateMonetaryBoundary(
        action({ amount: { currency: "USD", minor: 20_000 } }),
        boundary,
      ),
    ).toEqual(["FX_CONVERSION_MISMATCH"]);
  });

  it("an Authority-fixed reference rate defeats an inflated agent-supplied rate", () => {
    const pinned = MonetaryBoundarySchema.parse({
      ...boundary,
      referenceRate: { numerator: 108, denominator: 100 },
    });
    const violations = evaluateMonetaryBoundary(
      action(
        { amount: { currency: "USD", minor: 20_000 } },
        { rateNumerator: 200, rateDenominator: 100 },
      ),
      pinned,
    );
    expect(violations).toEqual(["FX_CONVERSION_MISMATCH"]);
    expect(evaluateMonetaryBoundary(action(), pinned)).toEqual([]);
  });

  it("requires the quoted source amount so the conversion can be verified at all", () => {
    const violations = evaluateMonetaryBoundary(
      action({}, { sourceAmountMinor: undefined }),
      boundary,
    );
    expect(violations).toEqual(["FX_SOURCE_AMOUNT_REQUIRED"]);
  });

  it("still denies FX entirely when the Authority does not allow it", () => {
    const strict = MonetaryBoundarySchema.parse({
      ...boundary,
      allowFx: false,
    });
    expect(evaluateMonetaryBoundary(action(), strict)).toEqual(["FX_DENIED"]);
  });

  it("denies unexpected settlement-currency substitution and merchant surcharge widening", () => {
    const substituted = FinancialActionSchema.parse({
      ...action({}, null),
      amount: { currency: "EUR", minor: 10_000 },
    });
    expect(evaluateMonetaryBoundary(substituted, boundary)).toContain(
      "SETTLEMENT_CURRENCY_DENIED",
    );
    const surcharge = action({
      fees: [
        { currency: "USD", minor: 300 },
        { currency: "USD", minor: 300 },
      ],
    });
    expect(evaluateMonetaryBoundary(surcharge, boundary)).toContain(
      "FEE_BOUNDARY_EXCEEDED",
    );
  });

  it("rejects fee/tax currency that differs from the settlement amount at the schema boundary", () => {
    expect(() => action({ fees: [{ currency: "EUR", minor: 1 }] })).toThrow();
    expect(() => action({}, { settlementCurrency: "GBP" })).toThrow();
  });

  it("detects integer overflow in fee accumulation", () => {
    const huge = action({
      fees: [
        { currency: "USD", minor: Number.MAX_SAFE_INTEGER },
        { currency: "USD", minor: Number.MAX_SAFE_INTEGER },
      ],
    });
    expect(evaluateMonetaryBoundary(huge, boundary)).toEqual([
      "INTEGER_OVERFLOW",
    ]);
  });
});
