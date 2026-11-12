import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type {
  AutomationService,
  Handler,
  Job,
} from "../automation/automation-service.js";
import type { MissionCaller, MissionService } from "./service.js";
import type { PlanService, TaskView } from "./plan-service.js";

/**
 * V3 M55 — plan runs: the executor that drives an ACTIVE mission plan's dependency graph.
 *
 * M27 already holds the graph (tasks, HARD/CONDITIONAL edges, readiness, approval gates, append-only events) and M56 already
 * holds a durable worker. Nothing joined them. This does, under three rules:
 *
 *  1. **It creates no authority.** Every task transition goes through the same `PlanService` calls an agent uses, as the
 *     ASSIGNED agent, so the capability check against the contract in force still runs on every single one. The executor
 *     cannot do anything an agent could not have done by hand.
 *  2. **It never performs a consequential action.** It has no payment, booking, hiring or messaging path. A task it cannot
 *     honestly automate is HANDED_OFF with a note naming what is missing. Buying, hiring, booking, paying and contacting
 *     stay where they are: human-approved actions on their own screens.
 *  3. **It stops at every gate a person owns.** A task awaiting approval is reported, not approved. A task with no honest
 *     path is left for a member to skip or invalidate. The executor never approves, skips or invalidates anything.
 *
 * Durability: the job is effect NONE, because every action is bookkeeping about work or a read, so a lost worker may be
 * re-queued safely. Each (run, task) has a stable run key, and `claim` treats a repeat under the same key as idempotent, so
 * a task left IN_PROGRESS by a crash resumes instead of being abandoned or done twice.
 *
 * Termination: passes run to a fixpoint. A pass that changes no task ends the run. `MAX_PASSES` bounds it regardless, so a
 * pathological plan cannot spin.
 */
export const PLAN_RUN_KIND = "PLAN_RUN";

/** A pass that changes nothing ends the run; this only bounds a pathological graph. */
const MAX_PASSES = 24;

export type PrRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "MISSION_NOT_ACTIVE"
  | "NO_ACTIVE_PLAN"
  | "RUN_ALREADY_OPEN"
  | "ALREADY_FINISHED";
export type PrResult<T> =
  { ok: true; value: T } | { ok: false; refusal: PrRefusal };

export const CreatePlanRunSchema = z.object({}).strict();

/**
 * What a connected specialist may report for one task. There are none by default, and that is the honest state of the
 * product: with no provider connected, every task is a handoff. Registering one here is the only way automated work ever
 * happens, and it still cannot bypass the capability check in `claim`.
 */
export type SpecialistOutcome =
  | {
      kind: "COMPLETED";
      summary: string;
      evidence: { kind: string; ref: string }[];
    }
  | { kind: "HANDOFF"; note: string }
  | { kind: "FAILED"; reason: string };
export interface PlanSpecialist {
  /** Shown in the handoff note and the run log, so a person can see what was tried. */
  readonly describe: string;
  run(input: {
    readonly caller: MissionCaller;
    readonly missionId: string;
    readonly task: TaskView;
  }): Promise<SpecialistOutcome>;
}

type Row = Record<string, unknown>;
const iso = (v: unknown) =>
  v ? new Date(v as string | Date).toISOString() : null;
const clip = (s: string, n = 500) => s.slice(0, n);

export interface PlanRunView {
  runId: string;
  missionId: string;
  planVersion: number;
  state: string;
  note: string | null;
  passes: number;
  createdAt: string;
  finishedAt: string | null;
  actions: {
    seq: number;
    taskKey: string;
    action: string;
    detail: string | null;
    occurredAt: string;
  }[];
  /** What a person has to do next, derived from the run's own log. Empty when the run completed the plan. */
  worklist: { taskKey: string; needs: string; detail: string | null }[];
  notice: string;
}

export const PLAN_RUN_NOTICE =
  "A plan run only moves work along and writes down who has to act. It never approves anything, and it never buys, hires, " +
  "books, pays or contacts anyone. Those are your decisions, on their own screens.";

/** What a person must do, per action the executor recorded. */
const NEEDS: Record<string, string> = {
  HANDED_OFF: "CONFIRM_THE_HANDOFF_WHEN_IT_IS_DONE",
  LEFT_FOR_MEMBER: "DECIDE_WHETHER_TO_SKIP_OR_CHANGE_THE_PLAN",
  WAITING_FOR_APPROVAL: "APPROVE_OR_REJECT_THIS_TASK",
  REFUSED: "GRANT_WHAT_IS_MISSING_OR_CHANGE_THE_PLAN",
  DISPATCH_FAILED: "LOOK_AT_THE_FAILURE_AND_RETRY_OR_SKIP",
};

