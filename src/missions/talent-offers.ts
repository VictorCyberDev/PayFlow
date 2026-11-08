import { z } from "zod";
import { isDate } from "./obligations.js";
import type { Role } from "./shortlist.js";
import type { CHECKS } from "./talent-scope.js";

/**
 * V3 M49 — offers and checks. Pure and deterministic.
 *
 * An offer is a set of milestones with amounts and dates inside the role's limits. Its total is the sum of its milestones. It may be
 * approved only when a person has recorded every check the scope requires as PASSED, and none as FAILED, for that candidate. PayFlow
 * sends nothing and is not a party to the contract; a person records what was sent and what came back.
 */
export type CheckKind = (typeof CHECKS)[number];
export type CheckResult = "PASSED" | "FAILED";
export interface CheckFact {
  readonly kind: CheckKind;
  readonly result: CheckResult;
  /** Position in the append-only log; the latest per kind counts. */
  readonly seq: number;
}
/** The standing of each required check: the latest finding per kind, or MISSING. */
export function checkStanding(
  required: readonly CheckKind[],
  facts: readonly CheckFact[],
): Record<CheckKind, "PASSED" | "FAILED" | "MISSING"> {
  const out = {} as Record<CheckKind, "PASSED" | "FAILED" | "MISSING">;
  for (const k of required) {
    const latest = facts
      .filter((f) => f.kind === k)
      .sort((a, b) => b.seq - a.seq)[0];
    out[k] = latest ? latest.result : "MISSING";
  }
  return out;
}
export function checkProblems(
  required: readonly CheckKind[],
  facts: readonly CheckFact[],
): string[] {
  const s = checkStanding(required, facts);
  return required
    .filter((k) => s[k] !== "PASSED")
    .map((k) => `${s[k] === "FAILED" ? "CHECK_FAILED" : "CHECK_MISSING"}:${k}`);
}

const Day = z.string().refine(isDate, { message: "date" });
export const MilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    amountMinor: z.number().int().safe().min(1).max(1_000_000_000_000),
    dueDate: Day,
  })
  .strict();
export const OfferTermsSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/u),
    startDate: Day,
    endDate: Day,
    /** Hourly roles: the rate this offer pays. Milestone amounts are then not-to-exceed amounts. */
    hourlyRateMinor: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(1_000_000_00)
      .optional(),
    hoursPerWeek: z.number().int().min(1).max(80).optional(),
    milestones: z.array(MilestoneSchema).min(1).max(12),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type OfferTerms = z.infer<typeof OfferTermsSchema>;
export const totalOf = (t: OfferTerms) =>
  t.milestones.reduce((a, m) => a + m.amountMinor, 0);

/** Everything wrong with the terms against the role and the clock. Empty means the offer may be drafted. */
export function termsProblems(
  t: OfferTerms,
  role: Role,
  scopeCurrency: string,
  scopeExpiresAt: string,
  nowIso: string,
): string[] {
  const p: string[] = [];
  if (t.currency !== scopeCurrency) p.push("CURRENCY_MISMATCH");
  if (t.endDate < t.startDate) p.push("ENDS_BEFORE_START");
  for (const [i, m] of t.milestones.entries()) {
    if (m.dueDate < t.startDate || m.dueDate > t.endDate)
      p.push(`MILESTONE_${i + 1}_OUTSIDE_TERM`);
    if (i > 0 && m.dueDate < t.milestones[i - 1]!.dueDate)
      p.push(`MILESTONE_${i + 1}_OUT_OF_ORDER`);
  }
  if (totalOf(t) > role.budgetCapMinor) p.push("ABOVE_ROLE_BUDGET");
  if (role.engagement === "HOURLY") {
    if (t.hourlyRateMinor === undefined) p.push("HOURLY_RATE_REQUIRED");
    else if (t.hourlyRateMinor > role.maxHourlyRateMinor!)
      p.push("RATE_ABOVE_MAXIMUM");
    if (
      role.maxHoursPerWeek !== undefined &&
      (t.hoursPerWeek ?? 0) > role.maxHoursPerWeek
    )
      p.push("HOURS_ABOVE_MAXIMUM");
  } else if (t.hourlyRateMinor !== undefined)
    p.push("RATE_ONLY_FOR_HOURLY_ROLES");
  if (t.expiresAt <= nowIso) p.push("OFFER_ALREADY_EXPIRED");
  if (t.expiresAt > scopeExpiresAt) p.push("OUTLIVES_SCOPE");
  return p;
}

export type OfferStatus =
  | "DRAFT"
  | "APPROVED"
  | "SENT"
  | "ACCEPTED"
  | "DECLINED"
  | "WITHDRAWN"
  | "EXPIRED";
const MOVES: Record<OfferStatus, readonly OfferStatus[]> = {
  DRAFT: ["APPROVED", "WITHDRAWN", "EXPIRED"],
  APPROVED: ["SENT", "WITHDRAWN", "EXPIRED"],
  SENT: ["ACCEPTED", "DECLINED", "WITHDRAWN", "EXPIRED"],
  ACCEPTED: [],
  DECLINED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};
export const canMoveOffer = (from: OfferStatus, to: OfferStatus) =>
  MOVES[from].includes(to);
export const isLive = (s: OfferStatus) =>
  s === "DRAFT" || s === "APPROVED" || s === "SENT";
