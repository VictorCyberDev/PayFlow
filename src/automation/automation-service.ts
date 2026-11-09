import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";

/**
 * V3 M56/M57 — durable automation and recurring schedules.
 *
 * Work survives restarts because it lives in PostgreSQL. Two workers never run the same job: a job is claimed under a row lock with
 * SKIP LOCKED and a lease. A lease that expires means the worker is lost, and what happens next depends on what the job could have done:
 *   - effect NONE (reads, or idempotent): re-queued, up to max attempts, then FAILED;
 *   - effect EXTERNAL (it may already have acted outside PayFlow): UNKNOWN. It is never re-queued; a person settles it.
 * A handler that throws is treated the same way, because "it threw" does not prove "it did nothing".
 */
export type JobEffect = "NONE" | "EXTERNAL";
export type JobState =
  "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED";
export interface JobTenant {
  organizationId: string;
  environment: "SANDBOX" | "PRODUCTION";
}
export interface Job extends JobTenant {
  jobId: string;
  kind: string;
  effect: JobEffect;
  payload: Record<string, unknown>;
  /** For a job made by a schedule this ends in `@<slot time>`. */
  dedupeKey: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  note: string | null;
}
/** What a handler reports. `retryInSeconds` is honoured only for effect NONE; for EXTERNAL it is ignored (a retry would be a second effect). */
export type HandlerResult =
  | { outcome: "SUCCEEDED"; note?: string }
  | { outcome: "FAILED"; note?: string }
  | { outcome: "RETRY"; retryInSeconds: number; note?: string };
export type Handler = (job: Job) => Promise<HandlerResult>;

const iso = (v: unknown) => new Date(v as string).toISOString();
const clip = (s: string | undefined) => (s ? s.slice(0, 300) : null);
const BACKOFF_CAP_SECONDS = 3600;

export class AutomationService {
  constructor(
    private readonly deps: { sql: Sql; now: () => string },
    private readonly leaseSeconds = 60,
  ) {}

  private view(r: Record<string, unknown>): Job {
    return {
      jobId: String(r.job_id),
      organizationId: String(r.organization_id),
      environment: r.environment as JobTenant["environment"],
      kind: String(r.kind),
      effect: r.effect as JobEffect,
      payload: r.payload as Record<string, unknown>,
      dedupeKey: String(r.dedupe_key),
      state: r.state as JobState,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      runAfter: iso(r.run_after),
      note: (r.last_note as string | null) ?? null,
    };
  }

  /** Enqueue once per (tenant, kind, dedupe key). A repeat returns the existing job and creates nothing. */
  async enqueue(
    t: JobTenant,
    o: {
      kind: string;
      effect: JobEffect;
      payload?: Record<string, unknown>;
      dedupeKey: string;
      runAfter?: string;
      maxAttempts?: number;
    },
  ): Promise<{ job: Job; created: boolean }> {
    const now = this.deps.now();
    const id = `job_${randomBytes(12).toString("hex")}`;
    const [ins] = await this.deps.sql`insert into automation_jobs
      (job_id, organization_id, environment, kind, effect, payload, dedupe_key, state, run_after, max_attempts, created_at, updated_at)
      values (${id}, ${t.organizationId}, ${t.environment}, ${o.kind}, ${o.effect}, ${this.deps.sql.json((o.payload ?? {}) as never)}, ${o.dedupeKey},
        'QUEUED', ${o.runAfter ?? now}, ${o.effect === "EXTERNAL" ? 1 : (o.maxAttempts ?? 5)}, ${now}, ${now})
      on conflict (organization_id, environment, kind, dedupe_key) do nothing returning *`;
    if (ins) return { job: this.view(ins), created: true };
    const [cur] = await this.deps
      .sql`select * from automation_jobs where organization_id = ${t.organizationId} and environment = ${t.environment}
      and kind = ${o.kind} and dedupe_key = ${o.dedupeKey}`;
    return { job: this.view(cur!), created: false };
  }