export class PlanRunService {
  constructor(
    private readonly deps: {
      sql: Sql;
      now: () => string;
      missions: MissionService;
      plans: PlanService;
      automation: AutomationService;
      /** Keyed by task type. Empty by default: with nothing connected, every task is an honest handoff. */
      specialists?: ReadonlyMap<string, PlanSpecialist>;
    },
  ) {}

  private get specialists(): ReadonlyMap<string, PlanSpecialist> {
    return this.deps.specialists ?? new Map();
  }

  private async view(run: Row): Promise<PlanRunView> {
    const runId = String(run.run_id);
    const acts = await this.deps
      .sql`select seq, task_key, action, detail, occurred_at from plan_run_actions where run_id = ${runId} order by seq`;
    const actions = acts.map((a) => ({
      seq: Number(a.seq),
      taskKey: String(a.task_key),
      action: String(a.action),
      detail: (a.detail as string | null) ?? null,
      occurredAt: iso(a.occurred_at)!,
    }));
    // The worklist is the last thing said about each task that still needs a person.
    const latest = new Map<string, (typeof actions)[number]>();
    for (const a of actions) latest.set(a.taskKey, a);
    const worklist = [...latest.values()]
      .filter((a) => a.action in NEEDS)
      .sort((x, y) => x.taskKey.localeCompare(y.taskKey))
      .map((a) => ({
        taskKey: a.taskKey,
        needs: NEEDS[a.action]!,
        detail: a.detail,
      }));
    return {
      runId,
      missionId: String(run.mission_id),
      planVersion: Number(run.plan_version),
      state: String(run.state),
      note: (run.note as string | null) ?? null,
      passes: Number(run.passes),
      createdAt: iso(run.created_at)!,
      finishedAt: iso(run.finished_at),
      actions,
      worklist,
      notice: PLAN_RUN_NOTICE,
    };
  }

  /** Starts a run against the mission's ACTIVE plan. One open run per mission. */
  async create(
    caller: MissionCaller,
    missionId: string,
    raw: unknown,
  ): Promise<PrResult<PlanRunView>> {
    if (!CreatePlanRunSchema.safeParse(raw ?? {}).success)
      return { ok: false, refusal: "MALFORMED" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (m.value.status !== "ACTIVE")
      return { ok: false, refusal: "MISSION_NOT_ACTIVE" };
    const cur = await this.deps.plans.current(caller, missionId);
    if (!cur.ok) return { ok: false, refusal: "NOT_FOUND" };
    const pv = cur.value.activePlanVersion;
    if (pv === null) return { ok: false, refusal: "NO_ACTIVE_PLAN" };
    const now = this.deps.now();
    const runId = `prn_${randomBytes(12).toString("hex")}`;
    try {
      await this.deps
        .sql`insert into plan_runs (run_id, organization_id, environment, mission_id, plan_version, created_by, state, created_at, updated_at)
          values (${runId}, ${caller.organizationId}, ${caller.environment}, ${missionId}, ${pv}, ${caller.id}, 'QUEUED', ${now}, ${now})`;
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
        kind: PLAN_RUN_KIND,
        effect: "NONE",
        payload: { runId },
        dedupeKey: `plan:${runId}`,
        maxAttempts: 3,
      },
    );
    const [run] = await this.deps
      .sql`select * from plan_runs where run_id = ${runId}`;
    return { ok: true, value: await this.view(run!) };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<PrResult<{ runs: PlanRunView[] }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const runs = await this.deps
      .sql`select * from plan_runs where organization_id = ${caller.organizationId} and environment = ${caller.environment}
        and mission_id = ${missionId} order by created_at desc, run_id limit 10`;
    return {
      ok: true,
      value: { runs: await Promise.all(runs.map((r) => this.view(r))) },
    };
  }

  /** Stops a run that has not finished. A task already being advanced finishes; no further task is started. */
  async cancel(
    caller: MissionCaller,
    runId: string,
  ): Promise<PrResult<PlanRunView>> {
    if (!/^prn_[a-f0-9]{24}$/u.test(runId))
      return { ok: false, refusal: "NOT_FOUND" };
    const now = this.deps.now();
    const done = await this.deps
      .sql`update plan_runs set state = 'CANCELLED', finished_at = ${now}, updated_at = ${now}, note = 'cancelled by a person'
        where run_id = ${runId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}
        and state in ('QUEUED','RUNNING') returning *`;
    if (!done[0]) {
      const [r] = await this.deps
        .sql`select state from plan_runs where run_id = ${runId} and organization_id = ${caller.organizationId}
          and environment = ${caller.environment}`;
      return { ok: false, refusal: r ? "ALREADY_FINISHED" : "NOT_FOUND" };
    }
    return { ok: true, value: await this.view(done[0]) };
  }

  handler(): Handler {
    return (job: Job) => this.advance(job);
  }

