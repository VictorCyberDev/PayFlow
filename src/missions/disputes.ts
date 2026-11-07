/**
 * V3 M43 — disputes. Pure and deterministic.
 *
 * A dispute can be opened only on a ground the computed fulfillment outcome supports, for no more than has been paid and not yet
 * refunded, and only once per ground while one is open. Resolving it as a refund can never exceed the claim.
 */
export const GROUNDS = [
  "DAMAGED",
  "WRONG_ITEM",
  "SHORT_DELIVERY",
  "OVER_DELIVERY",
  "NOT_DELIVERED_LATE",
] as const;
export type Ground = (typeof GROUNDS)[number];

export interface OpenFacts {
  readonly ground: Ground;
  readonly supportedGrounds: readonly string[];
  readonly claimedMinor: number;
  readonly paidMinor: number;
  readonly alreadyRefundedMinor: number;
  /** Claimed by OTHER still-open disputes on the same order. */
  readonly otherOpenClaimsMinor: number;
  readonly openOnSameGround: boolean;
  readonly ledgerSettled: boolean;
}
export function openProblems(f: OpenFacts): string[] {
  const p: string[] = [];
  if (!f.supportedGrounds.includes(f.ground)) p.push("GROUND_NOT_SUPPORTED");
  if (f.openOnSameGround) p.push("ALREADY_OPEN_ON_GROUND");
  if (!f.ledgerSettled) p.push("PAYMENT_NOT_SETTLED");
  const remaining =
    f.paidMinor - f.alreadyRefundedMinor - f.otherOpenClaimsMinor;
  if (f.claimedMinor > remaining) p.push("CLAIM_EXCEEDS_REMAINING");
  return p;
}
export interface ResolveFacts {
  readonly claimedMinor: number;
  readonly refundMinor: number;
  readonly paidMinor: number;
  readonly alreadyRefundedMinor: number;
}
export function refundProblems(f: ResolveFacts): string[] {
  const p: string[] = [];
  if (f.refundMinor < 1) p.push("REFUND_NOT_POSITIVE");
  if (f.refundMinor > f.claimedMinor) p.push("REFUND_EXCEEDS_CLAIM");
  if (f.refundMinor > f.paidMinor - f.alreadyRefundedMinor)
    p.push("REFUND_EXCEEDS_PAID");
  return p;
}