  /**
   * Put expired leases right. NONE jobs go back to the queue (or FAILED when out of attempts); EXTERNAL jobs become UNKNOWN.
   * Returns what it did, so an operator can see it.
   */
  async reapExpired(): Promise<{
    requeued: number;
    failed: number;
    unknown: number;
  }> {
    const now = this.deps.now();
    const out = { requeued: 0, failed: 0, unknown: 0 };
    await this.deps.sql.begin(async (tx) => {
      const rows =
        await tx`select * from automation_jobs where state = 'RUNNING' and lease_expires_at <= ${now} for update skip locked`;
      for (const r of rows) {
        const id = String(r.job_id);
        if (r.effect === "EXTERNAL") {
          await tx`update automation_jobs set state = 'UNKNOWN', lease_owner = null, lease_expires_at = null,
            last_note = 'the worker was lost; PayFlow cannot tell whether it acted', updated_at = ${now} where job_id = ${id}`;
          out.unknown++;
        } else if (Number(r.attempts) >= Number(r.max_attempts)) {
          await tx`update automation_jobs set state = 'FAILED', lease_owner = null, lease_expires_at = null,
            last_note = 'out of attempts', updated_at = ${now} where job_id = ${id}`;
          out.failed++;
        } else {
          await tx`update automation_jobs set state = 'QUEUED', lease_owner = null, lease_expires_at = null, updated_at = ${now} where job_id = ${id}`;
          out.requeued++;
        }
      }
    });
    return out;
  }

  /** Claim up to `limit` due jobs for `worker`. Concurrent claimers never receive the same job. */
  async claim(worker: string, limit = 5): Promise<Job[]> {
    const now = this.deps.now();
    const expires = new Date(
      Date.parse(now) + this.leaseSeconds * 1000,
    ).toISOString();
    const rows = await this.deps
      .sql`update automation_jobs set state = 'RUNNING', attempts = attempts + 1, lease_owner = ${worker},
        lease_expires_at = ${expires}, updated_at = ${now}
      where job_id in (select job_id from automation_jobs where state = 'QUEUED' and run_after <= ${now}
        order by run_after, job_id limit ${limit} for update skip locked) returning *`;
    return rows.map((r) => this.view(r));
  }

  /** Record how a claimed job ended. Only the worker holding the lease may; anyone else is refused. */
  async finish(
    job: Job,
    worker: string,
    result: HandlerResult | { outcome: "THREW" },
  ): Promise<boolean> {
    const now = this.deps.now();
    const note = "note" in result ? clip(result.note) : null;
    let next: { state: JobState; runAfter?: string };
    if (result.outcome === "SUCCEEDED") next = { state: "SUCCEEDED" };
    else if (result.outcome === "FAILED") next = { state: "FAILED" };
    else if (result.outcome === "THREW" && job.effect === "EXTERNAL")
      next = { state: "UNKNOWN" };
    else if (job.effect === "EXTERNAL")
      next = { state: "UNKNOWN" }; // a RETRY request from an effectful job is itself an unclear outcome
    else if (job.attempts >= job.maxAttempts) next = { state: "FAILED" };
    else {
      const wait = Math.min(
        BACKOFF_CAP_SECONDS,
        result.outcome === "RETRY"
          ? Math.max(1, result.retryInSeconds)
          : 2 ** job.attempts,
      );
      next = {
        state: "QUEUED",
        runAfter: new Date(Date.parse(now) + wait * 1000).toISOString(),
      };
    }
    const rows = await this.deps
      .sql`update automation_jobs set state = ${next.state},
        run_after = coalesce(${next.runAfter ?? null}::timestamptz, run_after),
        lease_owner = null, lease_expires_at = null, last_note = ${note}, updated_at = ${now}
      where job_id = ${job.jobId} and state = 'RUNNING' and lease_owner = ${worker} returning job_id`;
    return rows.length === 1;
  }

  /** Claim and run due jobs once. A kind with no handler FAILS (it never sits forever or runs as something else). */
  async runOnce(
    worker: string,
    handlers: Readonly<Record<string, Handler>>,
    limit = 5,
  ): Promise<{ ran: number }> {
    await this.reapExpired();
    const jobs = await this.claim(worker, limit);
    for (const j of jobs) {
      const h = handlers[j.kind];
      if (!h) {
        await this.finish(j, worker, {
          outcome: "FAILED",
          note: "no handler for this kind of job",
        });
        continue;
      }
      let r: HandlerResult | { outcome: "THREW" };
      try {
        r = await h(j);
      } catch {
        r = { outcome: "THREW" };
      }
      await this.finish(j, worker, r);
    }
    return { ran: jobs.length };
  }

  /** A person settles a job whose outcome was unclear, with what they know. This is the only way out of UNKNOWN. */
  async settle(
    t: JobTenant,
    jobId: string,
    outcome: "SUCCEEDED" | "FAILED",
    actor: string,
    note: string,
  ): Promise<boolean> {
    const rows = await this.deps
      .sql`update automation_jobs set state = ${outcome}, settled_by = ${actor},
        last_note = ${note.slice(0, 300)}, updated_at = ${this.deps.now()}
      where job_id = ${jobId} and organization_id = ${t.organizationId} and environment = ${t.environment} and state = 'UNKNOWN' returning job_id`;
    return rows.length === 1;
  }

