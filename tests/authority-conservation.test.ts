import { describe, expect, it } from "vitest";
import { mandateFingerprint, proposalDigest } from "../src/canonical.js";
import { authorize } from "../src/kernel.js";
import {
  MandateSchema,
  TransactionProposalSchema,
  type AgentPassport,
  type Mandate,
  type TransactionProposal,
} from "../src/domain.js";

const now = "2026-10-09T12:00:00.000Z";
const agent: AgentPassport = {
  id: "agent",
  principalId: "human",
  displayName: "Agent",
  status: "ACTIVE",
  issuedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
  capabilities: ["CAPTURE_PAYMENT"],
};
function authority(limit: number, quantity: number): Mandate {
  return {
    id: "mandate",
    principalId: "human",
    authorizedAgentId: "agent",
    purpose: "keyboard",
    category: "KEYBOARD",
    currency: "USD",
    maxSingleTransactionMinor: limit,
    cumulativeLimitMinor: limit,
    quantityLimit: quantity,
    merchantScope: { mode: "ONLY", ids: ["merchant-A"] },
    allowedConditions: ["NEW"],
    merchantRiskCeiling: "MEDIUM",
    autonomousPurchaseThresholdMinor: limit,
    humanApprovalThresholdMinor: limit,
    allowedCapabilities: ["CAPTURE_PAYMENT"],
    createdAt: agent.issuedAt,
    expiresAt: agent.expiresAt,
    version: 1,
    nonce: "human-authority-nonce",
  };
}
function candidate(m: Mandate, amount: number): TransactionProposal {
  return {
    id: "proposal",
    agentId: agent.id,
    mandateId: m.id,
    mandateFingerprint: mandateFingerprint(m),
    amount: { minor: amount, currency: "USD" },
    quantity: 1,
    merchant: { id: "merchant-A", displayName: "Merchant" },
    category: "KEYBOARD",
    condition: "NEW",
    requestedCapability: "CAPTURE_PAYMENT",
    proposedAt: now,
    nonce: "proposal-conserved-nonce",
    metadata: {},
  };
}
const context = {
  now,
  merchantRisk: "LOW" as const,
  cumulativeSpentMinor: 0,
  consumedQuantity: 0,
  replaySeen: false,
};
describe("M3F authority conservation using actual kernel and canonical structures", () => {
  it("seed 0x504159 bounded generation never ALLOWs a widened or exhausted proposal", () => {
    let seed = 0x504159;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let sample = 0; sample < 128; sample++) {
      const limit = 100 + (next() % 10000),
        quantity = 1 + (next() % 5);
      const m = authority(limit, quantity),
        p = candidate(m, 1 + (next() % limit));
      expect(
        authorize(m, agent, p, context).decision,
        `seed=0x504159 sample=${sample}`,
      ).toBe("ALLOW");
      const mutations: unknown[] = [
        { ...p, amount: { minor: limit + 1, currency: "USD" } },
        { ...p, amount: { minor: p.amount.minor, currency: "EUR" } },
        { ...p, quantity: quantity + 1 },
        { ...p, quantity: undefined },
        { ...p, merchant: { id: "merchant-B", displayName: "Merchant" } },
        { ...p, merchant: { id: "Merchant-A", displayName: "Merchant" } },
        { ...p, condition: "REFURBISHED" },
        { ...p, condition: undefined },
        { ...p, category: "HEADPHONES" },
        { ...p, agentId: "other-agent" },
        { ...p, mandateId: "other-mandate" },
        { ...p, mandateFingerprint: "0".repeat(64) },
        ...[
          "CREATE_ORDER",
          "REQUEST_REFUND",
          "CREATE_SUBSCRIPTION",
          "OPEN_DISPUTE",
          "UNKNOWN",
        ].map((requestedCapability) => ({ ...p, requestedCapability })),
        {
          ...p,
          amount: { minor: Number.MAX_SAFE_INTEGER + 1, currency: "USD" },
        },
      ];
      for (const [mutation, widened] of mutations.entries())
        expect(
          authorize(m, agent, widened, context).decision,
          `sample=${sample} mutation=${mutation}`,
        ).toBe("DENY");
      expect(
        authorize(m, agent, p, { ...context, cumulativeSpentMinor: limit })
          .decision,
      ).toBe("DENY");
      expect(
        authorize(m, agent, p, { ...context, consumedQuantity: quantity })
          .decision,
      ).toBe("DENY");
      expect(
        authorize(m, agent, p, { ...context, replaySeen: true }).decision,
      ).toBe("DENY");
    }
  });
  it("changed upstream authority invalidates existing fingerprint, while equivalent set ordering preserves identity", () => {
    const m = authority(100, 1),
      p = candidate(m, 50),
      fingerprint = mandateFingerprint(m);
    const patches: Partial<Mandate>[] = [
      { principalId: "other" },
      { authorizedAgentId: "other" },
      { maxSingleTransactionMinor: 1000 },
      { cumulativeLimitMinor: 1000 },
      { quantityLimit: 2 },
      { merchantScope: { mode: "ANY" } },
      { allowedConditions: ["NEW", "REFURBISHED"] },
      { allowedCapabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"] },
      { expiresAt: "2026-12-01T00:00:00.000Z" },
      { nonce: "different-human-nonce" },
      { version: 2 },
      { autonomousPurchaseThresholdMinor: 99 },
    ];
    for (const patch of patches) {
      const changed = { ...m, ...patch };
      expect(mandateFingerprint(changed)).not.toBe(fingerprint);
      expect(authorize(changed, agent, p, context).decision).toBe("DENY");
    }
    const multi = {
      ...m,
      merchantScope: { mode: "ONLY" as const, ids: ["A", "B"] },
      allowedCapabilities: [
        "CREATE_ORDER",
        "CAPTURE_PAYMENT",
      ] as Mandate["allowedCapabilities"],
    };
    expect(
      mandateFingerprint({
        ...multi,
        merchantScope: { mode: "ONLY", ids: ["B", "A"] },
        allowedCapabilities: ["CAPTURE_PAYMENT", "CREATE_ORDER"],
      }),
    ).toBe(mandateFingerprint(multi));
    expect(
      MandateSchema.safeParse({
        ...m,
        merchantScope: { mode: "ONLY", ids: [] },
      }).success,
    ).toBe(false);
  });
  it("proposal digest binds all downstream authority including quantity and capability", () => {
    const p = candidate(authority(100, 1), 50),
      digest = proposalDigest(p);
    const patches: Partial<TransactionProposal>[] = [
      { id: "other" },
      { quantity: 2 },
      { requestedCapability: "CREATE_ORDER" },
      { agentId: "other" },
      { mandateId: "other" },
      { mandateFingerprint: "0".repeat(64) },
      { amount: { minor: 51, currency: "USD" } },
      { amount: { minor: 50, currency: "EUR" } },
      { merchant: { id: "B", displayName: "B" } },
      { condition: "REFURBISHED" },
      { category: "HEADPHONES" },
      { nonce: "different-proposal-nonce" },
      { proposedAt: "2026-10-09T12:01:00.000Z" },
    ];
    for (const patch of patches)
      expect(proposalDigest({ ...p, ...patch })).not.toBe(digest);
    expect(
      TransactionProposalSchema.safeParse({
        ...p,
        requestedCapability: "UNKNOWN",
      }).success,
    ).toBe(false);
    expect(
      TransactionProposalSchema.safeParse({ ...p, trusted: true }).success,
    ).toBe(false);
  });
});
