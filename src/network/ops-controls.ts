import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { RateLimitDecision, RateLimitStore } from "./reliability.js";

export type Environment = "SANDBOX" | "PRODUCTION";

/**
 * Fixed-window counters in PostgreSQL, so the limit holds across serverless instances. A request
 * is counted before it is processed; the limit protects PayFlow, it never changes a decision.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly sql: Sql) {}
  async consume(
    bucket: string,
    keyHash: string,
    limit: number,
    windowSeconds: number,
    now: string,
  ): Promise<RateLimitDecision> {
    const t = Date.parse(now);
    const start = new Date(
      Math.floor(t / (windowSeconds * 1000)) * windowSeconds * 1000,
    ).toISOString();
    const rows = await this.sql`
      insert into rate_limit_windows (bucket, key_hash, window_start, request_count)
      values (${bucket}, ${keyHash}, ${start}, 1)
      on conflict (bucket, key_hash, window_start)
      do update set request_count = rate_limit_windows.request_count + 1
      returning request_count`;
    const count = Number(rows[0]!.request_count);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(Date.parse(start) + windowSeconds * 1000).toISOString(),
    };
  }
  /** Housekeeping. Old windows carry no information anyone needs. */
  async prune(olderThan: string): Promise<number> {
    const r = await this
      .sql`delete from rate_limit_windows where window_start < ${olderThan} returning 1`;
    return r.length;
  }
}

export const hashSubject = (subject: string): string =>
  createHash("sha256").update(subject, "utf8").digest("hex");

/**
 * Operator execution pauses. Reads and Proof stay available; only NEW economic requests are
 * refused. Written by operators (SQL runbook), never by a public endpoint.
 */
export class ExecutionControls {
  constructor(private readonly sql: Sql) {}
  async pausedReason(
    organizationId: string,
    environment: Environment,
  ): Promise<string | null> {
    const rows = await this.sql`
      select scope, reason from execution_controls
      where disabled and scope in ('GLOBAL', ${"ENV:" + environment}, ${"ORG:" + organizationId})
      order by case scope when 'GLOBAL' then 0 when ${"ENV:" + environment} then 1 else 2 end
      limit 1`;
    return rows[0] ? String(rows[0].scope) : null;
  }
}

export interface AuditEvent {
  readonly organizationId: string;
  readonly environment: Environment;
  readonly actorKind: "ADMIN" | "AGENT_CREDENTIAL" | "SYSTEM" | "OPERATOR";
  readonly actorId: string;
  readonly action: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  /** Identifiers and outcomes only. Never secrets or request payloads. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: string;
}

const FORBIDDEN_DETAIL = /secret|token|password|private|authorization|bearer/i;

export class AuditLog {
  constructor(private readonly sql: Sql) {}
  async append(event: AuditEvent): Promise<void> {
    for (const key of Object.keys(event.detail ?? {}))
      if (FORBIDDEN_DETAIL.test(key))
        throw new Error("AUDIT_DETAIL_FORBIDDEN_KEY");
    await this.sql`
      insert into organization_audit_events
        (organization_id, environment, actor_kind, actor_id, action, subject_kind, subject_id, detail, occurred_at)
      values (${event.organizationId}, ${event.environment}, ${event.actorKind}, ${event.actorId},
        ${event.action}, ${event.subjectKind}, ${event.subjectId}, ${this.sql.json(event.detail ?? {})}, ${event.occurredAt})`;
  }
  async list(
    organizationId: string,
    environment: Environment,
    limit = 100,
  ): Promise<readonly AuditEvent[]> {
    const rows = await this.sql`
      select organization_id, environment, actor_kind, actor_id, action, subject_kind, subject_id, detail, occurred_at
      from organization_audit_events
      where organization_id = ${organizationId} and environment = ${environment}
      order by sequence desc limit ${Math.min(Math.max(limit, 1), 500)}`;
    return rows.map((r) => ({
      organizationId: String(r.organization_id),
      environment: r.environment as Environment,
      actorKind: r.actor_kind as AuditEvent["actorKind"],
      actorId: String(r.actor_id),
      action: String(r.action),
      subjectKind: String(r.subject_kind),
      subjectId: String(r.subject_id),
      detail: r.detail as AuditEvent["detail"] & object,
      occurredAt: new Date(r.occurred_at as string).toISOString(),
    }));
  }
}
