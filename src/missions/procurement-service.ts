import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import type { LedgerService } from "./ledger-service.js";
import type { Stage } from "./ledger.js";
import {
  classify,
  digestOf,
  isForeignPayment,
  ledgerSteps,
  type PurchaseOrderDoc,
  type TraceFacts,
} from "./purchase.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M40 — from an accepted quote to a payment PayFlow can account for.
 *
 * A purchase order is an immutable instruction derived from an acceptance: who may pay (one PURCHASE agent), under which stored
 * Authority, whom, how much, for what. It does not pay. The agent pays through the one decision path. Reconciliation then reads
 * PayFlow's OWN operation trace for that payment (never the agent's report), compares it to the order exactly, and moves the budget
 * item with the evidence the ledger demands. Anything that does not match, or cannot be established, holds the budget.
 */
export type ProcRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NOT_ACCEPTED"
  | "ALREADY_ISSUED"
  | "QUOTE_EXPIRED"
  | "NO_AUTHORITY"
  | "ABOVE_AUTHORITY"
  | "MERCHANT_NOT_IN_AUTHORITY"
  | "NOT_THE_BUYER"
  | "ORDER_EXPIRED"
  | "TRACE_UNAVAILABLE"
  | "LEDGER_REFUSED";
export type PResult<T> =
  { ok: true; value: T } | { ok: false; refusal: ProcRefusal; detail?: string };

/** The operation trace for one proposal, as PayFlow itself projects it. Null when PayFlow has none. */
export interface TraceReader {
  read(proposalId: string): Promise<TraceFacts | null>;
}

const Idem = z.string().min(16).max(128);
const Ident = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const IssueSchema = z
  .object({
    agentId: Ident.optional(),
    category: Ident,
    purpose: z.string().trim().min(1).max(300),
    costCenter: z.string().trim().min(1).max(64).optional(),
    invoiceRef: z.string().trim().min(1).max(64).optional(),
    ttlMinutes: z.number().int().min(1).max(10080).default(1440),
    idempotencyKey: Idem,
  })
  .strict();
export const ReconcileSchema = z
  .object({ proposalId: Ident, idempotencyKey: Idem.optional() })
  .strict();

const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;

export interface PurchaseOrderView {
  readonly poId: string;
  readonly missionId: string;
  readonly acceptanceId: string;
  readonly supplierId: string;
  readonly quoteId: string;
  readonly agentId: string;
  readonly authorityId: string;
  readonly category: string;
  readonly merchant: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly document: PurchaseOrderDoc;
  readonly digest: string;
  readonly issuedBy: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly notice: string;
}
export interface ReconciliationView {
  readonly seq: number;
  readonly poId: string;
  readonly proposalId: string;
  readonly classification: string;
  readonly traceStatus: string;
  readonly financialOutcome: string;
  readonly problems: string[];
  readonly ledgerSteps: string[];
  readonly at: string;
}
const NOTICE =
  "A purchase order is an instruction, not a payment. The agent must still pay through PayFlow's Authority and Trust Kernel; this order only says what that payment has to match.";
const toPo = (r: Row): PurchaseOrderView => ({
  poId: String(r.po_id),
  missionId: String(r.mission_id),
  acceptanceId: String(r.acceptance_id),
  supplierId: String(r.supplier_id),
  quoteId: String(r.quote_id),
  agentId: String(r.agent_id),
  authorityId: String(r.authority_id),
  category: String(r.category),
  merchant: String(r.merchant),
  currency: String(r.currency).trim(),
  totalMinor: Number(r.total_minor),
  document: r.document as PurchaseOrderDoc,
  digest: String(r.document_digest),
  issuedBy: `${String(r.issued_by_kind).toLowerCase()}:${String(r.issued_by)}`,
  expiresAt: iso(r.expires_at),
  createdAt: iso(r.created_at),
  notice: NOTICE,
});
const toRec = (r: Row): ReconciliationView => ({
  seq: Number(r.seq),
  poId: String(r.po_id),
  proposalId: String(r.proposal_id),
  classification: String(r.classification),
  traceStatus: String(r.trace_status),
  financialOutcome: String(r.financial_outcome),
  problems: r.problems as string[],
  ledgerSteps: r.ledger_steps as string[],
  at: iso(r.occurred_at),
});

