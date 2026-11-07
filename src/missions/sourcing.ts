/**
 * V3 M35 — choosing which recorded quotes to rely on. Pure and deterministic.
 *
 * A quote is a bundle: it can only be relied on AS STATED (a different quantity could change shipping, tax or price in ways the
 * supplier never stated), so a plan is a SET of whole quotes. The search is exhaustive over the eligible quotes (at most
 * `MAX_ELIGIBLE`), so the answer is optimal for exactly the quotes on file and the constraints given, and says nothing about
 * quotes nobody has obtained. Among equally cheap plans the order is: fewer surplus units, fewer suppliers, then quote ids.
 */
export const MAX_ELIGIBLE = 20;
export interface Demand {
  readonly sku: string;
  readonly quantity: number;
}
export interface OptQuote {
  readonly quoteId: string;
  readonly supplierId: string;
  readonly totalMinor: number;
  readonly lines: readonly { sku: string | null; quantity: number }[];
}
export interface OptInput {
  readonly demand: readonly Demand[];
  readonly quotes: readonly OptQuote[];
  /** Budget still available, or null when it cannot be known. Null means the budget is not enforced here and the result says so. */
  readonly availableMinor: number | null;
  readonly maxCommitmentMinor: number;
  readonly humanApprovalAboveMinor: number | undefined;
  /** Units beyond what was asked that are tolerated in total. */
  readonly maxSurplusUnits: number;
  /** Allow quotes that also contain items nobody asked for. Their units count as surplus. */
  readonly allowExtras: boolean;
}
export interface Plan {
  readonly quoteIds: readonly string[];
  readonly supplierIds: readonly string[];
  readonly totalMinor: number;
  readonly surplusUnits: number;
  readonly coverage: readonly {
    sku: string;
    required: number;
    covered: number;
    surplus: number;
  }[];
  readonly requiresHumanApproval: readonly string[];
}
export interface Excluded {
  readonly quoteId: string;
  readonly reason: string;
}
export type Outcome =
  | {
      status: "OPTIMAL";
      best: Plan;
      alternatives: Plan[];
      excluded: Excluded[];
      budgetEnforced: boolean;
    }
  | {
      status: "INFEASIBLE";
      reasons: string[];
      excluded: Excluded[];
      cheapestWithoutBudgetMinor: number | null;
      budgetEnforced: boolean;
    }
  | {
      status: "TOO_MANY_ELIGIBLE";
      eligible: number;
      limit: number;
      excluded: Excluded[];
    };

