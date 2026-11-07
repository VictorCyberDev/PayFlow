import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import {
  ORDER_STATUSES,
  canMoveOrder,
  isOverdue,
  pendingClaim,
  type OrderEventFact,
  type OrderStatus,
} from "./orders.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M41 — orders: what a settled purchase became. The status moves only on a person's VERIFIED event with evidence; an agent's
 * report, or what the supplier said, is a CLAIM shown beside it. Nothing here moves money or contacts anyone.
 */
export type OrdRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NOT_SETTLED"
  | "ALREADY_CREATED"
  | "NOT_THE_BUYER"
  | "EVIDENCE_REQUIRED"
  | "ILLEGAL_MOVE"
  | "MEMBER_ONLY";
export type OResult<T> =
  { ok: true; value: T } | { ok: false; refusal: OrdRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const CreateOrderSchema = z.object({ idempotencyKey: Idem }).strict();
export const EventSchema = z
  .object({
    kind: z.enum(["STATUS", "REFERENCE", "DELIVERY_DATE", "NOTE"]),
    status: z.enum(ORDER_STATUSES).optional(),
    value: z.string().trim().min(1).max(500).optional(),
    verify: z.boolean().default(false),
    evidenceKind: z
      .enum(["NONE", "OWNER_ATTESTATION", "DOCUMENT_REF", "CONNECTOR_CALL"])
      .default("NONE"),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: Idem,
  })
  .strict()
  .refine(
    (e) =>
      e.kind === "STATUS" ? e.status !== undefined : e.value !== undefined,
    {
      message: "the subject is missing",
    },
  )
  .refine(
    (e) =>
      e.kind !== "DELIVERY_DATE" || /^\d{4}-\d{2}-\d{2}$/u.test(e.value ?? ""),
    {
      message: "date",
    },
  );

const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;
export interface OrderEventView {
  readonly seq: number;
  readonly kind: string;
  readonly verification: string;
  readonly status: string | null;
  readonly value: string | null;
  readonly evidenceKind: string;
  readonly evidenceRef: string | null;
  readonly actor: string;
  readonly at: string;
}
export interface OrderView {
  readonly orderId: string;
  readonly missionId: string;
  readonly poId: string;
  readonly supplierId: string;
  readonly status: OrderStatus;
  readonly supplierOrderRef: string | null;
  readonly expectedDelivery: string | null;
  readonly overdue: boolean;
  /** The latest unverified status someone reported, if it differs. Shown, never believed. */
  readonly claimedStatus: OrderStatus | null;
  readonly events: OrderEventView[];
  readonly createdAt: string;
  readonly notice: string;
}
const NOTICE =
  "The status moves only when a person records it with evidence. Reports from agents or the supplier are shown as claims.";

export class OrderService {
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
    detail: Record<string, string | number>,
    now: string,
  ) {
    await this.deps.audit
      .append({
        organizationId: c.organizationId,
        environment: c.environment,
        actorKind: c.kind === "MEMBER" ? "MEMBER" : "AGENT_CREDENTIAL",
        actorId: c.id,
        action,
        subjectKind: "MISSION_ORDER",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async view(order: Row): Promise<OrderView> {
    const ev = await this.deps
      .sql`select * from mission_order_events where order_id = ${String(order.order_id)} order by seq`;
    const facts: OrderEventFact[] = ev.map((e) => ({
      kind: e.kind as OrderEventFact["kind"],
      verification: e.verification as OrderEventFact["verification"],
      status: (e.status as OrderStatus | null) ?? null,
    }));
    const status = order.status as OrderStatus;
    const expected = order.expected_delivery
      ? new Date(order.expected_delivery as string).toISOString().slice(0, 10)
      : null;
    const claim = pendingClaim(facts);
    return {
      orderId: String(order.order_id),
      missionId: String(order.mission_id),
      poId: String(order.po_id),
      supplierId: String(order.supplier_id),
      status,
      supplierOrderRef: (order.supplier_order_ref as string | null) ?? null,
      expectedDelivery: expected,
      overdue: isOverdue(status, expected, this.deps.now()),
      claimedStatus: claim && claim !== status ? claim : null,
      events: ev.map((e) => ({
        seq: Number(e.seq),
        kind: String(e.kind),
        verification: String(e.verification),
        status: (e.status as string | null) ?? null,
        value: (e.value as string | null) ?? null,
        evidenceKind: String(e.evidence_kind),
        evidenceRef: (e.evidence_ref as string | null) ?? null,
        actor: `${String(e.actor_kind).toLowerCase()}:${String(e.actor_id)}`,
        at: iso(e.occurred_at),
      })),
      createdAt: iso(order.created_at),
      notice: NOTICE,
    };
  }
  private async orderRow(t: Tenant, orderId: string): Promise<Row | null> {
    if (!/^ord_[a-f0-9]{24}$/u.test(orderId)) return null;
    const [r] = await this.deps
      .sql`select o.*, p.agent_id from mission_orders o join missions m on m.mission_id = o.mission_id
      join mission_purchase_orders p on p.po_id = o.po_id
      where o.order_id = ${orderId} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }

  async create(
    caller: MissionCaller,
    poId: string,
    rawBody: unknown,
  ): Promise<OResult<{ order: OrderView; replayed: boolean }>> {
    const b = CreateOrderSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    if (!/^po_[a-f0-9]{24}$/u.test(poId))
      return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [po] =
      await sql`select p.* from mission_purchase_orders p join missions m on m.mission_id = p.mission_id
      where p.po_id = ${poId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!po) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(po.mission_id);
    const [prior] =
      await sql`select o.* from mission_orders o where o.mission_id = ${missionId} and o.created_by = ${caller.id} and o.idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.po_id === poId
        ? { ok: true, value: { order: await this.view(prior), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    if (caller.kind === "AGENT") {
      if (caller.id !== po.agent_id)
        return { ok: false, refusal: "NOT_THE_BUYER" };
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "PURCHASE",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    // Only a purchase PayFlow itself reconciled as settled becomes an order.
    const [settled] =
      await sql`select 1 from mission_purchase_reconciliations where po_id = ${poId} and classification = 'SETTLED'`;
    if (!settled) return { ok: false, refusal: "NOT_SETTLED" };
    const id = `ord_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    try {
      const [row] =
        await sql`insert into mission_orders (order_id, mission_id, po_id, supplier_id, status, created_by_kind, created_by, idempotency_key, created_at, updated_at)
        values (${id}, ${missionId}, ${poId}, ${String(po.supplier_id)}, 'PLACED', ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now}, ${now}) returning *`;
      await this.log(caller, "ORDER_CREATED", id, {}, now);
      return {
        ok: true,
        value: { order: await this.view(row!), replayed: false },
      };
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_CREATED" };
      throw e;
    }
  }

  async record(
    caller: MissionCaller,
    orderId: string,
    rawBody: unknown,
  ): Promise<OResult<{ order: OrderView; replayed: boolean }>> {
    const b = EventSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 2)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const o = await this.orderRow(caller, orderId);
    if (!o) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(o.mission_id);
    if (caller.kind === "AGENT") {
      if (caller.id !== o.agent_id)
        return { ok: false, refusal: "NOT_THE_BUYER" };
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "PURCHASE",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
      if (b.data.verify) return { ok: false, refusal: "MEMBER_ONLY" };
    }
    if (b.data.verify && b.data.evidenceKind === "NONE")
      return { ok: false, refusal: "EVIDENCE_REQUIRED" };
    const sql = this.deps.sql;
    const verified = b.data.verify;
    const now = this.deps.now();
    const out = await sql.begin(
      async (
        tx,
      ): Promise<
        | { ok: true; replayed: boolean }
        | { ok: false; refusal: OrdRefusal; detail?: string }
      > => {
        const [cur] =
          await tx`select * from mission_orders where order_id = ${orderId} for update`;
        const [dup] =
          await tx`select * from mission_order_events where order_id = ${orderId} and actor_id = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
        if (dup) {
          const same =
            dup.kind === b.data.kind &&
            (dup.status ?? null) === (b.data.status ?? null) &&
            (dup.value ?? null) === (b.data.value ?? null);
          return same
            ? { ok: true, replayed: true }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        }
        let status = cur!.status as OrderStatus;
        if (verified && b.data.kind === "STATUS") {
          if (!canMoveOrder(status, b.data.status!))
            return {
              ok: false,
              refusal: "ILLEGAL_MOVE",
              detail: `${status}->${b.data.status!}`,
            };
          status = b.data.status!;
        }
        await tx`insert into mission_order_events (order_id, kind, verification, status, value, evidence_kind, evidence_ref, actor_kind, actor_id, idempotency_key, occurred_at)
          values (${orderId}, ${b.data.kind}, ${verified ? "VERIFIED" : "CLAIMED"}, ${b.data.status ?? null}, ${b.data.value ?? null}, ${b.data.evidenceKind},
           ${b.data.evidenceRef ?? null}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now})`;
        if (verified) {
          await tx`update mission_orders set status = ${status},
            supplier_order_ref = ${b.data.kind === "REFERENCE" ? b.data.value! : (cur!.supplier_order_ref as string | null)},
            expected_delivery = ${b.data.kind === "DELIVERY_DATE" ? b.data.value! : (cur!.expected_delivery as string | null)},
            updated_at = ${now} where order_id = ${orderId}`;
        }
        return { ok: true, replayed: false };
      },
    );
    if (!out.ok) return out;
    if (!out.replayed)
      await this.log(
        caller,
        verified ? "ORDER_EVENT_VERIFIED" : "ORDER_EVENT_CLAIMED",
        orderId,
        { kind: b.data.kind },
        now,
      );
    const [fresh] =
      await sql`select * from mission_orders where order_id = ${orderId}`;
    return {
      ok: true,
      value: { order: await this.view(fresh!), replayed: out.replayed },
    };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<OResult<{ orders: OrderView[] }>> {
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
      .sql`select * from mission_orders where mission_id = ${missionId} order by created_at, order_id`;
    const orders: OrderView[] = [];
    for (const r of rows) orders.push(await this.view(r));
    return { ok: true, value: { orders } };
  }
}
