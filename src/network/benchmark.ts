import { mandateFingerprint } from "../canonical.js";
import type {
  AgentPassport,
  DecisionReceipt,
  Mandate,
  TransactionProposal,
} from "../domain.js";
import { authorize, type AuthorizationContext } from "../kernel.js";

export type AttackFamily =
  | "AMOUNT_WIDENING"
  | "MERCHANT_SUBSTITUTION"
  | "CURRENCY_SUBSTITUTION"
  | "CAPABILITY_ESCALATION"
  | "CONDITION_SUBSTITUTION"
  | "REPLAY"
  | "WRONG_AGENT"
  | "EXPIRED_AUTHORITY"
  | "QUANTITY_WIDENING"
  | "MERCHANT_RISK_WIDENING";

export interface BreakAuthorityScenarioResult {
  readonly id: string;
  readonly family: AttackFamily;
  readonly decision: DecisionReceipt["decision"];
  readonly reasonCodes: readonly string[];
}

export interface BreakAuthorityReport {
  readonly version: "break-authority/v1";
  readonly scenarioCount: number;
  readonly unauthorizedAllows: number;
  readonly providerEffectsExercised: false;
  readonly controlDecision: DecisionReceipt["decision"];
  readonly results: readonly BreakAuthorityScenarioResult[];
}

function fixture() {
  const mandate: Mandate = {
    id: "benchmark-authority",
    principalId: "benchmark-principal",
    authorizedAgentId: "benchmark-agent",
    purpose: "bounded benchmark purchase",
    category: "PROCUREMENT",
    currency: "USD",
    maxSingleTransactionMinor: 10_000,
    cumulativeLimitMinor: 25_000,
    quantityLimit: 2,
    merchantScope: { mode: "ONLY", ids: ["merchant-allowed"] },
    allowedConditions: ["NEW"],
    merchantRiskCeiling: "LOW",
    autonomousPurchaseThresholdMinor: 8_000,
    humanApprovalThresholdMinor: 10_000,
    allowedCapabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
    expiresAt: "2026-10-29T03:00:00.000Z",
    createdAt: "2026-10-28T02:00:00.000Z",
    version: 1,
    nonce: "benchmark-mandate-nonce",
  };
  const agent: AgentPassport = {
    id: "benchmark-agent",
    principalId: "benchmark-principal",
    displayName: "Benchmark Agent",
    issuedAt: "2026-10-28T02:00:00.000Z",
    expiresAt: "2026-10-29T03:00:00.000Z",
    status: "ACTIVE",
    capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
  };
  const proposal: TransactionProposal = {
    id: "benchmark-proposal",
    agentId: agent.id,
    mandateId: mandate.id,
    mandateFingerprint: mandateFingerprint(mandate),
    amount: { currency: "USD", minor: 5_000 },
    quantity: 1,
    merchant: { id: "merchant-allowed", displayName: "Allowed Merchant" },
    category: "PROCUREMENT",
    condition: "NEW",
    requestedCapability: "CAPTURE_PAYMENT",
    proposedAt: "2026-10-28T03:00:00.000Z",
    nonce: "benchmark-proposal-nonce",
    metadata: {},
  };
  const context: AuthorizationContext = {
    now: "2026-10-28T03:00:00.000Z",
    merchantRisk: "LOW",
    cumulativeSpentMinor: 0,
    replaySeen: false,
    consumedQuantity: 0,
  };
  return { mandate, agent, proposal, context };
}

function attack(
  family: AttackFamily,
  variant: number,
): {
  mandate: unknown;
  agent: unknown;
  proposal: unknown;
  context: AuthorizationContext;
} {
  const base = fixture();
  switch (family) {
    case "AMOUNT_WIDENING":
      return {
        ...base,
        proposal: {
          ...base.proposal,
          amount: { currency: "USD", minor: 10_001 + variant },
        },
      };
    case "MERCHANT_SUBSTITUTION":
      return {
        ...base,
        proposal: {
          ...base.proposal,
          merchant: { id: `merchant-attacker-${variant}`, displayName: "Substitute" },
        },
      };
    case "CURRENCY_SUBSTITUTION":
      return {
        ...base,
        proposal: { ...base.proposal, amount: { currency: "EUR", minor: 5_000 } },
      };
    case "CAPABILITY_ESCALATION":
      return {
        ...base,
        proposal: { ...base.proposal, requestedCapability: "REQUEST_REFUND" },
      };
    case "CONDITION_SUBSTITUTION":
      return {
        ...base,
        proposal: { ...base.proposal, condition: "USED" },
      };
    case "REPLAY":
      return { ...base, context: { ...base.context, replaySeen: true } };
    case "WRONG_AGENT":
      return {
        ...base,
        agent: { ...base.agent, id: `attacker-agent-${variant}` },
      };
    case "EXPIRED_AUTHORITY":
      return {
        ...base,
        context: { ...base.context, now: "2026-10-30T03:00:00.000Z" },
      };
    case "QUANTITY_WIDENING":
      return {
        ...base,
        proposal: { ...base.proposal, quantity: 3 + variant },
      };
    case "MERCHANT_RISK_WIDENING":
      return {
        ...base,
        context: { ...base.context, merchantRisk: "HIGH" },
      };
  }
}

const families: readonly AttackFamily[] = [
  "AMOUNT_WIDENING",
  "MERCHANT_SUBSTITUTION",
  "CURRENCY_SUBSTITUTION",
  "CAPABILITY_ESCALATION",
  "CONDITION_SUBSTITUTION",
  "REPLAY",
  "WRONG_AGENT",
  "EXPIRED_AUTHORITY",
  "QUANTITY_WIDENING",
  "MERCHANT_RISK_WIDENING",
];

export function runBreakAuthorityBenchmark(scenarioCount: 100 | 1000): BreakAuthorityReport {
  const results: BreakAuthorityScenarioResult[] = [];
  for (let index = 0; index < scenarioCount; index += 1) {
    const family = families[index % families.length];
    if (!family) throw new Error("benchmark family invariant");
    const variant = Math.floor(index / families.length);
    const scenario = attack(family, variant);
    const receipt = authorize(
      scenario.mandate,
      scenario.agent,
      scenario.proposal,
      scenario.context,
    );
    results.push({
      id: `${family.toLowerCase()}-${String(variant).padStart(3, "0")}`,
      family,
      decision: receipt.decision,
      reasonCodes: receipt.reasonCodes,
    });
  }
  const control = fixture();
  const controlReceipt = authorize(
    control.mandate,
    control.agent,
    control.proposal,
    control.context,
  );
  return {
    version: "break-authority/v1",
    scenarioCount,
    unauthorizedAllows: results.filter((result) => result.decision === "ALLOW").length,
    providerEffectsExercised: false,
    controlDecision: controlReceipt.decision,
    results,
  };
}
