/**
 * V3 M41 — orders. Pure and deterministic.
 *
 * The status of an order moves only on VERIFIED events (a person, with evidence). A CLAIM (an agent's report, or what the supplier
 * said) is recorded beside it and never moves anything. Moves are forward only; CANCELLED is final.
 */
export const ORDER_STATUSES = [
  "PLACED",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "IN_DISPUTE",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const MOVES: Record<OrderStatus, readonly OrderStatus[]> = {
  PLACED: ["CONFIRMED", "SHIPPED", "CANCELLED", "IN_DISPUTE"],
  CONFIRMED: ["SHIPPED", "CANCELLED", "IN_DISPUTE"],
  SHIPPED: ["DELIVERED", "IN_DISPUTE"],
  DELIVERED: ["IN_DISPUTE"],
  CANCELLED: [],
  IN_DISPUTE: ["DELIVERED", "CANCELLED"],
};
export const canMoveOrder = (from: OrderStatus, to: OrderStatus) =>
  MOVES[from].includes(to);
export const isFinal = (s: OrderStatus) => MOVES[s].length === 0;

export interface OrderEventFact {
  readonly kind: "STATUS" | "REFERENCE" | "DELIVERY_DATE" | "NOTE";
  readonly verification: "CLAIMED" | "VERIFIED";
  readonly status: OrderStatus | null;
}
/** The status after replaying events: only legal VERIFIED status events count. */
export function replayStatus(events: readonly OrderEventFact[]): OrderStatus {
  let s: OrderStatus = "PLACED";
  for (const e of events)
    if (
      e.kind === "STATUS" &&
      e.verification === "VERIFIED" &&
      e.status !== null &&
      canMoveOrder(s, e.status)
    )
      s = e.status;
  return s;
}
/** What was last claimed but not verified (the "supplier says" line). Null when nothing differs from the verified status. */
export function pendingClaim(
  events: readonly OrderEventFact[],
): OrderStatus | null {
  const verified = replayStatus(events);
  const last = [...events]
    .reverse()
    .find(
      (e) =>
        e.kind === "STATUS" &&
        e.verification === "CLAIMED" &&
        e.status !== null,
    );
  return last && last.status !== verified ? last.status : null;
}
/** Late = a date was expected, today is past it, and the order is not delivered, cancelled or in dispute. */
export function isOverdue(
  status: OrderStatus,
  expectedDelivery: string | null,
  todayIso: string,
): boolean {
  if (expectedDelivery === null) return false;
  if (status === "DELIVERED" || status === "CANCELLED") return false;
  return todayIso.slice(0, 10) > expectedDelivery;
}
