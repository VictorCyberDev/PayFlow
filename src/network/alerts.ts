import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";

/**
 * M14 operational alerts, persisted. This is an INTERNAL alert model: detection, severity, dedupe,
 * acknowledgement and resolution live in PostgreSQL. External paging (e-mail, chat, a pager) is a
 * delivery channel that is NOT configured here; `undelivered()` is the hand-off point for one.
 *
 *   P0  suspected unauthorized/duplicate economic effect, integrity failure, invariant violation
 *   P1  UNKNOWN too old, reconciliation backlog, repeated provider failure
 *   P2  degraded or restricted but not economic (e.g. an execution pause is active)
 */
export type Severity = "P0" | "P1" | "P2";

export interface AlertInput {
  readonly severity: Severity;
  readonly code: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly organizationId?: string | null;
  /** Identifiers and counts only. Never secrets or payloads. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AlertRecord extends AlertInput {
  readonly alertId: string;
  readonly state: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface AlertThresholds {
  readonly unknownMaxAgeSeconds: number;
  readonly backlogMax: number;
  readonly consecutiveProviderErrors: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = Object.freeze({
  unknownMaxAgeSeconds: 3600,
  backlogMax: 25,
  consecutiveProviderErrors: 3,
});

const FORBIDDEN = /secret|token|password|private|authorization|bearer|key/i;
const iso = (v: unknown) => new Date(v as string).toISOString();

const toRecord = (r: Record<string, unknown>): AlertRecord => ({
  alertId: String(r.alert_id),
  severity: r.severity as Severity,
  code: String(r.code),
  subjectKind: String(r.subject_kind),
  subjectId: String(r.subject_id),
  organizationId:
    typeof r.organization_id === "string" ? r.organization_id : null,
  detail: r.detail as AlertRecord["detail"] & object,
  state: r.state as AlertRecord["state"],
  occurrences: Number(r.occurrences),
  firstSeenAt: iso(r.first_seen_at),
  lastSeenAt: iso(r.last_seen_at),
});

export class AlertEngine {
  constructor(private readonly sql: Sql) {}

  /** Opens an alert, or increments the open one with the same dedupe key. */
  async raise(
    input: AlertInput,
    now: string,
  ): Promise<{ alertId: string; created: boolean }> {
    for (const key of Object.keys(input.detail ?? {}))
      if (FORBIDDEN.test(key)) throw new Error("ALERT_DETAIL_FORBIDDEN_KEY");
    const dedupe = `${input.code}:${input.subjectKind}:${input.subjectId}`;
    const alertId = `alr_${randomBytes(12).toString("hex")}`;
    const rows = await this.sql`
      insert into operational_alerts
        (alert_id, severity, code, subject_kind, subject_id, organization_id, detail, dedupe_key,
         state, occurrences, first_seen_at, last_seen_at)
      values (${alertId}, ${input.severity}, ${input.code}, ${input.subjectKind}, ${input.subjectId},
        ${input.organizationId ?? null}, ${this.sql.json(input.detail ?? {})}, ${dedupe}, 'OPEN', 1, ${now}, ${now})
      on conflict (dedupe_key) where state <> 'RESOLVED'
      do update set occurrences = operational_alerts.occurrences + 1, last_seen_at = excluded.last_seen_at,
                    detail = excluded.detail
      returning alert_id, (xmax = 0) as created`;
    return {
      alertId: String(rows[0]!.alert_id),
      created: Boolean(rows[0]!.created),
    };
  }

  async list(
    filter: { state?: AlertRecord["state"]; severity?: Severity } = {},
    limit = 200,
  ): Promise<readonly AlertRecord[]> {
    const rows = await this.sql`
      select * from operational_alerts
      where (${filter.state ?? null}::text is null or state = ${filter.state ?? null})
        and (${filter.severity ?? null}::text is null or severity = ${filter.severity ?? null})
      order by case severity when 'P0' then 0 when 'P1' then 1 else 2 end, last_seen_at desc
      limit ${Math.min(Math.max(limit, 1), 500)}`;
    return rows.map(toRecord);
  }

  async acknowledge(
    alertId: string,
    by: string,
    now: string,
  ): Promise<boolean> {
    const rows = await this.sql`
      update operational_alerts set state = 'ACKNOWLEDGED', acknowledged_by = ${by}, last_seen_at = ${now}
      where alert_id = ${alertId} and state = 'OPEN' returning alert_id`;
    return rows.length === 1;
  }

  /** Resolves the open alert for a subject, if any (recovery). Returns whether one was resolved. */
  async resolveSubject(
    code: string,
    subjectKind: string,
    subjectId: string,
    now: string,
  ): Promise<boolean> {
    const rows = await this.sql`
      update operational_alerts set state = 'RESOLVED', last_seen_at = ${now}
      where dedupe_key = ${`${code}:${subjectKind}:${subjectId}`} and state <> 'RESOLVED'
      returning alert_id`;
    return rows.length > 0;
  }

  async resolve(alertId: string, now: string): Promise<boolean> {
    const rows = await this.sql`
      update operational_alerts set state = 'RESOLVED', resolved_at = ${now}
      where alert_id = ${alertId} and state <> 'RESOLVED' returning alert_id`;
    return rows.length === 1;
  }