  async list(t: JobTenant, limit = 50): Promise<Job[]> {
    const rows = await this.deps
      .sql`select * from automation_jobs where organization_id = ${t.organizationId} and environment = ${t.environment}
      order by created_at desc, job_id limit ${limit}`;
    return rows.map((r) => this.view(r));
  }

  // -------------------------------------------------------------------------------------------- recurring schedules (M57)
  async createSchedule(
    t: JobTenant,
    o: {
      kind: string;
      effect: JobEffect;
      payload?: Record<string, unknown>;
      everySeconds: number;
      firstSlot?: string;
      createdBy: string;
    },
  ): Promise<string> {
    const now = this.deps.now();
    const id = `sch_${randomBytes(12).toString("hex")}`;
    await this.deps.sql`insert into automation_schedules
      (schedule_id, organization_id, environment, kind, effect, payload, every_seconds, next_slot, created_by, created_at)
      values (${id}, ${t.organizationId}, ${t.environment}, ${o.kind}, ${o.effect}, ${this.deps.sql.json((o.payload ?? {}) as never)},
        ${o.everySeconds}, ${o.firstSlot ?? now}, ${o.createdBy}, ${now})`;
    return id;
  }
  async listSchedules(
    t: JobTenant,
    missionId: string,
  ): Promise<
    {
      scheduleId: string;
      kind: string;
      payload: Record<string, unknown>;
      everySeconds: number;
      nextSlot: string;
      active: boolean;
    }[]
  > {
    const rows = await this.deps
      .sql`select * from automation_schedules where organization_id = ${t.organizationId} and environment = ${t.environment}
      and payload->>'missionId' = ${missionId} order by created_at desc, schedule_id`;
    return rows.map((r) => ({
      scheduleId: String(r.schedule_id),
      kind: String(r.kind),
      payload: r.payload as Record<string, unknown>,
      everySeconds: Number(r.every_seconds),
      nextSlot: iso(r.next_slot),
      active: Boolean(r.active),
    }));
  }
  async setScheduleActive(
    t: JobTenant,
    scheduleId: string,
    active: boolean,
  ): Promise<boolean> {
    const rows = await this.deps
      .sql`update automation_schedules set active = ${active} where schedule_id = ${scheduleId}
      and organization_id = ${t.organizationId} and environment = ${t.environment} returning schedule_id`;
    return rows.length === 1;
  }
  /**
   * Turn every due slot into one job. A slot is identified by its time, so a second ticker, a restart or a replay creates nothing new.
   * After a long outage only the most recent MAX_CATCH_UP slots are created, so a restart cannot unleash a flood.
   */
  async tick(maxCatchUp = 3): Promise<{ created: number }> {
    const now = this.deps.now();
    let created = 0;
    await this.deps.sql.begin(async (tx) => {
      const due =
        await tx`select * from automation_schedules where active and next_slot <= ${now} for update skip locked`;
      for (const s of due) {
        const step = Number(s.every_seconds) * 1000;
        let slot = Date.parse(iso(s.next_slot));
        const nowMs = Date.parse(now);
        const slots: number[] = [];
        while (slot <= nowMs) {
          slots.push(slot);
          slot += step;
        }
        for (const at of slots.slice(-maxCatchUp)) {
          const id = `job_${randomBytes(12).toString("hex")}`;
          const r = await tx`insert into automation_jobs
            (job_id, organization_id, environment, kind, effect, payload, dedupe_key, state, run_after, max_attempts, created_at, updated_at)
            values (${id}, ${String(s.organization_id)}, ${String(s.environment)}, ${String(s.kind)}, ${String(s.effect)}, ${tx.json(s.payload as never)},
              ${`${String(s.schedule_id)}@${new Date(at).toISOString()}`}, 'QUEUED', ${now}, ${s.effect === "EXTERNAL" ? 1 : 5}, ${now}, ${now})
            on conflict (organization_id, environment, kind, dedupe_key) do nothing returning job_id`;
          created += r.length;
        }
        await tx`update automation_schedules set next_slot = ${new Date(slot).toISOString()} where schedule_id = ${String(s.schedule_id)}`;
      }
    });
    return { created };
  }
}