export function optimize(input: OptInput): Outcome {
  const wanted = new Map(input.demand.map((d) => [d.sku, d.quantity]));
  const excluded: Excluded[] = [];
  const eligible: OptQuote[] = [];
  for (const q of [...input.quotes].sort((a, b) =>
    a.quoteId < b.quoteId ? -1 : a.quoteId > b.quoteId ? 1 : 0,
  )) {
    const matched = q.lines.filter((l) => l.sku !== null && wanted.has(l.sku));
    const extras = q.lines.filter((l) => l.sku === null || !wanted.has(l.sku));
    if (matched.length === 0)
      excluded.push({
        quoteId: q.quoteId,
        reason: "Offers nothing that was asked for.",
      });
    else if (extras.length > 0 && !input.allowExtras)
      excluded.push({
        quoteId: q.quoteId,
        reason: "Also contains items that were not asked for.",
      });
    else if (q.totalMinor > input.maxCommitmentMinor)
      excluded.push({
        quoteId: q.quoteId,
        reason: "Exceeds the contract's largest single commitment.",
      });
    else eligible.push(q);
  }
  if (eligible.length > MAX_ELIGIBLE)
    return {
      status: "TOO_MANY_ELIGIBLE",
      eligible: eligible.length,
      limit: MAX_ELIGIBLE,
      excluded,
    };

  const skus = input.demand.map((d) => d.sku);
  const n = eligible.length;
  // per-quote matched units by demand index, and unmatched (extra) units
  const per = eligible.map((q) => {
    const units = skus.map((s) =>
      q.lines.filter((l) => l.sku === s).reduce((a, l) => a + l.quantity, 0),
    );
    const extra = q.lines
      .filter((l) => l.sku === null || !wanted.has(l.sku))
      .reduce((a, l) => a + l.quantity, 0);
    return { units, extra };
  });

  type Cand = {
    mask: number;
    total: number;
    surplus: number;
    suppliers: number;
    key: string;
  };
  const better = (a: Cand, b: Cand) =>
    a.total - b.total ||
    a.surplus - b.surplus ||
    a.suppliers - b.suppliers ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const solve = (budget: number | null, keep: number): Cand[] => {
    const top: Cand[] = [];
    const covered = new Array<number>(skus.length).fill(0);
    let extraUnits = 0;
    const need = input.demand.map((d) => d.quantity);
    // suffix capacity: the most each sku could still be covered by later quotes, to prune hopeless branches
    const suffix = Array.from({ length: n + 1 }, () =>
      new Array<number>(skus.length).fill(0),
    );
    for (let i = n - 1; i >= 0; i--)
      for (let s = 0; s < skus.length; s++)
        suffix[i]![s] = suffix[i + 1]![s]! + per[i]!.units[s]!;
    const dfs = (i: number, mask: number, total: number) => {
      if (budget !== null && total > budget) return;
      if (top.length === keep && total > top[keep - 1]!.total) return;
      for (let s = 0; s < skus.length; s++)
        if (covered[s]! + suffix[i]![s]! < need[s]!) return;
      if (i === n) {
        let surplus = extraUnits;
        for (let s = 0; s < skus.length; s++)
          surplus += Math.max(0, covered[s]! - need[s]!);
        if (surplus > input.maxSurplusUnits) return;
        const ids = eligible
          .filter((_, k) => (mask >> k) & 1)
          .map((q) => q.quoteId);
        const suppliers = new Set(
          eligible.filter((_, k) => (mask >> k) & 1).map((q) => q.supplierId),
        ).size;
        const c: Cand = { mask, total, surplus, suppliers, key: ids.join("|") };
        top.push(c);
        top.sort(better);
        if (top.length > keep) top.length = keep;
        return;
      }
      // include
      for (let s = 0; s < skus.length; s++) covered[s]! += per[i]!.units[s]!;
      extraUnits += per[i]!.extra;
      dfs(i + 1, mask | (1 << i), total + eligible[i]!.totalMinor);
      for (let s = 0; s < skus.length; s++) covered[s]! -= per[i]!.units[s]!;
      extraUnits -= per[i]!.extra;
      // exclude
      dfs(i + 1, mask, total);
    };
    dfs(0, 0, 0);
    return top;
  };
  const toPlan = (c: Cand): Plan => {
    const chosen = eligible.filter((_, k) => (c.mask >> k) & 1);
    const coverage = input.demand.map((d, s) => {
      const covered = chosen.reduce(
        (a, q) => a + per[eligible.indexOf(q)]!.units[s]!,
        0,
      );
      return {
        sku: d.sku,
        required: d.quantity,
        covered,
        surplus: Math.max(0, covered - d.quantity),
      };
    });
    return {
      quoteIds: chosen.map((q) => q.quoteId),
      supplierIds: [...new Set(chosen.map((q) => q.supplierId))].sort(),
      totalMinor: c.total,
      surplusUnits: c.surplus,
      coverage,
      requiresHumanApproval:
        input.humanApprovalAboveMinor === undefined
          ? []
          : chosen
              .filter((q) => q.totalMinor > input.humanApprovalAboveMinor!)
              .map((q) => q.quoteId),
    };
  };
  const budgetEnforced = input.availableMinor !== null;
  const found = solve(input.availableMinor, 3);
  if (found.length > 0)
    return {
      status: "OPTIMAL",
      best: toPlan(found[0]!),
      alternatives: found.slice(1).map(toPlan),
      excluded,
      budgetEnforced,
    };

  const reasons: string[] = [];
  const offered = skus.map((_, s) => per.reduce((a, p) => a + p.units[s]!, 0));
  input.demand.forEach((d, s) => {
    if (offered[s]! < d.quantity)
      reasons.push(
        `COVERAGE:${d.sku} needs ${d.quantity}, eligible quotes offer ${offered[s]}`,
      );
  });
  let cheapest: number | null = null;
  if (reasons.length === 0) {
    const unconstrained = solve(null, 1);
    if (unconstrained.length > 0) {
      cheapest = unconstrained[0]!.total;
      if (input.availableMinor !== null && cheapest > input.availableMinor)
        reasons.push(`BUDGET_SHORTFALL:${cheapest - input.availableMinor}`);
      else
        reasons.push(
          "SURPLUS_LIMIT: the quotes that cover the demand bring more surplus units than allowed",
        );
    } else
      reasons.push(
        "SURPLUS_LIMIT: the quotes that cover the demand bring more surplus units than allowed",
      );
  }
  return {
    status: "INFEASIBLE",
    reasons,
    excluded,
    cheapestWithoutBudgetMinor: cheapest,
    budgetEnforced,
  };
}
