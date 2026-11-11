import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type {
  AutomationService,
  Handler,
  Job,
} from "../automation/automation-service.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * M55 (slice) — launch runs. A run sequences READ-ONLY discovery steps for a mission and leaves the decisions to people. It is executed by the
 * automation worker (effect NONE: every step is an observation, so a lost worker may safely be retried), resumes after a restart without
 * repeating a finished step, stops between steps when cancelled, and ends READY. It never books, buys, hires, pays or contacts anyone: those stay
 * separate, human-approved actions on their own screens. A search the mission does not allow is recorded as REFUSED and the run goes on.
 */
export const LAUNCH_RUN_KIND = "LAUNCH_RUN";
export type LrRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "MISSION_NOT_ACTIVE"
  | "RUN_ALREADY_OPEN"
  | "ALREADY_FINISHED";
export type LrResult<T> =
  { ok: true; value: T } | { ok: false; refusal: LrRefusal };

const Step = z.discriminatedUnion("area", [
  z
    .object({
      area: z.literal("WORKSPACE"),
      request: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      area: z.literal("SERVICES"),
      request: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export const CreateSchema = z
  .object({ steps: z.array(Step).min(1).max(8) })
  .strict();

export interface SearchPort {
  search(
    caller: MissionCaller,
    missionId: string,
    body: unknown,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; refusal: string; detail?: string }
  >;
}
type Row = Record<string, unknown>;
const iso = (v: unknown) =>
  v ? new Date(v as string | Date).toISOString() : null;
const clip = (s: string, n = 100) => s.slice(0, n);

export interface LaunchRunView {
  runId: string;
  missionId: string;
  state: string;
  note: string | null;
  createdAt: string;
  finishedAt: string | null;
  steps: {
    position: number;
    area: string;
    state: string;
    refusal: string | null;
    summary: unknown;
    attempts: number;
  }[];
  notice: string;
}
export const LAUNCH_NOTICE =
  "A launch run only looks. Nothing was booked, bought, hired or paid and no one was contacted. What it found is for you to decide on.";

export class LaunchRunService {
  constructor(
    private readonly deps: {
      sql: Sql;
      now: () => string;
      missions: MissionService;
      automation: AutomationService;
      workspace: SearchPort;
      services: SearchPort;
    },
  ) {}

  private async view(run: Row): Promise<LaunchRunView> {
    const steps = await this.deps
      .sql`select position, area, state, refusal, summary, attempts from launch_run_steps where run_id = ${String(run.run_id)} order by position`;
    return {
      runId: String(run.run_id),
      missionId: String(run.mission_id),
      state: String(run.state),
      note: (run.note as string | null) ?? null,
      createdAt: iso(run.created_at)!,
      finishedAt: iso(run.finished_at),
      steps: steps.map((s) => ({
        position: Number(s.position),
        area: String(s.area),
        state: String(s.state),
        refusal: (s.refusal as string | null) ?? null,
        summary: (s.summary as unknown) ?? null,
        attempts: Number(s.attempts),
      })),
      notice: LAUNCH_NOTICE,
    };
  }

  async create(
    caller: MissionCaller,
    missionId: string,
    raw: unknown,
  ): Promise<LrResult<LaunchRunView>> {
    const b = CreateSchema.safeParse(raw);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (m.value.status !== "ACTIVE")
      return { ok: false, refusal: "MISSION_NOT_ACTIVE" };
    const now = this.deps.now();
    const runId = `lrn_${randomBytes(12).toString("hex")}`;
    try {
      await this.deps.sql.begin(async (tx) => {
        await tx`insert into launch_runs (run_id, organization_id, environment, mission_id, created_by, state, created_at, updated_at)
          values (${runId}, ${caller.organizationId}, ${caller.environment}, ${missionId}, ${caller.id}, 'QUEUED', ${now}, ${now})`;
        let i = 0;
        for (const s of b.data.steps)
          await tx`insert into launch_run_steps (run_id, position, area, request, state) values (${runId}, ${i++}, ${s.area}, ${tx.json(s.request as never)}, 'PENDING')`;
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "RUN_ALREADY_OPEN" };
      throw e;
    }
    await this.deps.automation.enqueue(
      {
        organizationId: caller.organizationId,
        environment: caller.environment,
      },
      {
        kind: LAUNCH_RUN_KIND,
        effect: "NONE",
        payload: { runId },
        dedupeKey: `launch:${runId}`,
        maxAttempts: 3,
      },
    );
    const [run] = await this.deps
      .sql`select * from launch_runs where run_id = ${runId}`;
    return { ok: true, value: await this.view(run!) };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<LrResult<{ runs: LaunchRunView[] }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const runs = await this.deps
      .sql`select * from launch_runs where organization_id = ${caller.organizationId} and environment = ${caller.environment}
      and mission_id = ${missionId} order by created_at desc, run_id limit 10`;
    return {
      ok: true,
      value: { runs: await Promise.all(runs.map((r) => this.view(r))) },
    };
  }

  /** Stops a run that has not finished. A step already in progress completes; no further step starts. */
  async cancel(
    caller: MissionCaller,
    runId: string,
  ): Promise<LrResult<LaunchRunView>> {
    if (!/^lrn_[a-f0-9]{24}$/u.test(runId))
      return { ok: false, refusal: "NOT_FOUND" };
    const now = this.deps.now();
    const done = await this.deps
      .sql`update launch_runs set state = 'CANCELLED', finished_at = ${now}, updated_at = ${now}, note = 'cancelled by a person'
      where run_id = ${runId} and organization_id = ${caller.organizationId} and environment = ${caller.environment} and state in ('QUEUED','RUNNING') returning *`;
    if (!done[0]) {
      const [r] = await this.deps
        .sql`select state from launch_runs where run_id = ${runId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}`;
      return { ok: false, refusal: r ? "ALREADY_FINISHED" : "NOT_FOUND" };
    }
    return { ok: true, value: await this.view(done[0]) };
  }

  /** The automation handler. Resumable: finished steps are skipped, so a re-queued run carries on where the lost one stopped. */
  handler(): Handler {
    return (job: Job) => this.run(job);
  }

  private async run(job: Job) {
    const runId = job.payload.runId;
    if (typeof runId !== "string")
      return { outcome: "FAILED" as const, note: "no run" };
    const sql = this.deps.sql;
    const [run] =
      await sql`select * from launch_runs where run_id = ${runId} and organization_id = ${job.organizationId} and environment = ${job.environment}`;
    if (!run) return { outcome: "FAILED" as const, note: "unknown run" };
    if (["READY", "FAILED", "CANCELLED"].includes(String(run.state)))
      return { outcome: "SUCCEEDED" as const, note: "already finished" };
    await sql`update launch_runs set state = 'RUNNING', updated_at = ${this.deps.now()} where run_id = ${runId} and state in ('QUEUED','RUNNING')`;
    const caller: MissionCaller = {
      organizationId: job.organizationId,
      environment: job.environment,
      id: String(run.created_by),
      kind: "MEMBER",
    };
    const missionId = String(run.mission_id);
    for (;;) {
      // stop between steps if a person cancelled
      const [cur] =
        await sql`select state from launch_runs where run_id = ${runId}`;
      if (cur?.state === "CANCELLED")
        return { outcome: "SUCCEEDED" as const, note: "cancelled" };
      const [step] =
        await sql`update launch_run_steps set state = 'RUNNING', attempts = attempts + 1, started_at = ${this.deps.now()}
        where run_id = ${runId} and position = (select min(position) from launch_run_steps where run_id = ${runId} and state in ('PENDING','RUNNING'))
          and state in ('PENDING','RUNNING') returning *`;
      if (!step) break;
      const port =
        step.area === "WORKSPACE" ? this.deps.workspace : this.deps.services;
      const position = Number(step.position);
      const request = { ...(step.request as Record<string, unknown>) };
      // a retried workspace search is a replay, not a second search
      if (step.area === "WORKSPACE")
        request.idempotencyKey = `lr-${runId.slice(4, 20)}-${position}`;
      // a throw here propagates: the search is an observation, so the framework may retry the whole run
      const r = await port.search(caller, missionId, request);
      const now = this.deps.now();
      if (r.ok) {
        const v = r.value as {
          results?: { assessment: { qualified: boolean } }[];
          rejected?: number;
          truncated?: boolean;
          searchId?: string;
        };
        const results = v.results ?? [];
        const summary = {
          found: results.length,
          qualified: results.filter((x) => x.assessment.qualified).length,
          rejectedBySource: v.rejected ?? 0,
          truncated: v.truncated ?? false,
          ...(v.searchId ? { searchId: v.searchId } : {}),
        };
        await sql`update launch_run_steps set state = 'DONE', summary = ${sql.json(summary)}, finished_at = ${now} where run_id = ${runId} and position = ${position}`;
      } else {
        await sql`update launch_run_steps set state = 'REFUSED', refusal = ${clip(r.refusal)}, finished_at = ${now} where run_id = ${runId} and position = ${position}`;
      }
    }
    const now = this.deps.now();
    await sql`update launch_runs set state = 'READY', finished_at = ${now}, updated_at = ${now}, note = 'ready for your decision'
      where run_id = ${runId} and state in ('QUEUED','RUNNING')`;
    return { outcome: "SUCCEEDED" as const, note: "ready" };
  }
}
