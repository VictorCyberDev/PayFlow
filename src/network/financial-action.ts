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
  | "INTEGER_OVERFLOW";

function safeSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
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
  if (feeTotal > boundary.maxFeesMinor) violations.push("FEE_BOUNDARY_EXCEEDED");
  if (taxTotal > boundary.maxTaxesMinor) violations.push("TAX_BOUNDARY_EXCEEDED");
  if (action.fx) {
    if (!boundary.allowFx) violations.push("FX_DENIED");
    if (action.fx.observedSlippageBps > boundary.maxFxSlippageBps) {
      violations.push("FX_SLIPPAGE_EXCEEDED");
    }
  }
  return violations;
}
