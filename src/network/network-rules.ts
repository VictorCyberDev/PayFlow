export type NetworkParticipantRole = "ISSUER" | "VERIFIER" | "AGENT" | "RAIL";

export interface NetworkObligation {
  readonly role: NetworkParticipantRole;
  readonly obligation: string;
  readonly evidenceRequired: string;
}

export const NETWORK_OBLIGATIONS: readonly NetworkObligation[] = [
  {
    role: "ISSUER",
    obligation:
      "Issue only authenticated, bounded Authority and publish revocation/key status",
    evidenceRequired: "issuance record + key/revocation metadata",
  },
  {
    role: "VERIFIER",
    obligation:
      "Verify freshness, audience, issuer trust and tamper evidence without moving money",
    evidenceRequired: "verification request/verdict",
  },
  {
    role: "AGENT",
    obligation:
      "Submit the exact intended action and never widen delegated Authority",
    evidenceRequired: "bound action request + delegation path",
  },
  {
    role: "RAIL",
    obligation:
      "Honor only valid bounded grants, preserve idempotency and report ambiguous effects as UNKNOWN",
    evidenceRequired: "provider reference/effect evidence",
  },
] as const;

export type RecourseCaseState =
  "OPEN" | "EVIDENCE_COMPLETE" | "RESOLVED" | "UNRESOLVED";

export interface RecourseEvidence {
  readonly authorityReference: string;
  readonly actionReference: string;
  readonly executionGrantReference?: string;
  readonly providerReference?: string;
  readonly proofReference?: string;
  readonly revocationEvidence?: string;
  readonly reconciliationEvidence?: string;
  readonly incidentReference?: string;
}

export function evaluateRecourseEvidence(
  outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN",
  evidence: RecourseEvidence,
): { state: RecourseCaseState; missing: readonly string[] } {
  const missing: string[] = [];
  if (!evidence.authorityReference) missing.push("AUTHORITY_REFERENCE");
  if (!evidence.actionReference) missing.push("ACTION_REFERENCE");
  if (outcome === "SUCCEEDED" && !evidence.providerReference)
    missing.push("PROVIDER_REFERENCE");
  if (outcome === "UNKNOWN" && !evidence.reconciliationEvidence)
    missing.push("RECONCILIATION_EVIDENCE");
  if (!evidence.proofReference) missing.push("PROOF_REFERENCE");
  return {
    state:
      missing.length === 0
        ? "EVIDENCE_COMPLETE"
        : outcome === "UNKNOWN"
          ? "UNRESOLVED"
          : "OPEN",
    missing,
  };
}
