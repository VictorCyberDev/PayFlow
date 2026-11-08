/**
 * V3 M45 — the multi-vendor view of a mission. Pure and deterministic.
 *
 * When a mission buys from several suppliers, the question is no longer one quote but the whole: how the spend is spread, where it is
 * concentrated, which supplier has trouble open, and whether the mission can be closed out. Shares use integer basis points (no floats),
 * rounded down. Nothing here decides or moves anything.
 */
export interface SupplierFacts {
  readonly supplierId: string;
  readonly name: string;
  /** Paid and not refunded. */
  readonly spentMinor: number;
  /** Committed or in flight but not yet settled (including unknown outcomes). */
  readonly pendingMinor: number;
  readonly refundedMinor: number;
  readonly unknownOutcomes: number;
  readonly orders: {
    total: number;
    delivered: number;
    cancelled: number;
    inDispute: number;
  };
  readonly openDisputes: number;
  readonly overdueObligations: number;
  readonly orderIssues: number;
}
export interface SupplierRow extends SupplierFacts {
  readonly totalMinor: number;
  readonly shareBps: number;
  readonly flags: string[];
}
export interface Portfolio {
  readonly suppliers: SupplierRow[];
  readonly totalMinor: number;
  readonly concentration: { supplierId: string; shareBps: number }[];
  readonly maxShareBps: number;
  readonly closeOut: { ready: boolean; blockers: string[] };
}
export const DEFAULT_MAX_SHARE_BPS = 5000;

/** floor(10000 * part / total) with BigInt, so large amounts cannot lose precision. */
export function shareBps(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number((BigInt(part) * 10000n) / BigInt(total));
}
export function buildPortfolio(
  facts: readonly SupplierFacts[],
  maxShareBpsRaw: number = DEFAULT_MAX_SHARE_BPS,
): Portfolio {
  const maxShareBps = Math.min(10000, Math.max(1, Math.trunc(maxShareBpsRaw)));
  const totalMinor = facts.reduce(
    (a, f) => a + f.spentMinor + f.pendingMinor,
    0,
  );
  const suppliers: SupplierRow[] = facts
    .map((f) => {
      const t = f.spentMinor + f.pendingMinor;
      const flags: string[] = [];
      if (f.openDisputes > 0) flags.push("OPEN_DISPUTES");
      if (f.overdueObligations > 0) flags.push("OVERDUE_OBLIGATIONS");
      if (f.orderIssues > 0) flags.push("DELIVERY_ISSUES");
      if (f.unknownOutcomes > 0) flags.push("UNKNOWN_PAYMENT_OUTCOME");
      return { ...f, totalMinor: t, shareBps: shareBps(t, totalMinor), flags };
    })
    .sort(
      (a, b) =>
        b.totalMinor - a.totalMinor || (a.supplierId < b.supplierId ? -1 : 1),
    );
  // Concentration only means something when there is more than one supplier to compare against.
  const concentration =
    suppliers.length > 1
      ? suppliers
          .filter((s) => s.shareBps > maxShareBps)
          .map((s) => ({ supplierId: s.supplierId, shareBps: s.shareBps }))
      : [];
  const blockers: string[] = [];
  for (const s of suppliers) {
    if (s.openDisputes > 0) blockers.push(`${s.supplierId}:OPEN_DISPUTES`);
    if (s.overdueObligations > 0)
      blockers.push(`${s.supplierId}:OVERDUE_OBLIGATIONS`);
    if (s.unknownOutcomes > 0)
      blockers.push(`${s.supplierId}:UNKNOWN_PAYMENT_OUTCOME`);
    if (s.pendingMinor > 0) blockers.push(`${s.supplierId}:PAYMENT_PENDING`);
    const undone = s.orders.total - s.orders.delivered - s.orders.cancelled;
    if (undone > 0) blockers.push(`${s.supplierId}:ORDERS_NOT_FINISHED`);
  }
  return {
    suppliers,
    totalMinor,
    concentration,
    maxShareBps,
    closeOut: { ready: blockers.length === 0, blockers },
  };
}
