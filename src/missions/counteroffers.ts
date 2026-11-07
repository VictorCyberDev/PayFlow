import type { NegotiationDoc } from "./negotiation.js";

/**
 * V3 M38 — counteroffers. Pure and deterministic; no model.
 *
 * Rounds are COUNTED BY PAYFLOW from the counters already on file, never declared by whoever is sending (so the round limit cannot be
 * dodged by always saying "round 1"), and our offers never go backwards (a concession is not taken back). The recommender turns the
 * timeline and the approved rules into one of: review a supplier offer for acceptance, a next counter, wait, or walk away. It only
 * recommends. A counter still goes through the rules, a person approves it, and acceptance is a person's decision.
 */
export interface OurCounter {
  readonly messageId: string;
  readonly round: number;
  readonly totalMinor: number;
  readonly status:
    "PENDING_APPROVAL" | "APPROVED" | "SENDING" | "SENT" | "DELIVERY_UNKNOWN";
  /** When it was written, for display. Order is by `seq`, never by time. */
  readonly at: string;
  readonly seq: number;
}
export interface TheirOffer {
  readonly quoteId: string;
  readonly totalMinor: number | null;
  readonly complete: boolean;
  readonly current: boolean;
  readonly currency: string;
  readonly terms: {
    readonly warrantyMonths?: number;
    readonly returnWindowDays?: number;
    readonly deliveryDays?: number;
  };
  readonly at: string;
  readonly seq: number;
}

/** The round a new counter must carry: one more than the live counters before it. */
export const expectedRound = (earlierLiveCounters: number) =>
  earlierLiveCounters + 1;

/** Our previous offer, if any: the latest live counter before this one. */
export function previousOffer(earlier: readonly OurCounter[]): number | null {
  if (earlier.length === 0) return null;
  return [...earlier].sort((a, b) => a.round - b.round).at(-1)!.totalMinor;
}

export type Recommendation =
  | { action: "NEED_BASELINE"; why: string }
  | { action: "WAIT"; why: string }
  | {
      action: "REVIEW_FOR_ACCEPTANCE";
      why: string;
      theirTotalMinor: number;
      quoteId: string;
      termsShortfalls: string[];
    }
  | {
      action: "COUNTER";
      why: string;
      round: number;
      totalMinor: number;
      gapMinor: number;
      asks: Record<string, number>;
    }
  | { action: "WALK_AWAY"; why: string; theirTotalMinor: number | null }
  | { action: "ESCALATE"; why: string };

/** Floors the supplier's terms miss (silence counts as missing). */
export function termsShortfalls(
  doc: NegotiationDoc,
  t: TheirOffer["terms"],
): string[] {
  const out: string[] = [];
  const f = doc.terms;
  if (
    f.minWarrantyMonths !== undefined &&
    !((t.warrantyMonths ?? -1) >= f.minWarrantyMonths)
  )
    out.push("WARRANTY_BELOW_FLOOR");
  if (
    f.minReturnWindowDays !== undefined &&
    !((t.returnWindowDays ?? -1) >= f.minReturnWindowDays)
  )
    out.push("RETURN_WINDOW_BELOW_FLOOR");
  if (
    f.maxDeliveryDays !== undefined &&
    !(
      (t.deliveryDays ?? Number.POSITIVE_INFINITY) <=
      f.maxDeliveryDays + doc.concessions.mayExtendDeliveryDays
    )
  )
    out.push("DELIVERY_TOO_LATE");
  return out;
}

/**
 * The concession schedule: open at the target, then meet the supplier part-way. Each counter is the previous offer plus half the gap
 * to their latest total (rounded down, at least 1 minor unit), never above the walk-away and never below what we already offered.
 */
export function nextCounterTotal(
  doc: NegotiationDoc,
  previous: number | null,
  theirTotal: number,
): number {
  if (previous === null)
    return Math.min(doc.targetTotalMinor, doc.walkAwayMinor);
  const gap = theirTotal - previous;
  if (gap <= 0) return previous; // not above our offer: never move, and never offer less
  const step = Math.max(1, Math.floor(gap / 2));
  return Math.min(doc.walkAwayMinor, Math.max(previous, previous + step));
}

