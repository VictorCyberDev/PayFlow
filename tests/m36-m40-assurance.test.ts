import { describe, expect, it } from "vitest";
import { FinancialActionSchema } from "../src/network/financial-action.js";
import {
  authorizeFinancialAction,
  FinancialActionAuthorityExtensionSchema,
} from "../src/network/action-authorization.js";
import { FixtureAccountsPayableConnector } from "../src/network/enterprise-connectors.js";
import {
  ReconciliationOperationsCenter,
  type ReconciliationCase,
} from "../src/network/reconciliation-ops.js";
import {
  DeterministicFakeRail,
  financialActionDigest,
} from "../src/network/rail.js";
import { deletionDecision } from "../src/network/privacy.js";
import { readiness, retryDelayMs } from "../src/network/reliability.js";
import {
  calculateMeteredAmountMinor,
  PRICING_ARCHITECTURE,
} from "../src/network/metering.js";
import type { AgentPassport, Mandate } from "../src/domain.js";

describe("M36 reconciliation operations", () => {
  it("resolves UNKNOWN by observation and never calls execute during investigation", async () => {
    const rail = new DeterministicFakeRail("rail-1", "TIMEOUT_AFTER_EFFECT");
    const action = FinancialActionSchema.parse({
      version: "financial-action/v1",
      id: "a1",
      kind: "PURCHASE",
      principalId: "p1",
      agentId: "agent1",
      counterparty: { id: "m1" },
      amount: { currency: "USD", minor: 100 },
      purpose: "test",
      proposedAt: "2026-10-28T03:00:00.000Z",
      idempotencyKey: "reconciliation-idempotency-0001",
    });
    await rail.execute({
      action,
      grant: {
        grantId: "g1",
        authorityId: "auth1",
        actionDigest: financialActionDigest(action),
        idempotencyKey: action.idempotencyKey,
        expiresAt: "2026-10-28T03:10:00.000Z",
      },
      now: "2026-10-28T03:00:00.000Z",
    });
    let stored: ReconciliationCase = {
      id: "case1",
      attemptId: "attempt1",
      railId: rail.railId,
      idempotencyKey: action.idempotencyKey,
      state: "PENDING",
      openedAt: "2026-10-28T03:00:00.000Z",
      updatedAt: "2026-10-28T03:00:00.000Z",
      evidence: [],
    };
    const center = new ReconciliationOperationsCenter(
      {
        load: async () => stored,
        compareAndSet: async (_id, expected, next) => {
          if (stored.updatedAt !== expected) return false;
          stored = next;
          return true;
        },
      },
      new Map([[rail.railId, rail]]),
    );
    const resolved = await center.investigate(
      "case1",
      "2026-10-28T03:01:00.000Z",
    );
    expect(resolved.state).toBe("RESOLVED_SUCCEEDED");
    expect(resolved.evidence.at(-1)?.effectCount).toBe(1);
  });
});

describe("safety corrections", () => {
  it("denies generalized quantity that cannot be represented by the legacy kernel", () => {
    const mandate: Mandate = {
      id: "m1",
      principalId: "p1",
      authorizedAgentId: "agent1",
      purpose: "test",
      category: "BUY",
      currency: "USD",
      maxSingleTransactionMinor: 1000,
      quantityLimit: 2000,
      allowedConditions: ["NEW"],
      merchantRiskCeiling: "LOW",
      autonomousPurchaseThresholdMinor: 1000,
      humanApprovalThresholdMinor: 1000,
      allowedCapabilities: ["CAPTURE_PAYMENT"],
      expiresAt: "2026-10-29T03:00:00.000Z",
      createdAt: "2026-10-28T02:00:00.000Z",
      version: 1,
      nonce: "mandate-nonce-safe",
    };
    const agent: AgentPassport = {
      id: "agent1",
      principalId: "p1",
      displayName: "Agent",
      issuedAt: "2026-10-28T02:00:00.000Z",
      expiresAt: "2026-10-29T03:00:00.000Z",
      status: "ACTIVE",
      capabilities: ["CAPTURE_PAYMENT"],
    };
    const action = FinancialActionSchema.parse({
      version: "financial-action/v1",
      id: "large-q",
      kind: "PURCHASE",
      principalId: "p1",
      agentId: "agent1",
      counterparty: { id: "merchant1" },
      amount: { currency: "USD", minor: 100 },
      quantity: 1500,
      purpose: "test",
      proposedAt: "2026-10-28T03:00:00.000Z",
      idempotencyKey: "large-quantity-action-0001",
    });
    const extension = FinancialActionAuthorityExtensionSchema.parse({
      version: "financial-action-authority/v1",
      allowedKinds: ["PURCHASE"],
      allowedCounterpartyIds: ["merchant1"],
      monetary: {
        settlementCurrencies: ["USD"],
        maxAmountMinor: 1000,
        maxFeesMinor: 0,
        maxTaxesMinor: 0,
        maxFxSlippageBps: 0,
        allowFx: false,
      },
      requireInvoiceReferenceForSettlement: true,
      requireRecurringKeyForRecurring: true,
    });
    const result = authorizeFinancialAction(mandate, extension, agent, action, {
      now: "2026-10-28T03:00:00.000Z",
      merchantRisk: "LOW",
      cumulativeSpentMinor: 0,
      replaySeen: false,
      consumedQuantity: 0,
    });
    expect(result.decision).toBe("DENY");
    expect(result.extensionViolations).toContain(
      "QUANTITY_NOT_REPRESENTABLE_IN_KERNEL",
    );
  });

  it("validates untrusted AP fixture input before normalization", async () => {
    const connector = new FixtureAccountsPayableConnector();
    await expect(
      connector.normalizeInbound(
        { invoiceId: "x", amountMinor: -1 },
        {
          organizationId: "o1",
          environment: "SANDBOX",
          sourceSystem: "erp",
          sourceReference: "r1",
        },
      ),
    ).rejects.toBeDefined();
  });
});

describe("M14/M15/M38 controls", () => {
  it("reports degraded readiness and bounded retry policy", () => {
    expect(readiness({ database: true, keyResolver: false }).status).toBe(
      "degraded",
    );
    expect(retryDelayMs(0)).toBe(250);
    expect(retryDelayMs(20)).toBe(10_000);
  });

  it("preserves immutable financial evidence during deletion workflows", () => {
    expect(deletionDecision("PERSONAL").allowed).toBe(true);
    expect(deletionDecision("IMMUTABLE_FINANCIAL_EVIDENCE")).toEqual({
      allowed: false,
      reason: "IMMUTABLE_FINANCIAL_EVIDENCE",
    });
  });

  it("meters usage without pretending market validation", () => {
    const platform = PRICING_ARCHITECTURE.find(
      (plan) => plan.id === "PLATFORM",
    );
    expect(platform).toBeDefined();
    expect(
      calculateMeteredAmountMinor(platform!, [
        {
          id: "u1",
          organizationId: "o1",
          environment: "SANDBOX",
          meter: "GOVERNED_ACTION",
          quantity: 50,
          occurredAt: "2026-10-28T03:00:00.000Z",
          idempotencyKey: "usage-idempotency-0001",
        },
      ]),
    ).toBe(50);
  });
});
