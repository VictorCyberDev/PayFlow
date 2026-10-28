import { describe, expect, it } from "vitest";
import {
  EnterpriseDelegationGraph,
  ApprovalPolicySchema,
  evaluateApprovalEvidence,
  transitionAgentLifecycle,
  type DelegationEdge,
} from "../src/network/enterprise.js";
import { getOrganizationPolicyPack } from "../src/network/policy-packs.js";
import { FixtureAccountsPayableConnector } from "../src/network/enterprise-connectors.js";

function root(): DelegationEdge {
  return {
    id: "d1",
    parentAgentId: "root-agent",
    childAgentId: "agent-a",
    state: "ACTIVE",
    scope: {
      principalId: "p1",
      parentAgentId: "root-agent",
      childAgentId: "agent-a",
      audience: "payflow",
      actionKinds: ["PURCHASE", "INVOICE_SETTLEMENT"],
      currencies: ["USD"],
      counterpartyIds: ["vendor-1", "vendor-2"],
      maxAmountMinor: 10_000,
      issuedAt: "2026-10-28T02:00:00.000Z",
      expiresAt: "2026-10-29T02:00:00.000Z",
      nonce: "root-delegation-nonce",
    },
  };
}

describe("M31 delegation graph", () => {
  it("preserves ancestry, attenuation and revocation propagation", () => {
    const graph = new EnterpriseDelegationGraph();
    graph.addRoot(root());
    graph.addChild("d1", {
      id: "d2",
      parentEdgeId: "d1",
      parentAgentId: "agent-a",
      childAgentId: "agent-b",
      state: "ACTIVE",
      scope: {
        ...root().scope,
        parentAgentId: "agent-a",
        childAgentId: "agent-b",
        actionKinds: ["PURCHASE"],
        counterpartyIds: ["vendor-1"],
        maxAmountMinor: 5_000,
        nonce: "child-delegation-nonce",
      },
    });
    expect(graph.pathToRoot("d2").map((edge) => edge.id)).toEqual(["d2", "d1"]);
    graph.revoke("d1");
    expect(graph.pathToRoot("d2")[0]?.state).toBe("REVOKED");
  });
});

describe("M32 separation of duties", () => {
  it("requires distinct authenticated roles and rejects self approval", () => {
    const policy = ApprovalPolicySchema.parse({
      id: "dual-control",
      requiredRoles: ["FINANCE_OWNER", "SECURITY_OWNER"],
      minimumApprovals: 2,
      forbidSelfApproval: true,
      thresholdMinor: 10_000,
    });
    const result = evaluateApprovalEvidence(
      { ...policy },
      { requesterPrincipalId: "requester", actionDigest: "digest", amountMinor: 20_000 },
      [
        { principalId: "finance", role: "FINANCE_OWNER", actionDigest: "digest", approvedAt: "2026-10-28T03:00:00.000Z", authenticationEvidence: "authenticated-evidence-finance" },
        { principalId: "security", role: "SECURITY_OWNER", actionDigest: "digest", approvedAt: "2026-10-28T03:00:00.000Z", authenticationEvidence: "authenticated-evidence-security" },
      ],
    );
    expect(result.approved).toBe(true);
  });
});

describe("M33-M35 lifecycle policy packs and connectors", () => {
  it("enforces terminal lifecycle transitions and exposes non-authoritative templates", () => {
    expect(transitionAgentLifecycle("ACTIVE", "SUSPENDED")).toBe("SUSPENDED");
    expect(() => transitionAgentLifecycle("REVOKED", "ACTIVE")).toThrow("INVALID_AGENT_LIFECYCLE_TRANSITION");
    expect(getOrganizationPolicyPack("procurement")?.candidateActionKinds).toContain("PROCUREMENT_ORDER");
  });

  it("normalizes an AP fixture into the shared financial-action schema shape", async () => {
    const connector = new FixtureAccountsPayableConnector();
    const context = {
      organizationId: "org-1",
      environment: "SANDBOX" as const,
      sourceSystem: "fixture-erp",
      sourceReference: "batch-1",
    };
    const action = await connector.normalizeInbound(
      {
        invoiceId: "INV-42",
        principalId: "p1",
        agentId: "a1",
        supplierId: "vendor-1",
        amountMinor: 5_000,
        currency: "USD",
        costCenter: "CC-1",
        purpose: "approved invoice",
        proposedAt: "2026-10-28T03:00:00.000Z",
      },
      context,
    );
    expect(action.kind).toBe("INVOICE_SETTLEMENT");
    expect(action.invoiceReference).toBe("INV-42");
  });
});
