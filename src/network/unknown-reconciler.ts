import type { Sql } from "postgres";
import type { PaymentProvider, PayPalOrderView } from "../paypal.js";
import { retryDelayMs } from "./reliability.js";

/**
 * M14 scheduled UNKNOWN reconciliation. OBSERVATION ONLY.
 *
 *   UNKNOWN attempt -> LOOKUP_PENDING -> (read-only provider GET) -> PROVIDER_CAPTURED
 *                                                                  | PROVIDER_FAILED
 *                                                                  | STILL_UNKNOWN (retry, backoff)
 *                                       -> NO_PROVIDER_REF        (nothing to look up; never recreate)
 *
 * This class takes `Pick<PaymentProvider, "getOrder">`. It has no handle on createOrder or
 * captureOrder, so it cannot create or repeat a provider effect. It also never writes to
 * `payment_attempts`: the observation is persisted in `reconciliation_lookups`. Finalizing the
 * attempt remains the job of the M6-accepted resume path.
 */
export type LookupProvider = Pick<PaymentProvider, "getOrder">;

export const UNKNOWN_STATES = [
  "ORDER_CREATE_UNKNOWN",
  "CAPTURE_UNKNOWN",
  "CAPTURE_PENDING_PROVIDER",
  "ORDER_CREATING",
  "CAPTURE_PENDING",
  "CAPTURE_IN_FLIGHT",
] as const;

export interface ReconcilerOptions {
  readonly batch?: number;
  readonly leaseSeconds?: number;
  readonly baseDelaySeconds?: number;
  readonly maxDelaySeconds?: number;
}

export type TickSummary = {
  readonly enrolled: number;
  readonly examined: number;
  readonly capturedAtProvider: number;
  readonly failedAtProvider: number;
  readonly stillUnknown: number;
  readonly noProviderRef: number;
  readonly lookupErrors: number;
};

/** Reads the provider's own words. A capture is "COMPLETED"; a voided order or declined capture is a failure. */
export function interpretOrder(
  order: PayPalOrderView,
): "CAPTURED" | "FAILED" | "UNKNOWN" {
  if (order.captures.some((c) => c.status === "COMPLETED")) return "CAPTURED";
  if (order.status === "VOIDED") return "FAILED";
  if (
    order.captures.length > 0 &&
    order.captures.every(
      (c) => c.status === "DECLINED" || c.status === "FAILED",
    )
  )
    return "FAILED";
  return "UNKNOWN";
}

const safeError = (e: unknown): string =>
  (e instanceof Error ? e.name : "ERROR")
    .replace(/[^A-Za-z0-9_.-]/gu, "")
    .slice(0, 80) || "ERROR";

export class UnknownReconciler {
  constructor(
    private readonly sql: Sql,
    private readonly providerFor: (organizationId: string) => LookupProvider,
    private readonly options: ReconcilerOptions = {},
  ) {}

