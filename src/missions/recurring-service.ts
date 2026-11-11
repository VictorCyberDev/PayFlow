import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type {
  AutomationService,
  Job,
} from "../automation/automation-service.js";
import { z } from "zod";
import {
  RecurringSetupSchema,
  checkRecurrence,
  type MissionFacts,
  type Outcome,
} from "./recurring.js";

/** The owner may say why. Nothing else is accepted: an answer is yes or no, not an amount. */
export const RecurringDecisionSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();
import type { LedgerService } from "./ledger-service.js";
import type { MissionCaller, MissionService } from "./service.js";

export const RECURRING_KIND = "RECURRING_RENEWAL_CHECK";
export type RcRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "MISSION_NOT_ACTIVE"
  | "NOT_DUE"
  | "ALREADY_DECIDED";
export type RcResult<T> =
  { ok: true; value: T } | { ok: false; refusal: RcRefusal };
const iso = (v: unknown) => new Date(v as string).toISOString();

/**
 * Recurring renewal checks. Setting one up creates a schedule (effect NONE, so a lost worker only re-checks); each due slot becomes one job whose
 * handler reads the mission as it is now and records the outcome. Nothing here purchases, reserves or contacts anyone.
 */
export class RecurringService {
  constructor(
    private readonly deps: {
      sql: Sql;
      missions: MissionService;
      ledger: LedgerService;
      automation: AutomationService;
      now: () => string;
    },
  ) {}

  async create(
    caller: MissionCaller,
    missionId: string,
    raw: unknown,
  ): Promise<RcResult<{ scheduleId: string }>> {
    const b = RecurringSetupSchema.safeParse(raw);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (m.value.status !== "ACTIVE" || !m.value.activeContract)
      return { ok: false, refusal: "MISSION_NOT_ACTIVE" };
    const scheduleId = await this.deps.automation.createSchedule(caller, {
      kind: RECURRING_KIND,
      effect: "NONE",
      payload: {
        missionId,
        label: b.data.label,
        amountMinor: b.data.amountMinor,
        currency: m.value.activeContract.currency,
      },
      everySeconds: b.data.everySeconds,
      // the first check is one period from now unless the owner names a start
      firstSlot:
        b.data.firstSlot ??
        new Date(
          Date.parse(this.deps.now()) + b.data.everySeconds * 1000,
        ).toISOString(),
      createdBy: caller.id,
    });
    return { ok: true, value: { scheduleId } };
  }

  private async ownsSchedule(
    caller: MissionCaller,
    missionId: string,
    scheduleId: string,
  ) {
    return (await this.deps.automation.listSchedules(caller, missionId)).some(
      (s) => s.scheduleId === scheduleId,
    );
  }

  /** Stop checking. The schedule stays on the record; resuming starts again from now, never from the gap. */
  async stop(
    caller: MissionCaller,
    missionId: string,
    scheduleId: string,
  ): Promise<RcResult<{ stopped: true }>> {
    if (!(await this.ownsSchedule(caller, missionId, scheduleId)))
      return { ok: false, refusal: "NOT_FOUND" };
    await this.deps.automation.setScheduleActive(caller, scheduleId, false);
    return { ok: true, value: { stopped: true } };
  }

