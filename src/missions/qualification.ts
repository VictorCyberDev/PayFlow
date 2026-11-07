import type { MissionContract } from "./contract.js";

/**
 * V3 M33 — deciding whether a supplier is QUALIFIED. Pure and deterministic.
 *
 * A criterion is satisfied only by a VERIFIED fact that is still within its validity, with evidence acceptable for that
 * criterion. A FAILED fact fails the supplier. Everything else (a claim, an unknown, nothing recorded, an expired verification)
 * leaves the criterion OPEN, and an open criterion is never counted as met. QUALIFIED is a statement about evidence on file; it
 * is not an approval to negotiate or buy.
 */
export type EvidenceKind =
  "NONE" | "CONNECTOR_CALL" | "DOCUMENT_REF" | "OWNER_ATTESTATION";
export type FactStatus = "CLAIMED" | "VERIFIED" | "FAILED" | "UNKNOWN";

export interface CriterionDef {
  readonly id: string;
  readonly title: string;
  /** Which evidence can support VERIFIED. Anything else can only ever be a CLAIM. */
  readonly acceptableEvidence: readonly EvidenceKind[];
  /** How long a verification stays good. */
  readonly validDays: number;
  /** Plain words on what closes this criterion. */
  readonly howToClose: string;
}
/** Computed from the contract, never recorded. */
export const COMPUTED_CRITERION = "CONTRACT_ALLOWED";
export const CRITERIA: readonly CriterionDef[] = [
  {
    id: "IDENTITY",
    title: "The legal entity is who it says it is",
    acceptableEvidence: ["OWNER_ATTESTATION", "DOCUMENT_REF"],
    validDays: 365,
    howToClose:
      "A person checks a registry or document and attests, or references the document they checked.",
  },
  {
    id: "PAYMENT_ACCEPTED",
    title: "Accepts the payment method the mission would use",
    acceptableEvidence: ["CONNECTOR_CALL", "OWNER_ATTESTATION"],
    validDays: 90,
    howToClose:
      "A reviewed connector observation that states it, or a person's attestation.",
  },
  {
    id: "RETURN_POLICY",
    title: "Has a stated return or refund policy",
    acceptableEvidence: ["CONNECTOR_CALL", "DOCUMENT_REF"],
    validDays: 90,
    howToClose:
      "A reviewed connector observation or a referenced policy document.",
  },
  {
    id: "WARRANTY",
    title: "States a warranty where one applies",
    acceptableEvidence: ["CONNECTOR_CALL", "DOCUMENT_REF"],
    validDays: 90,
    howToClose: "A reviewed connector observation or a referenced document.",
  },
  {
    id: "SHIPS_TO_REGION",
    title: "Ships to the delivery region",
    acceptableEvidence: ["CONNECTOR_CALL", "DOCUMENT_REF", "OWNER_ATTESTATION"],
    validDays: 30,
    howToClose:
      "A reviewed observation, document or attestation naming the region.",
  },
  {
    id: "REFERENCES",
    title: "Independent references or track record on file",
    acceptableEvidence: ["DOCUMENT_REF", "OWNER_ATTESTATION"],
    validDays: 180,
    howToClose: "A person records the references they checked.",
  },
  {
    id: "SANCTIONS_SCREEN",
    title: "Screened against sanctions and restricted-party lists",
    // PayFlow does not screen. Only a person's attestation that their own screening was done can support this.
    acceptableEvidence: ["OWNER_ATTESTATION"],
    validDays: 30,
    howToClose:
      "A person attests that their own screening was done. PayFlow does not perform sanctions screening.",
  },
];
export const CRITERION_IDS = CRITERIA.map((c) => c.id);
export const DEFAULT_REQUIRED: readonly string[] = [
  COMPUTED_CRITERION,
  "IDENTITY",
  "PAYMENT_ACCEPTED",
  "RETURN_POLICY",
];
export const criterionDef = (id: string) => CRITERIA.find((c) => c.id === id);

export interface FactRow {
  readonly criterion: string;
  readonly status: FactStatus;
  readonly evidenceKind: EvidenceKind;
  readonly evidenceRef: string | null;
  readonly recordedAt: string;
  readonly actorKind: "MEMBER" | "AGENT";
}

