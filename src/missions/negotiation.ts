import { z } from "zod";

/**
 * V3 M36 — the negotiation rulebook. Pure and deterministic.
 *
 * A move (a counteroffer, or a willingness to accept) is checked against the version in force. Every rule is stated as a code so a
 * refusal can be explained; a move is allowed only when no rule is broken. The budget can never be disclosed to a supplier, the
 * walk-away limit is a hard ceiling on what we would pay, and the term floors apply to whatever deal is on the table.
 */
export const PAYMENT_TERMS = [
  "PREPAY",
  "ON_DELIVERY",
  "NET_15",
  "NET_30",
  "NET_45",
  "NET_60",
] as const;
const Minor = z.number().int().safe().min(1).max(1_000_000_000_000);

export const NegotiationDocSchema = z
  .object({
    baselineQuoteId: z
      .string()
      .regex(/^qte_[a-f0-9]{24}$/u)
      .optional(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    /** The landed total we are aiming for. */
    targetTotalMinor: Minor,
    /** The most we would ever pay, landed. A hard ceiling. */
    walkAwayMinor: Minor,
    terms: z
      .object({
        minWarrantyMonths: z.number().int().min(0).max(240).optional(),
        minReturnWindowDays: z.number().int().min(0).max(365).optional(),
        maxDeliveryDays: z.number().int().min(0).max(365).optional(),
        /** Empty means any payment terms are acceptable. */
        acceptablePaymentTerms: z
          .array(z.enum(PAYMENT_TERMS))
          .max(PAYMENT_TERMS.length)
          .default([]),
      })
      .strict()
      .default({ acceptablePaymentTerms: [] }),
    concessions: z
      .object({
        maxQuantityIncreasePercent: z.number().int().min(0).max(100).default(0),
        mayExtendDeliveryDays: z.number().int().min(0).max(60).default(0),
      })
      .strict()
      .default({ maxQuantityIncreasePercent: 0, mayExtendDeliveryDays: 0 }),
    rounds: z.object({ maxRounds: z.number().int().min(1).max(10) }).strict(),
    negotiatorAgentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    /** What may be revealed to the supplier. The budget and other suppliers' identities can never be. */
    disclosure: z
      .object({
        budget: z.literal(false).default(false),
        otherSuppliersIdentity: z.literal(false).default(false),
        competingQuotes: z.boolean().default(false),
        deadline: z.boolean().default(false),
      })
      .strict()
      .default({
        budget: false,
        otherSuppliersIdentity: false,
        competingQuotes: false,
        deadline: false,
      }),
    /** Who may accept a deal. AGENT_WITHIN_LIMITS is only possible when the mission itself allows it (checked on approval). */
    acceptanceRule: z
      .enum(["PERSON_ALWAYS", "AGENT_WITHIN_LIMITS"])
      .default("PERSON_ALWAYS"),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine((d) => d.targetTotalMinor <= d.walkAwayMinor, {
    message: "target must not exceed walk-away",
    path: ["targetTotalMinor"],
  });
export type NegotiationDoc = z.infer<typeof NegotiationDocSchema>;

export type Disclosure =
  "BUDGET" | "OTHER_SUPPLIERS_IDENTITY" | "COMPETING_QUOTES" | "DEADLINE";
export interface Move {
  readonly kind: "COUNTER" | "ACCEPT";
  readonly round: number;
  readonly currency: string;
  /** For COUNTER: the landed total we offer. For ACCEPT: the landed total they offered that we would accept. */
  readonly totalMinor: number;
  readonly terms: {
    readonly warrantyMonths?: number;
    readonly returnWindowDays?: number;
    readonly deliveryDays?: number;
    readonly paymentTerms?: (typeof PAYMENT_TERMS)[number];
  };
  readonly quantityIncreasePercent: number;
  readonly disclosing: readonly Disclosure[];
}
export type Verdict =
  | { verdict: "ALLOW" }
  | { verdict: "REQUIRES_PERSON"; reasons: string[] }
  | { verdict: "REFUSE"; reasons: string[] };

/**
 * The rules, in the order a person would read them. ACCEPT under PERSON_ALWAYS is never decided here: it can only be prepared for
 * a person. Anything missing that a floor needs (e.g. warranty not stated while a minimum is set) counts as NOT met.
 */
export function checkMove(doc: NegotiationDoc, m: Move, now: string): Verdict {
  const reasons: string[] = [];
  if (Date.parse(doc.expiresAt) <= Date.parse(now)) reasons.push("EXPIRED");
  if (m.currency !== doc.currency) reasons.push("CURRENCY_MISMATCH");
  if (
    !Number.isInteger(m.round) ||
    m.round < 1 ||
    m.round > doc.rounds.maxRounds
  )
    reasons.push("ROUND_LIMIT");
  if (!Number.isSafeInteger(m.totalMinor) || m.totalMinor < 1)
    reasons.push("TOTAL_INVALID");
  else if (m.totalMinor > doc.walkAwayMinor) reasons.push("ABOVE_WALK_AWAY");
  const t = doc.terms;
  if (
    t.minWarrantyMonths !== undefined &&
    !(
      m.terms.warrantyMonths !== undefined &&
      m.terms.warrantyMonths >= t.minWarrantyMonths
    )
  )
    reasons.push("WARRANTY_BELOW_FLOOR");
  if (
    t.minReturnWindowDays !== undefined &&
    !(
      m.terms.returnWindowDays !== undefined &&
      m.terms.returnWindowDays >= t.minReturnWindowDays
    )
  )
    reasons.push("RETURN_WINDOW_BELOW_FLOOR");
  if (
    t.maxDeliveryDays !== undefined &&
    !(
      m.terms.deliveryDays !== undefined &&
      m.terms.deliveryDays <=
        t.maxDeliveryDays + doc.concessions.mayExtendDeliveryDays
    )
  )
    reasons.push("DELIVERY_TOO_LATE");
  if (
    t.acceptablePaymentTerms.length > 0 &&
    !(
      m.terms.paymentTerms !== undefined &&
      t.acceptablePaymentTerms.includes(m.terms.paymentTerms)
    )
  )
    reasons.push("PAYMENT_TERMS_NOT_ACCEPTABLE");
  if (
    !Number.isInteger(m.quantityIncreasePercent) ||
    m.quantityIncreasePercent < 0 ||
    m.quantityIncreasePercent > doc.concessions.maxQuantityIncreasePercent
  )
    reasons.push("QUANTITY_INCREASE_NOT_ALLOWED");
  for (const d of new Set(m.disclosing)) {
    if (d === "BUDGET" || d === "OTHER_SUPPLIERS_IDENTITY")
      reasons.push(`DISCLOSURE_FORBIDDEN:${d}`);
    else if (d === "COMPETING_QUOTES" && !doc.disclosure.competingQuotes)
      reasons.push("DISCLOSURE_NOT_ALLOWED:COMPETING_QUOTES");
    else if (d === "DEADLINE" && !doc.disclosure.deadline)
      reasons.push("DISCLOSURE_NOT_ALLOWED:DEADLINE");
  }
  if (reasons.length > 0) return { verdict: "REFUSE", reasons };
  if (m.kind === "ACCEPT" && doc.acceptanceRule === "PERSON_ALWAYS")
    return {
      verdict: "REQUIRES_PERSON",
      reasons: ["ACCEPTANCE_IS_A_PERSONS_DECISION"],
    };
  return { verdict: "ALLOW" };
}

/** Problems with a document against the facts around it, found when a version is proposed and again when it is approved. */
export interface Facts {
  readonly missionCurrency: string;
  readonly maxCommitmentMinor: number;
  readonly availableMinor: number | null;
  readonly missionExpiresAt: string;
  readonly agentMayNegotiate: (agentId: string) => boolean;
  readonly requireApprovalToContract: boolean;
  readonly humanApprovalAboveMinor: number | undefined;
  readonly supplierQualified: boolean;
  readonly baseline: {
    exists: boolean;
    supplierMatches: boolean;
    current: boolean;
  } | null;
}
export function problemsWith(
  doc: NegotiationDoc,
  f: Facts,
  now: string,
): string[] {
  const p: string[] = [];
  if (doc.currency !== f.missionCurrency) p.push("CURRENCY_NOT_THE_MISSIONS");
  if (doc.walkAwayMinor > f.maxCommitmentMinor)
    p.push("WALK_AWAY_ABOVE_LARGEST_COMMITMENT");
  if (f.availableMinor !== null && doc.walkAwayMinor > f.availableMinor)
    p.push("WALK_AWAY_ABOVE_AVAILABLE_BUDGET");
  if (Date.parse(doc.expiresAt) <= Date.parse(now)) p.push("ALREADY_EXPIRED");
  if (Date.parse(doc.expiresAt) > Date.parse(f.missionExpiresAt))
    p.push("OUTLIVES_THE_MISSION");
  if (!f.agentMayNegotiate(doc.negotiatorAgentId))
    p.push("NEGOTIATOR_LACKS_THE_NEGOTIATE_GRANT");
  if (!f.supplierQualified) p.push("SUPPLIER_NOT_QUALIFIED");
  if (doc.acceptanceRule === "AGENT_WITHIN_LIMITS") {
    if (f.requireApprovalToContract)
      p.push("MISSION_REQUIRES_A_PERSON_TO_CONTRACT");
    if (
      f.humanApprovalAboveMinor === undefined ||
      doc.walkAwayMinor > f.humanApprovalAboveMinor
    )
      p.push("WALK_AWAY_ABOVE_THE_HUMAN_APPROVAL_THRESHOLD");
  }
  if (doc.baselineQuoteId !== undefined) {
    if (!f.baseline?.exists) p.push("BASELINE_QUOTE_NOT_FOUND");
    else {
      if (!f.baseline.supplierMatches)
        p.push("BASELINE_QUOTE_IS_ANOTHER_SUPPLIERS");
      if (!f.baseline.current) p.push("BASELINE_QUOTE_NOT_CURRENT");
    }
  }
  return p;
}