  /**
   * Start checking again, from now. Not from where it stopped: a schedule paused for a month must not come back and
   * report a renewal that was "due" three weeks ago. The cadence keeps its own day and time.
   */
  async resume(
    caller: MissionCaller,
    missionId: string,
    scheduleId: string,
  ): Promise<RcResult<{ resumed: true; nextCheck: string }>> {
    if (!(await this.ownsSchedule(caller, missionId, scheduleId)))
      return { ok: false, refusal: "NOT_FOUND" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    // Resuming onto a mission that is not active would schedule checks that can only be skipped.
    if (m.value.status !== "ACTIVE")
      return { ok: false, refusal: "MISSION_NOT_ACTIVE" };
    const r = await this.deps.automation.resumeSchedule(caller, scheduleId);
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    return { ok: true, value: { resumed: true, nextCheck: r.nextSlot } };
  }

  /**
   * The owner answers a recurrence that came due. Exactly one answer per check, enforced by a unique key, so a double
   * submit or two people at once records once.
   *
   * Approving is NOT a payment and NOT an authorization to make one. It records what the owner wants; the renewal still
   * goes the normal approved path, where the amount is checked against the contract in force at that moment. That is why
   * this takes no amount and writes nothing to the ledger.
   */
  async decide(
    caller: MissionCaller,
    checkId: string,
    decision: "APPROVED" | "DECLINED",
    raw: unknown,
  ): Promise<
    RcResult<{
      checkId: string;
      decision: string;
      decidedAt: string;
      notice: string;
    }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "NOT_FOUND" };
    const b = RecurringDecisionSchema.safeParse(raw ?? {});
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    if (!/^rck_[a-f0-9]{24}$/u.test(checkId))
      return { ok: false, refusal: "NOT_FOUND" };
    const [chk] = await this.deps.sql`select * from recurring_checks
      where check_id = ${checkId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}`;
    if (!chk) return { ok: false, refusal: "NOT_FOUND" };
    // Only a check that actually came due can be answered; a skipped one has nothing to decide.
    if (chk.outcome !== "DUE_FOR_OWNER")
      return { ok: false, refusal: "NOT_DUE" };
    const missionId = String(chk.mission_id);
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    // A decision taken against a mission that has since been paused or ended must not stand.
    if (m.value.status !== "ACTIVE")
      return { ok: false, refusal: "MISSION_NOT_ACTIVE" };
    const now = this.deps.now();
    try {
      await this.deps.sql`insert into recurring_decisions
        (decision_id, check_id, organization_id, environment, mission_id, decision, decided_by, note, decided_at)
        values (${`rcd_${randomBytes(12).toString("hex")}`}, ${checkId}, ${caller.organizationId}, ${caller.environment},
          ${missionId}, ${decision}, ${caller.id}, ${b.data.note ?? null}, ${now})`;
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_DECIDED" };
      throw e;
    }
    return {
      ok: true,
      value: {
        checkId,
        decision,
        decidedAt: now,
        notice:
          decision === "APPROVED"
            ? "Recorded that you want this renewal. Nothing has been bought or paid: it still goes through the normal approval, where the real amount is checked against your limits."
            : "Recorded that you do not want this renewal. Nothing was bought or paid.",
      },
    };
  }

  async list(caller: MissionCaller, missionId: string) {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" } as const;
    const schedules = (
      await this.deps.automation.listSchedules(caller, missionId)
    ).filter((s) => s.kind === RECURRING_KIND);
    const checks = await this.deps
      .sql`select c.*, d.decision, d.decided_by, d.decided_at, d.note as decision_note
      from recurring_checks c
      left join recurring_decisions d on d.check_id = c.check_id
      where c.mission_id = ${missionId} and c.organization_id = ${caller.organizationId} and c.environment = ${caller.environment}
      order by c.slot desc, c.check_id limit 50`;
    return {
      ok: true,
      value: {
        schedules: schedules.map((s) => ({
          scheduleId: s.scheduleId,
          label: typeof s.payload.label === "string" ? s.payload.label : "",
          amountMinor: Number(s.payload.amountMinor ?? 0),
          currency:
            typeof s.payload.currency === "string" ? s.payload.currency : "",
          everySeconds: s.everySeconds,
          nextCheck: s.nextSlot,
          active: s.active,
        })),
        checks: checks.map((c) => ({
          checkId: String(c.check_id),
          label: String(c.label),
          amountMinor: Number(c.amount_minor),
          currency: String(c.currency).trim(),
          outcome: c.outcome as Outcome,
          slot: iso(c.slot),
          checkedAt: iso(c.checked_at),
          decision: (c.decision as string | null) ?? null,
          decidedBy: (c.decided_by as string | null) ?? null,
          decidedAt: c.decided_at ? iso(c.decided_at) : null,
          decisionNote: (c.decision_note as string | null) ?? null,
          /** A due check nobody has answered yet. This is the only thing on this screen that needs you. */
          awaitingYou: c.outcome === "DUE_FOR_OWNER" && !c.decision,
        })),
        awaitingYouCount: checks.filter(
          (c) => c.outcome === "DUE_FOR_OWNER" && !c.decision,
        ).length,
        notice:
          "A recurring item is only checked. PayFlow never buys, renews or pays on its own; when one is due, you are asked, " +
          "and saying yes records what you want without buying anything.",
      },
    } as const;
  }

  /** The job handler: read the mission as it is now, decide, record once. */
  async runCheck(job: Job): Promise<{ outcome: "SUCCEEDED" | "FAILED" }> {
    const p = job.payload;
    const missionId = typeof p.missionId === "string" ? p.missionId : null;
    const amountMinor = typeof p.amountMinor === "number" ? p.amountMinor : 0;
    const currency = typeof p.currency === "string" ? p.currency : "";
    const label = typeof p.label === "string" ? p.label : "Renewal";
    const at = job.dedupeKey.split("@")[1];
    const scheduleId = job.dedupeKey.split("@")[0];
    if (!missionId || !at || !scheduleId || amountMinor < 1)
      return { outcome: "FAILED" };
    // A system caller for reading only; this path writes nothing to the mission or the ledger.
    const caller: MissionCaller = {
      organizationId: job.organizationId,
      environment: job.environment,
      id: "automation",
      kind: "MEMBER",
    };
    const m = await this.deps.missions.get(caller, missionId);
    let facts: MissionFacts | null = null;
    if (m.ok && m.value.activeContract) {
      const ov = await this.deps.ledger.overview(caller, missionId);
      facts = {
        status: m.value.status,
        expiresAt: m.value.activeContract.expiresAt,
        currency: m.value.activeContract.currency,
        maxCommitmentMinor: m.value.activeContract.maxCommitmentMinor,
        availableMinor: ov.ok ? ov.value.summary.availableMinor : 0,
      };
    } else if (m.ok) {
      facts = {
        status: m.value.status,
        expiresAt: "1970-01-01T00:00:00.000Z",
        currency,
        maxCommitmentMinor: 0,
        availableMinor: 0,
      };
    }
    const outcome = checkRecurrence(
      { amountMinor, currency },
      facts,
      this.deps.now(),
    );
    await this.deps.sql`insert into recurring_checks
      (check_id, organization_id, environment, mission_id, schedule_id, slot, label, amount_minor, currency, outcome, checked_at)
      values (${`rck_${randomBytes(12).toString("hex")}`}, ${job.organizationId}, ${job.environment}, ${missionId}, ${scheduleId}, ${at},
        ${label.slice(0, 120)}, ${amountMinor}, ${currency}, ${outcome}, ${this.deps.now()})
      on conflict (schedule_id, slot) do nothing`;
    return { outcome: "SUCCEEDED" };
  }
}
