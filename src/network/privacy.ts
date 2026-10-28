import { createHash } from "node:crypto";

export type DataClass =
  | "PUBLIC"
  | "OPERATIONAL"
  | "PERSONAL"
  | "SECRET_REFERENCE"
  | "IMMUTABLE_FINANCIAL_EVIDENCE";

export interface RetentionRule {
  readonly dataClass: DataClass;
  readonly retentionDays: number | "INDEFINITE_BY_EVIDENCE_POLICY";
  readonly deletable: boolean;
  readonly exportable: boolean;
  readonly rationale: string;
}

export const DEFAULT_RETENTION_RULES: readonly RetentionRule[] = [
  {
    dataClass: "PUBLIC",
    retentionDays: 3650,
    deletable: true,
    exportable: true,
    rationale: "public documentation and metadata",
  },
  {
    dataClass: "OPERATIONAL",
    retentionDays: 365,
    deletable: true,
    exportable: true,
    rationale: "bounded operational debugging and support",
  },
  {
    dataClass: "PERSONAL",
    retentionDays: 365,
    deletable: true,
    exportable: true,
    rationale: "minimize personal data while supporting account operations",
  },
  {
    dataClass: "SECRET_REFERENCE",
    retentionDays: 90,
    deletable: true,
    exportable: false,
    rationale: "references only; raw secrets are not evidence",
  },
  {
    dataClass: "IMMUTABLE_FINANCIAL_EVIDENCE",
    retentionDays: "INDEFINITE_BY_EVIDENCE_POLICY",
    deletable: false,
    exportable: true,
    rationale:
      "preserve historical financial truth, subject to applicable legal policy",
  },
] as const;

export type DeletionDecision =
  | { allowed: true; reason: "DELETION_ALLOWED" }
  | { allowed: false; reason: "IMMUTABLE_FINANCIAL_EVIDENCE" };

export function deletionDecision(dataClass: DataClass): DeletionDecision {
  return dataClass === "IMMUTABLE_FINANCIAL_EVIDENCE"
    ? { allowed: false, reason: "IMMUTABLE_FINANCIAL_EVIDENCE" }
    : { allowed: true, reason: "DELETION_ALLOWED" };
}

/** One-way tenant-scoped identifier. It is pseudonymous, not anonymous. */
export function pseudonymousSubjectId(
  organizationId: string,
  subjectId: string,
): string {
  return `psn_${createHash("sha256")
    .update(organizationId, "utf8")
    .update("\u0000", "utf8")
    .update(subjectId, "utf8")
    .digest("hex")}`;
}