  private async log(
    runId: string,
    task: { key: string; taskId: string },
    action: string,
    detail: string | null,
  ) {
    const now = this.deps.now();
    // seq is allocated against the run's own rows; the run holds the mission lock through PlanService, and only one run
    // per mission can be open, so there is no second writer to race.
    await this.deps
      .sql`insert into plan_run_actions (run_id, seq, task_key, task_id, action, detail, occurred_at)
        values (${runId}, (select coalesce(max(seq), 0) + 1 from plan_run_actions where run_id = ${runId}),
          ${task.key}, ${task.taskId}, ${action}, ${detail === null ? null : clip(detail)}, ${now})`;
  }

  /** A stable, bounded key per (run, task): a re-queued run claims the same task under the same key, which is idempotent. */
  private runKey(runId: string, taskKey: string) {
    return `pr-${runId.slice(4, 20)}-${taskKey.slice(0, 40)}`;
  }

  private async finish(runId: string, state: string, note: string) {
    const now = this.deps.now();
    await this.deps
      .sql`update plan_runs set state = ${state}, note = ${clip(note, 300)}, finished_at = ${now}, updated_at = ${now}
        where run_id = ${runId} and state in ('QUEUED','RUNNING')`;
  }

  private async advance(job: Job) {
    const runId = job.payload.runId;
    if (typeof runId !== "string")
      return { outcome: "FAILED" as const, note: "no run" };
    const sql = this.deps.sql;
    const [run] =
      await sql`select * from plan_runs where run_id = ${runId} and organization_id = ${job.organizationId}
        and environment = ${job.environment}`;
    if (!run) return { outcome: "FAILED" as const, note: "unknown run" };
    if (
      ["WAITING_ON_PEOPLE", "COMPLETE", "CANCELLED", "FAILED"].includes(
        String(run.state),
      )
    )
      return { outcome: "SUCCEEDED" as const, note: "already finished" };

    await sql`update plan_runs set state = 'RUNNING', updated_at = ${this.deps.now()}
      where run_id = ${runId} and state in ('QUEUED','RUNNING')`;

    const tenant = {
      organizationId: job.organizationId,
      environment: job.environment,
    };
    const missionId = String(run.mission_id);
    const planVersion = Number(run.plan_version);
    /** Only the first time a task is reported as waiting; a fixpoint pass must not fill the log with repeats. */
    const reported = new Set<string>();
    let passes = 0;

    for (; passes < MAX_PASSES; passes++) {
      const [cur0] =
        await sql`select state from plan_runs where run_id = ${runId}`;
      if (cur0?.state === "CANCELLED")
        return { outcome: "SUCCEEDED" as const, note: "cancelled" };

      // current() reconciles the graph first, so states and readiness are fresh on every pass.
      const cur = await this.deps.plans.current(tenant, missionId);
      if (!cur.ok) {
        await this.finish(runId, "FAILED", "the mission could not be read");
        return { outcome: "SUCCEEDED" as const, note: "mission gone" };
      }
      if (cur.value.activePlanVersion !== planVersion) {
        await this.finish(
          runId,
          "FAILED",
          `the plan was replaced while this run was going (started on version ${planVersion})`,
        );
        return { outcome: "SUCCEEDED" as const, note: "plan superseded" };
      }

      let progressed = false;
      const tasks = [...cur.value.tasks].sort((a, b) =>
        a.key.localeCompare(b.key),
      );
      for (const t of tasks) {
        if (["COMPLETED", "FAILED", "SKIPPED", "INVALIDATED"].includes(t.state))
          continue;

        // Gates that belong to a person. Reported once, never acted on.
        if (t.state === "AWAITING_APPROVAL") {
          if (!reported.has(`a:${t.key}`)) {
            reported.add(`a:${t.key}`);
            await this.log(
              runId,
              t,
              "WAITING_FOR_APPROVAL",
              `"${t.title}" needs your approval before anything may happen.`,
            );
          }
          continue;
        }
        if (t.state === "BLOCKED") {
          if (!reported.has(`b:${t.key}`)) {
            reported.add(`b:${t.key}`);
            await this.log(runId, t, "BLOCKED", t.blockReason);
          }
          continue;
        }
        // Already with a person, waiting for them to confirm it was done.
        if (t.state === "HANDED_OFF") {
          if (!reported.has(`h:${t.key}`)) {
            reported.add(`h:${t.key}`);
            await this.log(
              runId,
              t,
              "HANDED_OFF",
              `"${t.title}" is with you. Confirm it when it is done.`,
            );
          }
          continue;
        }

        // READY, or IN_PROGRESS because a previous worker was lost part-way through this very task.
        if (t.state !== "READY" && t.state !== "IN_PROGRESS") continue;

        if (!t.assignedAgentId || t.readiness === "UNAVAILABLE") {
          if (!reported.has(`m:${t.key}`)) {
            reported.add(`m:${t.key}`);
            await this.log(
              runId,
              t,
              "LEFT_FOR_MEMBER",
              t.readiness === "UNAVAILABLE"
                ? `There is no honest way to do "${t.title}" automatically: ${t.readinessReason ?? "no path"}. Skip it or change the plan.`
                : `"${t.title}" has no agent assigned, so only you can take it forward.`,
            );
          }
          continue;
        }

        // From here on the executor acts AS THE ASSIGNED AGENT, so the contract's capability check runs on every call.
        const agent: MissionCaller = {
          ...tenant,
          id: t.assignedAgentId,
          kind: "AGENT",
        };
        const runKey = this.runKey(runId, t.key);
        const claimed = await this.deps.plans.claim(agent, t.taskId, {
          runKey,
        });
        if (!claimed.ok) {
          if (!reported.has(`r:${t.key}`)) {
            reported.add(`r:${t.key}`);
            await this.log(
              runId,
              t,
              "REFUSED",
              `${claimed.refusal}${"detail" in claimed && claimed.detail ? `: ${String(claimed.detail)}` : ""}`,
            );
          }
          continue;
        }
        progressed = true;

        const specialist =
          t.readiness === "EXECUTABLE"
            ? this.specialists.get(t.taskType)
            : undefined;

        if (!specialist) {
          // The honest default. Nothing is connected that can do this, so a person takes it, and the note says why.
          const why =
            t.readiness === "PREPARED_HANDOFF"
              ? (t.readinessReason ??
                "a person or a provider step is needed for this")
              : `no specialist is connected for ${t.taskType}`;
          const note = `Prepared, not done: ${why}. Nothing was bought, hired, booked or paid, and no one was contacted.`;
          const off = await this.deps.plans.handoff(agent, t.taskId, {
            runKey,
            note,
          });
          await this.log(
            runId,
            t,
            off.ok ? "HANDED_OFF" : "REFUSED",
            off.ok ? note : `handoff refused: ${off.refusal}`,
          );
          continue;
        }

        // A connected specialist. It still cannot exceed what the agent was granted: claim already proved the capability.
        let outcome: SpecialistOutcome;
        try {
          outcome = await specialist.run({
            caller: agent,
            missionId,
            task: t,
          });
        } catch (e) {
          outcome = {
            kind: "FAILED",
            reason: `${specialist.describe} threw: ${e instanceof Error ? e.message : "unknown"}`,
          };
        }
        if (outcome.kind === "COMPLETED") {
          const done = await this.deps.plans.complete(agent, t.taskId, {
            runKey,
            summary: outcome.summary,
            evidence: outcome.evidence,
          });
          await this.log(
            runId,
            t,
            done.ok ? "COMPLETED" : "DISPATCH_FAILED",
            done.ok
              ? `${specialist.describe}: ${outcome.summary}`
              : `could not record completion: ${done.refusal}`,
          );
        } else if (outcome.kind === "HANDOFF") {
          const off = await this.deps.plans.handoff(agent, t.taskId, {
            runKey,
            note: outcome.note,
          });
          await this.log(
            runId,
            t,
            off.ok ? "HANDED_OFF" : "REFUSED",
            off.ok ? outcome.note : `handoff refused: ${off.refusal}`,
          );
        } else {
          const bad = await this.deps.plans.fail(agent, t.taskId, {
            runKey,
            reason: outcome.reason,
          });
          await this.log(
            runId,
            t,
            "DISPATCH_FAILED",
            bad.ok
              ? outcome.reason
              : `could not record the failure: ${bad.refusal}`,
          );
        }
      }

      // Guarded on state: a person may have cancelled during this pass, and a finished run is immutable, so an
      // unguarded write here would hit the trigger and turn a legitimate cancellation into a job failure.
      await sql`update plan_runs set passes = ${passes + 1}, updated_at = ${this.deps.now()}
        where run_id = ${runId} and state in ('QUEUED','RUNNING')`;
      if (!progressed) break;
    }

    // Did the plan finish, or is it waiting on people?
    const final = await this.deps.plans.current(tenant, missionId);
    const open = final.ok
      ? final.value.tasks.filter(
          (t) =>
            !["COMPLETED", "FAILED", "SKIPPED", "INVALIDATED"].includes(
              t.state,
            ),
        )
      : [];
    if (!open.length) {
      await this.finish(
        runId,
        "COMPLETE",
        "every task in the plan has reached a final state",
      );
      return { outcome: "SUCCEEDED" as const, note: "plan complete" };
    }
    await this.finish(
      runId,
      "WAITING_ON_PEOPLE",
      `${open.length} task${open.length === 1 ? "" : "s"} need you; the run moved everything it could`,
    );
    return { outcome: "SUCCEEDED" as const, note: "waiting on people" };
  }
}
