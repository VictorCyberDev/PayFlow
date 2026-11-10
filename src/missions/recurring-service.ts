import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type {
  AutomationService,
  Job,
} from "../automation/automation-service.js";
import {
  RecurringSetupSchema,
  checkRecurrence,
  type MissionFacts,
  type Outcome,
} from "./recurring.js";
import type { LedgerService } from "./ledger-service.js";
import type { MissionCaller, MissionService } from "./service.js";

export const RECURRING_KIND = "RECURRING_RENEWAL_CHECK";
export type RcRefusal = "MALFORMED" | "NOT_FOUND" | "MISSION_NOT_ACTIVE";
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

  async stop(
    caller: MissionCaller,
    missionId: string,
    scheduleId: string,
  ): Promise<RcResult<{ stopped: true }>> {
    const mine = (
      await this.deps.automation.listSchedules(caller, missionId)
    ).some((s) => s.scheduleId === scheduleId);
    if (!mine) return { ok: false, refusal: "NOT_FOUND" };
    await this.deps.automation.setScheduleActive(caller, scheduleId, false);
    return { ok: true, value: { stopped: true } };
  }

  async list(caller: MissionCaller, missionId: string) {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" } as const;
    const schedules = (
      await this.deps.automation.listSchedules(caller, missionId)
    ).filter((s) => s.kind === RECURRING_KIND);
    const checks = await this.deps.sql`select * from recurring_checks
      where mission_id = ${missionId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}
      order by slot desc, check_id limit 50`;
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
        })),
        notice:
          "A recurring item is only checked. PayFlow never buys, renews or pays on its own; when one is due, you are asked.",
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
