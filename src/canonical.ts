import { createHash } from "node:crypto";
import type { Mandate, TransactionProposal } from "./domain.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function canonicalMandate(mandate: Mandate): string {
  const securityCritical = {
    id: mandate.id,
    principalId: mandate.principalId,
    authorizedAgentId: mandate.authorizedAgentId,
    purpose: mandate.purpose,
    category: mandate.category,
    currency: mandate.currency,
    maxSingleTransactionMinor: mandate.maxSingleTransactionMinor,
    cumulativeLimitMinor: mandate.cumulativeLimitMinor ?? null,
    allowedConditions: [...mandate.allowedConditions].sort(),
    merchantRiskCeiling: mandate.merchantRiskCeiling,
    autonomousPurchaseThresholdMinor: mandate.autonomousPurchaseThresholdMinor,
    humanApprovalThresholdMinor: mandate.humanApprovalThresholdMinor,
    allowedCapabilities: [...mandate.allowedCapabilities].sort(),
    expiresAt: mandate.expiresAt,
    createdAt: mandate.createdAt,
    version: mandate.version,
    nonce: mandate.nonce,
  };
  return JSON.stringify(stable(securityCritical));
}

export function mandateFingerprint(mandate: Mandate): string {
  return createHash("sha256")
    .update(canonicalMandate(mandate), "utf8")
    .digest("hex");
}

/** Deterministic digest of every proposal field that can affect execution. */
export function canonicalProposal(proposal: TransactionProposal): string {
  return JSON.stringify(
    stable({
      id: proposal.id,
      agentId: proposal.agentId,
      mandateId: proposal.mandateId,
      mandateFingerprint: proposal.mandateFingerprint,
      amount: proposal.amount,
      merchant: proposal.merchant,
      category: proposal.category,
      condition: proposal.condition,
      requestedCapability: proposal.requestedCapability,
      proposedAt: proposal.proposedAt,
      nonce: proposal.nonce,
      metadata: proposal.metadata,
    }),
  );
}

export function proposalDigest(proposal: TransactionProposal): string {
  return createHash("sha256")
    .update(canonicalProposal(proposal), "utf8")
    .digest("hex");
}
