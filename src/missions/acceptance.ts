import type { NegotiationDoc } from "./negotiation.js";
import { termsShortfalls } from "./counteroffers.js";

/**
 * V3 M39 — can this quote be accepted? Pure and deterministic.
 *
 * Every check is named so a refusal can be explained. Some checks are HARD (nobody can override them: the walk-away is the owner's own
 * ceiling, so exceeding it means revising the rules first, not accepting anyway). The term floors are SOFT for a person, who may
 * accept a quote that misses a floor by saying why; an agent can never. An agent may accept alone only when the approved rules say so
 * and everything holds; otherwise it hands the decision to a person.
 */
export interface AcceptanceFacts {
  readonly missionActive: boolean;
  readonly quote: {
    readonly current: boolean;
    readonly complete: boolean;
    readonly currency: string;
    readonly totalMinor: number | null;
    readonly terms: {
      readonly warrantyMonths?: number;
      readonly returnWindowDays?: number;
      readonly deliveryDays?: number;
    };
  };
  readonly missionCurrency: string;
  readonly maxCommitmentMinor: number;
  /** What the ledger can still take. A quote already in the ledger as QUOTED holds nothing, so the full total is needed. */
  readonly availableMinor: number | null;
  readonly supplierOutcome:
    "QUALIFIED" | "NOT_QUALIFIED" | "INCOMPLETE" | "UNKNOWN";
  /** The rules in force for this supplier, if a negotiation exists. */
  readonly rules: NegotiationDoc | null;
  readonly negotiationExists: boolean;
  readonly alreadyAccepted: boolean;
  readonly negotiationConcluded: boolean;
  /** Does the mission itself let an agent accept within limits? */
  readonly requireApprovalToContract: boolean;
  readonly humanApprovalAboveMinor: number | undefined;
}
export interface Check {
  readonly code: string;
  readonly ok: boolean;
  readonly hard: boolean;
  readonly detail: string;
}
export interface Evaluation {
  readonly checks: readonly Check[];
  readonly hardFailures: readonly string[];
  readonly softFailures: readonly string[];
  /** A person may accept (soft failures need an override reason). */
  readonly personMayAccept: boolean;
  /** An agent may accept on its own authority. */
  readonly agentMayAccept: boolean;
}

export function evaluateAcceptance(f: AcceptanceFacts): Evaluation {
  const checks: Check[] = [];
  const add = (code: string, ok: boolean, hard: boolean, detail: string) =>
    checks.push({ code, ok, hard, detail });
  const total = f.quote.totalMinor;
  add(
    "MISSION_ACTIVE",
    f.missionActive,
    true,
    f.missionActive ? "The mission is running." : "The mission is not running.",
  );
  add(
    "NOT_ALREADY_ACCEPTED",
    !f.alreadyAccepted && !f.negotiationConcluded,
    true,
    f.alreadyAccepted
      ? "This quote was already accepted."
      : f.negotiationConcluded
        ? "This negotiation already concluded in an acceptance."
        : "Nothing accepted yet.",
  );
  add(
    "QUOTE_CURRENT",
    f.quote.current,
    true,
    f.quote.current
      ? "The quote is current."
      : "The quote has expired or been replaced.",
  );
  add(
    "QUOTE_COMPLETE",
    f.quote.complete && total !== null,
    true,
    f.quote.complete
      ? "Nothing in the total is unknown."
      : "Part of the total is unknown, so there is no total to accept.",
  );
  add(
    "CURRENCY_MATCH",
    f.quote.currency === f.missionCurrency,
    true,
    `Quote in ${f.quote.currency}; mission in ${f.missionCurrency}. No conversion is done.`,
  );
  add(
    "SUPPLIER_QUALIFIED",
    f.supplierOutcome === "QUALIFIED",
    true,
    `Supplier qualification: ${f.supplierOutcome}.`,
  );
  if (total !== null) {
    add(
      "WITHIN_LARGEST_COMMITMENT",
      total <= f.maxCommitmentMinor,
      true,
      `Total ${total}; the contract's largest single commitment is ${f.maxCommitmentMinor}.`,
    );
    add(
      "WITHIN_AVAILABLE_BUDGET",
      f.availableMinor === null || total <= f.availableMinor,
      true,
      f.availableMinor === null
        ? "The budget could not be read; not enforced here."
        : `Total ${total}; ${f.availableMinor} is still available.`,
    );
  }
  if (f.negotiationExists) {
    add(
      "RULES_IN_FORCE",
      f.rules !== null,
      true,
      f.rules
        ? "Approved negotiation rules are in force."
        : "A negotiation exists for this supplier but no approved rules are in force now.",
    );
    if (f.rules && total !== null) {
      add(
        "WITHIN_WALK_AWAY",
        total <= f.rules.walkAwayMinor,
        true,
        `Total ${total}; the walk-away is ${f.rules.walkAwayMinor}. Exceeding it means revising the rules first.`,
      );
      const short = termsShortfalls(f.rules, f.quote.terms);
      add(
        "TERMS_MEET_FLOORS",
        short.length === 0,
        false,
        short.length === 0
          ? "Every term floor is met."
          : `Term floors missed: ${short.join(", ")}.`,
      );
    }
  }
  const hardFailures = checks.filter((c) => c.hard && !c.ok).map((c) => c.code);
  const softFailures = checks
    .filter((c) => !c.hard && !c.ok)
    .map((c) => c.code);
  const rulesAllowAgent =
    f.rules !== null &&
    f.rules.acceptanceRule === "AGENT_WITHIN_LIMITS" &&
    !f.requireApprovalToContract &&
    f.humanApprovalAboveMinor !== undefined &&
    total !== null &&
    total <= f.humanApprovalAboveMinor;
  return {
    checks,
    hardFailures,
    softFailures,
    personMayAccept: hardFailures.length === 0,
    agentMayAccept:
      hardFailures.length === 0 && softFailures.length === 0 && rulesAllowAgent,
  };
}