/** May this fact be recorded as VERIFIED? Agents never; evidence must be acceptable for the criterion and must point at something. */
export function verificationProblem(
  criterion: string,
  evidenceKind: EvidenceKind,
  evidenceRef: string | null,
  actorKind: "MEMBER" | "AGENT",
): string | null {
  const def = criterionDef(criterion);
  if (!def) return "UNKNOWN_CRITERION";
  if (actorKind !== "MEMBER") return "ONLY_A_PERSON_CAN_VERIFY";
  if (!def.acceptableEvidence.includes(evidenceKind))
    return `EVIDENCE_NOT_ACCEPTABLE:${def.acceptableEvidence.join("|")}`;
  if (evidenceKind !== "OWNER_ATTESTATION" && !evidenceRef)
    return "EVIDENCE_REFERENCE_REQUIRED";
  return null;
}

export type CriterionState = "SATISFIED" | "FAILED" | "OPEN";
export interface CriterionResult {
  readonly criterion: string;
  readonly state: CriterionState;
  readonly reason: string;
  readonly fact: FactRow | null;
  readonly expired: boolean;
}

/** MERCHANT allowed by the contract? ANY = yes; NONE_ALLOWED = no; ONLY = if listed. */
export function contractAllows(
  contract: Pick<MissionContract, "merchantRestrictions">,
  externalRef: string,
): { allowed: boolean; reason: string } {
  const m = contract.merchantRestrictions;
  if (m.mode === "NONE_ALLOWED")
    return { allowed: false, reason: "The contract allows no merchant." };
  if (m.mode === "ANY")
    return { allowed: true, reason: "The contract allows any merchant." };
  return m.ids.includes(externalRef)
    ? { allowed: true, reason: "The contract names this merchant." }
    : { allowed: false, reason: "The contract does not name this merchant." };
}

export function assess(
  required: readonly string[],
  latest: ReadonlyMap<string, FactRow>,
  contract: Pick<MissionContract, "merchantRestrictions">,
  externalRef: string,
  now: string,
) {
  const results: CriterionResult[] = required.map((id) => {
    if (id === COMPUTED_CRITERION) {
      const c = contractAllows(contract, externalRef);
      return {
        criterion: id,
        state: c.allowed ? ("SATISFIED" as const) : ("FAILED" as const),
        reason: c.reason,
        fact: null,
        expired: false,
      };
    }
    const def = criterionDef(id);
    const f = latest.get(id) ?? null;
    if (!def)
      return {
        criterion: id,
        state: "OPEN",
        reason: "Unknown criterion.",
        fact: null,
        expired: false,
      };
    if (!f)
      return {
        criterion: id,
        state: "OPEN",
        reason: "Nothing recorded.",
        fact: null,
        expired: false,
      };
    if (f.status === "FAILED")
      return {
        criterion: id,
        state: "FAILED",
        reason: "A failure is on file.",
        fact: f,
        expired: false,
      };
    if (f.status !== "VERIFIED")
      return {
        criterion: id,
        state: "OPEN",
        reason:
          f.status === "CLAIMED"
            ? "Only claimed, not verified by a person."
            : "Not known.",
        fact: f,
        expired: false,
      };
    // Defence in depth: even if a row somehow says VERIFIED, it counts only if the evidence is acceptable for the criterion.
    if (!def.acceptableEvidence.includes(f.evidenceKind))
      return {
        criterion: id,
        state: "OPEN",
        reason: "The evidence on file is not acceptable for this criterion.",
        fact: f,
        expired: false,
      };
    const ageDays = (Date.parse(now) - Date.parse(f.recordedAt)) / 86_400_000;
    if (ageDays > def.validDays)
      return {
        criterion: id,
        state: "OPEN",
        reason: `Verified ${Math.floor(ageDays)} days ago; good for ${def.validDays}.`,
        fact: f,
        expired: true,
      };
    return {
      criterion: id,
      state: "SATISFIED",
      reason: "Verified by a person with acceptable evidence.",
      fact: f,
      expired: false,
    };
  });
  const outcome: "QUALIFIED" | "NOT_QUALIFIED" | "INCOMPLETE" = results.some(
    (r) => r.state === "FAILED",
  )
    ? "NOT_QUALIFIED"
    : results.every((r) => r.state === "SATISFIED") && results.length > 0
      ? "QUALIFIED"
      : "INCOMPLETE";
  return { outcome, criteria: results };
}
