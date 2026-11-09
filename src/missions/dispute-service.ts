import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import { GROUNDS, openProblems, refundProblems } from "./disputes.js";
import type { FulfillmentService } from "./fulfillment-service.js";
import type { LedgerService } from "./ledger-service.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M43 — disputes and refunds. A dispute needs a ground the computed fulfillment outcome supports. A person resolves it; a refund is
 * recorded only with Proof or a provider confirmation, through the ledger's own partial-refund path. A supplier's reply is a claim.
 * PayFlow does not itself pull money back here: it records a refund that provably happened.
 */
export type DspRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NOT_THE_BUYER"
  | "MEMBER_ONLY"
  | "DISPUTE_NOT_ALLOWED"
  | "ALREADY_RESOLVED"
  | "REFUND_NOT_ALLOWED"
  | "LEDGER_REFUSED";
export type DResult<T> =
  { ok: true; value: T } | { ok: false; refusal: DspRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const OpenSchema = z
  .object({
    ground: z.enum(GROUNDS),
    claimedMinor: z.number().int().safe().min(1).max(1_000_000_000_000),
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: Idem,
  })
  .strict();
export const ResolveSchema = z
  .object({
    decision: z.enum(["REFUND", "NO_REFUND"]),
    refundMinor: z.number().int().safe().min(1).optional(),
    evidenceKind: z.enum(["PAYFLOW_PROOF", "PROVIDER_CONFIRMATION"]).optional(),
    evidenceRef: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(500).default(""),
  })
  .strict();
export const EventSchema = z
  .object({
    kind: z.enum(["SUPPLIER_RESPONSE", "NOTE"]),
    text: z.string().trim().min(1).max(1000),
    idempotencyKey: Idem,
  })
  .strict();
const WithdrawSchema = z
  .object({ reason: z.string().trim().min(1).max(300) })
  .strict();

const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;
const NOTICE =
  "A dispute is a claim. Only a person resolves it, and a refund is recorded only with Proof or a provider confirmation. A supplier's reply is shown as a claim and resolves nothing.";

export interface DisputeView {
  readonly disputeId: string;
  readonly missionId: string;
  readonly orderId: string;
  readonly ground: string;
  readonly claimedMinor: number;
  readonly refundedMinor: number;
  readonly reason: string;
  readonly status: string;
  readonly openedBy: string;
  readonly snapshot: unknown;
  readonly events: { kind: string; text: string; actor: string; at: string }[];
  readonly createdAt: string;
  readonly resolutionNote: string | null;
  readonly notice: string;
}

export class DisputeService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      ledger: LedgerService;
      fulfillment: FulfillmentService;
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
        subjectKind: "MISSION_DISPUTE",
        subjectId,
        detail: {},
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async view(d: Row): Promise<DisputeView> {
    const ev = await this.deps
      .sql`select * from mission_dispute_events where dispute_id = ${String(d.dispute_id)} order by seq`;
    return {
      disputeId: String(d.dispute_id),
      missionId: String(d.mission_id),
      orderId: String(d.order_id),
      ground: String(d.ground),
      claimedMinor: Number(d.claimed_minor),
      refundedMinor: Number(d.refunded_minor),
      reason: String(d.reason),
      status: String(d.status),
      openedBy: `${String(d.opened_by_kind).toLowerCase()}:${String(d.opened_by)}`,
      snapshot: d.snapshot,
      events: ev.map((e) => ({
        kind: String(e.kind),
        text: String(e.text),
        actor: `${String(e.actor_kind).toLowerCase()}:${String(e.actor_id)}`,
        at: iso(e.occurred_at),
      })),
      createdAt: iso(d.created_at),
      resolutionNote: (d.resolution_note as string | null) ?? null,
      notice: NOTICE,
    };
  }
  private async orderRow(t: Tenant, orderId: string): Promise<Row | null> {
    if (!/^ord_[a-f0-9]{24}$/u.test(orderId)) return null;
    const [r] = await this.deps
      .sql`select o.*, p.agent_id, a.ledger_item_id from mission_orders o join missions m on m.mission_id = o.mission_id
      join mission_purchase_orders p on p.po_id = o.po_id join mission_acceptances a on a.acceptance_id = p.acceptance_id
      where o.order_id = ${orderId} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }
  private async agentGate(
    caller: MissionCaller,
    missionId: string,
    buyerId: string | null,
  ): Promise<DResult<true>> {
    if (caller.kind !== "AGENT") return { ok: true, value: true };
    if (buyerId !== null && caller.id !== buyerId)
      return { ok: false, refusal: "NOT_THE_BUYER" };
    const a = await this.deps.missions.authorizeCapability(
      caller,
      missionId,
      caller.id,
      buyerId !== null ? "PURCHASE" : "READ",
    );
    return a.allowed
      ? { ok: true, value: true }
      : { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
  }

  async open(
    caller: MissionCaller,
    orderId: string,
    rawBody: unknown,
  ): Promise<DResult<{ dispute: DisputeView; replayed: boolean }>> {
    const b = OpenSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const o = await this.orderRow(caller, orderId);
    if (!o) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(o.mission_id);
    const sql = this.deps.sql;
    const [prior] =
      await sql`select * from mission_disputes where mission_id = ${missionId} and opened_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.order_id === orderId && prior.ground === b.data.ground
        ? {
            ok: true,
            value: { dispute: await this.view(prior), replayed: true },
          }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const g = await this.agentGate(caller, missionId, String(o.agent_id));
    if (!g.ok) return g;
    const f = await this.deps.fulfillment.view(
      {
        organizationId: caller.organizationId,
        environment: caller.environment,
        id: "disputes",
        kind: "MEMBER",
      },
      orderId,
    );
    if (!f.ok) return { ok: false, refusal: "NOT_FOUND" };
    const [item] =
      await sql`select amount_minor, refunded_minor, stage from mission_ledger_items where item_id = ${String(o.ledger_item_id)}`;
    const [others] =
      await sql`select coalesce(sum(claimed_minor),0)::bigint n from mission_disputes where order_id = ${orderId} and status = 'OPEN'`;
    const [same] =
      await sql`select 1 from mission_disputes where order_id = ${orderId} and ground = ${b.data.ground} and status = 'OPEN'`;
    const problems = openProblems({
      ground: b.data.ground,
      supportedGrounds: f.value.disputeGrounds,
      claimedMinor: b.data.claimedMinor,
      paidMinor: Number(item!.amount_minor),
      alreadyRefundedMinor: Number(item!.refunded_minor),
      otherOpenClaimsMinor: Number(others!.n),
      openOnSameGround: !!same,
      ledgerSettled: item!.stage === "SETTLED" || item!.stage === "REFUNDED",
    });
    if (problems.length > 0)
      return {
        ok: false,
        refusal: "DISPUTE_NOT_ALLOWED",
        detail: problems.join(","),
      };
    const id = `dsp_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    try {
      const [row] =
        await sql`insert into mission_disputes (dispute_id, mission_id, order_id, ground, claimed_minor, reason, snapshot, opened_by_kind, opened_by, idempotency_key, created_at)
        values (${id}, ${missionId}, ${orderId}, ${b.data.ground}, ${b.data.claimedMinor}, ${b.data.reason},
         ${sql.json({ outcome: f.value.outcome, lines: f.value.lines, problems: f.value.problems } as never)}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now}) returning *`;
      await this.log(caller, "DISPUTE_OPENED", id, now);
      return {
        ok: true,
        value: { dispute: await this.view(row!), replayed: false },
      };
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return {
          ok: false,
          refusal: "DISPUTE_NOT_ALLOWED",
          detail: "ALREADY_OPEN_ON_GROUND",
        };
      throw e;
    }
  }

  private async disputeRow(t: Tenant, id: string): Promise<Row | null> {
    if (!/^dsp_[a-f0-9]{24}$/u.test(id)) return null;
    const [r] = await this.deps
      .sql`select d.*, p.agent_id, a.ledger_item_id from mission_disputes d join missions m on m.mission_id = d.mission_id
      join mission_orders o on o.order_id = d.order_id join mission_purchase_orders p on p.po_id = o.po_id
      join mission_acceptances a on a.acceptance_id = p.acceptance_id
      where d.dispute_id = ${id} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }

  async resolve(
    caller: MissionCaller,
    disputeId: string,
    rawBody: unknown,
  ): Promise<DResult<{ dispute: DisputeView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = ResolveSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const d = await this.disputeRow(caller, disputeId);
    if (!d) return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const want =
      b.data.decision === "REFUND" ? "RESOLVED_REFUNDED" : "RESOLVED_NO_REFUND";
    if (d.status !== "OPEN")
      return d.status === want &&
        (want === "RESOLVED_NO_REFUND" ||
          Number(d.refunded_minor) === b.data.refundMinor)
        ? { ok: true, value: { dispute: await this.view(d), replayed: true } }
        : { ok: false, refusal: "ALREADY_RESOLVED" };
    const now = this.deps.now();
    if (
      b.data.decision === "REFUND" &&
      (b.data.refundMinor === undefined ||
        !b.data.evidenceKind ||
        !b.data.evidenceRef)
    )
      return {
        ok: false,
        refusal: "REFUND_NOT_ALLOWED",
        detail: "REFUND_NEEDS_AMOUNT_AND_EVIDENCE",
      };
    // R0: the refund in the ledger and the dispute's resolution are ONE transaction, under a lock on the dispute. Before, a crash
    // between them left the refund applied and the dispute OPEN, and the retry's own pre-check then saw the refund already applied
    // and refused it, so the dispute could never be resolved.
    class Rollback extends Error {
      constructor(readonly refusal: DRefusalOut) {
        super("ROLLBACK");
      }
    }
    type DRefusalOut = { refusal: string; detail?: string };
    const afters: (() => Promise<void>)[] = [];
    try {
      const resolved = await sql.begin(async (tx) => {
        const [cur] =
          await tx`select status from mission_disputes where dispute_id = ${disputeId} for update`;
        if (!cur || cur.status !== "OPEN")
          throw new Rollback({ refusal: "ALREADY_RESOLVED" });
        if (b.data.decision === "REFUND") {
          const [item] =
            await tx`select amount_minor, refunded_minor from mission_ledger_items where item_id = ${String(d.ledger_item_id)} for update`;
          const problems = refundProblems({
            claimedMinor: Number(d.claimed_minor),
            refundMinor: b.data.refundMinor!,
            paidMinor: Number(item!.amount_minor),
            alreadyRefundedMinor: Number(item!.refunded_minor),
          });
          if (problems.length > 0)
            throw new Rollback({
              refusal: "REFUND_NOT_ALLOWED",
              detail: problems.join(","),
            });
          // The ledger applies the refund (it demands the evidence). Its key is fixed per dispute, so a replay is never a second refund.
          const moved = await this.deps.ledger.transitionInTx(
            tx,
            caller,
            String(d.ledger_item_id),
            {
              to: "SETTLED",
              refundMinor: b.data.refundMinor,
              evidenceKind: b.data.evidenceKind,
              evidence: { dispute: disputeId, ref: b.data.evidenceRef },
              idempotencyKey: `refund-${disputeId}`,
            },
          );
          if (!moved.ok)
            throw new Rollback({
              refusal: "LEDGER_REFUSED",
              detail: moved.refusal,
            });
          if (moved.after) afters.push(moved.after);
        }
        const [upd] =
          await tx`update mission_disputes set status = ${want}, refunded_minor = ${b.data.decision === "REFUND" ? b.data.refundMinor! : 0},
          resolved_by = ${caller.id}, resolved_at = ${now}, resolution_note = ${b.data.note || null}
          where dispute_id = ${disputeId} and status = 'OPEN' returning *`;
        if (!upd) throw new Rollback({ refusal: "ALREADY_RESOLVED" });
        return upd;
      });
      for (const after of afters) await after();
      await this.log(caller, "DISPUTE_RESOLVED", disputeId, now);
      return {
        ok: true,
        value: { dispute: await this.view(resolved), replayed: false },
      };
    } catch (e) {
      if (e instanceof Rollback)
        return {
          ok: false,
          refusal: e.refusal.refusal as "ALREADY_RESOLVED",
          ...(e.refusal.detail ? { detail: e.refusal.detail } : {}),
        };
      throw e;
    }
  }

  async withdraw(
    caller: MissionCaller,
    disputeId: string,
    rawBody: unknown,
  ): Promise<DResult<{ dispute: DisputeView; replayed: boolean }>> {
    const b = WithdrawSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const d = await this.disputeRow(caller, disputeId);
    if (!d) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT" && d.opened_by !== caller.id)
      return { ok: false, refusal: "NOT_THE_BUYER" };
    if (d.status === "WITHDRAWN")
      return {
        ok: true,
        value: { dispute: await this.view(d), replayed: true },
      };
    const now = this.deps.now();
    const upd = await this.deps
      .sql`update mission_disputes set status = 'WITHDRAWN', resolved_by = ${caller.id}, resolved_at = ${now}, resolution_note = ${b.data.reason}
      where dispute_id = ${disputeId} and status = 'OPEN' returning *`;
    if (upd.length === 0) return { ok: false, refusal: "ALREADY_RESOLVED" };
    await this.log(caller, "DISPUTE_WITHDRAWN", disputeId, now);
    return {
      ok: true,
      value: { dispute: await this.view(upd[0]!), replayed: false },
    };
  }

  async addEvent(
    caller: MissionCaller,
    disputeId: string,
    rawBody: unknown,
  ): Promise<DResult<{ dispute: DisputeView; replayed: boolean }>> {
    const b = EventSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const d = await this.disputeRow(caller, disputeId);
    if (!d) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.agentGate(
      caller,
      String(d.mission_id),
      String(d.agent_id),
    );
    if (!g.ok) return g;
    const sql = this.deps.sql;
    const [dup] =
      await sql`select * from mission_dispute_events where dispute_id = ${disputeId} and actor_id = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (dup)
      return dup.text === b.data.text && dup.kind === b.data.kind
        ? { ok: true, value: { dispute: await this.view(d), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    await sql`insert into mission_dispute_events (dispute_id, kind, text, actor_kind, actor_id, idempotency_key, occurred_at)
      values (${disputeId}, ${b.data.kind}, ${b.data.text}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${this.deps.now()})`;
    const [fresh] =
      await sql`select * from mission_disputes where dispute_id = ${disputeId}`;
    return {
      ok: true,
      value: { dispute: await this.view(fresh!), replayed: false },
    };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<DResult<{ disputes: DisputeView[] }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.agentGate(caller, missionId, null);
    if (!g.ok) return g;
    const rows = await this.deps
      .sql`select * from mission_disputes where mission_id = ${missionId} order by created_at, dispute_id`;
    const disputes: DisputeView[] = [];
    for (const r of rows) disputes.push(await this.view(r));
    return { ok: true, value: { disputes } };
  }
}
