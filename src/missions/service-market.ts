import { z } from "zod";

/**
 * V3 M54 — professional services marketplace (fixed-scope packages). Pure and deterministic.
 *
 * A service source is untrusted. A package is an OBSERVATION of what a provider says it sells: it is not a quote, an engagement or a
 * purchase. Anything the source does not state (price, delivery time, revisions, refund terms) is UNKNOWN and is never read as
 * favourable. Money is integer minor units. A package with an unstated price has no liability figure at all.
 */
const Text = (n: number) => z.string().trim().min(1).max(n);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const Minor = z.number().int().safe().min(0).max(1_000_000_000_000);

export const SERVICE_CATEGORIES = [
  "DESIGN",
  "SOFTWARE",
  "WRITING",
  "LEGAL_REVIEW",
  "BOOKKEEPING",
  "MARKETING",
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const ServicePackageSchema = z
  .object({
    packageId: Id,
    category: z.enum(SERVICE_CATEGORIES),
    providerName: Text(120),
    title: Text(160),
    /** What is delivered. A package with no stated deliverable cannot be compared. */
    deliverables: z.array(Text(160)).min(1).max(20),
    /** Fixed price for the whole package. `null` = the source did not say. */
    priceMinor: Minor.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    deliveryDays: z.number().int().min(0).max(3650).nullable(),
    revisionsIncluded: z.number().int().min(0).max(100).nullable(),
    /** Share of the price returned if the owner cancels before work starts, in basis points. `null` = not stated. */
    refundBeforeStartBps: z.number().int().min(0).max(10_000).nullable(),
    provenance: z
      .object({
        sourceId: Id,
        observedAt: z.string().datetime(),
        evidence: z.enum(["PROVIDER_API", "DOCUMENT_REF", "OWNER_REPORTED"]),
      })
      .strict(),
  })
  .strict();
export type ServicePackage = z.infer<typeof ServicePackageSchema>;

/** Parse untrusted output: oversize or non-array yields nothing; each bad or duplicate record is dropped and counted, never repaired. */
export function parsePackages(
  raw: unknown,
  limits = { maxRecords: 50, maxBytes: 200_000 },
): { packages: ServicePackage[]; rejected: number; truncated: boolean } {
  let bytes = 0;
  try {
    bytes = JSON.stringify(raw)?.length ?? 0;
  } catch {
    return { packages: [], rejected: 1, truncated: false };
  }
  if (!Array.isArray(raw) || bytes > limits.maxBytes)
    return {
      packages: [],
      rejected: Array.isArray(raw) ? raw.length : 1,
      truncated: bytes > limits.maxBytes,
    };
  const out: ServicePackage[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const r of raw.slice(0, limits.maxRecords)) {
    const p = ServicePackageSchema.safeParse(r);
    if (!p.success || seen.has(p.data.packageId)) {
      rejected++;
      continue;
    }
    seen.add(p.data.packageId);
    out.push(p.data);
  }
  return {
    packages: out,
    rejected: rejected + Math.max(0, raw.length - limits.maxRecords),
    truncated: raw.length > limits.maxRecords,
  };
}

export const ServiceNeedSchema = z
  .object({
    category: z.enum(SERVICE_CATEGORIES),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    /** The most the owner will pay for one package. */
    maxPriceMinor: z.number().int().safe().min(1).max(1_000_000_000_000),
    maxDeliveryDays: z.number().int().min(1).max(3650),
    minRevisions: z.number().int().min(0).max(100).default(0),
    /** Least share of the price that must come back if the owner cancels before work starts. */
    minRefundBeforeStartBps: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type ServiceNeed = z.infer<typeof ServiceNeedSchema>;

export type ServiceProblem =
  | "WRONG_CATEGORY"
  | "WRONG_CURRENCY"
  | "PRICE_UNKNOWN"
  | "ABOVE_PRICE_LIMIT"
  | "DELIVERY_UNKNOWN"
  | "TOO_SLOW"
  | "REVISIONS_UNKNOWN"
  | "TOO_FEW_REVISIONS"
  | "REFUND_TERMS_UNKNOWN"
  | "REFUND_TOO_SMALL";

export interface ServiceAssessment {
  readonly packageId: string;
  /** What the owner would owe if they buy it. `null` when the price is unstated. */
  readonly priceMinor: number | null;
  /** Most that stays at risk once work has started: the whole price. `null` when unknown. */
  readonly atRiskOnceStartedMinor: number | null;
  /** What could be lost by cancelling before work starts. `null` when the price or refund terms are unknown. */
  readonly lostIfCancelledBeforeStartMinor: number | null;
  readonly problems: readonly ServiceProblem[];
  readonly qualified: boolean;
}

export function assessPackage(
  p: ServicePackage,
  need: ServiceNeed,
): ServiceAssessment {
  const problems: ServiceProblem[] = [];
  if (p.category !== need.category) problems.push("WRONG_CATEGORY");
  if (p.currency !== need.currency) problems.push("WRONG_CURRENCY");
  if (p.priceMinor === null) problems.push("PRICE_UNKNOWN");
  else if (p.priceMinor > need.maxPriceMinor)
    problems.push("ABOVE_PRICE_LIMIT");
  if (p.deliveryDays === null) problems.push("DELIVERY_UNKNOWN");
  else if (p.deliveryDays > need.maxDeliveryDays) problems.push("TOO_SLOW");
  if (p.revisionsIncluded === null) problems.push("REVISIONS_UNKNOWN");
  else if (p.revisionsIncluded < need.minRevisions)
    problems.push("TOO_FEW_REVISIONS");
  if (p.refundBeforeStartBps === null) problems.push("REFUND_TERMS_UNKNOWN");
  else if (p.refundBeforeStartBps < need.minRefundBeforeStartBps)
    problems.push("REFUND_TOO_SMALL");
  const lost =
    p.priceMinor === null || p.refundBeforeStartBps === null
      ? null
      : p.priceMinor -
        Math.floor((p.priceMinor * p.refundBeforeStartBps) / 10_000);
  return {
    packageId: p.packageId,
    priceMinor: p.priceMinor,
    atRiskOnceStartedMinor: p.priceMinor,
    lostIfCancelledBeforeStartMinor: lost,
    problems,
    qualified: problems.length === 0,
  };
}

/** Qualified first, cheapest first; the rest by fewest problems. Deterministic; an unknown price never sorts as cheap. */
export function rankPackages(
  a: readonly ServiceAssessment[],
): ServiceAssessment[] {
  return [...a].sort((x, y) => {
    if (x.qualified !== y.qualified) return x.qualified ? -1 : 1;
    if (x.qualified)
      return (
        (x.priceMinor ?? Infinity) - (y.priceMinor ?? Infinity) ||
        (x.packageId < y.packageId ? -1 : 1)
      );
    return (
      x.problems.length - y.problems.length ||
      (x.packageId < y.packageId ? -1 : 1)
    );
  });
}
