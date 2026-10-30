import { z } from "zod";

export const FinancialActionKindSchema = z.enum([
  "PURCHASE",
  "INVOICE_SETTLEMENT",
  "SUBSCRIPTION_RENEWAL",
  "PAYOUT",
  "REIMBURSEMENT",
  "PROCUREMENT_ORDER",
  "RECURRING_PAYMENT",
  "MARKETPLACE_DISBURSEMENT",
  "MACHINE_RESOURCE_PURCHASE",
]);
export type FinancialActionKind = z.infer<typeof FinancialActionKindSchema>;

const PositiveMoneySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    minor: z.number().int().safe().positive(),
  })
  .strict();

const NonnegativeMoneySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    minor: z.number().int().safe().nonnegative(),
  })
  .strict();

export const FinancialActionSchema = z
  .object({
    version: z.literal("financial-action/v1"),
    id: z.string().min(1),
    kind: FinancialActionKindSchema,
    principalId: z.string().min(1),
    agentId: z.string().min(1),
    counterparty: z
      .object({
        id: z.string().min(1),
        displayName: z.string().min(1).optional(),
      })
      .strict(),
    amount: PositiveMoneySchema,
    fees: z.array(NonnegativeMoneySchema).max(20).default([]),
    taxes: z.array(NonnegativeMoneySchema).max(20).default([]),
    quantity: z.number().int().safe().positive().max(1_000_000).optional(),
    items: z
      .array(
        z
          .object({
            sku: z.string().min(1).max(256),
            quantity: z.number().int().safe().positive().max(1_000_000),
            unitPriceMinor: z.number().int().safe().nonnegative(),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    purpose: z.string().min(1).max(1024),
    costCenter: z.string().min(1).max(128).optional(),
    invoiceReference: z.string().min(1).max(256).optional(),
    recurringKey: z.string().min(1).max(256).optional(),
    fx: z
      .object({
        sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
        settlementCurrency: z.string().regex(/^[A-Z]{3}$/),
        rateNumerator: z.number().int().safe().positive(),
        rateDenominator: z.number().int().safe().positive(),
        observedSlippageBps: z.number().int().safe().nonnegative().max(100_000),
        /** Quoted amount in sourceCurrency (minor units). Required to verify the conversion. */
        sourceAmountMinor: z.number().int().safe().positive().optional(),
      })
      .strict()
      .optional(),
    proposedAt: z.string().datetime(),
    idempotencyKey: z.string().min(16).max(256),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .superRefine((action, context) => {
    for (const component of [...action.fees, ...action.taxes]) {
      if (component.currency !== action.amount.currency) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fee/tax currency must equal settlement amount currency",
        });
      }
    }
    if (action.fx && action.fx.settlementCurrency !== action.amount.currency) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "FX settlement currency must equal action amount currency",
      });
    }
  });
export type FinancialAction = Readonly<z.infer<typeof FinancialActionSchema>>;

export const MonetaryBoundarySchema = z
  .object({
    settlementCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    maxAmountMinor: z.number().int().safe().positive(),
    maxFeesMinor: z.number().int().safe().nonnegative(),
    maxTaxesMinor: z.number().int().safe().nonnegative(),
    maxFxSlippageBps: z.number().int().safe().nonnegative().max(100_000),
    allowFx: z.boolean(),
    /**
     * Trusted quote the Authority fixed for FX (never agent-supplied). When
     * present the conversion is recomputed from it; without it only the
     * action's own rate can be checked for internal consistency.
     */
    referenceRate: z
      .object({
        numerator: z.number().int().safe().positive(),
        denominator: z.number().int().safe().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MonetaryBoundary = Readonly<z.infer<typeof MonetaryBoundarySchema>>;

export type MonetaryViolation =
  | "SETTLEMENT_CURRENCY_DENIED"
  | "AMOUNT_EXCEEDS_BOUNDARY"
  | "FEE_BOUNDARY_EXCEEDED"
  | "TAX_BOUNDARY_EXCEEDED"
  | "FX_DENIED"
  | "FX_SLIPPAGE_EXCEEDED"
  | "FX_SOURCE_AMOUNT_REQUIRED"
  | "FX_CONVERSION_MISMATCH"
  | "INTEGER_OVERFLOW";

function safeSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/**
 * Deterministic integer conversion: round-half-up of source * numerator /
 * denominator, computed with BigInt so no floating-point rounding can widen
 * or narrow the result. Returns null when the result is not a safe integer.
 */
export function convertMinorHalfUp(
  sourceMinor: number,
  rateNumerator: number,
  rateDenominator: number,
): number | null {
  const numerator = BigInt(sourceMinor) * BigInt(rateNumerator);
  const denominator = BigInt(rateDenominator);
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

export function evaluateMonetaryBoundary(
  action: FinancialAction,
  boundary: MonetaryBoundary,
): readonly MonetaryViolation[] {
  const violations: MonetaryViolation[] = [];
  if (!boundary.settlementCurrencies.includes(action.amount.currency)) {
    violations.push("SETTLEMENT_CURRENCY_DENIED");
  }
  if (action.amount.minor > boundary.maxAmountMinor) {
    violations.push("AMOUNT_EXCEEDS_BOUNDARY");
  }
  const feeTotal = safeSum(action.fees.map((fee) => fee.minor));
  const taxTotal = safeSum(action.taxes.map((tax) => tax.minor));
  if (feeTotal === null || taxTotal === null) {
    violations.push("INTEGER_OVERFLOW");
    return violations;
  }
  if (feeTotal > boundary.maxFeesMinor)
    violations.push("FEE_BOUNDARY_EXCEEDED");
  if (taxTotal > boundary.maxTaxesMinor)
    violations.push("TAX_BOUNDARY_EXCEEDED");
  if (action.fx) {
    if (!boundary.allowFx) violations.push("FX_DENIED");
    if (action.fx.observedSlippageBps > boundary.maxFxSlippageBps) {
      violations.push("FX_SLIPPAGE_EXCEEDED");
    }
    // The agent-reported slippage is untrusted: recompute the conversion ourselves.
    if (boundary.allowFx) {
      if (action.fx.sourceAmountMinor === undefined) {
        violations.push("FX_SOURCE_AMOUNT_REQUIRED");
      } else {
        const expected = convertMinorHalfUp(
          action.fx.sourceAmountMinor,
          boundary.referenceRate?.numerator ?? action.fx.rateNumerator,
          boundary.referenceRate?.denominator ?? action.fx.rateDenominator,
        );
        const allowed =
          expected === null
            ? 0
            : Math.floor((expected * boundary.maxFxSlippageBps) / 10_000);
        if (
          expected === null ||
          Math.abs(action.amount.minor - expected) > allowed
        ) {
          violations.push("FX_CONVERSION_MISMATCH");
        }
      }
    }
  }
  return violations;
}
