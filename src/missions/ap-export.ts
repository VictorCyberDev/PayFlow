/**
 * V3 M68 — accounting export (accounts-payable style). Pure and deterministic.
 *
 * What goes out is the commitment ledger as rows a bookkeeper can open: one line per item with integer-exact decimal amounts (no floats),
 * the stage in words, and how it was verified. It is an EXPORT: it connects to no ERP, posts nothing and claims no entry is booked anywhere.
 * Every text cell is neutralised against spreadsheet formula injection, because supplier-supplied text can end up in a label.
 */
export interface ExportItem {
  readonly itemId: string;
  readonly kind: string;
  readonly label: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly refundedMinor: number;
  readonly exposureMinor: number;
  readonly stage: string;
  readonly verification: string;
  readonly createdAt: string;
}
const MINOR_DIGITS: Record<string, number> = { JPY: 0, KRW: 0, KWD: 3, BHD: 3 };

/** Minor units to a plain decimal string without floating point: 12345 + USD => "123.45". */
export function decimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new Error("not an integer amount");
  const d = MINOR_DIGITS[currency] ?? 2;
  const neg = minor < 0;
  const s = String(Math.abs(minor)).padStart(d + 1, "0");
  const body = d === 0 ? s : `${s.slice(0, -d)}.${s.slice(-d)}`;
  return neg ? `-${body}` : body;
}

/** Quote a cell; neutralise a leading = + - @ tab or CR (formula injection) with an apostrophe; double any quote. */
export function cell(v: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  let t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, " ");
  if (/^[=+\-@\t\r]/u.test(t)) t = "'" + t;
  return `"${t.replaceAll('"', '""')}"`;
}

export const HEADER = [
  "Item",
  "Kind",
  "Description",
  "Currency",
  "Amount",
  "Refunded",
  "At risk now",
  "Stage",
  "Verification",
  "Recorded at",
] as const;

export function toCsv(items: readonly ExportItem[]): string {
  const rows = items.map((i) =>
    [
      i.itemId,
      i.kind,
      i.label,
      i.currency,
      decimal(i.amountMinor, i.currency),
      decimal(i.refundedMinor, i.currency),
      decimal(i.exposureMinor, i.currency),
      i.stage,
      i.verification,
      i.createdAt,
    ]
      .map((c) => cell(String(c)))
      .join(","),
  );
  return [HEADER.map((h) => cell(h)).join(","), ...rows].join("\r\n") + "\r\n";
}
