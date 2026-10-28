import { z } from "zod";
import type { FinancialAction } from "./financial-action.js";

const ProcurementSkuSchema = z
  .object({
    sku: z.string().min(1).max(256),
    expectedUnitPriceMinor: z.number().int().safe().nonnegative(),
  })
  .strict();

export const ProcurementAuthorityPackSchema = z
  .object({
    version: z.literal("procurement-authority/v1"),
    id: z.string().min(1),
    approvedVendorIds: z.array(z.string().min(1)).min(1).max(500),
    approvedSkus: z.array(ProcurementSkuSchema).min(1).max(1000),
    maxQuantity: z.number().int().safe().positive().max(1_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    budgetMinor: z.number().int().safe().positive(),
    maxRecurringActions: z.number().int().safe().positive().max(10_000).optional(),
    invoiceReferencePrefix: z.string().min(1).max(64).optional(),
    costCenter: z.string().min(1).max(128),
    purpose: z.string().min(1).max(1024),
    expiresAt: z.string().datetime(),
    supplierSubstitution: z.enum(["DENY", "APPROVED_ONLY"]),
    priceToleranceBps: z.number().int().safe().nonnegative().max(100_000),
    maxTaxMinor: z.number().int().safe().nonnegative(),
    maxFeeMinor: z.number().int().safe().nonnegative(),
    humanEscalationAboveMinor: z.number().int().safe().positive(),
  })
  .strict();
export type ProcurementAuthorityPack = Readonly<
  z.infer<typeof ProcurementAuthorityPackSchema>
>;

export type ProcurementViolation =
  | "ACTION_KIND_DENIED"
  | "VENDOR_DENIED"
  | "SKU_DENIED"
  | "QUANTITY_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "CURRENCY_MISMATCH"
  | "INVOICE_REFERENCE_MISMATCH"
  | "COST_CENTER_MISMATCH"
  | "PURPOSE_MISMATCH"
  | "AUTHORITY_EXPIRED"
  | "PRICE_TOLERANCE_EXCEEDED"
  | "TAX_EXCEEDED"
  | "FEE_EXCEEDED"
  | "HUMAN_ESCALATION_REQUIRED";

export function evaluateProcurementAction(
  pack: ProcurementAuthorityPack,
  action: FinancialAction,
  now: string,
): readonly ProcurementViolation[] {
  const violations: ProcurementViolation[] = [];
  if (action.kind !== "PROCUREMENT_ORDER" && action.kind !== "PURCHASE") {
    violations.push("ACTION_KIND_DENIED");
  }
  if (!pack.approvedVendorIds.includes(action.counterparty.id)) {
    violations.push("VENDOR_DENIED");
  }
  if (action.amount.currency !== pack.currency) violations.push("CURRENCY_MISMATCH");
  if (action.amount.minor > pack.budgetMinor) violations.push("BUDGET_EXCEEDED");
  if ((action.quantity ?? action.items.reduce((sum, item) => sum + item.quantity, 0)) > pack.maxQuantity) {
    violations.push("QUANTITY_EXCEEDED");
  }
  if (action.costCenter !== pack.costCenter) violations.push("COST_CENTER_MISMATCH");
  if (action.purpose !== pack.purpose) violations.push("PURPOSE_MISMATCH");
  if (Date.parse(now) >= Date.parse(pack.expiresAt)) violations.push("AUTHORITY_EXPIRED");
  if (
    pack.invoiceReferencePrefix &&
    !action.invoiceReference?.startsWith(pack.invoiceReferencePrefix)
  ) {
    violations.push("INVOICE_REFERENCE_MISMATCH");
  }
  const approved = new Map(pack.approvedSkus.map((entry) => [entry.sku, entry]));
  for (const item of action.items) {
    const expected = approved.get(item.sku);
    if (!expected) {
      violations.push("SKU_DENIED");
      continue;
    }
    const delta = Math.abs(item.unitPriceMinor - expected.expectedUnitPriceMinor);
    const allowedDelta = Math.floor(
      (expected.expectedUnitPriceMinor * pack.priceToleranceBps) / 10_000,
    );
    if (delta > allowedDelta) violations.push("PRICE_TOLERANCE_EXCEEDED");
  }
  const taxes = action.taxes.reduce((sum, item) => sum + item.minor, 0);
  const fees = action.fees.reduce((sum, item) => sum + item.minor, 0);
  if (taxes > pack.maxTaxMinor) violations.push("TAX_EXCEEDED");
  if (fees > pack.maxFeeMinor) violations.push("FEE_EXCEEDED");
  if (action.amount.minor > pack.humanEscalationAboveMinor) {
    violations.push("HUMAN_ESCALATION_REQUIRED");
  }
  return [...new Set(violations)];
}
