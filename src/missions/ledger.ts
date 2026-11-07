/**
 * Mission commitment ledger — the accounting rules, as pure functions.
 *
 * The question this answers is not "how much has been paid" but "how much of the mission ceiling is spoken for". A founder may
 * owe money before it is paid, an agent may hold a reservation that has not settled, and a payment may be of unknown outcome. The
 * ceiling must never look more available than it is.
 *
 * ONE item has ONE amount at a time and moves through stages, so an obligation that goes committed -> reserved -> settled is
 * counted once. Which stages consume budget is a decision, written here and nowhere else:
 *
 *   consumes:      APPROVED, COMMITTED, RESERVED, IN_FLIGHT, SETTLED (net of refunds), UNKNOWN
 *   does not:      ESTIMATED, QUOTED (offers and guesses), CANCELLED, RELEASED, FAILED (known zero effect), REFUNDED (fully returned)
 *
 * UNKNOWN is conservative: it keeps consuming budget until evidence resolves it. An obligation that is only owner-reported or
 * unverified still consumes (the money may be owed) but is shown as such; it is never labelled enforced or settled.
 */
export const STAGES = [
  "ESTIMATED",
  "QUOTED",
  "APPROVED",
  "COMMITTED",
  "RESERVED",
  "IN_FLIGHT",
  "SETTLED",
  "UNKNOWN",
  "REFUNDED",
  "CANCELLED",
  "RELEASED",
  "FAILED",
] as const;
export type Stage = (typeof STAGES)[number];

export const EVIDENCE_KINDS = [
  "NONE",
  "AGENT_REPORTED",
  "OWNER_REPORTED",
  "PAYFLOW_AUTHORITY_RECEIPT",
  "PAYFLOW_PROOF",
  "PROVIDER_CONFIRMATION",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const CONSUMING: readonly Stage[] = [
  "APPROVED",
  "COMMITTED",
  "RESERVED",
  "IN_FLIGHT",
  "SETTLED",
  "UNKNOWN",
];
export const consumes = (stage: Stage): boolean => CONSUMING.includes(stage);

/** Budget an item currently holds, in minor units. Refunds only reduce a SETTLED item. */
export function exposureOf(item: {
  stage: Stage;
  amountMinor: number;
  refundedMinor: number;
}): number {
  if (!consumes(item.stage)) return 0;
  return item.stage === "SETTLED"
    ? item.amountMinor - item.refundedMinor
    : item.amountMinor;
}

/** Legal stage moves. Anything not listed is refused. A move from a stage to itself is allowed only to re-quote (QUOTED -> QUOTED). */
const MOVES: Readonly<Record<Stage, readonly Stage[]>> = {
  ESTIMATED: ["QUOTED", "CANCELLED"],
  QUOTED: ["QUOTED", "APPROVED", "CANCELLED"],
  APPROVED: ["COMMITTED", "RESERVED", "QUOTED", "CANCELLED"],
  COMMITTED: ["RESERVED", "CANCELLED"],
  RESERVED: ["IN_FLIGHT", "CANCELLED"],
  IN_FLIGHT: ["SETTLED", "UNKNOWN", "FAILED"],
  UNKNOWN: ["SETTLED", "RELEASED"],
  SETTLED: ["REFUNDED"], // plus partial refunds, which do not change the stage
  REFUNDED: [],
  CANCELLED: [],
  RELEASED: [],
  FAILED: [],
};
export const canMove = (from: Stage, to: Stage): boolean =>
  MOVES[from].includes(to);

/** Only these stages may be entered by an agent: an agent can estimate and quote, never approve, commit or move money. */
export const AGENT_STAGES: readonly Stage[] = ["ESTIMATED", "QUOTED"];

/** Moves that assert what happened in the outside world need evidence from PayFlow's own decision or from the provider. */
const NEEDS_AUTHORITATIVE: readonly Stage[] = [
  "SETTLED",
  "REFUNDED",
  "FAILED",
  "RELEASED",
];
const AUTHORITATIVE: readonly EvidenceKind[] = [
  "PAYFLOW_PROOF",
  "PROVIDER_CONFIRMATION",
];
/** Entering or leaving a reservation is an Authority fact. */
const NEEDS_RECEIPT: readonly Stage[] = ["RESERVED", "IN_FLIGHT", "UNKNOWN"];
const RECEIPTS: readonly EvidenceKind[] = [
  "PAYFLOW_AUTHORITY_RECEIPT",
  "PAYFLOW_PROOF",
  "PROVIDER_CONFIRMATION",
];

/**
 * Is this evidence good enough for this move? An item whose obligation is only owner-reported or unverified (a commitment made
 * outside PayFlow) may be moved on the owner's word, but it then stays labelled as such.
 */
export function evidenceOk(
  to: Stage,
  evidence: EvidenceKind,
  verification:
    "PAYFLOW_ENFORCED" | "PROVIDER_CONFIRMED" | "OWNER_REPORTED" | "UNVERIFIED",
): boolean {
  const external =
    verification === "OWNER_REPORTED" || verification === "UNVERIFIED";
  if (NEEDS_AUTHORITATIVE.includes(to))
    return (
      AUTHORITATIVE.includes(evidence) ||
      (external && evidence === "OWNER_REPORTED")
    );
  if (NEEDS_RECEIPT.includes(to))
    return (
      RECEIPTS.includes(evidence) || (external && evidence === "OWNER_REPORTED")
    );
  if (to === "CANCELLED") return evidence !== "AGENT_REPORTED";
  return true;
}

export interface Bucket {
  readonly count: number;
  readonly amountMinor: number;
}
export interface LedgerSummary {
  readonly currency: string;
  readonly ceilingMinor: number;
  /** Budget spoken for: the sum of exposures. Never above the ceiling. */
  readonly exposureMinor: number;
  readonly availableMinor: number;
  readonly byStage: Readonly<Record<string, Bucket>>;
  /** Exposure that PayFlow cannot enforce or a provider has not confirmed. */
  readonly unverifiedExposureMinor: number;
  readonly unknownExposureMinor: number;
  readonly refundedMinor: number;
}

export function summarize(
  currency: string,
  ceilingMinor: number,
  items: readonly {
    stage: Stage;
    amountMinor: number;
    refundedMinor: number;
    verification: string;
  }[],
): LedgerSummary {
  const byStage: Record<string, { count: number; amountMinor: number }> = {};
  let exposure = 0;
  let unverified = 0;
  let unknown = 0;
  let refunded = 0;
  for (const i of items) {
    const b = (byStage[i.stage] ??= { count: 0, amountMinor: 0 });
    b.count++;
    b.amountMinor += i.amountMinor;
    const e = exposureOf(i);
    exposure += e;
    if (
      e > 0 &&
      (i.verification === "OWNER_REPORTED" || i.verification === "UNVERIFIED")
    )
      unverified += e;
    if (i.stage === "UNKNOWN") unknown += e;
    refunded += i.refundedMinor;
  }
  return {
    currency,
    ceilingMinor,
    exposureMinor: exposure,
    availableMinor: Math.max(0, ceilingMinor - exposure),
    byStage,
    unverifiedExposureMinor: unverified,
    unknownExposureMinor: unknown,
    refundedMinor: refunded,
  };
}
