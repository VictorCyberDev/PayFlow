/**
 * Reference external agent: accounts-payable / procurement.
 *
 * Journey (everything local; the rail is the deterministic FAKE rail):
 *   invoice -> procurement pack check -> SDK -> REST -> Gateway -> Trust Kernel
 *   -> bounded capability -> rail execution -> UNKNOWN handling -> reconciliation.
 *
 * Run: npx tsx examples/procurement-ap-agent.ts
 */
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { mandateFingerprint } from "../src/canonical.js";
import type { AgentPassport, Mandate } from "../src/domain.js";
import {
  GATEWAY_AUDIENCE,
  FinancialAuthorityGateway,
} from "../src/network/gateway.js";
import { FinancialActionSchema } from "../src/network/financial-action.js";
import {
  ProcurementAuthorityPackSchema,
  evaluateProcurementAction,
} from "../src/network/procurement.js";
import {
  DeterministicFakeRail,
  financialActionDigest,
  reconcileWithoutReexecution,
} from "../src/network/rail.js";
import { createGatewayRestHandler } from "../src/network/rest.js";

const NOW = "2026-10-28T03:00:00.000Z";

export async function runProcurementExample() {
  const mandate: Mandate = {
    id: "ap-authority-1",
    principalId: "finance-team",
    authorizedAgentId: "ap-agent-1",
    purpose: "pay approved lab-supply invoices",
    category: "LAB_SUPPLIES",
    currency: "USD",
    maxSingleTransactionMinor: 50_000,
    cumulativeLimitMinor: 120_000,
    merchantScope: { mode: "ONLY", ids: ["vendor-acme"] },
    allowedConditions: ["NEW"],
    merchantRiskCeiling: "LOW",
    autonomousPurchaseThresholdMinor: 50_000,
    humanApprovalThresholdMinor: 50_000,
    allowedCapabilities: ["CAPTURE_PAYMENT"],
    expiresAt: "2026-11-28T00:00:00.000Z",
    createdAt: "2026-10-28T00:00:00.000Z",
    version: 1,
    nonce: "ap-authority-nonce-0001",
  };
  const agent: AgentPassport = {
    id: "ap-agent-1",
    principalId: "finance-team",
    displayName: "AP Agent",
    issuedAt: "2026-10-28T00:00:00.000Z",
    expiresAt: "2026-11-28T00:00:00.000Z",
    status: "ACTIVE",
    capabilities: ["CAPTURE_PAYMENT"],
  };
  const pack = ProcurementAuthorityPackSchema.parse({
    version: "procurement-authority/v1",
    id: "lab-supplies-q4",
    approvedVendorIds: ["vendor-acme"],
    approvedSkus: [{ sku: "PIPETTE-10", expectedUnitPriceMinor: 2_500 }],
    maxQuantity: 40,
    currency: "USD",
    budgetMinor: 50_000,
    costCenter: "LAB-7",
    purpose: "pay approved lab-supply invoices",
    expiresAt: "2026-11-28T00:00:00.000Z",
    supplierSubstitution: "DENY",
    priceToleranceBps: 200,
    maxTaxMinor: 2_000,
    maxFeeMinor: 500,
    humanEscalationAboveMinor: 50_000,
  });

  // Server side: loads Authority state itself; the agent can never supply it.
  const claimed = new Set<string>();
  const gateway = new FinancialAuthorityGateway({
    loadMandate: (id) => Promise.resolve(id === mandate.id ? mandate : null),
    loadAgent: (id) => Promise.resolve(id === agent.id ? agent : null),
    authorityState: () => Promise.resolve("ACTIVE"),
    cumulativeSpentMinor: () => Promise.resolve(0),
    consumedQuantity: () => Promise.resolve(0),
    claimReplayKey: (scope, key) => {
      const composite = `${scope}:${key}`;
      if (claimed.has(composite)) return Promise.resolve(false);
      claimed.add(composite);
      return Promise.resolve(true);
    },
    issueExecutionCapability: (_receipt, proposal) =>
      Promise.resolve({
        grantId: `grant:${proposal.id}`,
        expiresAt: "2026-10-28T03:01:00.000Z",
        proposalDigest: mandateFingerprint(mandate),
      }),
  });
  const handler = createGatewayRestHandler(gateway, {
    authenticate: (authorization) =>
      authorization === "Bearer ap-agent-token"
        ? Promise.resolve({
            clientId: "ap-client",
            agentId: agent.id,
            principalId: mandate.principalId,
            audience: GATEWAY_AUDIENCE,
            scopes: ["authority:read", "action:request"],
            issuedAt: "2026-10-28T00:00:00.000Z",
            expiresAt: "2026-11-28T00:00:00.000Z",
            status: "ACTIVE",
          })
        : Promise.reject(new Error("unauthenticated")),
    trustedMerchantRisk: () => Promise.resolve("LOW"),
    now: () => NOW,
  });
  const client = new PayFlowClient({
    baseUrl: "http://localhost:3000",
    accessToken: "ap-agent-token",
    fetch: async (input, init) => {
      const url = new URL(input as URL);
      const headers = new Headers(init?.headers);
      const reply = await handler({
        method: (init?.method ?? "GET") as "GET" | "POST",
        path: url.pathname,
        ...(headers.get("authorization")
          ? { authorization: headers.get("authorization") as string }
          : {}),
        ...(init?.body
          ? { body: JSON.parse(init.body as string) as unknown }
          : {}),
      });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    },
  });

  const invoice = FinancialActionSchema.parse({
    version: "financial-action/v1",
    id: "order-PO-1042",
    kind: "PROCUREMENT_ORDER",
    principalId: mandate.principalId,
    agentId: agent.id,
    counterparty: { id: "vendor-acme", displayName: "Acme Lab Supply" },
    amount: { currency: "USD", minor: 25_000 },
    fees: [],
    taxes: [{ currency: "USD", minor: 1_000 }],
    items: [{ sku: "PIPETTE-10", quantity: 10, unitPriceMinor: 2_500 }],
    purpose: pack.purpose,
    costCenter: "LAB-7",
    invoiceReference: "INV-1042",
    proposedAt: NOW,
    idempotencyKey: "ap-idempotency-INV-1042",
  });

  // 1. The pack check is advisory: it produces candidate violations, never authority.
  const packViolations = evaluateProcurementAction(pack, invoice, NOW);

  // 2. The Trust Kernel decides.
  const decision = (await client.requestAuthorizedAction({
    requestId: "req-INV-1042",
    mandateId: mandate.id,
    agentId: agent.id,
    amount: invoice.amount,
    merchant: { id: "vendor-acme", displayName: "Acme Lab Supply" },
    category: mandate.category,
    condition: "NEW",
    requestedCapability: "CAPTURE_PAYMENT",
    proposedAt: NOW,
    nonce: "ap-nonce-INV-1042-001",
    metadata: { invoice: "INV-1042" },
  })) as {
    decision: { decision: string };
    executionCapability?: { grantId: string };
  };

  // 3. Execute on the fake rail inside the grant window; the response is lost.
  const rail = new DeterministicFakeRail(
    "sandbox-rail",
    "TIMEOUT_AFTER_EFFECT",
  );
  const evidence = await rail.execute({
    action: invoice,
    grant: {
      grantId: decision.executionCapability?.grantId ?? "none",
      authorityId: mandate.id,
      actionDigest: financialActionDigest(invoice),
      idempotencyKey: invoice.idempotencyKey,
      expiresAt: "2026-10-28T03:01:00.000Z",
    },
    now: NOW,
  });

  // 4. UNKNOWN is never retried as a new payment; reconciliation only looks up truth.
  const truth = await reconcileWithoutReexecution(
    rail,
    invoice.idempotencyKey,
    "2026-10-28T03:05:00.000Z",
  );

  // 5. Drift is denied and produces no capability.
  const drift = (await client.requestAuthorizedAction({
    requestId: "req-INV-1043",
    mandateId: mandate.id,
    agentId: agent.id,
    amount: { currency: "USD", minor: 90_000 },
    merchant: { id: "vendor-other", displayName: "Substitute Supplier" },
    category: mandate.category,
    condition: "NEW",
    requestedCapability: "CAPTURE_PAYMENT",
    proposedAt: NOW,
    nonce: "ap-nonce-INV-1043-001",
    metadata: {},
  })) as { decision: { decision: string }; executionCapability?: unknown };

  return {
    packViolations,
    kernelDecision: decision.decision.decision,
    executionOutcomeBeforeReconciliation: evidence.state,
    reconciledState: truth.state,
    providerEffects: rail.providerEffectWrites,
    driftDecision: drift.decision.decision,
    driftCapability: drift.executionCapability ?? null,
    railKind: "deterministic-fake (no real money moved)",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runProcurementExample().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  });
}
