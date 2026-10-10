import { describe, expect, it } from "vitest";
import { mandateFingerprint } from "../src/canonical.js";
import type {
  AgentPassport,
  DecisionReceipt,
  Mandate,
  TransactionProposal,
} from "../src/domain.js";
import { InMemoryEvidenceLedger } from "../src/evidence.js";
import {
  AuthorizedPaymentExecutor,
  MockPaymentProvider,
} from "../src/payment.js";
import { TrustKernelService } from "../src/service.js";

const now = "2026-10-09T12:00:00.000Z";
const mandate: Mandate = {
  id: "m",
  principalId: "p",
  authorizedAgentId: "a",
  purpose: "keyboard",
  category: "KEYBOARD",
  currency: "USD",
  maxSingleTransactionMinor: 10000,
  cumulativeLimitMinor: 20000,
  allowedConditions: ["NEW"],
  merchantRiskCeiling: "MEDIUM",
  autonomousPurchaseThresholdMinor: 7500,
  humanApprovalThresholdMinor: 10000,
  allowedCapabilities: ["CREATE_ORDER"],
  createdAt: now,
  expiresAt: "2026-12-01T00:00:00.000Z",
  version: 1,
  nonce: "mandate-nonce-0001",
};
const agent: AgentPassport = {
  id: "a",
  principalId: "p",
  displayName: "Agent",
  issuedAt: now,
  expiresAt: "2026-12-01T00:00:00.000Z",
  status: "ACTIVE",
  capabilities: ["CREATE_ORDER"],
};
const make = (minor: number, id = "tx"): TransactionProposal => ({
  id,
  agentId: "a",
  mandateId: "m",
  mandateFingerprint: mandateFingerprint(mandate),
  amount: { currency: "USD", minor },
  merchant: { id: "s", displayName: "Shop" },
  category: "KEYBOARD",
  condition: "NEW",
  requestedCapability: "CREATE_ORDER",
  proposedAt: now,
  nonce: `proposal-nonce-${id}`,
  metadata: {},
});

function setup() {
  const ledger = new InMemoryEvidenceLedger();
  const provider = new MockPaymentProvider();
  const executor = new AuthorizedPaymentExecutor(provider, ledger);
  return {
    ledger,
    provider,
    service: new TrustKernelService(ledger, executor),
  };
}

describe("authorization before financial side effects", () => {
  it("DENY never invokes provider", async () => {
    const { provider, service } = setup();
    const p = make(12000);
    const r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    expect(r.decision).toBe("DENY");
    await expect(service.execute(p, r)).rejects.toThrow(
      "PAYMENT_NOT_AUTHORIZED",
    );
    expect(provider.createCalls).toBe(0);
  });

  it("ESCALATE never invokes provider without approval", async () => {
    const { provider, service } = setup();
    const p = make(8000);
    const r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    expect(r.decision).toBe("ESCALATE");
    await expect(service.execute(p, r)).rejects.toThrow(
      "HUMAN_APPROVAL_REQUIRED",
    );
    expect(provider.createCalls).toBe(0);
  });

  it("valid ALLOW invokes mock provider", async () => {
    const { provider, service } = setup();
    const p = make(7000);
    const r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    await service.execute(p, r);
    expect(provider.createCalls).toBe(1);
  });

  it("explicit principal approval enables original ESCALATE", async () => {
    const { provider, service, ledger } = setup();
    const p = make(8000);
    const r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    service.approve(r, "p", now);
    await service.execute(p, r);
    expect(provider.createCalls).toBe(1);
    expect(
      ledger.entries().some((entry) => entry.type === "HUMAN_APPROVAL_GRANTED"),
    ).toBe(true);
  });

  it("rejects approval from the wrong principal", () => {
    const { service } = setup();
    const p = make(8000);
    const r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    expect(() => service.approve(r, "attacker", now)).toThrow(
      "APPROVAL_PRINCIPAL_MISMATCH",
    );
  });

  it("rejects a forged client ALLOW receipt", async () => {
    const { provider, service } = setup();
    const p = make(7000);
    const legitimate = service.evaluate(mandate, agent, p, {
      now,
      merchantRisk: "LOW",
    });
    const forged: DecisionReceipt = {
      ...legitimate,
      receiptId: "forged-receipt",
      decision: "ALLOW",
      reasonCodes: ["ALLOWED"],
    };
    await expect(service.execute(p, forged)).rejects.toThrow(
      "UNTRUSTED_DECISION_RECEIPT",
    );
    expect(provider.createCalls).toBe(0);
  });

  it("rejects transaction substitution after authorization", async () => {
    const { provider, service } = setup();
    const p = make(7000);
    const r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    const substituted: TransactionProposal = {
      ...p,
      amount: { currency: "USD", minor: 9999 },
    };
    await expect(service.execute(substituted, r)).rejects.toThrow(
      "PROPOSAL_SUBSTITUTION_DETECTED",
    );
    expect(provider.createCalls).toBe(0);
  });

  it("rejects a duplicate proposal id even with a different nonce", () => {
    const { service } = setup();
    const first = make(7000, "duplicate");
    expect(
      service.evaluate(mandate, agent, first, { now, merchantRisk: "LOW" })
        .decision,
    ).toBe("ALLOW");
    const duplicate = { ...first, nonce: "different-nonce-0002" };
    expect(
      service.evaluate(mandate, agent, duplicate, { now, merchantRisk: "LOW" })
        .reasonCodes,
    ).toContain("REPLAY_DETECTED");
  });
});

describe("2E original mock boundary hardening", () => {
  it("issued receipts are recursively immutable", () => {
    const { service } = setup(),
      p = make(7000),
      r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    expect(() => {
      (r.amount as { minor: number }).minor = 1;
    }).toThrow();
    expect(() => {
      (r as { decision: string }).decision = "ALLOW";
    }).toThrow();
  });
  it("mutating the original proposal does not mutate its authorization snapshot", async () => {
    const { service, provider } = setup(),
      p = make(7000),
      r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    (p.merchant as { id: string }).id = "OTHER";
    await expect(service.execute(p, r)).rejects.toThrow("SUBSTITUTION");
    expect(provider.createCalls).toBe(0);
  });
  it("concurrent and repeated execution consume the receipt once", async () => {
    const { service, provider } = setup(),
      p = make(7000),
      r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    const results = await Promise.allSettled([
      service.execute(p, r),
      service.execute(p, r),
    ]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(provider.createCalls).toBe(1);
    await expect(service.execute(p, r)).rejects.toThrow("REPLAY");
  });
  it("outstanding evaluated decisions cannot overspend the cumulative budget concurrently", async () => {
    const { service, provider } = setup();
    const proposals = [
      make(7000, "one"),
      make(7000, "two"),
      make(7000, "three"),
    ];
    const receipts = proposals.map((p) =>
      service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" }),
    );
    expect(receipts.map((r) => r.decision)).toEqual([
      "ALLOW",
      "ALLOW",
      "ALLOW",
    ]);
    const results = await Promise.allSettled(
      proposals.map((p, i) => service.execute(p, receipts[i]!)),
    );
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(2);
    expect(provider.createCalls).toBe(2);
  });
  it("duplicate human approval is rejected without rewriting the receipt", () => {
    const { service } = setup(),
      p = make(8000),
      r = service.evaluate(mandate, agent, p, { now, merchantRisk: "LOW" });
    service.approve(r, "p", now);
    expect(() => service.approve(r, "p", now)).toThrow("ALREADY_RECORDED");
    expect(r.decision).toBe("ESCALATE");
  });
});
