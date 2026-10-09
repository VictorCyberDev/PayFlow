import { randomUUID } from "node:crypto";
import { mandateFingerprint } from "./canonical.js";
import {
  MerchantRiskSchema,
  AgentPassportSchema,
  MandateSchema,
  TransactionProposalSchema,
  type AgentPassport,
  type CheckResult,
  type DecisionCode,
  type DecisionReceipt,
  type Mandate,
  type MerchantRisk,
  type TransactionProposal,
} from "./domain.js";

export const AUTHORIZATION_ENGINE_VERSION = "payflow-trust-kernel/1.0";
const riskRank: Readonly<Record<MerchantRisk, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  EXCESSIVE: 3,
};

export interface AuthorizationContext {
  readonly now: string;
  readonly merchantRisk: MerchantRisk;
  readonly cumulativeSpentMinor: number;
  readonly replaySeen: boolean;
}

const checkNames = [
  "mandate",
  "mandateIntegrity",
  "agentAuthority",
  "capability",
  "budget",
  "approvalCeiling",
  "cumulativeBudget",
  "currency",
  "category",
  "condition",
  "merchantRisk",
  "replay",
] as const;

function blankChecks(): Record<(typeof checkNames)[number], CheckResult> {
  return Object.fromEntries(
    checkNames.map((name) => [name, "NOT_EVALUATED"]),
  ) as Record<(typeof checkNames)[number], CheckResult>;
}