  async tick(now: string): Promise<TickSummary> {
    const sql = this.sql;
    const batch = this.options.batch ?? 25;
    const lease = this.options.leaseSeconds ?? 60;
    const base = this.options.baseDelaySeconds ?? 60;
    const max = this.options.maxDelaySeconds ?? 3600;
    const backoff = (n: number) =>
      new Date(
        Date.parse(now) + retryDelayMs(n, base * 1000, max * 1000),
      ).toISOString();

    // 1. Enroll unresolved attempts (idempotent) and close ones the normal path already settled.
    const enrolled = await sql`
      insert into reconciliation_lookups
        (attempt_id, organization_id, environment, provider, provider_ref, state, next_lookup_at, opened_at)
      select a.id, o.organization_id, o.environment, a.provider, a.provider_order_id, 'LOOKUP_PENDING', ${now}, ${now}
      from payment_attempts a
      join authority_ownership o on o.mandate_id = a.mandate_id
      where a.status = any(${[...UNKNOWN_STATES]})
      on conflict (attempt_id) do nothing
      returning attempt_id`;
    await sql`
      update reconciliation_lookups l set state = 'PROVIDER_CAPTURED', resolved_at = ${now},
             last_result = 'ATTEMPT_SETTLED_ELSEWHERE'
      from payment_attempts a
      where a.id = l.attempt_id and l.resolved_at is null and a.status = 'CAPTURED'`;
    await sql`
      update reconciliation_lookups l set state = 'PROVIDER_FAILED', resolved_at = ${now},
             last_result = 'ATTEMPT_SETTLED_ELSEWHERE'
      from payment_attempts a
      where a.id = l.attempt_id and l.resolved_at is null and a.status in ('FAILED','CANCELLED')`;

    // 2. Claim due rows. SKIP LOCKED + a lease keeps two workers off the same attempt.
    const due = await sql`
      update reconciliation_lookups set next_lookup_at = ${new Date(Date.parse(now) + lease * 1000).toISOString()}
      where attempt_id in (
        select attempt_id from reconciliation_lookups
        where resolved_at is null and next_lookup_at <= ${now}
        order by next_lookup_at limit ${batch} for update skip locked)
      returning attempt_id, organization_id, retry_count`;

    const summary = {
      enrolled: enrolled.length,
      examined: due.length,
      capturedAtProvider: 0,
      failedAtProvider: 0,
      stillUnknown: 0,
      noProviderRef: 0,
      lookupErrors: 0,
    };
    for (const row of due) {
      const attemptId = String(row.attempt_id);
      const retry = Number(row.retry_count);
      const att =
        await sql`select provider_order_id from payment_attempts where id = ${attemptId}`;
      const ref = att[0]?.provider_order_id
        ? String(att[0].provider_order_id)
        : null;
      if (!ref) {
        // No provider reference: there is nothing to look up and recreating an order is not
        // reconciliation. It stays UNKNOWN and ages until a person or the alert rules act.
        summary.noProviderRef++;
        await sql`update reconciliation_lookups set state = 'NO_PROVIDER_REF', retry_count = retry_count + 1,
          lookups_total = lookups_total + 1, last_lookup_at = ${now}, last_result = 'NO_PROVIDER_REF',
          next_lookup_at = ${backoff(retry + 1)} where attempt_id = ${attemptId}`;
        continue;
      }
      let verdict: "CAPTURED" | "FAILED" | "UNKNOWN";
      try {
        verdict = interpretOrder(
          await this.providerFor(String(row.organization_id)).getOrder(ref),
        );
      } catch (error) {
        summary.lookupErrors++;
        await sql`update reconciliation_lookups set retry_count = retry_count + 1,
          consecutive_errors = consecutive_errors + 1, lookup_errors_total = lookup_errors_total + 1,
          lookups_total = lookups_total + 1, last_lookup_at = ${now}, last_error = ${safeError(error)},
          last_result = 'LOOKUP_ERROR', provider_ref = ${ref}, next_lookup_at = ${backoff(retry + 1)}
          where attempt_id = ${attemptId}`;
        continue;
      }
      if (verdict === "UNKNOWN") {
        summary.stillUnknown++;
        await sql`update reconciliation_lookups set state = 'STILL_UNKNOWN', retry_count = retry_count + 1,
          consecutive_errors = 0, lookups_total = lookups_total + 1, last_lookup_at = ${now},
          last_error = null, last_result = 'STILL_UNKNOWN', provider_ref = ${ref},
          next_lookup_at = ${backoff(retry + 1)} where attempt_id = ${attemptId}`;
        continue;
      }
      const state =
        verdict === "CAPTURED" ? "PROVIDER_CAPTURED" : "PROVIDER_FAILED";
      if (verdict === "CAPTURED") summary.capturedAtProvider++;
      else summary.failedAtProvider++;
      await sql`update reconciliation_lookups set state = ${state}, consecutive_errors = 0,
        lookups_total = lookups_total + 1, last_lookup_at = ${now}, last_error = null,
        last_result = ${"PROVIDER_" + verdict}, provider_ref = ${ref}, resolved_at = ${now}
        where attempt_id = ${attemptId}`;
    }
    return summary;
  }
}

export interface ReconciliationMetrics {
  readonly backlog: number;
  readonly oldestUnresolvedAgeSeconds: number | null;
  readonly ageBuckets: {
    readonly under5m: number;
    readonly under1h: number;
    readonly under24h: number;
    readonly over24h: number;
  };
  readonly stillUnknown: number;
  readonly noProviderRef: number;
  /** lookup errors / lookups, or null when no lookup has run. */
  readonly lookupFailureRate: number | null;
  /** resolved / ever enrolled, or null when nothing was enrolled. */
  readonly resolutionRate: number | null;
}

export async function reconciliationMetrics(
  sql: Sql,
  now: string,
  organizationId?: string,
): Promise<ReconciliationMetrics> {
  const org = organizationId ?? null;
  const r = (
    await sql`
    select
      count(*) filter (where resolved_at is null)::int backlog,
      max(extract(epoch from (${now}::timestamptz - opened_at))) filter (where resolved_at is null) oldest,
      count(*) filter (where resolved_at is null and ${now}::timestamptz - opened_at < interval '5 minutes')::int u5,
      count(*) filter (where resolved_at is null and ${now}::timestamptz - opened_at >= interval '5 minutes'
                         and ${now}::timestamptz - opened_at < interval '1 hour')::int u1h,
      count(*) filter (where resolved_at is null and ${now}::timestamptz - opened_at >= interval '1 hour'
                         and ${now}::timestamptz - opened_at < interval '24 hours')::int u24,
      count(*) filter (where resolved_at is null and ${now}::timestamptz - opened_at >= interval '24 hours')::int o24,
      count(*) filter (where state = 'STILL_UNKNOWN')::int still,
      count(*) filter (where state = 'NO_PROVIDER_REF')::int noref,
      coalesce(sum(lookup_errors_total), 0)::int errs,
      coalesce(sum(lookups_total), 0)::int looks,
      count(*) filter (where resolved_at is not null)::int resolved,
      count(*)::int total
    from reconciliation_lookups where (${org}::text is null or organization_id = ${org})`
  )[0]!;
  return {
    backlog: Number(r.backlog),
    oldestUnresolvedAgeSeconds:
      r.oldest === null ? null : Math.floor(Number(r.oldest)),
    ageBuckets: {
      under5m: Number(r.u5),
      under1h: Number(r.u1h),
      under24h: Number(r.u24),
      over24h: Number(r.o24),
    },
    stillUnknown: Number(r.still),
    noProviderRef: Number(r.noref),
    lookupFailureRate:
      Number(r.looks) === 0 ? null : Number(r.errs) / Number(r.looks),
    resolutionRate:
      Number(r.total) === 0 ? null : Number(r.resolved) / Number(r.total),
  };
}
