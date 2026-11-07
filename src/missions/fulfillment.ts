/**
 * V3 M42 — what actually arrived. Pure and deterministic.
 *
 * Receipts are a person's counts of one purchase-order line each; they add up. The outcome of a line and of the whole order is computed
 * from the ordered quantities and the receipts and is never declared by anyone.
 */
export type Condition = "OK" | "DAMAGED" | "WRONG_ITEM";
export interface OrderedLine {
  readonly quantity: number;
}
export interface ReceiptFact {
  readonly lineIndex: number;
  readonly quantity: number;
  readonly condition: Condition;
}
export type LineOutcome =
  "PENDING" | "COMPLETE" | "SHORT" | "DAMAGED" | "WRONG_ITEM" | "OVER";
export interface LineResult {
  readonly lineIndex: number;
  readonly ordered: number;
  readonly okQty: number;
  readonly damagedQty: number;
  readonly wrongQty: number;
  readonly receivedQty: number;
  readonly outcome: LineOutcome;
}
export type OrderOutcome = "PENDING" | "PARTIAL" | "COMPLETE" | "HAS_ISSUES";

export function lineResult(
  lineIndex: number,
  ordered: number,
  receipts: readonly ReceiptFact[],
): LineResult {
  const mine = receipts.filter((r) => r.lineIndex === lineIndex);
  const sum = (c: Condition) =>
    mine.filter((r) => r.condition === c).reduce((a, r) => a + r.quantity, 0);
  const okQty = sum("OK");
  const damagedQty = sum("DAMAGED");
  const wrongQty = sum("WRONG_ITEM");
  const receivedQty = okQty + damagedQty + wrongQty;
  let outcome: LineOutcome;
  if (mine.length === 0) outcome = "PENDING";
  else if (receivedQty > ordered) outcome = "OVER";
  else if (wrongQty > 0) outcome = "WRONG_ITEM";
  else if (damagedQty > 0) outcome = "DAMAGED";
  else if (okQty === ordered) outcome = "COMPLETE";
  else outcome = "SHORT";
  return {
    lineIndex,
    ordered,
    okQty,
    damagedQty,
    wrongQty,
    receivedQty,
    outcome,
  };
}
export function fulfillment(
  lines: readonly OrderedLine[],
  receipts: readonly ReceiptFact[],
): { lines: LineResult[]; outcome: OrderOutcome; problems: string[] } {
  const results = lines.map((l, i) => lineResult(i, l.quantity, receipts));
  const problems = results
    .filter((r) => !["PENDING", "COMPLETE", "SHORT"].includes(r.outcome))
    .map((r) => `LINE_${r.lineIndex}_${r.outcome}`);
  let outcome: OrderOutcome;
  if (results.every((r) => r.outcome === "PENDING")) outcome = "PENDING";
  else if (problems.length > 0) outcome = "HAS_ISSUES";
  else if (results.every((r) => r.outcome === "COMPLETE")) outcome = "COMPLETE";
  else outcome = "PARTIAL";
  return { lines: results, outcome, problems };
}
/** The dispute grounds the evidence supports; M43 offers exactly these and no others. */
export function disputeGrounds(
  results: readonly LineResult[],
  orderLate: boolean,
): string[] {
  const g = new Set<string>();
  for (const r of results) {
    if (r.outcome === "DAMAGED") g.add("DAMAGED");
    if (r.outcome === "WRONG_ITEM") g.add("WRONG_ITEM");
    if (r.outcome === "SHORT") g.add("SHORT_DELIVERY");
    if (r.outcome === "OVER") g.add("OVER_DELIVERY");
  }
  if (orderLate) g.add("NOT_DELIVERED_LATE");
  return [...g].sort();
}
