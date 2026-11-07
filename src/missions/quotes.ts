import { z } from "zod";

/**
 * V3 M34 — quotes and landed cost. Pure and deterministic, integer minor units only (BigInt inside, so no rounding and no
 * overflow), one currency per quote and no conversion.
 *
 * Each money component is STATED (the supplier said so), ESTIMATED (someone's estimate, labelled) or UNKNOWN. The landed total is
 * computed from what is known. It is `complete` only when nothing is unknown; otherwise only `knownMinor` and the list of
 * unknown parts are given and a total is never claimed. Whether the quote is still good is a separate question (`validUntil`).
 */
export const MAX_MINOR = 1_000_000_000_000;
const Basis = z.enum(["STATED", "ESTIMATED"]);
export const MoneySchema = z.discriminatedUnion("basis", [
  z
    .object({
      basis: Basis,
      minor: z.number().int().safe().min(0).max(MAX_MINOR),
    })
    .strict(),
  z.object({ basis: z.literal("UNKNOWN") }).strict(),
]);
export type Money = z.infer<typeof MoneySchema>;
const Text = (n: number) => z.string().trim().min(1).max(n);

export const QuoteLineSchema = z
  .object({
    description: Text(200),
    sku: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/u)
      .optional(),
    quantity: z.number().int().min(1).max(1_000_000),
    unitPrice: MoneySchema,
  })
  .strict();
export const QuoteDocumentSchema = z
  .object({
    lines: z.array(QuoteLineSchema).min(1).max(50),
    shipping: MoneySchema,
    tax: MoneySchema,
    duties: MoneySchema,
    fees: MoneySchema,
    /** Money OFF the total. Unknown means a discount may exist that is not counted. */
    discount: MoneySchema,
    terms: z
      .object({
        paymentTerms: Text(200).optional(),
        deliveryDays: z.number().int().min(0).max(365).optional(),
        returnWindowDays: z.number().int().min(0).max(365).optional(),
        warrantyMonths: z.number().int().min(0).max(240).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type QuoteDocument = z.infer<typeof QuoteDocumentSchema>;

export const COMPONENTS = [
  "shipping",
  "tax",
  "duties",
  "fees",
  "discount",
] as const;

export interface Landed {
  readonly subtotalKnownMinor: number;
  readonly knownMinor: number;
  /** Equals knownMinor only when `complete`. */
  readonly totalMinor: number | null;
  readonly complete: boolean;
  readonly hasEstimates: boolean;
  readonly unknown: readonly string[];
  readonly estimated: readonly string[];
}

const big = (m: Money) => (m.basis === "UNKNOWN" ? null : BigInt(m.minor));
export function landed(doc: QuoteDocument): Landed | { tooLarge: true } {
  const unknown: string[] = [];
  const estimated: string[] = [];
  let sub = 0n;
  doc.lines.forEach((l, i) => {
    const u = big(l.unitPrice);
    if (u === null) unknown.push(`line ${i + 1} unit price`);
    else {
      sub += u * BigInt(l.quantity);
      if (l.unitPrice.basis === "ESTIMATED")
        estimated.push(`line ${i + 1} unit price`);
    }
  });
  let plus = 0n;
  let minus = 0n;
  for (const c of COMPONENTS) {
    const v = big(doc[c]);
    if (v === null) unknown.push(c);
    else {
      if (doc[c].basis === "ESTIMATED") estimated.push(c);
      if (c === "discount") minus += v;
      else plus += v;
    }
  }
  const known = sub + plus - minus;
  // A discount larger than everything else would make a negative total; refuse to present one.
  if (known < 0n) return { tooLarge: true };
  if (
    sub > BigInt(Number.MAX_SAFE_INTEGER) ||
    known > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return { tooLarge: true };
  const complete = unknown.length === 0;
  return {
    subtotalKnownMinor: Number(sub),
    knownMinor: Number(known),
    totalMinor: complete ? Number(known) : null,
    complete,
    hasEstimates: estimated.length > 0,
    unknown,
    estimated,
  };
}

export type QuoteStatus = "CURRENT" | "EXPIRED" | "SUPERSEDED";
export const statusOf = (
  validUntil: string,
  superseded: boolean,
  now: string,
): QuoteStatus =>
  superseded
    ? "SUPERSEDED"
    : Date.parse(validUntil) <= Date.parse(now)
      ? "EXPIRED"
      : "CURRENT";

export interface Comparable {
  readonly quoteId: string;
  readonly supplierId: string;
  readonly currency: string;
  readonly status: QuoteStatus;
  readonly landed: Landed;
}
/**
 * Only complete, current quotes in the mission's currency are ranked, by landed total then id. Everything else is listed with the
 * reason it was not ranked: a quote with unknown parts is never ranked against complete ones by its partial total.
 */
export function compareQuotes(items: readonly Comparable[], currency: string) {
  const ranked: (Comparable & { rank: number })[] = [];
  const notRanked: { quoteId: string; reason: string }[] = [];
  const eligible: Comparable[] = [];
  for (const q of items) {
    if (q.currency !== currency)
      notRanked.push({
        quoteId: q.quoteId,
        reason: `In ${q.currency}; no conversion is done.`,
      });
    else if (q.status !== "CURRENT")
      notRanked.push({
        quoteId: q.quoteId,
        reason:
          q.status === "EXPIRED"
            ? "The quote has expired."
            : "A newer quote replaced it.",
      });
    else if (!q.landed.complete)
      notRanked.push({
        quoteId: q.quoteId,
        reason: `Not complete: ${q.landed.unknown.join(", ")} unknown.`,
      });
    else eligible.push(q);
  }
  eligible
    .sort(
      (a, b) =>
        a.landed.totalMinor! - b.landed.totalMinor! ||
        (a.quoteId < b.quoteId ? -1 : 1),
    )
    .forEach((q, i) => ranked.push({ ...q, rank: i + 1 }));
  const best = ranked[0]?.landed.totalMinor;
  return {
    ranked: ranked.map((q) => ({
      quoteId: q.quoteId,
      supplierId: q.supplierId,
      rank: q.rank,
      totalMinor: q.landed.totalMinor!,
      overBestMinor: q.landed.totalMinor! - best!,
      hasEstimates: q.landed.hasEstimates,
    })),
    notRanked,
  };
}
