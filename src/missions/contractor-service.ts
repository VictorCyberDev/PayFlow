import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import {
  SubmissionSchema,
  milestoneState,
  paymentDoc,
  terminationPlan,
} from "./contractor-pay.js";
import type { LedgerService } from "./ledger-service.js";
import type { Stage } from "./ledger.js";
import type { TraceReader } from "./procurement-service.js";
import {
  classify,
  digestOf,
  isForeignPayment,
  ledgerSteps,
  type PurchaseOrderDoc,
} from "./purchase.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M50 — deliverables and contractor payment. A deliverable is a claim; a person accepts it with evidence. A payment instruction is
 * derived from an accepted deliverable and says exactly what may be paid, to whom, by which agent, under which stored Authority. The agent
 * pays through the one decision path; reconciliation reads PayFlow's own trace and moves the milestone's budget item with the evidence the
 * ledger requires. PayFlow is not the payer of record for tax purposes and handles no payee onboarding here.
 */
export type CtRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "MEMBER_ONLY"
  | "NO_SUCH_MILESTONE"
  | "CONTRACT_TERMINATED"
  | "ALREADY_ACCEPTED"
  | "ALREADY_OPEN"
  | "ALREADY_DECIDED"
  | "NOT_ACCEPTED"
  | "ALREADY_ISSUED"
  | "NO_AUTHORITY"
  | "ABOVE_AUTHORITY"
  | "PAYEE_NOT_IN_AUTHORITY"
  | "MILESTONE_NOT_COMMITTED"
  | "NOT_THE_BUYER"
  | "TRACE_UNAVAILABLE"
  | "LEDGER_REFUSED"
  | "EVIDENCE_REQUIRED";