  /**
   * Delivers every undelivered OPEN alert to one webhook (a generic JSON POST; the `text` and `content`
   * fields make it work as a Slack or Discord incoming webhook). An alert is marked delivered only on
   * a 2xx. A failure never throws, never loses the alert, and is retried on the next tick. Payloads
   * contain identifiers and counts only, because alert details are already refused secret-looking keys.
   */
  async deliver(
    webhookUrl: string,
    send: (url: string, init: RequestInit) => Promise<{ ok: boolean }>,
    now: string,
    timeoutMs = 5000,
  ): Promise<{ attempted: number; delivered: number; failed: number }> {
    const result = { attempted: 0, delivered: 0, failed: 0 };
    for (const a of await this.undelivered()) {
      result.attempted++;
      const text = `[${a.severity}] ${a.code} ${a.subjectKind} ${a.subjectId} (x${a.occurrences})`;
      try {
        const res = await send(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "payflow",
            alertId: a.alertId,
            severity: a.severity,
            code: a.code,
            subjectKind: a.subjectKind,
            subjectId: a.subjectId,
            organizationId: a.organizationId ?? null,
            occurrences: a.occurrences,
            firstSeenAt: a.firstSeenAt,
            lastSeenAt: a.lastSeenAt,
            detail: a.detail ?? {},
            text,
            content: text,
          }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        if (res.ok) {
          await this.markDelivered(a.alertId, now);
          result.delivered++;
        } else result.failed++;
      } catch {
        result.failed++;
      }
    }
    return result;
  }

  /** Hand-off for an external channel. Marks nothing; call `markDelivered` after a real send. */
  async undelivered(): Promise<readonly AlertRecord[]> {
    const rows = await this
      .sql`select * from operational_alerts where delivered_at is null and state = 'OPEN' order by first_seen_at`;
    return rows.map(toRecord);
  }

  async markDelivered(alertId: string, now: string): Promise<void> {
    await this
      .sql`update operational_alerts set delivered_at = ${now} where alert_id = ${alertId}`;
  }

  /**
   * Evaluates the detection rules against the database and raises/resolves alerts. P0 alerts are
   * never auto-resolved: a person has to look at them.
   */
  async evaluate(
    now: string,
    thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
  ): Promise<{ raised: readonly string[]; autoResolved: number }> {
    const raised: string[] = [];
    const firing = new Set<string>();
    const fire = async (input: AlertInput) => {
      firing.add(`${input.code}:${input.subjectKind}:${input.subjectId}`);
      await this.raise(input, now);
      raised.push(input.code);
    };

    // P0: more than one captured effect for one proposal.
    for (const r of await this.sql`
      select proposal_id, count(*)::int n from payment_attempts
      where status = 'CAPTURED' group by proposal_id having count(*) > 1`)
      await fire({
        severity: "P0",
        code: "DUPLICATE_ECONOMIC_EFFECT",
        subjectKind: "PROPOSAL",
        subjectId: String(r.proposal_id),
        detail: { captures: Number(r.n) },
      });

    // P0: captured money exceeds the Authority's cumulative limit.
    for (const r of await this.sql`
      select a.mandate_id, sum(a.amount_minor)::bigint captured, m.cumulative_limit_minor lim
      from payment_attempts a join mandates m on m.id = a.mandate_id
      where a.status = 'CAPTURED'
      group by a.mandate_id, m.cumulative_limit_minor
      having sum(a.amount_minor) > m.cumulative_limit_minor`)
      await fire({
        severity: "P0",
        code: "CUMULATIVE_LIMIT_EXCEEDED",
        subjectKind: "AUTHORITY",
        subjectId: String(r.mandate_id),
        detail: {
          capturedMinor: Number(r.captured),
          limitMinor: Number(r.lim),
        },
      });

    // P1: UNKNOWN older than the threshold.
    for (const r of await this.sql`
      select attempt_id, organization_id,
             extract(epoch from (${now}::timestamptz - opened_at))::bigint age
      from reconciliation_lookups
      where resolved_at is null
        and extract(epoch from (${now}::timestamptz - opened_at)) > ${thresholds.unknownMaxAgeSeconds}`)
      await fire({
        severity: "P1",
        code: "UNKNOWN_TOO_OLD",
        subjectKind: "ATTEMPT",
        subjectId: String(r.attempt_id),
        organizationId: String(r.organization_id),
        detail: { ageSeconds: Number(r.age) },
      });

    // P1: backlog.
    const backlog = await this
      .sql`select count(*)::int n from reconciliation_lookups where resolved_at is null`;
    if (Number(backlog[0]!.n) > thresholds.backlogMax)
      await fire({
        severity: "P1",
        code: "RECONCILIATION_BACKLOG",
        subjectKind: "QUEUE",
        subjectId: "reconciliation",
        detail: { unresolved: Number(backlog[0]!.n) },
      });

    // P1: the provider keeps failing the lookup.
    for (const r of await this.sql`
      select attempt_id, organization_id, consecutive_errors from reconciliation_lookups
      where resolved_at is null and consecutive_errors >= ${thresholds.consecutiveProviderErrors}`)
      await fire({
        severity: "P1",
        code: "REPEATED_PROVIDER_FAILURE",
        subjectKind: "ATTEMPT",
        subjectId: String(r.attempt_id),
        organizationId: String(r.organization_id),
        detail: { consecutiveErrors: Number(r.consecutive_errors) },
      });

    // P2: an execution pause is in force (expected during an incident, but it must be visible).
    for (const r of await this
      .sql`select scope from execution_controls where disabled`)
      await fire({
        severity: "P2",
        code: "EXECUTION_PAUSED",
        subjectKind: "SCOPE",
        subjectId: String(r.scope),
      });

    // Auto-resolve non-P0 alerts whose condition no longer holds.
    let autoResolved = 0;
    for (const open of await this.sql`
      select alert_id, dedupe_key from operational_alerts
      where state <> 'RESOLVED' and severity <> 'P0'`)
      if (!firing.has(String(open.dedupe_key)))
        if (await this.resolve(String(open.alert_id), now)) autoResolved++;
    return { raised, autoResolved };
  }
}
