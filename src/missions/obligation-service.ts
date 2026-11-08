import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import { derive, isDate, stateOf, type State } from "./obligations.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M44 — obligations: dates the mission must not forget. Those derived from a quote's terms start from VERIFIED facts only and exist
 * once per order and kind. Due-soon and overdue are computed when asked, never stored. A person closes one (DONE or WAIVED); an agent
 * may add a reminder. Obligations move no money.
 */
export type ObRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "MEMBER_ONLY"
  | "ALREADY_RESOLVED";
export type OResult<T> =
  { ok: true; value: T } | { ok: false; refusal: ObRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
const Day = z.string().refine(isDate, { message: "date" });
export const CreateSchema = z
  .object({
    kind: z.enum(["CUSTOM", "RENEWAL", "PAYMENT_DUE"]).default("CUSTOM"),
    title: z.string().trim().min(1).max(200),
    dueDate: Day,
    amountMinor: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(1_000_000_000_000)
      .optional(),
    orderId: z
      .string()
      .regex(/^ord_[a-f0-9]{24}$/u)
      .optional(),
    idempotencyKey: Idem,
  })
  .strict();
export const ResolveSchema = z
  .object({
    outcome: z.enum(["DONE", "WAIVED"]),
    note: z.string().trim().max(300).default(""),
  })
  .strict();

const day = (v: unknown) => new Date(v as string).toISOString().slice(0, 10);
type Row = Record<string, unknown>;
export interface ObligationView {
  readonly obligationId: string;
  readonly orderId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly dueDate: string;
  readonly derivedFrom: string | null;
  readonly amountMinor: number | null;
  readonly status: string;
  readonly state: State;
  readonly createdBy: string;
  readonly resolutionNote: string | null;
}
const NOTICE =
  "Obligations are reminders computed from verified facts. They move no money; only a person closes one.";

export class ObligationService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      now: () => string;
    },
  ) {}
  private async log(
    c: Pick<MissionCaller, "organizationId" | "environment" | "id" | "kind">,
    action: string,
    subjectId: string,
    now: string,
  ) {
    await this.deps.audit
      .append({
        organizationId: c.organizationId,
        environment: c.environment,
        actorKind: c.kind === "MEMBER" ? "MEMBER" : "AGENT_CREDENTIAL",
        actorId: c.id,
        action,
        subjectKind: "MISSION_OBLIGATION",
        subjectId,
        detail: {},
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private toView(r: Row, today: string): ObligationView {
    const status = r.status as "OPEN" | "DONE" | "WAIVED";
    const due = day(r.due_date);
    return {
      obligationId: String(r.obligation_id),
      orderId: (r.order_id as string | null) ?? null,
      kind: String(r.kind),
      title: String(r.title),
      dueDate: due,
      derivedFrom: (r.derived_from as string | null) ?? null,
      amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
      status,
      state: stateOf(status, due, today),
      createdBy: `${String(r.created_by_kind).toLowerCase()}:${String(r.created_by)}`,
      resolutionNote: (r.resolution_note as string | null) ?? null,
    };
  }

  /** Derive what the quote's terms and the verified facts support. Safe to repeat: each kind exists once per order. */
  async derive(
    caller: MissionCaller,
    orderId: string,
  ): Promise<
    OResult<{ obligations: ObligationView[]; created: number; notice: string }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    if (!/^ord_[a-f0-9]{24}$/u.test(orderId))
      return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [o] =
      await sql`select o.*, q.document as quote_doc from mission_orders o join missions m on m.mission_id = o.mission_id
      join mission_purchase_orders p on p.po_id = o.po_id join mission_quotes q on q.quote_id = p.quote_id
      where o.order_id = ${orderId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!o) return { ok: false, refusal: "NOT_FOUND" };
    const [del] = await sql`select min(occurred_at) at from mission_order_events
      where order_id = ${orderId} and kind = 'STATUS' and status = 'DELIVERED' and verification = 'VERIFIED'`;
    const terms =
      (o.quote_doc as { terms?: Record<string, number> }).terms ?? {};
    const items = derive({
      orderCreatedDate: day(o.created_at),
      deliveredDate: del?.at ? day(del.at) : null,
      terms: {
        ...(terms.deliveryDays !== undefined
          ? { deliveryDays: terms.deliveryDays }
          : {}),
        ...(terms.returnWindowDays !== undefined
          ? { returnWindowDays: terms.returnWindowDays }
          : {}),
        ...(terms.warrantyMonths !== undefined
          ? { warrantyMonths: terms.warrantyMonths }
          : {}),
      },
    });
    const now = this.deps.now();
    let created = 0;
    for (const it of items) {
      const id = `obl_${randomBytes(12).toString("hex")}`;
      const ins =
        await sql`insert into mission_obligations (obligation_id, mission_id, order_id, kind, title, due_date, derived_from, created_by_kind, created_by, created_at)
        values (${id}, ${String(o.mission_id)}, ${orderId}, ${it.kind}, ${it.title}, ${it.dueDate}, ${it.derivedFrom}, 'SYSTEM', ${caller.id}, ${now})
        on conflict (order_id, kind) where derived_from is not null do nothing returning obligation_id`;
      if (ins.length > 0) created++;
    }
    if (created > 0)
      await this.log(caller, "OBLIGATIONS_DERIVED", orderId, now);
    const rows =
      await sql`select * from mission_obligations where order_id = ${orderId} order by due_date, obligation_id`;
    const today = now.slice(0, 10);
    return {
      ok: true,
      value: {
        obligations: rows.map((r) => this.toView(r, today)),
        created,
        notice: NOTICE,
      },
    };
  }

  async create(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<OResult<{ obligation: ObligationView; replayed: boolean }>> {
    const b = CreateSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 2)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "READ",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const sql = this.deps.sql;
    if (b.data.orderId) {
      const [o] =
        await sql`select 1 from mission_orders where order_id = ${b.data.orderId} and mission_id = ${missionId}`;
      if (!o) return { ok: false, refusal: "NOT_FOUND", detail: "order" };
    }
    const now = this.deps.now();
    const [prior] =
      await sql`select * from mission_obligations where mission_id = ${missionId} and created_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.title === b.data.title &&
        day(prior.due_date) === b.data.dueDate
        ? {
            ok: true,
            value: {
              obligation: this.toView(prior, now.slice(0, 10)),
              replayed: true,
            },
          }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const id = `obl_${randomBytes(12).toString("hex")}`;
    const [row] =
      await sql`insert into mission_obligations (obligation_id, mission_id, order_id, kind, title, due_date, amount_minor, created_by_kind, created_by, idempotency_key, created_at)
      values (${id}, ${missionId}, ${b.data.orderId ?? null}, ${b.data.kind}, ${b.data.title}, ${b.data.dueDate}, ${b.data.amountMinor ?? null}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now}) returning *`;
    await this.log(caller, "OBLIGATION_ADDED", id, now);
    return {
      ok: true,
      value: {
        obligation: this.toView(row!, now.slice(0, 10)),
        replayed: false,
      },
    };
  }

  async resolve(
    caller: MissionCaller,
    obligationId: string,
    rawBody: unknown,
  ): Promise<OResult<{ obligation: ObligationView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = ResolveSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    if (!/^obl_[a-f0-9]{24}$/u.test(obligationId))
      return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [r] =
      await sql`select ob.* from mission_obligations ob join missions m on m.mission_id = ob.mission_id
      where ob.obligation_id = ${obligationId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    const now = this.deps.now();
    if (r.status !== "OPEN")
      return r.status === b.data.outcome
        ? {
            ok: true,
            value: {
              obligation: this.toView(r, now.slice(0, 10)),
              replayed: true,
            },
          }
        : { ok: false, refusal: "ALREADY_RESOLVED" };
    const upd =
      await sql`update mission_obligations set status = ${b.data.outcome}, resolved_by = ${caller.id}, resolved_at = ${now}, resolution_note = ${b.data.note || null}
      where obligation_id = ${obligationId} and status = 'OPEN' returning *`;
    if (upd.length === 0) return { ok: false, refusal: "ALREADY_RESOLVED" };
    await this.log(caller, `OBLIGATION_${b.data.outcome}`, obligationId, now);
    return {
      ok: true,
      value: {
        obligation: this.toView(upd[0]!, now.slice(0, 10)),
        replayed: false,
      },
    };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<
    OResult<{
      obligations: ObligationView[];
      counts: Record<State, number>;
      notice: string;
    }>
  > {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "READ",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const rows = await this.deps
      .sql`select * from mission_obligations where mission_id = ${missionId} order by due_date, obligation_id`;
    const today = this.deps.now().slice(0, 10);
    const obligations = rows.map((r) => this.toView(r, today));
    const counts: Record<State, number> = {
      DONE: 0,
      WAIVED: 0,
      OVERDUE: 0,
      DUE_SOON: 0,
      UPCOMING: 0,
    };
    for (const o of obligations) counts[o.state]++;
    return { ok: true, value: { obligations, counts, notice: NOTICE } };
  }
}
