import { z } from "zod";

/**
 * V3 M51/M52 — workspace discovery and qualification. Pure and deterministic.
 *
 * A workspace source is untrusted. What it returns is bounded and parsed into a `WorkspaceListing`; a record that does not parse
 * is dropped and counted, never repaired. A listing is an OBSERVATION: it is not a quote, not a booking and not a reservation.
 * Availability we cannot read is UNKNOWN and is never treated as available. Money is integer minor units. The total liability of a
 * stay is computed here from the listing's own terms so that the owner compares what they could owe, not a headline rate.
 */
const Text = (n: number) => z.string().trim().min(1).max(n);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const Minor = z.number().int().safe().min(0).max(1_000_000_000_000);

export const SPACE_KINDS = [
  "DESK",
  "PRIVATE_OFFICE",
  "MEETING_ROOM",
  "EVENT_SPACE",
] as const;
export const RATE_BASES = ["HOURLY", "DAILY", "MONTHLY"] as const;
export type RateBasis = (typeof RATE_BASES)[number];

export const CancellationSchema = z.discriminatedUnion("policy", [
  z.object({ policy: z.literal("NON_REFUNDABLE") }).strict(),
  z
    .object({
      policy: z.literal("FREE_UNTIL"),
      /** Whole hours before the start that cancellation is free. After that the penalty applies. */
      freeHoursBeforeStart: z
        .number()
        .int()
        .min(0)
        .max(24 * 365),
      /** Penalty after the free period, in basis points of the rent (10000 = all of it). */
      penaltyBps: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ policy: z.literal("UNKNOWN") }).strict(),
]);