export function authorize(
  rawMandate: unknown,
  rawAgent: unknown,
  rawProposal: unknown,
  context: AuthorizationContext,
): DecisionReceipt {
  const mandateResult = MandateSchema.safeParse(rawMandate);
  const agentResult = AgentPassportSchema.safeParse(rawAgent);
  const proposalResult = TransactionProposalSchema.safeParse(rawProposal);
  const checks = blankChecks();
  const fallback =
    rawProposal !== null && typeof rawProposal === "object"
      ? (rawProposal as Record<string, unknown>)
      : {};

  if (
    !mandateResult.success ||
    !agentResult.success ||
    !proposalResult.success ||
    !Number.isSafeInteger(context.cumulativeSpentMinor) ||
    context.cumulativeSpentMinor < 0 ||
    !MerchantRiskSchema.safeParse(context.merchantRisk).success ||
    !Number.isFinite(Date.parse(context.now))
  ) {
    return {
      receiptId: randomUUID(),
      decision: "DENY",
      reasonCodes: ["MALFORMED_INPUT"],
      mandateId: mandateResult.success ? mandateResult.data.id : "INVALID",
      mandateFingerprint: mandateResult.success
        ? mandateFingerprint(mandateResult.data)
        : "INVALID",
      agentId: agentResult.success ? agentResult.data.id : "INVALID",
      proposalId: typeof fallback.id === "string" ? fallback.id : "INVALID",
      amount: proposalResult.success
        ? proposalResult.data.amount
        : { currency: "XXX", minor: 0 },
      checks,
      evaluatedAt: context.now,
      authorizationEngineVersion: AUTHORIZATION_ENGINE_VERSION,
    };
  }

  const mandate: Mandate = mandateResult.data;
  const agent: AgentPassport = agentResult.data;
  const proposal: TransactionProposal = proposalResult.data;
  const reasons: DecisionCode[] = [];
  const now = Date.parse(context.now);
  const fail = (code: DecisionCode) => {
    if (!reasons.includes(code)) reasons.push(code);
  };

  checks.mandate =
    now >= Date.parse(mandate.createdAt) && now < Date.parse(mandate.expiresAt)
      ? "PASS"
      : "FAIL";
  if (checks.mandate === "FAIL") fail("MANDATE_EXPIRED");

  const fingerprint = mandateFingerprint(mandate);
  checks.mandateIntegrity =
    proposal.mandateId === mandate.id &&
    proposal.mandateFingerprint === fingerprint
      ? "PASS"
      : "FAIL";
  if (checks.mandateIntegrity === "FAIL") fail("MANDATE_INTEGRITY_FAILURE");

  const agentMatches =
    agent.id === mandate.authorizedAgentId &&
    agent.principalId === mandate.principalId &&
    proposal.agentId === agent.id;
  checks.agentAuthority =
    agentMatches &&
    agent.status === "ACTIVE" &&
    now >= Date.parse(agent.issuedAt) &&
    now < Date.parse(agent.expiresAt)
      ? "PASS"
      : "FAIL";
  if (!agentMatches) fail("AGENT_UNAUTHORIZED");
  if (agent.status === "SUSPENDED" || agent.status === "REVOKED") {
    fail("AGENT_SUSPENDED");
  }
  if (now >= Date.parse(agent.expiresAt) || now < Date.parse(agent.issuedAt))
    fail("AGENT_EXPIRED");

  const capabilityAllowed =
    mandate.allowedCapabilities.includes(proposal.requestedCapability) &&
    agent.capabilities.includes(proposal.requestedCapability);
  checks.capability = capabilityAllowed ? "PASS" : "FAIL";
  if (!capabilityAllowed) fail("CAPABILITY_DENIED");

  checks.budget =
    proposal.amount.minor <= mandate.maxSingleTransactionMinor
      ? "PASS"
      : "FAIL";
  if (checks.budget === "FAIL") fail("AMOUNT_EXCEEDS_LIMIT");

  checks.approvalCeiling =
    proposal.amount.minor <= mandate.humanApprovalThresholdMinor
      ? "PASS"
      : "FAIL";
  if (checks.approvalCeiling === "FAIL") {
    fail("HUMAN_APPROVAL_LIMIT_EXCEEDED");
  }

  const cumulativeAllowed =
    Number.isSafeInteger(
      context.cumulativeSpentMinor + proposal.amount.minor,
    ) &&
    (mandate.cumulativeLimitMinor === undefined ||
      context.cumulativeSpentMinor + proposal.amount.minor <=
        mandate.cumulativeLimitMinor);
  checks.cumulativeBudget = cumulativeAllowed ? "PASS" : "FAIL";
  if (!cumulativeAllowed) fail("CUMULATIVE_LIMIT_EXCEEDED");

  checks.currency =
    proposal.amount.currency === mandate.currency ? "PASS" : "FAIL";
  if (checks.currency === "FAIL") fail("CURRENCY_MISMATCH");

  checks.category = proposal.category === mandate.category ? "PASS" : "FAIL";
  if (checks.category === "FAIL") fail("CATEGORY_DENIED");

  checks.condition = mandate.allowedConditions.includes(proposal.condition)
    ? "PASS"
    : "FAIL";
  if (checks.condition === "FAIL") fail("CONDITION_DENIED");

  checks.merchantRisk =
    riskRank[context.merchantRisk] <= riskRank[mandate.merchantRiskCeiling]
      ? "PASS"
      : "FAIL";
  if (checks.merchantRisk === "FAIL") fail("MERCHANT_RISK_TOO_HIGH");

  checks.replay = context.replaySeen ? "FAIL" : "PASS";
  if (context.replaySeen) fail("REPLAY_DETECTED");

  let decision: DecisionReceipt["decision"];
  if (reasons.length > 0) {
    decision = "DENY";
  } else if (proposal.amount.minor > mandate.autonomousPurchaseThresholdMinor) {
    decision = "ESCALATE";
    reasons.push("HUMAN_APPROVAL_REQUIRED");
    checks.budget = "ESCALATE";
  } else {
    decision = "ALLOW";
    reasons.push("ALLOWED");
  }

  return {
    receiptId: randomUUID(),
    decision,
    reasonCodes: reasons,
    mandateId: mandate.id,
    mandateFingerprint: fingerprint,
    agentId: agent.id,
    proposalId: proposal.id,
    amount: proposal.amount,
    checks,
    evaluatedAt: context.now,
    authorizationEngineVersion: AUTHORIZATION_ENGINE_VERSION,
  };
}