export function recommend(input: {
  doc: NegotiationDoc;
  ours: readonly OurCounter[];
  theirs: readonly TheirOffer[];
}): Recommendation {
  const { doc } = input;
  const live = [...input.ours].sort((a, b) => a.round - b.round);
  const usable = input.theirs
    .filter(
      (t) =>
        t.current &&
        t.complete &&
        t.totalMinor !== null &&
        t.currency === doc.currency,
    )
    .sort((a, b) => a.seq - b.seq);
  const latest = usable.at(-1) ?? null;
  const lastOurs = live.at(-1) ?? null;
  if (!latest) {
    if (input.theirs.length === 0 && live.length === 0)
      return {
        action: "NEED_BASELINE",
        why: "No supplier quote is on file to negotiate from.",
      };
    if (lastOurs && lastOurs.seq > (input.theirs.at(-1)?.seq ?? -1))
      return {
        action: "WAIT",
        why: "Our last counter is out and the supplier has not replied with a usable quote.",
      };
    return {
      action: "NEED_BASELINE",
      why: "The supplier's quotes on file are incomplete, expired or in another currency.",
    };
  }
  const their = latest.totalMinor!;
  const shortfalls = termsShortfalls(doc, latest.terms);
  // Their offer is not above what we already offered: take it. (No reason to pay more than we offered.)
  if (
    their <= (lastOurs?.totalMinor ?? Number.NEGATIVE_INFINITY) &&
    their <= doc.walkAwayMinor
  )
    return {
      action: "REVIEW_FOR_ACCEPTANCE",
      why: "The supplier's offer is at or below what we already offered.",
      theirTotalMinor: their,
      quoteId: latest.quoteId,
      termsShortfalls: shortfalls,
    };
  if (
    their <= doc.walkAwayMinor &&
    shortfalls.length === 0 &&
    their <= doc.targetTotalMinor
  )
    return {
      action: "REVIEW_FOR_ACCEPTANCE",
      why: "The supplier's offer meets the target and every term floor.",
      theirTotalMinor: their,
      quoteId: latest.quoteId,
      termsShortfalls: shortfalls,
    };
  if (lastOurs && lastOurs.seq > latest.seq)
    return {
      action: "WAIT",
      why: "Our last counter is out and the supplier has not answered it.",
    };
  const round = expectedRound(live.length);
  if (round > doc.rounds.maxRounds) {
    return their <= doc.walkAwayMinor
      ? {
          action: "REVIEW_FOR_ACCEPTANCE",
          why: "No rounds are left; the supplier's offer is within the walk-away, so a person decides whether to take it.",
          theirTotalMinor: their,
          quoteId: latest.quoteId,
          termsShortfalls: shortfalls,
        }
      : {
          action: "WALK_AWAY",
          why: "No rounds are left and the supplier's offer is above the walk-away.",
          theirTotalMinor: their,
        };
  }
  const previous = lastOurs?.totalMinor ?? null;
  // A repeated offer necessarily replaced the one before it, so look at the supplier's whole history, not only the current quote.
  const history = input.theirs
    .filter(
      (t) => t.complete && t.totalMinor !== null && t.currency === doc.currency,
    )
    .sort((a, b) => a.seq - b.seq);
  const stalled =
    history.length >= 2 &&
    history.at(-1)!.totalMinor === history.at(-2)!.totalMinor;
  if (
    their > doc.walkAwayMinor &&
    previous !== null &&
    previous >= doc.walkAwayMinor
  )
    return {
      action: "WALK_AWAY",
      why: "We are already at the walk-away and the supplier is still above it.",
      theirTotalMinor: their,
    };
  if (their > doc.walkAwayMinor && stalled && live.length >= 1)
    return {
      action: "WALK_AWAY",
      why: "The supplier repeated an offer above the walk-away after our counter.",
      theirTotalMinor: their,
    };
  const total = nextCounterTotal(doc, previous, their);
  if (previous !== null && total <= previous && total >= doc.walkAwayMinor)
    return {
      action: "ESCALATE",
      why: "No further concession is possible inside the rules; a person decides.",
    };
  const asks: Record<string, number> = {};
  if (doc.terms.minWarrantyMonths !== undefined)
    asks["warrantyMonths"] = doc.terms.minWarrantyMonths;
  if (doc.terms.minReturnWindowDays !== undefined)
    asks["returnWindowDays"] = doc.terms.minReturnWindowDays;
  if (doc.terms.maxDeliveryDays !== undefined)
    asks["deliveryDays"] = doc.terms.maxDeliveryDays;
  return {
    action: "COUNTER",
    why:
      previous === null
        ? "Open at the target."
        : "Meet the supplier part-way, without going back on what we offered.",
    round,
    totalMinor: total,
    gapMinor: their - total,
    asks,
  };
}
