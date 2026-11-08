import type { Sql } from "postgres";
import type { FulfillmentService } from "./fulfillment-service.js";
import {
  buildPortfolio,
  DEFAULT_MAX_SHARE_BPS,
  type Portfolio,
  type SupplierFacts,
} from "./portfolio.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M45 — the multi-vendor view: spend by supplier, concentration, trouble open per supplier and whether the mission can be closed
 * out. Read-only; it is computed from the ledger, orders, disputes and obligations when asked and stored nowhere.
 */
export type PfRefusal = "MALFORMED" | "NOT_FOUND" | "CAPABILITY_REFUSED";
export type PResult<T> =
  { ok: true; value: T } | { ok: false; refusal: PfRefusal; detail?: string };

const SETTLED_STAGES = ["SETTLED", "REFUNDED"];
const PENDING_STAGES = [
  "APPROVED",
  "COMMITTED",
  "RESERVED",
  "IN_FLIGHT",
  "UNKNOWN",
];

export class PortfolioService {
  constructor(
    private readonly deps: {
      sql: Sql;
      missions: MissionService;
      fulfillment: FulfillmentService;
      now: () => string;
    },
  ) {}

  async get(
    caller: MissionCaller,
    missionId: string,
    maxShareBps?: number,
  ): Promise<PResult<Portfolio & { asOf: string; notice: string }>> {
    if (
      maxShareBps !== undefined &&
      (!Number.isInteger(maxShareBps) || maxShareBps < 1 || maxShareBps > 10000)
    )
      return { ok: false, refusal: "MALFORMED", detail: "maxShareBps" };
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
    const now = this.deps.now();
    const today = now.slice(0, 10);
    const sup =
      await sql`select supplier_id, display_name from mission_suppliers where mission_id = ${missionId}`;
    const names = new Map(
      sup.map((s) => [String(s.supplier_id), String(s.display_name)]),
    );
    const items =
      await sql`select a.supplier_id, i.stage, i.amount_minor, i.refunded_minor from mission_acceptances a
      join mission_ledger_items i on i.item_id = a.ledger_item_id where a.mission_id = ${missionId} and a.status = 'ACCEPTED'`;
    const orders =
      await sql`select order_id, supplier_id, status from mission_orders where mission_id = ${missionId}`;
    const disputes =
      await sql`select o.supplier_id, count(*)::int n from mission_disputes d join mission_orders o on o.order_id = d.order_id
      where d.mission_id = ${missionId} and d.status = 'OPEN' group by o.supplier_id`;
    const overdue =
      await sql`select o.supplier_id, count(*)::int n from mission_obligations b join mission_orders o on o.order_id = b.order_id
      where b.mission_id = ${missionId} and b.status = 'OPEN' and b.due_date < ${today} group by o.supplier_id`;
    const ids = new Set<string>([
      ...items.map((r) => String(r.supplier_id)),
      ...orders.map((r) => String(r.supplier_id)),
    ]);
    const reader: MissionCaller = {
      organizationId: caller.organizationId,
      environment: caller.environment,
      id: "portfolio",
      kind: "MEMBER",
    };
    const issuesBy = new Map<string, number>();
    for (const o of orders) {
      const f = await this.deps.fulfillment.view(reader, String(o.order_id));
      if (f.ok && f.value.outcome === "HAS_ISSUES")
        issuesBy.set(
          String(o.supplier_id),
          (issuesBy.get(String(o.supplier_id)) ?? 0) + 1,
        );
    }
    const count = (rows: readonly Record<string, unknown>[], id: string) =>
      Number(rows.find((r) => String(r.supplier_id) === id)?.n ?? 0);
    const facts: SupplierFacts[] = [...ids].sort().map((id) => {
      const mine = items.filter((r) => String(r.supplier_id) === id);
      let spent = 0;
      let pending = 0;
      let refunded = 0;
      let unknown = 0;
      for (const r of mine) {
        const amount = Number(r.amount_minor);
        const ref = Number(r.refunded_minor);
        const stage = String(r.stage);
        refunded += ref;
        if (SETTLED_STAGES.includes(stage)) spent += amount - ref;
        else if (PENDING_STAGES.includes(stage)) pending += amount;
        if (stage === "UNKNOWN") unknown++;
      }
      const os = orders.filter((r) => String(r.supplier_id) === id);
      return {
        supplierId: id,
        name: names.get(id) ?? id,
        spentMinor: spent,
        pendingMinor: pending,
        refundedMinor: refunded,
        unknownOutcomes: unknown,
        orders: {
          total: os.length,
          delivered: os.filter((r) => r.status === "DELIVERED").length,
          cancelled: os.filter((r) => r.status === "CANCELLED").length,
          inDispute: os.filter((r) => r.status === "IN_DISPUTE").length,
        },
        openDisputes: count(disputes, id),
        overdueObligations: count(overdue, id),
        orderIssues: issuesBy.get(id) ?? 0,
      };
    });
    return {
      ok: true,
      value: {
        ...buildPortfolio(facts, maxShareBps ?? DEFAULT_MAX_SHARE_BPS),
        asOf: now,
        notice:
          "Computed when asked from the ledger, orders, disputes and obligations. It decides and moves nothing.",
      },
    };
  }
}
