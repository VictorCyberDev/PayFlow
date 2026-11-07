import { z } from "zod";

/**
 * V3 M32 — judging discovered candidates against stated requirements. Pure and deterministic: no model, no network, no clock
 * other than the `now` it is given. Every check is MET, NOT_MET or UNKNOWN; UNKNOWN (the candidate did not say) is never treated
 * as MET. Nothing here is a quote: a price is "what was observed at `observedAt`".
 */
const ClaimValue = z.union([z.string().max(200), z.number(), z.boolean()]);
export const RequirementsSchema = z
  .object({
    maxUnitPriceMinor: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(1_000_000_000_000)
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    minQuantity: z.number().int().min(1).max(1_000_000).optional(),
    /** Claims the candidate must state with exactly this value, e.g. { condition: "NEW" }. */
    claims: z
      .record(z.string().max(64), ClaimValue)
      .refine((c) => Object.keys(c).length <= 8, "at most 8 claim requirements")
      .optional(),
    /** An observation older than this is stale. Default one day. */
    maxAgeMinutes: z.number().int().min(1).max(10_080).default(1440),
  })
  .strict();
export type Requirements = z.infer<typeof RequirementsSchema>;

export interface CandidateFacts {
  readonly candidateId: string;
  readonly recordId: string;
  readonly unitPriceMinor: number | null;
  readonly currency: string | null;
  readonly availableQuantity: number | null;
  readonly observedAt: string;
  readonly claims: Readonly<Record<string, string | number | boolean | null>>;
}
export type CheckStatus = "MET" | "NOT_MET" | "UNKNOWN";
export interface Check {
  readonly requirement: string;
  readonly status: CheckStatus;
  readonly detail: string;
}
export interface Evaluation {
  readonly checks: readonly Check[];
  readonly metAll: boolean;
  readonly notMet: number;
  readonly unknown: number;
  readonly stale: boolean;
  readonly ageMinutes: number;
}

export function evaluate(
  c: CandidateFacts,
  req: Requirements,
  now: string,
): Evaluation {
  const checks: Check[] = [];
  const add = (requirement: string, status: CheckStatus, detail: string) =>
    checks.push({ requirement, status, detail });
  const ageMinutes = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(c.observedAt)) / 60_000),
  );
  const stale = ageMinutes > req.maxAgeMinutes;
  add(
    "freshness",
    stale ? "NOT_MET" : "MET",
    stale
      ? `Observed ${ageMinutes} minutes ago; the limit is ${req.maxAgeMinutes}.`
      : `Observed ${ageMinutes} minutes ago.`,
  );
  if (req.currency !== undefined) {
    if (c.currency === null)
      add("currency", "UNKNOWN", "The candidate states no price.");
    else
      add(
        "currency",
        c.currency === req.currency ? "MET" : "NOT_MET",
        `Priced in ${c.currency}; wanted ${req.currency}. No conversion is done.`,
      );
  }
  if (req.maxUnitPriceMinor !== undefined) {
    if (c.unitPriceMinor === null)
      add("maxUnitPrice", "UNKNOWN", "The candidate states no price.");
    else if (req.currency !== undefined && c.currency !== req.currency)
      add(
        "maxUnitPrice",
        "UNKNOWN",
        "Price is in another currency; not compared.",
      );
    else
      add(
        "maxUnitPrice",
        c.unitPriceMinor <= req.maxUnitPriceMinor ? "MET" : "NOT_MET",
        `Observed ${c.unitPriceMinor}; limit ${req.maxUnitPriceMinor} (minor units).`,
      );
  }
  if (req.minQuantity !== undefined) {
    if (c.availableQuantity === null)
      add("minQuantity", "UNKNOWN", "The candidate states no availability.");
    else
      add(
        "minQuantity",
        c.availableQuantity >= req.minQuantity ? "MET" : "NOT_MET",
        `Available ${c.availableQuantity}; wanted ${req.minQuantity}.`,
      );
  }
  for (const [k, want] of Object.entries(req.claims ?? {})) {
    const have = c.claims[k];
    if (have === undefined || have === null)
      add(`claim:${k}`, "UNKNOWN", `The candidate does not state ${k}.`);
    else
      add(
        `claim:${k}`,
        have === want ? "MET" : "NOT_MET",
        `States ${k}=${String(have)}; wanted ${String(want)}.`,
      );
  }
  const notMet = checks.filter((x) => x.status === "NOT_MET").length;
  const unknown = checks.filter((x) => x.status === "UNKNOWN").length;
  return {
    checks,
    metAll: notMet === 0 && unknown === 0,
    notMet,
    unknown,
    stale,
    ageMinutes,
  };
}

/**
 * Order: fewest unmet requirements, then fewest unknowns, then lowest observed price (unpriced last), then record id.
 * "Rank 1" means "best against what was asked", never "best" and never "approved".
 */
export function rank<T extends CandidateFacts>(
  items: readonly T[],
  req: Requirements,
  now: string,
): (T & { evaluation: Evaluation; rank: number })[] {
  return items
    .map((i) => ({ ...i, evaluation: evaluate(i, req, now) }))
    .sort(
      (a, b) =>
        a.evaluation.notMet - b.evaluation.notMet ||
        a.evaluation.unknown - b.evaluation.unknown ||
        (a.unitPriceMinor ?? Number.MAX_SAFE_INTEGER) -
          (b.unitPriceMinor ?? Number.MAX_SAFE_INTEGER) ||
        (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
    )
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

/** A grouping key only when the candidate states a SKU. Otherwise never merge: similar titles are not the same product. */
export function matchKeyOf(
  claims: Readonly<Record<string, string | number | boolean | null>>,
): string | null {
  const sku = claims["sku"];
  return typeof sku === "string" && sku.trim() !== ""
    ? `sku:${sku.trim().toLowerCase()}`
    : null;
}

/** Side by side: which fields differ across the candidates compared. Only what was observed; no totals, no landed cost. */
export function compareFacts(
  items: readonly (CandidateFacts & { title: string; connectorId: string })[],
) {
  const claimKeys = [
    ...new Set(items.flatMap((i) => Object.keys(i.claims))),
  ].sort();
  const row = (
    field: string,
    value: (i: (typeof items)[number]) => unknown,
  ) => {
    const values = items.map(value);
    return {
      field,
      values,
      differs: new Set(values.map((v) => JSON.stringify(v ?? null))).size > 1,
    };
  };
  return [
    row("title", (i) => i.title),
    row("connector", (i) => i.connectorId),
    row("unitPriceMinor", (i) => i.unitPriceMinor),
    row("currency", (i) => i.currency),
    row("availableQuantity", (i) => i.availableQuantity),
    row("observedAt", (i) => i.observedAt),
    ...claimKeys.map((k) => row(`claim:${k}`, (i) => i.claims[k] ?? null)),
  ];
}
