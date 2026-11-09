/**
 * V3 M69 — organization policy packs. Pure and deterministic. A pack is a named set of ceilings. Applying a pack only ever TIGHTENS what the owner
 * asked for: a limit above the pack's ceiling is lowered to it (and the change is reported), a limit below it is left alone. A pack
 * can never raise a limit, add a provider type or widen a window.
 */
export interface Limits {
  totalBudgetMinor: number;
  maxPurchaseMinor: number;
  approveAboveMinor: number;
  durationDays: number;
}
export interface Pack {
  readonly id: "CAUTIOUS" | "STANDARD" | "EXPLORATORY_ONLY";
  readonly title: string;
  readonly summary: string;
  /** Ceilings as shares of the total budget (basis points) and a duration cap. */
  readonly maxPurchaseBps: number;
  readonly approveAboveBps: number;
  readonly maxDurationDays: number;
  /** Cannot buy at all: only look and compare. */
  readonly lookOnly: boolean;
}
export const PACKS: readonly Pack[] = [
  {
    id: "CAUTIOUS",
    title: "Cautious",
    summary:
      "No single purchase above a fifth of the budget, you approve anything above a tenth, and the mission ends within 14 days.",
    maxPurchaseBps: 2_000,
    approveAboveBps: 1_000,
    maxDurationDays: 14,
    lookOnly: false,
  },
  {
    id: "STANDARD",
    title: "Standard",
    summary:
      "No single purchase above half the budget, you approve anything above a quarter, and the mission ends within 30 days.",
    maxPurchaseBps: 5_000,
    approveAboveBps: 2_500,
    maxDurationDays: 30,
    lookOnly: false,
  },
  {
    id: "EXPLORATORY_ONLY",
    title: "Look only",
    summary: "Agents may look and compare. Nothing can be bought.",
    maxPurchaseBps: 0,
    approveAboveBps: 0,
    maxDurationDays: 30,
    lookOnly: true,
  },
];
export interface Applied {
  limits: Limits;
  changes: { field: keyof Limits; from: number; to: number }[];
  lookOnly: boolean;
}
export function applyPack(pack: Pack, asked: Limits): Applied {
  const ceil = (bps: number) =>
    Math.floor((asked.totalBudgetMinor * bps) / 10_000);
  const caps: Limits = {
    totalBudgetMinor: asked.totalBudgetMinor,
    maxPurchaseMinor: ceil(pack.maxPurchaseBps),
    approveAboveMinor: ceil(pack.approveAboveBps),
    durationDays: pack.maxDurationDays,
  };
  const out: Limits = { ...asked };
  const changes: Applied["changes"] = [];
  for (const k of [
    "maxPurchaseMinor",
    "approveAboveMinor",
    "durationDays",
  ] as const) {
    if (asked[k] > caps[k]) {
      out[k] = caps[k];
      changes.push({ field: k, from: asked[k], to: caps[k] });
    }
  }
  return { limits: out, changes, lookOnly: pack.lookOnly };
}