export class ProcurementService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      ledger: LedgerService;
      traces: TraceReader;
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
        subjectKind: "MISSION_PURCHASE_ORDER",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async poRow(t: Tenant, poId: string): Promise<Row | null> {
    if (!/^po_[a-f0-9]{24}$/u.test(poId)) return null;
    const [r] = await this.deps
      .sql`select p.* from mission_purchase_orders p join missions m on m.mission_id = p.mission_id
      where p.po_id = ${poId} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }

  // ---------------------------------------------------------------------------------------------------- issue
  async issue(
    caller: MissionCaller,
    acceptanceId: string,
    rawBody: unknown,
  ): Promise<PResult<{ order: PurchaseOrderView; replayed: boolean }>> {
    const b = IssueSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 2)
          .map((i) => i.path.join("."))
          .join(","),
      };
    if (!/^acc_[a-f0-9]{24}$/u.test(acceptanceId))
      return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [acc] =
      await sql`select a.* from mission_acceptances a join missions m on m.mission_id = a.mission_id
      where a.acceptance_id = ${acceptanceId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!acc) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(acc.mission_id);
    const [prior] =
      await sql`select * from mission_purchase_orders where mission_id = ${missionId} and issued_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.acceptance_id === acceptanceId
        ? { ok: true, value: { order: toPo(prior), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    // Who is the buyer: an agent buys for itself; a person names the agent.
    const agentId = caller.kind === "AGENT" ? caller.id : b.data.agentId;
    if (
      !agentId ||
      (caller.kind === "AGENT" &&
        b.data.agentId &&
        b.data.agentId !== caller.id)
    )
      return { ok: false, refusal: "MALFORMED", detail: "agentId" };
    const cap = await this.deps.missions.authorizeCapability(
      caller,
      missionId,
      agentId,
      "PURCHASE",
    );
    if (!cap.allowed)
      return { ok: false, refusal: "CAPABILITY_REFUSED", detail: cap.reason };
    if (acc.status !== "ACCEPTED")
      return { ok: false, refusal: "NOT_ACCEPTED" };
    const [existing] =
      await sql`select po_id from mission_purchase_orders where acceptance_id = ${acceptanceId}`;
    if (existing) return { ok: false, refusal: "ALREADY_ISSUED" };
    const [item] =
      await sql`select stage from mission_ledger_items where item_id = ${String(acc.ledger_item_id)}`;
    if (!item || !["APPROVED", "COMMITTED"].includes(String(item.stage)))
      return { ok: false, refusal: "NOT_ACCEPTED", detail: "LEDGER_STAGE" };
    const now = this.deps.now();
    const [q] =
      await sql`select q.*, s.external_ref from mission_quotes q join mission_suppliers s on s.supplier_id = q.supplier_id where q.quote_id = ${String(acc.quote_id)}`;
    if (!q || new Date(q.valid_until as string).getTime() <= Date.parse(now))
      return { ok: false, refusal: "QUOTE_EXPIRED" };
    const [auth] =
      await sql`select a.authority_id, a.allocation_minor, d.document
      from mission_authorities a join mandates d on d.id = a.authority_id
      where a.mission_id = ${missionId} and a.agent_id = ${agentId} and a.category = ${b.data.category} and a.status = 'ACTIVE'`;
    if (!auth) return { ok: false, refusal: "NO_AUTHORITY" };
    const mandate = auth.document as {
      maxSingleTransactionMinor: number;
      merchantScope: { mode: string; ids: string[] };
    };
    const total = Number(acc.total_minor);
    const merchant = String(q.external_ref);
    if (
      total > mandate.maxSingleTransactionMinor ||
      total > Number(auth.allocation_minor)
    )
      return { ok: false, refusal: "ABOVE_AUTHORITY" };
    if (
      mandate.merchantScope.mode !== "ONLY" ||
      !mandate.merchantScope.ids.includes(merchant)
    )
      return { ok: false, refusal: "MERCHANT_NOT_IN_AUTHORITY" };
    const document = q.document as {
      lines: {
        sku?: string;
        description: string;
        quantity: number;
        unitPrice: { basis: string; minor?: number };
      }[];
    };
    const poId = `po_${randomBytes(12).toString("hex")}`;
    const expiresAt = new Date(
      Math.min(
        new Date(q.valid_until as string).getTime(),
        Date.parse(now) + b.data.ttlMinutes * 60_000,
      ),
    ).toISOString();
    const doc: PurchaseOrderDoc = {
      merchant,
      currency: String(acc.currency).trim(),
      totalMinor: total,
      lines: document.lines.map((l) => ({
        sku: l.sku ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor:
          l.unitPrice.basis === "UNKNOWN" ? null : (l.unitPrice.minor ?? null),
      })),
      category: b.data.category,
      purpose: b.data.purpose,
      costCenter: b.data.costCenter ?? null,
      invoiceRef: b.data.invoiceRef ?? null,
      quoteId: String(acc.quote_id),
      acceptanceId,
      authorityId: String(auth.authority_id),
      agentId,
      requestId: poId,
      expiresAt,
    };
    try {
      const [row] = await sql`insert into mission_purchase_orders
        (po_id, mission_id, acceptance_id, supplier_id, quote_id, agent_id, authority_id, category, merchant, currency, total_minor,
         document, document_digest, issued_by_kind, issued_by, idempotency_key, expires_at, created_at)
        values (${poId}, ${missionId}, ${acceptanceId}, ${String(acc.supplier_id)}, ${String(acc.quote_id)}, ${agentId}, ${doc.authorityId},
         ${doc.category}, ${merchant}, ${doc.currency}, ${total}, ${sql.json(doc as never)}, ${digestOf(doc)}, ${caller.kind}, ${caller.id},
         ${b.data.idempotencyKey}, ${expiresAt}, ${now}) returning *`;
      await this.log(caller, "PURCHASE_ORDER_ISSUED", poId, { total }, now);
      return { ok: true, value: { order: toPo(row!), replayed: false } };
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_ISSUED" };
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------------- read
  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<
    PResult<{
      orders: PurchaseOrderView[];
      reconciliations: ReconciliationView[];
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
    const o = await this.deps
      .sql`select * from mission_purchase_orders where mission_id = ${missionId} order by created_at, po_id`;
    const r = await this.deps
      .sql`select r.* from mission_purchase_reconciliations r
      join mission_purchase_orders p on p.po_id = r.po_id where p.mission_id = ${missionId} order by r.seq`;
    return {
      ok: true,
      value: { orders: o.map(toPo), reconciliations: r.map(toRec) },
    };
  }

  // ---------------------------------------------------------------------------------------------------- reconcile
  async reconcile(
    caller: MissionCaller,
    poId: string,
    rawBody: unknown,
  ): Promise<
    PResult<{
      reconciliation: ReconciliationView;
      itemStage: string;
      replayed: boolean;
    }>
  > {
    const b = ReconcileSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const po = await this.poRow(caller, poId);
    if (!po) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(po.mission_id);
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
    const sql = this.deps.sql;
    const doc = po.document as PurchaseOrderDoc;
    const proposalId = b.data.proposalId;
    // PayFlow's own record of the payment. If it has none, nothing can be concluded.
    const trace = await this.deps.traces.read(proposalId);
    if (!trace) return { ok: false, refusal: "TRACE_UNAVAILABLE" };
    let { classification, problems } = classify(doc, trace) as {
      classification: string;
      problems: string[];
    };
    const [settled] =
      await sql`select proposal_id from mission_purchase_reconciliations where po_id = ${poId} and classification = 'SETTLED' and proposal_id <> ${proposalId} limit 1`;
    const foreign = isForeignPayment(problems);
    if (
      settled &&
      !foreign &&
      !["FAILED_NO_EFFECT", "INCOMPLETE"].includes(classification)
    ) {
      classification = "DUPLICATE";
      problems = ["ORDER_ALREADY_SETTLED_BY_ANOTHER_PAYMENT"];
    }
    const itemId = String(
      (
        await sql`select ledger_item_id from mission_acceptances where acceptance_id = ${String(po.acceptance_id)}`
      )[0]!.ledger_item_id,
    );
    const stageOf = async () =>
      String(
        (
          await sql`select stage from mission_ledger_items where item_id = ${itemId}`
        )[0]!.stage,
      );
    const from = (await stageOf()) as Stage;
    const steps =
      foreign ||
      classification === "DUPLICATE" ||
      classification === "INCOMPLETE"
        ? []
        : ledgerSteps(
            from,
            classification as Parameters<typeof ledgerSteps>[1],
            trace,
            proposalId,
          );
    const system = {
      organizationId: caller.organizationId,
      environment: caller.environment,
      id: "procurement",
      kind: "SYSTEM" as const,
    };
    for (const s of steps) {
      const moved = await this.deps.ledger.transition(system, itemId, {
        to: s.to,
        evidenceKind: s.evidenceKind,
        evidence: s.evidence,
        idempotencyKey: `${poId}:${proposalId}:${s.to}`.padEnd(16, "-"),
      });
      if (!moved.ok)
        return { ok: false, refusal: "LEDGER_REFUSED", detail: moved.refusal };
    }
    const now = this.deps.now();
    const [had] =
      await sql`select 1 from mission_purchase_reconciliations where po_id = ${poId} and proposal_id = ${proposalId} and classification = ${classification}`;
    // A person who is not the order's buyer may look, but a foreign payment's references are never stored or echoed.
    const refs = foreign
      ? {}
      : {
          receiptId: trace.references.receiptId,
          providerCaptureId: trace.references.providerCaptureId,
          providerOrderId: trace.references.providerOrderId,
        };
    await sql`insert into mission_purchase_reconciliations
      (po_id, proposal_id, classification, trace_status, financial_outcome, refs, problems, ledger_steps, actor_kind, actor_id, occurred_at)
      values (${poId}, ${proposalId}, ${classification}, ${foreign ? "WITHHELD" : trace.status}, ${foreign ? "WITHHELD" : trace.financialOutcome},
       ${sql.json(refs)}, ${sql.json(problems)}, ${sql.json(steps.map((s) => s.to))}, ${caller.kind}, ${caller.id}, ${now})
      on conflict (po_id, proposal_id, classification) do nothing`;
    const [rec] =
      await sql`select * from mission_purchase_reconciliations where po_id = ${poId} and proposal_id = ${proposalId} and classification = ${classification}`;
    await this.log(
      caller,
      "PURCHASE_RECONCILED",
      poId,
      { classification, steps: steps.length },
      now,
    );
    return {
      ok: true,
      value: {
        reconciliation: toRec(rec!),
        itemStage: await stageOf(),
        replayed: !!had,
      },
    };
  }
}
