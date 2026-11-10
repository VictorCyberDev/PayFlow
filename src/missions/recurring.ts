import { z } from "zod";

/**
 * V3 M57 (a slice) — recurring renewal checks. Pure and deterministic.
 *
 * A recurrence never spends. Each time it comes due it is checked, on its own, against the mission as it is NOW: still active, not expired, the
 * amount within the single-purchase limit and the budget actually left. The result is a recorded outcome; "due for you" means the owner is asked,
 * and buying (if they choose to) happens by the normal approved path. Pausing or ending a mission therefore stops every later recurrence at its
 * next check, with no separate switch to remember.
 */
export const RecurringSetupSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    amountMinor: z.number().int().safe().min(1).max(1_000_000_000_000),
    /** Daily at the shortest. Anything faster is not a renewal. */
    everySeconds: z
      .number()
      .int()
      .min(86_400)
      .max(366 * 86_400),
    firstSlot: z.string().datetime().optional(),
  })
  .strict();

export const OUTCOMES = [
  "DUE_FOR_OWNER",
  "SKIPPED_MISSION_NOT_ACTIVE",
  "SKIPPED_MISSION_EXPIRED",
  "SKIPPED_ABOVE_PURCHASE_LIMIT",
  "SKIPPED_NO_BUDGET_LEFT",
  "SKIPPED_CURRENCY_CHANGED",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface MissionFacts {
  readonly status: string;
  readonly expiresAt: string;
  readonly currency: string;
  readonly maxCommitmentMinor: number;
  /** Budget still unspoken for right now, from the commitment ledger. */
  readonly availableMinor: number;
}
export function checkRecurrence(
  r: { amountMinor: number; currency: string },
  m: MissionFacts | null,
  now: string,
): Outcome {
  // an unknown or unreadable mission is never "due": we cannot show the owner a sound request
  if (!m || m.status !== "ACTIVE") return "SKIPPED_MISSION_NOT_ACTIVE";
  if (!(Date.parse(m.expiresAt) > Date.parse(now)))
    return "SKIPPED_MISSION_EXPIRED";
  if (m.currency !== r.currency) return "SKIPPED_CURRENCY_CHANGED";
  if (r.amountMinor > m.maxCommitmentMinor)
    return "SKIPPED_ABOVE_PURCHASE_LIMIT";
  if (r.amountMinor > m.availableMinor) return "SKIPPED_NO_BUDGET_LEFT";
  return "DUE_FOR_OWNER";
}
export const OUTCOME_WORDS: Record<Outcome, string> = {
  DUE_FOR_OWNER: "Due. Your decision is needed. Nothing was bought.",
  SKIPPED_MISSION_NOT_ACTIVE: "Skipped: the mission is not active.",
  SKIPPED_MISSION_EXPIRED: "Skipped: the mission has ended.",
  SKIPPED_ABOVE_PURCHASE_LIMIT: "Skipped: more than the single-purchase limit.",
  SKIPPED_NO_BUDGET_LEFT: "Skipped: not enough budget is left.",
  SKIPPED_CURRENCY_CHANGED: "Skipped: the mission's currency changed.",
};