export type CResult<T> =
  { ok: true; value: T } | { ok: false; refusal: CtRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
const Ident = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const SubmitSchema = z
  .object({ submission: SubmissionSchema, idempotencyKey: Idem })
  .strict();
export const DecideSchema = z
  .object({
    decision: z.enum(["ACCEPT", "REJECT"]),
    evidenceKind: z.enum(["OWNER_ATTESTATION", "DOCUMENT_REF"]).optional(),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().max(300).default(""),
  })
  .strict();
export const PaymentSchema = z
  .object({
    agentId: Ident.optional(),
    payee: Ident,
    purpose: z.string().trim().min(1).max(300),
    ttlMinutes: z.number().int().min(1).max(10080).default(1440),
    idempotencyKey: Idem,
  })
  .strict();
export const ReconcileSchema = z.object({ proposalId: Ident }).strict();
const TerminateSchema = z
  .object({ reason: z.string().trim().min(1).max(300) })
  .strict();
const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;
type Milestone = {
  index: number;
  title: string;
  amountMinor: number;
  dueDate: string;
  ledgerItemId: string;
};
const NOTICE =
  "A deliverable is a claim until a person accepts it with evidence. A payment instruction is not a payment: the agent pays through PayFlow's Authority and PayFlow reconciles from its own record.";

export class ContractorService {
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
    now: string,
  ) {
    await this.deps.audit
      .append({
        organizationId: c.organizationId,
        environment: c.environment,
        actorKind: c.kind === "MEMBER" ? "MEMBER" : "AGENT_CREDENTIAL",
        actorId: c.id,
        action,
        subjectKind: "MISSION_CONTRACTOR_PAYMENT",
        subjectId,
        detail: {},
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async contractRow(t: Tenant, id: string): Promise<Row | null> {
    if (!/^tct_[a-f0-9]{24}$/u.test(id)) return null;
    const [r] = await this.deps
      .sql`select c.* from mission_talent_contracts c join missions m on m.mission_id = c.mission_id
      where c.contract_id = ${id} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }
  private async terminated(contractId: string): Promise<boolean> {
    const [r] = await this.deps
      .sql`select 1 from mission_contract_terminations where contract_id = ${contractId}`;
    return !!r;
  }
  private async agentOk(
    caller: MissionCaller,
    missionId: string,
    cap: "READ" | "PURCHASE",
  ): Promise<CResult<true>> {
    if (caller.kind !== "AGENT") return { ok: true, value: true };
    const a = await this.deps.missions.authorizeCapability(
      caller,
      missionId,
      caller.id,
      cap,
    );
    return a.allowed
      ? { ok: true, value: true }
      : { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
  }

  // ------------------------------------------------------------------------------------------------ view
  async list(caller: MissionCaller, missionId: string) {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" } as const;
    const g = await this.agentOk(caller, missionId, "READ");
    if (!g.ok) return g;
    const sql = this.deps.sql;
    const cons =
      await sql`select * from mission_talent_contracts where mission_id = ${missionId} order by created_at, contract_id`;
    const out = [];
    for (const c of cons) {
      const id = String(c.contract_id);
      const dels =
        await sql`select * from mission_deliverables where contract_id = ${id} order by seq`;
      const pays =
        await sql`select * from mission_contractor_payments where contract_id = ${id}`;
      const term =
        await sql`select * from mission_contract_terminations where contract_id = ${id}`;
      const items =
        await sql`select item_id, stage from mission_ledger_items where mission_id = ${missionId}`;
      const stageOf = new Map(
        items.map((i) => [String(i.item_id), String(i.stage)]),
      );
      const cancelled = new Set(
        (term[0]?.cancelled_milestones as number[] | undefined) ?? [],
      );
      out.push({
        contractId: id,
        offerId: String(c.offer_id),
        candidateId: String(c.candidate_id),
        roleId: String(c.role_id),
        currency: String(c.currency).trim(),
        totalMinor: Number(c.total_minor),
        terminated: term.length > 0,
        milestones: (c.milestones as Milestone[]).map((ms) => {
          const mine = dels.filter(
            (d) => Number(d.milestone_index) === ms.index,
          );
          const pay = pays.find((p) => Number(p.milestone_index) === ms.index);
          return {
            ...ms,
            state: milestoneState({
              deliverables: mine.map(
                (d) => d.status as "SUBMITTED" | "ACCEPTED" | "REJECTED",
              ),
              paymentIssued: !!pay,
              settled: stageOf.get(ms.ledgerItemId) === "SETTLED",
              cancelled: cancelled.has(ms.index),
            }),
            budgetStage: stageOf.get(ms.ledgerItemId) ?? null,
            deliverables: mine.map((d) => ({
              deliverableId: String(d.deliverable_id),
              status: String(d.status),
              submittedBy: `${String(d.submitted_by_kind).toLowerCase()}:${String(d.submitted_by)}`,
              submission: d.submission as unknown,
              evidenceKind: (d.evidence_kind as string | null) ?? null,
              decisionNote: (d.decision_note as string | null) ?? null,
            })),
            paymentId: pay ? String(pay.payment_id) : null,
          };
        }),
      });
    }
    return { ok: true, value: { contracts: out, notice: NOTICE } } as const;
  }

  // ------------------------------------------------------------------------------------------------ deliverables
  async submit(
    caller: MissionCaller,
    contractId: string,
    index: number,
    rawBody: unknown,
  ): Promise<
    CResult<{ deliverableId: string; status: string; replayed: boolean }>
  > {
    const b = SubmitSchema.safeParse(rawBody);
    if (!b.success || !Number.isInteger(index) || index < 1)
      return { ok: false, refusal: "MALFORMED" };
    const c = await this.contractRow(caller, contractId);
    if (!c) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(c.mission_id);
    const g = await this.agentOk(caller, missionId, "READ");
    if (!g.ok) return g;
    if (!(c.milestones as Milestone[]).some((m) => m.index === index))
      return { ok: false, refusal: "NO_SUCH_MILESTONE" };
    if (await this.terminated(contractId))
      return { ok: false, refusal: "CONTRACT_TERMINATED" };
    const sql = this.deps.sql;
    const [dup] =
      await sql`select * from mission_deliverables where mission_id = ${missionId} and submitted_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (dup)
      return dup.contract_id === contractId &&
        Number(dup.milestone_index) === index
        ? {
            ok: true,
            value: {
              deliverableId: String(dup.deliverable_id),
              status: String(dup.status),
              replayed: true,
            },
          }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const [acc] =
      await sql`select 1 from mission_deliverables where contract_id = ${contractId} and milestone_index = ${index} and status = 'ACCEPTED'`;
    if (acc) return { ok: false, refusal: "ALREADY_ACCEPTED" };
    const id = `dlv_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    try {
      await sql`insert into mission_deliverables (deliverable_id, mission_id, contract_id, milestone_index, submission, submitted_by_kind, submitted_by, idempotency_key, submitted_at)
        values (${id}, ${missionId}, ${contractId}, ${index}, ${sql.json(b.data.submission)}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now})`;
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_OPEN" };
      throw e;
    }
    await this.log(caller, "DELIVERABLE_SUBMITTED", id, now);
    return {
      ok: true,
      value: { deliverableId: id, status: "SUBMITTED", replayed: false },
    };
  }

  private async deliverableRow(t: Tenant, id: string): Promise<Row | null> {
    if (!/^dlv_[a-f0-9]{24}$/u.test(id)) return null;
    const [r] = await this.deps
      .sql`select d.* from mission_deliverables d join missions m on m.mission_id = d.mission_id
      where d.deliverable_id = ${id} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }
  async decide(
    caller: MissionCaller,
    deliverableId: string,
    rawBody: unknown,
  ): Promise<
    CResult<{ deliverableId: string; status: string; replayed: boolean }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = DecideSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const d = await this.deliverableRow(caller, deliverableId);
    if (!d) return { ok: false, refusal: "NOT_FOUND" };
    const want = b.data.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
    if (d.status !== "SUBMITTED")
      return d.status === want
        ? { ok: true, value: { deliverableId, status: want, replayed: true } }
        : { ok: false, refusal: "ALREADY_DECIDED" };
    if (await this.terminated(String(d.contract_id)))
      return { ok: false, refusal: "CONTRACT_TERMINATED" };
    if (want === "ACCEPTED" && !b.data.evidenceKind)
      return { ok: false, refusal: "EVIDENCE_REQUIRED" };
    const now = this.deps.now();
    const upd = await this.deps
      .sql`update mission_deliverables set status = ${want}, decided_by = ${caller.id}, decided_at = ${now}, evidence_kind = ${b.data.evidenceKind ?? null},
      evidence_ref = ${b.data.evidenceRef ?? null}, decision_note = ${b.data.note || null} where deliverable_id = ${deliverableId} and status = 'SUBMITTED' returning deliverable_id`;
    if (upd.length === 0) return { ok: false, refusal: "ALREADY_DECIDED" };
    await this.log(caller, `DELIVERABLE_${want}`, deliverableId, now);
    return {
      ok: true,
      value: { deliverableId, status: want, replayed: false },
    };
  }

  // ------------------------------------------------------------------------------------------------ payment instruction
  async issuePayment(
    caller: MissionCaller,
    deliverableId: string,
    rawBody: unknown,
  ): Promise<CResult<{ payment: unknown; replayed: boolean }>> {
    const b = PaymentSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const d = await this.deliverableRow(caller, deliverableId);
    if (!d) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(d.mission_id);
    const contractId = String(d.contract_id);
    const sql = this.deps.sql;
    const [prior] =
      await sql`select * from mission_contractor_payments where mission_id = ${missionId} and issued_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.deliverable_id === deliverableId
        ? { ok: true, value: { payment: this.payView(prior), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
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
    if (d.status !== "ACCEPTED") return { ok: false, refusal: "NOT_ACCEPTED" };
    if (await this.terminated(contractId))
      return { ok: false, refusal: "CONTRACT_TERMINATED" };
    const [existing] =
      await sql`select 1 from mission_contractor_payments where contract_id = ${contractId} and milestone_index = ${Number(d.milestone_index)}`;
    if (existing) return { ok: false, refusal: "ALREADY_ISSUED" };
    const c = (await this.contractRow(caller, contractId))!;
    const ms = (c.milestones as Milestone[]).find(
      (m) => m.index === Number(d.milestone_index),
    )!;
    const [item] =
      await sql`select stage from mission_ledger_items where item_id = ${ms.ledgerItemId}`;
    if (!item || item.stage !== "COMMITTED")
      return {
        ok: false,
        refusal: "MILESTONE_NOT_COMMITTED",
        detail: String(item?.stage),
      };
    const [scope] =
      await sql`select s.document from mission_talent_scopes s join mission_talent_offers o on o.scope_id = s.scope_id where o.offer_id = ${String(c.offer_id)}`;
    const category = String((scope!.document as { category: string }).category);
    const [auth] =
      await sql`select a.authority_id, a.allocation_minor, d.document from mission_authorities a join mandates d on d.id = a.authority_id
      where a.mission_id = ${missionId} and a.agent_id = ${agentId} and a.category = ${category} and a.status = 'ACTIVE'`;
    if (!auth) return { ok: false, refusal: "NO_AUTHORITY" };
    const mandate = auth.document as {
      maxSingleTransactionMinor: number;
      merchantScope: { mode: string; ids: string[] };
    };
    if (
      ms.amountMinor > mandate.maxSingleTransactionMinor ||
      ms.amountMinor > Number(auth.allocation_minor)
    )
      return { ok: false, refusal: "ABOVE_AUTHORITY" };
    if (
      mandate.merchantScope.mode !== "ONLY" ||
      !mandate.merchantScope.ids.includes(b.data.payee)
    )
      return { ok: false, refusal: "PAYEE_NOT_IN_AUTHORITY" };
    const now = this.deps.now();
    const id = `cpy_${randomBytes(12).toString("hex")}`;
    const expiresAt = new Date(
      Date.parse(now) + b.data.ttlMinutes * 60_000,
    ).toISOString();
    const doc = paymentDoc({
      currency: String(c.currency).trim(),
      milestone: ms,
      contractId,
      paymentId: id,
      agentId,
      authorityId: String(auth.authority_id),
      category,
      payee: b.data.payee,
      purpose: b.data.purpose,
      expiresAt,
    });
    try {
      const [row] =
        await sql`insert into mission_contractor_payments (payment_id, mission_id, contract_id, milestone_index, deliverable_id, agent_id, authority_id, category, payee, currency, amount_minor, document, document_digest, issued_by_kind, issued_by, idempotency_key, expires_at, created_at)
        values (${id}, ${missionId}, ${contractId}, ${ms.index}, ${deliverableId}, ${agentId}, ${doc.authorityId}, ${category}, ${b.data.payee}, ${doc.currency}, ${ms.amountMinor}, ${sql.json(doc as never)}, ${digestOf(doc)}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${expiresAt}, ${now}) returning *`;
      await this.log(caller, "CONTRACTOR_PAYMENT_ISSUED", id, now);
      return {
        ok: true,
        value: { payment: this.payView(row!), replayed: false },
      };
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_ISSUED" };
      throw e;
    }
  }
  private payView(r: Row) {
    return {
      paymentId: String(r.payment_id),
      contractId: String(r.contract_id),
      milestoneIndex: Number(r.milestone_index),
      deliverableId: String(r.deliverable_id),
      agentId: String(r.agent_id),
      authorityId: String(r.authority_id),
      payee: String(r.payee),
      currency: String(r.currency).trim(),
      amountMinor: Number(r.amount_minor),
      digest: String(r.document_digest).trim(),
      expiresAt: iso(r.expires_at),
      notice: NOTICE,
    };
  }

  // ------------------------------------------------------------------------------------------------ reconcile
  async reconcile(caller: MissionCaller, paymentId: string, rawBody: unknown) {
    const b = ReconcileSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" } as const;
    if (!/^cpy_[a-f0-9]{24}$/u.test(paymentId))
      return { ok: false, refusal: "NOT_FOUND" } as const;
    const sql = this.deps.sql;
    const [p] =
      await sql`select p.* from mission_contractor_payments p join missions m on m.mission_id = p.mission_id
      where p.payment_id = ${paymentId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!p) return { ok: false, refusal: "NOT_FOUND" } as const;
    if (caller.kind === "AGENT") {
      if (caller.id !== p.agent_id)
        return { ok: false, refusal: "NOT_THE_BUYER" } as const;
      const g = await this.agentOk(caller, String(p.mission_id), "PURCHASE");
      if (!g.ok) return g;
    }
    const doc = p.document as PurchaseOrderDoc;
    const proposalId = b.data.proposalId;
    const trace = await this.deps.traces.read(proposalId);
    if (!trace) return { ok: false, refusal: "TRACE_UNAVAILABLE" } as const;
    let { classification, problems } = classify(doc, trace) as {
      classification: string;
      problems: string[];
    };
    const [settled] =
      await sql`select proposal_id from mission_contractor_payment_reconciliations where payment_id = ${paymentId} and classification = 'SETTLED' and proposal_id <> ${proposalId} limit 1`;
    const foreign = isForeignPayment(problems);
    if (
      settled &&
      !foreign &&
      !["FAILED_NO_EFFECT", "INCOMPLETE"].includes(classification)
    ) {
      classification = "DUPLICATE";
      problems = ["PAYMENT_ALREADY_SETTLED_BY_ANOTHER_PAYMENT"];
    }
    const c = (await this.contractRow(caller, String(p.contract_id)))!;
    const ms = (c.milestones as Milestone[]).find(
      (m) => m.index === Number(p.milestone_index),
    )!;
    const stageOf = async () =>
      String(
        (
          await sql`select stage from mission_ledger_items where item_id = ${ms.ledgerItemId}`
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
      id: "contractor-payments",
      kind: "SYSTEM" as const,
    };
    for (const s of steps) {
      const moved = await this.deps.ledger.transition(system, ms.ledgerItemId, {
        to: s.to,
        evidenceKind: s.evidenceKind,
        evidence: s.evidence,
        idempotencyKey: `${paymentId}:${proposalId}:${s.to}`.padEnd(16, "-"),
      });
      if (!moved.ok)
        return {
          ok: false,
          refusal: "LEDGER_REFUSED",
          detail: moved.refusal,
        } as const;
    }
    const now = this.deps.now();
    const [had] =
      await sql`select 1 from mission_contractor_payment_reconciliations where payment_id = ${paymentId} and proposal_id = ${proposalId} and classification = ${classification}`;
    const refs = foreign
      ? {}
      : {
          receiptId: trace.references.receiptId,
          providerCaptureId: trace.references.providerCaptureId,
          providerOrderId: trace.references.providerOrderId,
        };
    await sql`insert into mission_contractor_payment_reconciliations (payment_id, proposal_id, classification, trace_status, financial_outcome, refs, problems, ledger_steps, actor_kind, actor_id, occurred_at)
      values (${paymentId}, ${proposalId}, ${classification}, ${foreign ? "WITHHELD" : trace.status}, ${foreign ? "WITHHELD" : trace.financialOutcome}, ${sql.json(refs)}, ${sql.json(problems)}, ${sql.json(steps.map((s) => s.to))}, ${caller.kind}, ${caller.id}, ${now})
      on conflict (payment_id, proposal_id, classification) do nothing`;
    await this.log(caller, "CONTRACTOR_PAYMENT_RECONCILED", paymentId, now);
    return {
      ok: true,
      value: {
        paymentId,
        proposalId,
        classification,
        problems,
        ledgerSteps: steps.map((s) => s.to),
        milestoneStage: await stageOf(),
        replayed: !!had,
      },
    } as const;
  }

  // ------------------------------------------------------------------------------------------------ terminate
  async terminate(
    caller: MissionCaller,
    contractId: string,
    rawBody: unknown,
  ): Promise<
    CResult<{
      contractId: string;
      cancelledMilestones: number[];
      keptMilestones: number[];
      replayed: boolean;
    }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = TerminateSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const c = await this.contractRow(caller, contractId);
    if (!c) return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [done] =
      await sql`select * from mission_contract_terminations where contract_id = ${contractId}`;
    if (done)
      return {
        ok: true,
        value: {
          contractId,
          cancelledMilestones: done.cancelled_milestones as number[],
          keptMilestones: done.kept_milestones as number[],
          replayed: true,
        },
      };
    const pays =
      await sql`select milestone_index from mission_contractor_payments where contract_id = ${contractId}`;
    const plan = terminationPlan(
      (c.milestones as Milestone[]).map((m) => ({
        index: m.index,
        paymentIssued: pays.some((p) => Number(p.milestone_index) === m.index),
      })),
    );
    for (const idx of plan.cancel) {
      const ms = (c.milestones as Milestone[]).find((m) => m.index === idx)!;
      const moved = await this.deps.ledger.transition(caller, ms.ledgerItemId, {
        to: "CANCELLED",
        idempotencyKey: `terminate-${contractId}-${idx}`.padEnd(16, "-"),
      });
      if (!moved.ok)
        return {
          ok: false,
          refusal: "LEDGER_REFUSED",
          detail: `${moved.refusal}@milestone${idx}`,
        };
    }
    const now = this.deps.now();
    await sql`insert into mission_contract_terminations (contract_id, reason, cancelled_milestones, kept_milestones, terminated_by, terminated_at)
      values (${contractId}, ${b.data.reason}, ${sql.json(plan.cancel)}, ${sql.json(plan.keep)}, ${caller.id}, ${now}) on conflict (contract_id) do nothing`;
    await this.log(caller, "CONTRACT_TERMINATED", contractId, now);
    return {
      ok: true,
      value: {
        contractId,
        cancelledMilestones: plan.cancel,
        keptMilestones: plan.keep,
        replayed: false,
      },
    };
  }
}
