/**
 * V3 M44 — obligations. Pure and deterministic; no clock of its own.
 *
 * Dates derived from a quote's terms are computed from verified facts. Calendar months clamp to the end of the month (31 Jan + 1 month
 * is 28/29 Feb, never 3 March). Whether an obligation is due soon or late is computed against the date it is asked about, never stored.
 */
export type Kind =
  | "DELIVERY_DEADLINE"
  | "RETURN_WINDOW"
  | "WARRANTY_END"
  | "RENEWAL"
  | "PAYMENT_DUE"
  | "CUSTOM";

const pad = (n: number) => String(n).padStart(2, "0");
export const isDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addMonths(date: string, months: number): string {
  const [y, m, day] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(day, last))}`;
}
export interface Derivable {
  readonly kind: Kind;
  readonly title: string;
  readonly dueDate: string;
  readonly derivedFrom: string;
}
export interface DeriveFacts {
  readonly orderCreatedDate: string;
  /** The date a person verified delivery, if they have. */
  readonly deliveredDate: string | null;
  readonly terms: {
    readonly deliveryDays?: number;
    readonly returnWindowDays?: number;
    readonly warrantyMonths?: number;
  };
}
/** What can be derived now. Return window and warranty start only from a VERIFIED delivery; a claimed one starts nothing. */
export function derive(f: DeriveFacts): Derivable[] {
  const out: Derivable[] = [];
  if (f.terms.deliveryDays !== undefined)
    out.push({
      kind: "DELIVERY_DEADLINE",
      title: `Supplier promised delivery within ${f.terms.deliveryDays} days`,
      dueDate: addDays(f.orderCreatedDate, f.terms.deliveryDays),
      derivedFrom: "QUOTE_TERMS:deliveryDays",
    });
  if (f.deliveredDate !== null) {
    if (f.terms.returnWindowDays !== undefined)
      out.push({
        kind: "RETURN_WINDOW",
        title: `Return window (${f.terms.returnWindowDays} days) closes`,
        dueDate: addDays(f.deliveredDate, f.terms.returnWindowDays),
        derivedFrom: "QUOTE_TERMS:returnWindowDays",
      });
    if (f.terms.warrantyMonths !== undefined)
      out.push({
        kind: "WARRANTY_END",
        title: `Warranty (${f.terms.warrantyMonths} months) ends`,
        dueDate: addMonths(f.deliveredDate, f.terms.warrantyMonths),
        derivedFrom: "QUOTE_TERMS:warrantyMonths",
      });
  }
  return out;
}
export type State = "DONE" | "WAIVED" | "OVERDUE" | "DUE_SOON" | "UPCOMING";
export const DUE_SOON_DAYS = 7;
export function stateOf(
  status: "OPEN" | "DONE" | "WAIVED",
  dueDate: string,
  today: string,
): State {
  if (status === "DONE") return "DONE";
  if (status === "WAIVED") return "WAIVED";
  if (dueDate < today) return "OVERDUE";
  return dueDate <= addDays(today, DUE_SOON_DAYS) ? "DUE_SOON" : "UPCOMING";
}