export const WorkspaceListingSchema = z
  .object({
    listingId: Id,
    kind: z.enum(SPACE_KINDS),
    name: Text(120),
    locality: z
      .object({
        country: z.string().regex(/^[A-Z]{2}$/u),
        city: Text(80),
        postalCode: z.string().trim().max(20).optional(),
      })
      .strict(),
    capacity: z.number().int().min(1).max(10_000),
    rate: z
      .object({
        basis: z.enum(RATE_BASES),
        minor: Minor,
        currency: z.string().regex(/^[A-Z]{3}$/u),
      })
      .strict(),
    /** Held by the provider and returned later: it is exposure, not a cost. `null` = the source did not say (UNKNOWN). */
    depositMinor: Minor.nullable(),
    /** Fees the source states on top of the rent (cleaning, admin). `null` = not stated. */
    feesMinor: Minor.nullable(),
    minTermDays: z.number().int().min(0).max(3650).nullable(),
    cancellation: CancellationSchema,
    amenities: z.array(Text(60)).max(30),
    /** Windows the source says are open. `null` = the source cannot say: UNKNOWN, never "available". */
    availableWindows: z
      .array(
        z
          .object({ start: z.string().datetime(), end: z.string().datetime() })
          .strict()
          .refine((w) => Date.parse(w.end) > Date.parse(w.start), {
            message: "window ends before it starts",
          }),
      )
      .max(60)
      .nullable(),
    provenance: z
      .object({
        sourceId: Id,
        observedAt: z.string().datetime(),
        evidence: z.enum(["PROVIDER_API", "DOCUMENT_REF", "OWNER_REPORTED"]),
        url: z
          .string()
          .url()
          .max(2048)
          .refine((v) => {
            const u = new URL(v);
            return u.protocol === "https:" && !u.username && !u.password;
          })
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type WorkspaceListing = z.infer<typeof WorkspaceListingSchema>;

/** Parse an untrusted source result: oversize or non-array output yields nothing; each bad record is dropped and counted. */
export function parseListings(
  raw: unknown,
  limits = { maxRecords: 50, maxBytes: 200_000 },
): { listings: WorkspaceListing[]; rejected: number; truncated: boolean } {
  let bytes = 0;
  try {
    bytes = JSON.stringify(raw)?.length ?? 0;
  } catch {
    return { listings: [], rejected: 1, truncated: false };
  }
  if (!Array.isArray(raw) || bytes > limits.maxBytes)
    return {
      listings: [],
      rejected: Array.isArray(raw) ? raw.length : 1,
      truncated: bytes > limits.maxBytes,
    };
  const out: WorkspaceListing[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const r of raw.slice(0, limits.maxRecords)) {
    const p = WorkspaceListingSchema.safeParse(r);
    if (!p.success || seen.has(p.data.listingId)) {
      rejected++;
      continue;
    }
    seen.add(p.data.listingId);
    out.push(p.data);
  }
  return {
    listings: out,
    rejected: rejected + Math.max(0, raw.length - limits.maxRecords),
    truncated: raw.length > limits.maxRecords,
  };
}

// ------------------------------------------------------------------------------------------------ the stay and what it can cost
export const StaySchema = z
  .object({
    start: z.string().datetime(),
    end: z.string().datetime(),
    people: z.number().int().min(1).max(10_000),
  })
  .strict()
  .refine((s) => Date.parse(s.end) > Date.parse(s.start), {
    message: "stay ends before it starts",
  });
export type Stay = z.infer<typeof StaySchema>;

const HOUR = 3_600_000;
/** Billable units, rounded UP: the provider bills a started hour/day/month. A month is 30 days. */
export function billableUnits(
  basis: RateBasis,
  stay: Pick<Stay, "start" | "end">,
): number {
  const ms = Date.parse(stay.end) - Date.parse(stay.start);
  const unit =
    basis === "HOURLY" ? HOUR : basis === "DAILY" ? 24 * HOUR : 30 * 24 * HOUR;
  return Math.max(1, Math.ceil(ms / unit));
}

export interface Liability {
  readonly currency: string;
  /** Rent for the stay: rate x billable units. */
  readonly rentMinor: number;
  /** Stated fees; `null` when the source did not say (the total is then UNKNOWN, not lower). */
  readonly feesMinor: number | null;
  /** Held by the provider; returned if terms are met. Exposure, not cost. */
  readonly depositMinor: number | null;
  /** Rent + fees: what is owed if the stay happens. `null` when a component is unknown. */
  readonly totalCostMinor: number | null;
  /** Most that could be owed if cancelled at `cancelAt`: penalty on rent (+fees) under the stated policy. `null` when unknown. */
  readonly cancellationExposureMinor: number | null;
  /** Everything at risk at once: total cost + deposit. `null` when any component is unknown. */
  readonly maxExposureMinor: number | null;
  readonly unknown: readonly string[];
}

export function liability(
  l: WorkspaceListing,
  stay: Stay,
  cancelAt: string,
): Liability {
  const unknown: string[] = [];
  const rentMinor = l.rate.minor * billableUnits(l.rate.basis, stay);
  if (l.feesMinor === null) unknown.push("FEES");
  if (l.depositMinor === null) unknown.push("DEPOSIT");
  if (l.cancellation.policy === "UNKNOWN") unknown.push("CANCELLATION");
  if (l.minTermDays === null) unknown.push("MIN_TERM");
  const totalCostMinor = l.feesMinor === null ? null : rentMinor + l.feesMinor;
  let cancellationExposureMinor: number | null = null;
  if (l.cancellation.policy === "NON_REFUNDABLE")
    cancellationExposureMinor = totalCostMinor;
  else if (l.cancellation.policy === "FREE_UNTIL" && totalCostMinor !== null) {
    const freeUntil =
      Date.parse(stay.start) - l.cancellation.freeHoursBeforeStart * HOUR;
    cancellationExposureMinor =
      Date.parse(cancelAt) <= freeUntil
        ? 0
        : Math.floor((totalCostMinor * l.cancellation.penaltyBps) / 10_000);
  }
  const maxExposureMinor =
    totalCostMinor === null || l.depositMinor === null
      ? null
      : totalCostMinor + l.depositMinor;
  return {
    currency: l.rate.currency,
    rentMinor,
    feesMinor: l.feesMinor,
    depositMinor: l.depositMinor,
    totalCostMinor,
    cancellationExposureMinor,
    maxExposureMinor,
    unknown,
  };
}

// ------------------------------------------------------------------------------------------------ qualification
export const WorkspaceNeedSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/u),
    city: Text(80),
    kinds: z.array(z.enum(SPACE_KINDS)).min(1).max(4),
    minCapacity: z.number().int().min(1).max(10_000),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    /** The most the owner will have at risk at once for ONE workspace (total cost + deposit). */
    maxExposureMinor: z.number().int().safe().min(1).max(1_000_000_000_000),
    requiredAmenities: z.array(Text(60)).max(20).default([]),
    maxMinTermDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();
export type WorkspaceNeed = z.infer<typeof WorkspaceNeedSchema>;

export type Problem =
  | "WRONG_CITY"
  | "WRONG_KIND"
  | "TOO_SMALL"
  | "WRONG_CURRENCY"
  | "MISSING_AMENITY"
  | "NOT_AVAILABLE_FOR_STAY"
  | "AVAILABILITY_UNKNOWN"
  | "ABOVE_EXPOSURE_LIMIT"
  | "EXPOSURE_UNKNOWN"
  | "STAY_SHORTER_THAN_MIN_TERM"
  | "TERM_TOO_LONG"
  | "TERM_UNKNOWN"
  | "CANCELLATION_UNKNOWN";

export interface Assessment {
  readonly listingId: string;
  readonly liability: Liability;
  /** Hard problems stop a listing being recommended. UNKNOWN is a problem: it is never read as favourable. */
  readonly problems: readonly Problem[];
  readonly qualified: boolean;
}

export function assess(
  l: WorkspaceListing,
  need: WorkspaceNeed,
  stay: Stay,
  cancelAt: string,
): Assessment {
  const p: Problem[] = [];
  const lia = liability(l, stay, cancelAt);
  if (
    l.locality.country !== need.country ||
    l.locality.city.toLowerCase() !== need.city.toLowerCase()
  )
    p.push("WRONG_CITY");
  if (!need.kinds.includes(l.kind)) p.push("WRONG_KIND");
  if (l.capacity < Math.max(need.minCapacity, stay.people)) p.push("TOO_SMALL");
  if (l.rate.currency !== need.currency) p.push("WRONG_CURRENCY");
  const have = new Set(l.amenities.map((a) => a.toLowerCase()));
  if (need.requiredAmenities.some((a) => !have.has(a.toLowerCase())))
    p.push("MISSING_AMENITY");
  if (l.availableWindows === null) p.push("AVAILABILITY_UNKNOWN");
  else if (
    !l.availableWindows.some(
      (w) =>
        Date.parse(w.start) <= Date.parse(stay.start) &&
        Date.parse(w.end) >= Date.parse(stay.end),
    )
  )
    p.push("NOT_AVAILABLE_FOR_STAY");
  if (lia.maxExposureMinor === null) p.push("EXPOSURE_UNKNOWN");
  else if (lia.maxExposureMinor > need.maxExposureMinor)
    p.push("ABOVE_EXPOSURE_LIMIT");
  if (l.minTermDays === null) p.push("TERM_UNKNOWN");
  else {
    if (
      Date.parse(stay.end) - Date.parse(stay.start) <
      l.minTermDays * 24 * HOUR
    )
      p.push("STAY_SHORTER_THAN_MIN_TERM");
    if (
      need.maxMinTermDays !== undefined &&
      l.minTermDays > need.maxMinTermDays
    )
      p.push("TERM_TOO_LONG");
  }
  if (l.cancellation.policy === "UNKNOWN") p.push("CANCELLATION_UNKNOWN");
  return {
    listingId: l.listingId,
    liability: lia,
    problems: p,
    qualified: p.length === 0,
  };
}

/** Qualified listings first, cheapest total exposure first; unqualified ones follow, fewest problems first. Deterministic. */
export function rank(assessments: readonly Assessment[]): Assessment[] {
  return [...assessments].sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    if (a.qualified)
      return (
        (a.liability.maxExposureMinor ?? 0) -
          (b.liability.maxExposureMinor ?? 0) ||
        (a.listingId < b.listingId ? -1 : 1)
      );
    return (
      a.problems.length - b.problems.length ||
      (a.listingId < b.listingId ? -1 : 1)
    );
  });
}
