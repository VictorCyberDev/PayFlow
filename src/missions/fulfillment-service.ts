import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import {
  disputeGrounds,
  fulfillment,
  type Condition,
  type ReceiptFact,
} from "./fulfillment.js";
import { isOverdue, type OrderStatus } from "./orders.js";
import type { PurchaseOrderDoc } from "./purchase.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M42 — fulfillment: shipments (claims until a person verifies them) and receipts (a person's counts of what physically arrived).
 * The outcome is computed from the purchase order's lines and the receipts; nobody declares it.
 */
export type FulRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NOT_THE_BUYER"
  | "MEMBER_ONLY"
  | "EVIDENCE_REQUIRED"
  | "ORDER_NOT_SHIPPED"
  | "NO_SUCH_LINE";
export type FResult<T> =
  { ok: true; value: T } | { ok: false; refusal: FulRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const ShipmentSchema = z
  .object({
    carrier: z.string().trim().min(1).max(80),
    trackingRef: z.string().trim().min(1).max(120),
    expectedDelivery: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    verify: z.boolean().default(false),
    evidenceKind: z
      .enum(["NONE", "OWNER_ATTESTATION", "DOCUMENT_REF", "CONNECTOR_CALL"])
      .default("NONE"),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: Idem,
  })
  .strict();
export const ReceiptSchema = z
  .object({
    lineIndex: z.number().int().min(0).max(49),
    quantity: z.number().int().min(1).max(1_000_000),
    condition: z.enum(["OK", "DAMAGED", "WRONG_ITEM"]),
    evidenceKind: z.enum(["OWNER_ATTESTATION", "DOCUMENT_REF"]),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().min(1).max(300).optional(),
    idempotencyKey: Idem,
  })
  .strict();

const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;
const NOTICE =
  "Receipts are a person's counts. The outcome is computed from them and the purchase order; shipments from agents or suppliers are claims.";

export class FulfillmentService {
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
        subjectKind: "MISSION_FULFILLMENT",
        subjectId,
        detail: {},
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async orderRow(t: Tenant, orderId: string): Promise<Row | null> {
    if (!/^ord_[a-f0-9]{24}$/u.test(orderId)) return null;
    const [r] = await this.deps
      .sql`select o.*, p.agent_id, p.document as po_doc from mission_orders o join missions m on m.mission_id = o.mission_id
      join mission_purchase_orders p on p.po_id = o.po_id
      where o.order_id = ${orderId} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }
  private async buyerGate(
    caller: MissionCaller,
    o: Row,
    capability: "PURCHASE" | "READ",
  ): Promise<FResult<true>> {
    if (caller.kind !== "AGENT") return { ok: true, value: true };
    if (capability === "PURCHASE" && caller.id !== o.agent_id)
      return { ok: false, refusal: "NOT_THE_BUYER" };
    const a = await this.deps.missions.authorizeCapability(
      caller,
      String(o.mission_id),
      caller.id,
      capability,
    );
    return a.allowed
      ? { ok: true, value: true }
      : { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
  }

  async view(caller: MissionCaller, orderId: string) {
    const o = await this.orderRow(caller, orderId);
    if (!o) return { ok: false, refusal: "NOT_FOUND" } as const;
    const g = await this.buyerGate(caller, o, "READ");
    if (!g.ok) return g;
    const sql = this.deps.sql;
    const lines = (o.po_doc as PurchaseOrderDoc).lines;
    const rc =
      await sql`select * from mission_receipts where order_id = ${orderId} order by seq`;
    const sh =
      await sql`select * from mission_shipments where order_id = ${orderId} order by seq`;
    const facts: ReceiptFact[] = rc.map((r) => ({
      lineIndex: Number(r.line_index),
      quantity: Number(r.quantity),
      condition: r.condition as Condition,
    }));
    const f = fulfillment(lines, facts);
    const expected = o.expected_delivery
      ? new Date(o.expected_delivery as string).toISOString().slice(0, 10)
      : null;
    const late = isOverdue(o.status as OrderStatus, expected, this.deps.now());
    return {
      ok: true,
      value: {
        orderId,
        orderStatus: String(o.status),
        outcome: f.outcome,
        lines: f.lines,
        problems: f.problems,
        disputeGrounds: disputeGrounds(f.lines, late),
        shipments: sh.map((s) => ({
          shipmentId: String(s.shipment_id),
          carrier: String(s.carrier),
          trackingRef: String(s.tracking_ref),
          expectedDelivery: s.expected_delivery
            ? new Date(s.expected_delivery as string).toISOString().slice(0, 10)
            : null,
          verification: String(s.verification),
          actor: `${String(s.actor_kind).toLowerCase()}:${String(s.actor_id)}`,
          at: iso(s.occurred_at),
        })),
        receipts: rc.map((r) => ({
          receiptId: String(r.receipt_id),
          lineIndex: Number(r.line_index),
          quantity: Number(r.quantity),
          condition: String(r.condition),
          evidenceKind: String(r.evidence_kind),
          note: (r.note as string | null) ?? null,
          at: iso(r.occurred_at),
        })),
        notice: NOTICE,
      },
    } as const;
  }

  async addShipment(
    caller: MissionCaller,
    orderId: string,
    rawBody: unknown,
  ): Promise<
    FResult<{ shipmentId: string; verification: string; replayed: boolean }>
  > {
    const b = ShipmentSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const o = await this.orderRow(caller, orderId);
    if (!o) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.buyerGate(caller, o, "PURCHASE");
    if (!g.ok) return g;
    if (b.data.verify && caller.kind !== "MEMBER")
      return { ok: false, refusal: "MEMBER_ONLY" };
    if (b.data.verify && b.data.evidenceKind === "NONE")
      return { ok: false, refusal: "EVIDENCE_REQUIRED" };
    const sql = this.deps.sql;
    const [dup] =
      await sql`select * from mission_shipments where order_id = ${orderId} and actor_id = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (dup)
      return dup.tracking_ref === b.data.trackingRef
        ? {
            ok: true,
            value: {
              shipmentId: String(dup.shipment_id),
              verification: String(dup.verification),
              replayed: true,
            },
          }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const id = `shp_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    const verification = b.data.verify ? "VERIFIED" : "CLAIMED";
    await sql`insert into mission_shipments (shipment_id, order_id, carrier, tracking_ref, expected_delivery, verification, evidence_kind, evidence_ref, actor_kind, actor_id, idempotency_key, occurred_at)
      values (${id}, ${orderId}, ${b.data.carrier}, ${b.data.trackingRef}, ${b.data.expectedDelivery ?? null}, ${verification}, ${b.data.evidenceKind},
       ${b.data.evidenceRef ?? null}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now})`;
    await this.log(caller, `SHIPMENT_${verification}`, id, now);
    return {
      ok: true,
      value: { shipmentId: id, verification, replayed: false },
    };
  }

  async addReceipt(
    caller: MissionCaller,
    orderId: string,
    rawBody: unknown,
  ): Promise<FResult<{ receiptId: string; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = ReceiptSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const o = await this.orderRow(caller, orderId);
    if (!o) return { ok: false, refusal: "NOT_FOUND" };
    const lines = (o.po_doc as PurchaseOrderDoc).lines;
    if (b.data.lineIndex >= lines.length)
      return { ok: false, refusal: "NO_SUCH_LINE" };
    if (!["SHIPPED", "DELIVERED", "IN_DISPUTE"].includes(String(o.status)))
      return {
        ok: false,
        refusal: "ORDER_NOT_SHIPPED",
        detail: String(o.status),
      };
    const sql = this.deps.sql;
    const [dup] =
      await sql`select * from mission_receipts where order_id = ${orderId} and actor_id = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (dup)
      return dup.line_index === b.data.lineIndex &&
        dup.quantity === b.data.quantity &&
        dup.condition === b.data.condition
        ? {
            ok: true,
            value: { receiptId: String(dup.receipt_id), replayed: true },
          }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const id = `rcp_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    await sql`insert into mission_receipts (receipt_id, order_id, line_index, quantity, condition, evidence_kind, evidence_ref, note, actor_id, idempotency_key, occurred_at)
      values (${id}, ${orderId}, ${b.data.lineIndex}, ${b.data.quantity}, ${b.data.condition}, ${b.data.evidenceKind}, ${b.data.evidenceRef ?? null},
       ${b.data.note ?? null}, ${caller.id}, ${b.data.idempotencyKey}, ${now})`;
    await this.log(caller, "RECEIPT_RECORDED", id, now);
    return { ok: true, value: { receiptId: id, replayed: false } };
  }
}
