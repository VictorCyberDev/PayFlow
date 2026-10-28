import { describe, expect, it } from "vitest";
import {
  FinancialActionSchema,
  MonetaryBoundarySchema,
  evaluateMonetaryBoundary,
} from "../src/network/financial-action.js";
import {
  ProcurementAuthorityPackSchema,
  evaluateProcurementAction,
} from "../src/network/procurement.js";
import {
  assertEnvironmentBoundary,
  assertSameTenant,
  roleAllows,
} from "../src/network/control-plane.js";

const action = FinancialActionSchema.parse({
  version: "financial-action/v1",
  id: "action-1",
  kind: "PROCUREMENT_ORDER",
  principalId: "principal-1",
  agentId: "agent-1",
  counterparty: { id: "vendor-1", displayName: "Vendor" },
  amount: { currency: "USD", minor: 9_500 },
  fees: [{ currency: "USD", minor: 100 }],
  taxes: [{ currency: "USD", minor: 200 }],
  quantity: 2,
  items: [{ sku: "SKU-1", quantity: 2, unitPriceMinor: 4_600 }],
  purpose: "lab reagents",
  costCenter: "BIO-100",
  invoiceReference: "INV-LAB-42",
  proposedAt: "2026-10-28T03:00:00.000Z",
  idempotencyKey: "idempotency-action-0001",
});

describe("M11 procurement pack", () => {
  it("accepts an in-boundary procurement action and detects substitutions", () => {
    const pack = ProcurementAuthorityPackSchema.parse({
      version: "procurement-authority/v1",
      id: "pack-1",
      approvedVendorIds: ["vendor-1"],
      approvedSkus: [{ sku: "SKU-1", expectedUnitPriceMinor: 4_500 }],
      maxQuantity: 3,
      currency: "USD",
      budgetMinor: 10_000,
      invoiceReferencePrefix: "INV-LAB-",
      costCenter: "BIO-100",
      purpose: "lab reagents",
      expiresAt: "2026-10-29T03:00:00.000Z",
      supplierSubstitution: "DENY",
      priceToleranceBps: 500,
      maxTaxMinor: 300,
      maxFeeMinor: 200,
      humanEscalationAboveMinor: 10_000,
    });
    expect(
      evaluateProcurementAction(pack, action, "2026-10-28T03:00:00.000Z"),
    ).toEqual([]);
    const substituted = { ...action, counterparty: { id: "vendor-evil" } };
    expect(
      evaluateProcurementAction(pack, substituted, "2026-10-28T03:00:00.000Z"),
    ).toContain("VENDOR_DENIED");
  });
});

describe("M30 monetary boundary", () => {
  it("keeps fees, tax and FX inside explicit integer boundaries", () => {
    const boundary = MonetaryBoundarySchema.parse({
      settlementCurrencies: ["USD"],
      maxAmountMinor: 10_000,
      maxFeesMinor: 200,
      maxTaxesMinor: 300,
      maxFxSlippageBps: 50,
      allowFx: false,
    });
    expect(evaluateMonetaryBoundary(action, boundary)).toEqual([]);
    const widened = FinancialActionSchema.parse({
      ...action,
      amount: { currency: "USD", minor: 10_001 },
      fees: [{ currency: "USD", minor: 500 }],
      fx: {
        sourceCurrency: "EUR",
        settlementCurrency: "USD",
        rateNumerator: 108,
        rateDenominator: 100,
        observedSlippageBps: 75,
      },
    });
    expect(evaluateMonetaryBoundary(widened, boundary)).toEqual([
      "AMOUNT_EXCEEDS_BOUNDARY",
      "FEE_BOUNDARY_EXCEEDED",
      "FX_DENIED",
      "FX_SLIPPAGE_EXCEEDED",
    ]);
  });
});

describe("M13 tenant boundaries", () => {
  it("fails closed across organizations and environments", () => {
    expect(() => assertSameTenant("org-a", "org-b")).toThrow(
      "CROSS_TENANT_ACCESS_DENIED",
    );
    expect(() => assertEnvironmentBoundary("SANDBOX", "PRODUCTION")).toThrow(
      "CROSS_ENVIRONMENT_ACCESS_DENIED",
    );
    expect(roleAllows("AUDITOR", "proof:read")).toBe(true);
    expect(roleAllows("VIEWER", "authority:revoke")).toBe(false);
  });
});
