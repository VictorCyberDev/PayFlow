import { describe, expect, it } from "vitest";
import type { AgentPassport, Mandate } from "../src/domain.js";
import {
  FinancialActionAuthorityExtensionSchema,
  authorizeFinancialAction,
} from "../src/network/action-authorization.js";
import { FinancialActionSchema } from "../src/network/financial-action.js";
import {
  DeterministicFakeRail,
  financialActionDigest,
  reconcileWithoutReexecution,
} from "../src/network/rail.js";

const mandate: Mandate = {
  id: "m-action",
  principalId: "p1",
  authorizedAgentId: "a1",
  purpose: "bounded finance",
  category: "FINANCIAL_ACTION",
  currency: "USD",
  maxSingleTransactionMinor: 50_000,
  cumulativeLimitMinor: 100_000,
  merchantScope: { mode: "ONLY", ids: ["vendor-1"] },
  allowedConditions: ["NEW"],
  merchantRiskCeiling: "LOW",
  autonomousPurchaseThresholdMinor: 50_000,
  humanApprovalThresholdMinor: 50_000,
  allowedCapabilities: ["CAPTURE_PAYMENT", "CREATE_SUBSCRIPTION"],
  expiresAt: "2026-10-29T03:00:00.000Z",
  createdAt: "2026-10-28T02:00:00.000Z",
  version: 1,
  nonce: "financial-action-mandate-nonce",
};
const agent: AgentPassport = {
  id: "a1",
  principalId: "p1",
  displayName: "Finance Agent",
  issuedAt: "2026-10-28T02:00:00.000Z",
  expiresAt: "2026-10-29T03:00:00.000Z",
  status: "ACTIVE",
  capabilities: ["CAPTURE_PAYMENT", "CREATE_SUBSCRIPTION"],
};
const extension = FinancialActionAuthorityExtensionSchema.parse({
  version: "financial-action-authority/v1",
  allowedKinds: ["PURCHASE", "INVOICE_SETTLEMENT", "SUBSCRIPTION_RENEWAL", "PAYOUT", "REIMBURSEMENT"],
  allowedCounterpartyIds: ["vendor-1"],
  monetary: {
    settlementCurrencies: ["USD"],
    maxAmountMinor: 50_000,
    maxFeesMinor: 1_000,
    maxTaxesMinor: 5_000,
    maxFxSlippageBps: 50,
    allowFx: false,
  },
  requireInvoiceReferenceForSettlement: true,
  requireRecurringKeyForRecurring: true,
});

function action(kind: "PURCHASE" | "INVOICE_SETTLEMENT" | "SUBSCRIPTION_RENEWAL" | "PAYOUT" | "REIMBURSEMENT") {
  return FinancialActionSchema.parse({
    version: "financial-action/v1",
    id: `action-${kind}`,
    kind,
    principalId: "p1",
    agentId: "a1",
    counterparty: { id: "vendor-1" },
    amount: { currency: "USD", minor: 10_000 },
    purpose: "bounded finance",
    ...(kind === "INVOICE_SETTLEMENT" ? { invoiceReference: "INV-1" } : {}),
    ...(kind === "SUBSCRIPTION_RENEWAL" ? { recurringKey: "sub-1" } : {}),
    proposedAt: "2026-10-28T03:00:00.000Z",
    idempotencyKey: `idempotency-${kind}-0001`,
  });
}

const context = {
  now: "2026-10-28T03:00:00.000Z",
  merchantRisk: "LOW" as const,
  cumulativeSpentMinor: 0,
  replaySeen: false,
};

describe("M29 consequential action semantics", () => {
  for (const kind of ["PURCHASE", "INVOICE_SETTLEMENT", "SUBSCRIPTION_RENEWAL", "PAYOUT", "REIMBURSEMENT"] as const) {
    it(`authorizes ${kind} through extension guard and the same Trust Kernel`, () => {
      const result = authorizeFinancialAction(mandate, extension, agent, action(kind), context);
      expect(result.extensionViolations).toEqual([]);
      expect(result.decision).toBe("ALLOW");
    });
  }

  it("denies action-kind and counterparty widening even if generic money fits", () => {
    const widened = FinancialActionSchema.parse({
      ...action("PURCHASE"),
      kind: "MARKETPLACE_DISBURSEMENT",
      counterparty: { id: "attacker" },
    });
    const result = authorizeFinancialAction(mandate, extension, agent, widened, context);
    expect(result.decision).toBe("DENY");
    expect(result.extensionViolations).toContain("ACTION_KIND_DENIED");
    expect(result.extensionViolations).toContain("COUNTERPARTY_DENIED");
  });
});

describe("M26/M27 provider-neutral rail conformance", () => {
  it("preserves exactly-one simulated effect across two distinct local rails", async () => {
    for (const railId of ["fake-card-rail", "fake-push-rail"]) {
      const rail = new DeterministicFakeRail(railId, "SUCCESS");
      const target = action("PURCHASE");
      const grant = {
        grantId: `grant-${railId}`,
        authorityId: mandate.id,
        actionDigest: financialActionDigest(target),
        idempotencyKey: target.idempotencyKey,
        expiresAt: "2026-10-28T03:05:00.000Z",
      };
      const first = await rail.execute({ action: target, grant, now: context.now });
      const duplicate = await rail.execute({ action: target, grant, now: context.now });
      expect(first.effectCount).toBe(1);
      expect(duplicate.providerReference).toBe(first.providerReference);
    }
  });

  it("keeps UNKNOWN first-class and reconciles without re-execution", async () => {
    const rail = new DeterministicFakeRail("fake-timeout-rail", "TIMEOUT_AFTER_EFFECT");
    const target = action("PURCHASE");
    const grant = {
      grantId: "grant-timeout",
      authorityId: mandate.id,
      actionDigest: financialActionDigest(target),
      idempotencyKey: target.idempotencyKey,
      expiresAt: "2026-10-28T03:05:00.000Z",
    };
    const result = await rail.execute({ action: target, grant, now: context.now });
    expect(result.state).toBe("UNKNOWN");
    expect(result.effectCount).toBeNull();
    const reconciled = await reconcileWithoutReexecution(rail, target.idempotencyKey, "2026-10-28T03:01:00.000Z");
    expect(reconciled.state).toBe("SUCCEEDED");
    expect(reconciled.effectCount).toBe(1);
  });
});
