import { z } from "zod";

/**
 * V3 M63 — foreign exchange for budgets. Pure and deterministic. Integer math only (BigInt); no floats anywhere.
 *
 * A rate is an OBSERVATION with a source and a time. A rate that is stale, malformed or for the wrong pair is not used: the result is an
 * explicit refusal, never a guess. Rounding is always stated and always against the owner's interest being understated: what could be
 * OWED rounds UP, what is AVAILABLE rounds DOWN, so conversion can never make a budget look roomier than it is.
 */
const Code = z.string().regex(/^[A-Z]{3}$/u);
export const FxRateSchema = z
  .object({
    base: Code,
    quote: Code,
    /** 1 base = num/den quote, in MAJOR units. Example 1.2745 = 12745 / 10000. */
    num: z.number().int().safe().min(1).max(1_000_000_000_000),
    den: z.number().int().safe().min(1).max(1_000_000_000_000),
    observedAt: z.string().datetime(),
    source: z.string().trim().min(1).max(80),
  })
  .strict()
  .refine((r) => r.base !== r.quote, { message: "same currency" });
export type FxRate = z.infer<typeof FxRateSchema>;

/** Minor-unit exponent (digits after the decimal point). Unknown currencies are refused, not assumed to be 2. */
const EXPONENT: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  NZD: 2,
  SGD: 2,
  INR: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
};
export const exponentOf = (c: string): number | null => EXPONENT[c] ?? null;

export type Direction = "OWED" | "AVAILABLE";
export type FxRefusal =
  "BAD_RATE" | "WRONG_PAIR" | "STALE_RATE" | "UNKNOWN_CURRENCY" | "BAD_AMOUNT";
export type FxResult =
  | { ok: true; minor: number; rate: FxRate; rounding: "UP" | "DOWN" }
  | { ok: false; refusal: FxRefusal };

export function convert(
  amountMinor: number,
  from: string,
  to: string,
  rate: unknown,
  o: { now: string; maxAgeSeconds: number; direction: Direction },
): FxResult {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    return { ok: false, refusal: "BAD_AMOUNT" };
  const p = FxRateSchema.safeParse(rate);
  if (!p.success) return { ok: false, refusal: "BAD_RATE" };
  const r = p.data;
  // either direction of the pair is usable; the inverse is exact (swap num and den)
  let num: bigint;
  let den: bigint;
  if (r.base === from && r.quote === to) {
    num = BigInt(r.num);
    den = BigInt(r.den);
  } else if (r.base === to && r.quote === from) {
    num = BigInt(r.den);
    den = BigInt(r.num);
  } else return { ok: false, refusal: "WRONG_PAIR" };
  const ef = exponentOf(from);
  const et = exponentOf(to);
  if (ef === null || et === null)
    return { ok: false, refusal: "UNKNOWN_CURRENCY" };
  const age = Date.parse(o.now) - Date.parse(r.observedAt);
  // a rate from the future is as untrustworthy as an old one
  if (!(age >= 0) || age > o.maxAgeSeconds * 1000)
    return { ok: false, refusal: "STALE_RATE" };
  const top = BigInt(amountMinor) * num * 10n ** BigInt(et);
  const bottom = den * 10n ** BigInt(ef);
  const down = top / bottom;
  const up = top % bottom === 0n ? down : down + 1n;
  const v = o.direction === "OWED" ? up : down;
  if (v > BigInt(Number.MAX_SAFE_INTEGER))
    return { ok: false, refusal: "BAD_AMOUNT" };
  return {
    ok: true,
    minor: Number(v),
    rate: r,
    rounding: o.direction === "OWED" ? "UP" : "DOWN",
  };
}
