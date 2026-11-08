import type { Profile } from "./talent-candidates.js";
import type { TalentScope } from "./talent-scope.js";

/**
 * V3 M48 — ranking candidates against a role. Pure and deterministic; no model.
 *
 * Every check is MET, NOT_MET or UNKNOWN, and UNKNOWN is never MET: a rate that was not stated is not a rate within the cap. Skills and
 * rates are CLAIMS from a profile, so a candidate is at best "claimed to meet" until a person verifies (M49). Ranking uses only the
 * checks, preferred skills, price and portfolio. It deliberately does NOT use years of experience (a proxy for age) or anything else
 * that could stand in for a protected attribute; that field is shown but never ranked.
 */
export type Check = "MET" | "NOT_MET" | "UNKNOWN";
export type Role = TalentScope["roles"][number];
export interface Evaluation {
  readonly requiredSkills: { skill: string; check: Check }[];
  readonly price: {
    check: Check;
    amountMinor: number | null;
    capMinor: number;
  };
  readonly preferredMet: number;
  readonly portfolioCount: number;
  readonly standing: "ELIGIBLE" | "NEEDS_INFO" | "INELIGIBLE";
  readonly reasons: string[];
}
const norm = (s: string) => s.trim().toLowerCase();

export function evaluate(role: Role, profile: Profile): Evaluation {
  const has = new Set(profile.skills.map(norm));
  const requiredSkills: { skill: string; check: Check }[] =
    role.requiredSkills.map((skill) => ({
      skill,
      check: has.has(norm(skill)) ? "MET" : "NOT_MET",
    }));
  // The price that applies: hourly roles compare an hourly rate to the maximum rate; others compare a fixed quote to the budget cap.
  const hourly = role.engagement === "HOURLY";
  const amount = hourly
    ? (profile.hourlyRateMinor ?? null)
    : (profile.fixedQuoteMinor ?? null);
  const cap = hourly ? role.maxHourlyRateMinor! : role.budgetCapMinor;
  const priceCheck: Check =
    amount === null ? "UNKNOWN" : amount <= cap ? "MET" : "NOT_MET";
  const preferredMet = (role.preferredSkills ?? []).filter((s) =>
    has.has(norm(s)),
  ).length;
  const reasons: string[] = [];
  for (const r of requiredSkills)
    if (r.check !== "MET") reasons.push(`MISSING_SKILL:${r.skill}`);
  if (priceCheck === "NOT_MET") reasons.push("PRICE_ABOVE_CAP");
  if (priceCheck === "UNKNOWN") reasons.push("PRICE_NOT_STATED");
  const skillsOk = requiredSkills.every((r) => r.check === "MET");
  const standing =
    !skillsOk || priceCheck === "NOT_MET"
      ? "INELIGIBLE"
      : priceCheck === "UNKNOWN"
        ? "NEEDS_INFO"
        : "ELIGIBLE";
  return {
    requiredSkills,
    price: { check: priceCheck, amountMinor: amount, capMinor: cap },
    preferredMet,
    portfolioCount: profile.portfolioRefs.length,
    standing,
    reasons,
  };
}

export interface Ranked {
  readonly candidateId: string;
  readonly handle: string;
  readonly evaluation: Evaluation;
  readonly rank: number | null;
}
const ORDER = { ELIGIBLE: 0, NEEDS_INFO: 1, INELIGIBLE: 2 } as const;
/** Stable total order: standing, then more preferred skills, then lower price (unknown last), then more portfolio items, then handle. */
export function rank(
  role: Role,
  candidates: readonly {
    candidateId: string;
    handle: string;
    profile: Profile;
  }[],
): Ranked[] {
  const rows = candidates.map((c) => ({
    candidateId: c.candidateId,
    handle: c.handle,
    evaluation: evaluate(role, c.profile),
  }));
  rows.sort((a, b) => {
    const ea = a.evaluation;
    const eb = b.evaluation;
    return (
      ORDER[ea.standing] - ORDER[eb.standing] ||
      eb.preferredMet - ea.preferredMet ||
      (ea.price.amountMinor ?? Number.POSITIVE_INFINITY) -
        (eb.price.amountMinor ?? Number.POSITIVE_INFINITY) ||
      eb.portfolioCount - ea.portfolioCount ||
      (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0)
    );
  });
  let n = 0;
  return rows.map((r) => ({
    ...r,
    rank: r.evaluation.standing === "INELIGIBLE" ? null : ++n,
  }));
}
export const MAX_SHORTLIST = 5;
/** A person may shortlist only ranked (not ineligible) candidates, between one and five, each once. */
export function shortlistProblems(
  ranked: readonly Ranked[],
  chosen: readonly string[],
): string[] {
  const p: string[] = [];
  if (chosen.length < 1) p.push("EMPTY");
  if (chosen.length > MAX_SHORTLIST) p.push("TOO_MANY");
  if (new Set(chosen).size !== chosen.length) p.push("DUPLICATE");
  for (const id of chosen) {
    const r = ranked.find((x) => x.candidateId === id);
    if (!r) p.push(`UNKNOWN_CANDIDATE:${id}`);
    else if (r.evaluation.standing === "INELIGIBLE") p.push(`INELIGIBLE:${id}`);
  }
  return p;
}
