import { describe, expect, it } from "vitest";
import { mandateFingerprint } from "../src/canonical.js";
import type { AgentPassport, Mandate } from "../src/domain.js";
import { FinancialAuthorityGateway } from "../src/network/gateway.js";

const now = "2026-10-28T02:40:00.000Z";
const mandate: Mandate = {
  id: "mandate-m7",
  principalId: "principal-1",
  authorizedAgentId: "agent-1",
  purpose: "buy approved lab consumables",
  category: "LAB_SUPPLIES",
  currency: "USD",
  maxSingleTransactionMinor: 10_000,
  cumulativeLimitMinor: 30_000,
  quantityLimit: 5,
  merchantScope: { mode: "ONLY", ids: ["merchant-approved"] },
  allowedConditions: ["NEW"],
  merchantRiskCeiling: "LOW",
  autonomousPurchaseThresholdMinor: 8_000,
  humanApprovalThresholdMinor: 10_000,
  allowedCapabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
  expiresAt: "2026-10-29T02:40:00.000Z",
  createdAt: "2026-10-28T01:40:00.000Z",
  version: 1,
  nonce: "mandate-nonce-0001",
};
const agent: AgentPassport = {
  id: "agent-1",
  principalId: "principal-1",
  displayName: "Procurement Agent",
  issuedAt: "2026-10-28T01:40:00.000Z",
  expiresAt: "2026-10-29T02:40:00.000Z",
  status: "ACTIVE",
  capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
};
const access = {
  clientId: "client-1",
  agentId: "agent-1",
  principalId: "principal-1",
  audience: "payflow-gateway-v1",
  scopes: ["authority:read", "action:request"],
  issuedAt: "2026-10-28T01:40:00.000Z",
  expiresAt: "2026-10-29T02:40:00.000Z",
  status: "ACTIVE",
};

function fixture(lifecycle: "ACTIVE" | "SUSPENDED" | "REVOKED" = "ACTIVE") {
  const claimed = new Set<string>();
  return new FinancialAuthorityGateway({
    authorityState: async () => lifecycle,
    loadMandate: async (id) => (id === mandate.id ? mandate : null),
    loadAgent: async (id) => (id === agent.id ? agent : null),
    cumulativeSpentMinor: async () => 0,
    consumedQuantity: async () => 0,
    claimReplayKey: async (scope, key) => {
      const composite = `${scope}:${key}`;
      if (claimed.has(composite)) return false;
      claimed.add(composite);
      return true;
    },
    issueExecutionCapability: async (_receipt, proposal) => ({
      grantId: `grant:${proposal.id}`,
      expiresAt: "2026-10-28T02:41:00.000Z",
      proposalDigest: mandateFingerprint(mandate),
    }),
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-1",
    mandateId: mandate.id,
    agentId: agent.id,
    amount: { currency: "USD", minor: 5_000 },
    quantity: 1,
    merchant: { id: "merchant-approved", displayName: "Approved Merchant" },
    category: "LAB_SUPPLIES",
    condition: "NEW",
    requestedCapability: "CAPTURE_PAYMENT",
    proposedAt: now,
    nonce: "gateway-nonce-0001",
    metadata: {},
    ...overrides,
  };
}

describe("M7 external agent gateway", () => {
  it("routes an allowed external request through the real Trust Kernel", async () => {
    const gateway = fixture();
    const result = await gateway.requestAction(access, request(), {
      now,
      merchantRisk: "LOW",
    });
    expect(result.decision.decision).toBe("ALLOW");
    expect(result.executionCapability?.grantId).toBe("grant:request-1");
  });

  it("blocks amount and merchant drift without trusting external authority assertions", async () => {
    const gateway = fixture();
    const result = await gateway.requestAction(
      access,
      request({
        amount: { currency: "USD", minor: 12_000 },
        merchant: { id: "merchant-evil", displayName: "Substitute" },
      }),
      { now, merchantRisk: "LOW" },
    );
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.reasonCodes).toContain("AMOUNT_EXCEEDS_LIMIT");
    expect(result.decision.reasonCodes).toContain("MERCHANT_NOT_ALLOWED");
  });

  it("makes duplicate gateway invocation replay-safe", async () => {
    const gateway = fixture();
    const first = await gateway.requestAction(access, request(), {
      now,
      merchantRisk: "LOW",
    });
    const second = await gateway.requestAction(access, request(), {
      now,
      merchantRisk: "LOW",
    });
    expect(first.decision.decision).toBe("ALLOW");
    expect(second.decision.decision).toBe("DENY");
    expect(second.decision.reasonCodes).toContain("REPLAY_DETECTED");
  });

  it.each(["REVOKED", "SUSPENDED"] as const)(
    "fails closed for %s Authority without consuming the nonce",
    async (state) => {
      const gateway = fixture(state);
      await expect(
        gateway.requestAction(access, request(), { now, merchantRisk: "LOW" }),
      ).rejects.toMatchObject({ code: "AUTHORITY_INACTIVE" });
      await expect(
        gateway.readAuthority(access, mandate.id, now),
      ).resolves.toMatchObject({ status: state });
    },
  );

  it("checkAction is read-only: repeatable, never consumes the nonce, never issues a capability", async () => {
    const gateway = fixture();
    const readOnly = { ...access, scopes: ["authority:read"] };
    const a = await gateway.checkAction(readOnly, request(), {
      now,
      merchantRisk: "LOW",
    });
    const b = await gateway.checkAction(readOnly, request(), {
      now,
      merchantRisk: "LOW",
    });
    expect(a.decision.decision).toBe("ALLOW");
    expect(b.decision.decision).toBe("ALLOW");
    expect("executionCapability" in a).toBe(false);
    // The nonce is still unspent, so the real request succeeds exactly once.
    const real = await gateway.requestAction(access, request(), {
      now,
      merchantRisk: "LOW",
    });
    expect(real.decision.decision).toBe("ALLOW");
    // A read-only token cannot request an action.
    await expect(
      gateway.requestAction(
        readOnly,
        request({ nonce: "gateway-nonce-0000002" }),
        { now, merchantRisk: "LOW" },
      ),
    ).rejects.toMatchObject({ code: "ACCESS_SCOPE_DENIED" });
  });

  it("refuses an access token bound to a different agent", async () => {
    const gateway = fixture();
    await expect(
      gateway.requestAction({ ...access, agentId: "agent-other" }, request(), {
        now,
        merchantRisk: "LOW",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_AGENT_MISMATCH" });
  });
});
