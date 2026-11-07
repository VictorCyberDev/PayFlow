import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import {
  evaluateAcceptance,
  type AcceptanceFacts,
  type Evaluation,
} from "./acceptance.js";
import type { LedgerService } from "./ledger-service.js";
import type { NegotiationService } from "./negotiation-service.js";
import type { QualificationService } from "./qualification-service.js";
import type { QuoteService, QuoteView } from "./quote-service.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M39 — accepting a supplier's quote, and handing the decision to a person when it is not the agent's to make.
 *
 * Acceptance approves the quote's ledger item (committing the budget) and concludes the negotiation. It tells the supplier nothing and
 * pays nothing. A person cannot exceed the walk-away (revise the rules first) but may accept a quote that misses a term floor by
 * saying why. An agent accepts alone only when the approved rules say so, it holds CONTRACT, and every check holds; otherwise its
 * request becomes an escalation for a person.
 */
export type AccRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CHECKS_FAILED"
  | "OVERRIDE_REQUIRED"
  | "ALREADY_RESOLVED"
  | "LEDGER_REFUSED"
  | "MEMBER_ONLY"
  | "NOT_ACCEPTED";
export type AccResult<T> =
  { ok: true; value: T } | { ok: false; refusal: AccRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const AcceptSchema = z
  .object({
    idempotencyKey: Idem,
    overrideReason: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
const WithdrawSchema = z
  .object({ reason: z.string().trim().min(1).max(300) })
  .strict();
export const EscalateSchema = z
  .object({
    kind: z.enum(["ACCEPTANCE_REQUEST", "WALK_AWAY_REQUEST"]),
    quoteId: z
      .string()
      .regex(/^qte_[a-f0-9]{24}$/u)
      .optional(),
    negotiationId: z
      .string()
      .regex(/^ngt_[a-f0-9]{24}$/u)
      .optional(),
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: Idem,
  })
  .strict()
  .refine(
    (e) =>
      e.kind === "ACCEPTANCE_REQUEST"
        ? e.quoteId !== undefined
        : e.negotiationId !== undefined,
    { message: "the subject is missing" },
  );
const ResolveSchema = z
  .object({
    decision: z.enum(["ACCEPT", "DECLINE", "DISMISS"]),
    note: z.string().trim().max(300).default(""),
    overrideReason: z.string().trim().min(1).max(300).optional(),
    idempotencyKey: Idem.optional(),
  })
  .strict();

const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;

export interface AcceptanceView {
  readonly acceptanceId: string;
  readonly missionId: string;
  readonly supplierId: string;
  readonly quoteId: string;
  readonly negotiationId: string | null;
  readonly totalMinor: number;
  readonly currency: string;
  readonly basis: string;
  readonly acceptedBy: string;
  readonly checks: unknown;
  readonly overrideReason: string | null;
  readonly ledgerItemId: string;
  readonly status: "ACCEPTED" | "WITHDRAWN";
  readonly createdAt: string;
  readonly notice: string;
}
const NOTICE =
  "Accepting committed the budget inside PayFlow. It did not tell the supplier and did not pay anyone.";
const toAcceptance = (r: Row): AcceptanceView => ({
  acceptanceId: String(r.acceptance_id),
  missionId: String(r.mission_id),
  supplierId: String(r.supplier_id),
  quoteId: String(r.quote_id),
  negotiationId: (r.negotiation_id as string | null) ?? null,
  totalMinor: Number(r.total_minor),
  currency: String(r.currency).trim(),
  basis: String(r.basis),
  acceptedBy: `${String(r.accepted_by_kind).toLowerCase()}:${String(r.accepted_by)}`,
  checks: r.checks,
  overrideReason: (r.override_reason as string | null) ?? null,
  ledgerItemId: String(r.ledger_item_id),
  status: r.status as AcceptanceView["status"],
  createdAt: iso(r.created_at),
  notice: NOTICE,
});
export interface EscalationView {
  readonly escalationId: string;
  readonly kind: string;
  readonly quoteId: string | null;
  readonly negotiationId: string | null;
  readonly reason: string;
  readonly snapshot: unknown;
  readonly requestedBy: string;
  readonly status: string;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
  readonly createdAt: string;
}
const toEscalation = (r: Row): EscalationView => ({
  escalationId: String(r.escalation_id),
  kind: String(r.kind),
  quoteId: (r.quote_id as string | null) ?? null,
  negotiationId: (r.negotiation_id as string | null) ?? null,
  reason: String(r.reason),
  snapshot: r.snapshot,
  requestedBy: `${String(r.requested_by_kind).toLowerCase()}:${String(r.requested_by)}`,
  status: String(r.status),
  resolvedBy: (r.resolved_by as string | null) ?? null,
  resolutionNote: (r.resolution_note as string | null) ?? null,
  createdAt: iso(r.created_at),
});

export class AcceptanceService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      quotes: QuoteService;
      qualification: QualificationService;
      negotiations: NegotiationService;
      ledger: LedgerService;
      now: () => string;
    },
  ) {}

  private reader(t: Tenant): MissionCaller {
    return {
      organizationId: t.organizationId,
      environment: t.environment,
      id: "acceptance",
      kind: "MEMBER",
    };
  }
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
        subjectKind: "MISSION_ACCEPTANCE",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async quoteRow(
    t: Tenant,
    quoteId: string,
  ): Promise<{ missionId: string; view: QuoteView } | null> {
    if (!/^qte_[a-f0-9]{24}$/u.test(quoteId)) return null;
    const [r] = await this.deps
      .sql`select q.mission_id from mission_quotes q join missions m on m.mission_id = q.mission_id
      where q.quote_id = ${quoteId} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    if (!r) return null;
    const l = await this.deps.quotes.list(this.reader(t), String(r.mission_id));
    const view = l.ok
      ? l.value.quotes.find((q) => q.quoteId === quoteId)
      : undefined;
    return view ? { missionId: String(r.mission_id), view } : null;
  }
  /** Everything the checklist needs, read now. */
  private async facts(t: Tenant, missionId: string, q: QuoteView) {
    const m = await this.deps.missions.get(t, missionId);
    if (!m.ok) return null;
    const contract = m.value.activeContract ?? m.value.latestContract;
    const ql = await this.deps.qualification.list(this.reader(t), missionId);
    const outcome = ql.ok
      ? ((ql.value.suppliers as { supplierId: string; outcome: string }[]).find(
          (s) => s.supplierId === q.supplierId,
        )?.outcome ?? "UNKNOWN")
      : "UNKNOWN";
    const nl = await this.deps.negotiations.list(this.reader(t), missionId);
    const neg = nl.ok
      ? nl.value.negotiations.find((n) => n.supplierId === q.supplierId)
      : undefined;
    const led = await this.deps.ledger.overview(this.reader(t), missionId);
    const [acc] = await this.deps
      .sql`select 1 from mission_acceptances where quote_id = ${q.quoteId}`;
    const [concl] = neg
      ? await this.deps
          .sql`select 1 from mission_acceptances where negotiation_id = ${neg.negotiationId} and status = 'ACCEPTED'`
      : [];
    const facts: AcceptanceFacts = {
      missionActive: m.value.status === "ACTIVE",
      quote: {
        current: q.status === "CURRENT",
        complete: q.landed.complete,
        currency: q.currency,
        totalMinor: q.landed.totalMinor,
        terms: {
          ...(q.document.terms.warrantyMonths !== undefined
            ? { warrantyMonths: q.document.terms.warrantyMonths }
            : {}),
          ...(q.document.terms.returnWindowDays !== undefined
            ? { returnWindowDays: q.document.terms.returnWindowDays }
            : {}),
          ...(q.document.terms.deliveryDays !== undefined
            ? { deliveryDays: q.document.terms.deliveryDays }
            : {}),
        },
      },
      missionCurrency: contract.currency,
      maxCommitmentMinor: contract.maxCommitmentMinor,
      availableMinor: led.ok ? led.value.summary.availableMinor : null,
      supplierOutcome: outcome as AcceptanceFacts["supplierOutcome"],
      rules: neg?.inForce?.document ?? null,
      negotiationExists: !!neg,
      alreadyAccepted: !!acc,
      negotiationConcluded: !!concl,
      requireApprovalToContract:
        contract.approvalConditions.requireApprovalToContract,
      humanApprovalAboveMinor:
        contract.approvalConditions.humanApprovalAboveMinor,
    };
    return {
      facts,
      negotiation: neg ?? null,
      evaluation: evaluateAcceptance(facts),
    };
  }

  // ---------------------------------------------------------------------------------------------------- read
  async evaluate(
    caller: MissionCaller,
    quoteId: string,
  ): Promise<
    AccResult<{
      quoteId: string;
      evaluation: Evaluation;
      personMayAccept: boolean;
      agentMayAccept: boolean;
    }>
  > {
    const q = await this.quoteRow(caller, quoteId);
    if (!q) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        q.missionId,
        caller.id,
        "READ",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const f = await this.facts(caller, q.missionId, q.view);
    if (!f) return { ok: false, refusal: "NOT_FOUND" };
    return {
      ok: true,
      value: {
        quoteId,
        evaluation: f.evaluation,
        personMayAccept: f.evaluation.personMayAccept,
        agentMayAccept: f.evaluation.agentMayAccept,
      },
    };
  }
  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<
    AccResult<{ acceptances: AcceptanceView[]; escalations: EscalationView[] }>
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
    const a = await this.deps
      .sql`select * from mission_acceptances where mission_id = ${missionId} order by created_at, acceptance_id`;
    const e = await this.deps
      .sql`select * from mission_escalations where mission_id = ${missionId} order by created_at, escalation_id`;
    return {
      ok: true,
      value: {
        acceptances: a.map(toAcceptance),
        escalations: e.map(toEscalation),
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------- accept
  async accept(
    caller: MissionCaller,
    quoteId: string,
    rawBody: unknown,
  ): Promise<
    AccResult<
      | { outcome: "ACCEPTED"; acceptance: AcceptanceView; replayed: boolean }
      | { outcome: "ESCALATED"; escalation: EscalationView; replayed: boolean }
    >
  > {
    const b = AcceptSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 2)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const q = await this.quoteRow(caller, quoteId);
    if (!q) return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [prior] =
      await sql`select * from mission_acceptances where mission_id = ${q.missionId} and accepted_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.quote_id === quoteId
        ? {
            ok: true,
            value: {
              outcome: "ACCEPTED",
              acceptance: toAcceptance(prior),
              replayed: true,
            },
          }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        q.missionId,
        caller.id,
        "CONTRACT",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const f = await this.facts(caller, q.missionId, q.view);
    if (!f) return { ok: false, refusal: "NOT_FOUND" };
    const ev = f.evaluation;
    if (!ev.personMayAccept)
      return {
        ok: false,
        refusal: "CHECKS_FAILED",
        detail: ev.hardFailures.join(","),
      };
    let basis: "PERSON" | "AGENT_WITHIN_LIMITS" = "PERSON";
    let override: string | null = null;
    if (caller.kind === "AGENT") {
      const named =
        f.negotiation?.inForce?.document.negotiatorAgentId === caller.id;
      if (!(ev.agentMayAccept && named)) {
        // Not the agent's decision: hand it to a person instead of failing silently.
        const esc = await this.escalate(caller, {
          kind: "ACCEPTANCE_REQUEST",
          quoteId,
          reason: ev.softFailures.length
            ? `Terms below the floor: ${ev.softFailures.join(", ")}`
            : "Acceptance is a person's decision under the approved rules.",
          idempotencyKey: b.data.idempotencyKey,
        });
        return esc.ok
          ? {
              ok: true,
              value: {
                outcome: "ESCALATED",
                escalation: esc.value.escalation,
                replayed: esc.value.replayed,
              },
            }
          : esc;
      }
      basis = "AGENT_WITHIN_LIMITS";
    } else {
      if (ev.softFailures.length > 0) {
        if (!b.data.overrideReason)
          return {
            ok: false,
            refusal: "OVERRIDE_REQUIRED",
            detail: ev.softFailures.join(","),
          };
        override = b.data.overrideReason;
      }
    }
    return this.commit(
      caller,
      q,
      f.negotiation,
      ev,
      basis,
      override,
      b.data.idempotencyKey,
    );
  }

  /** Approve the budget item, then record the acceptance. Retryable: the ledger step is idempotent and the record is unique per quote. */
  private async commit(
    caller: MissionCaller,
    q: { missionId: string; view: QuoteView },
    negotiation: {
      negotiationId: string;
      inForce: { version: number } | null;
    } | null,
    ev: Evaluation,
    basis: "PERSON" | "AGENT_WITHIN_LIMITS",
    override: string | null,
    idempotencyKey: string,
  ) {
    const quoteId = q.view.quoteId;
    const sql = this.deps.sql;
    const linked = await this.deps.quotes.toLedger(
      basis === "PERSON" ? caller : this.reader(caller),
      quoteId,
      { idempotencyKey: `accept-ledger-${quoteId}` },
    );
    if (!linked.ok)
      return {
        ok: false as const,
        refusal: "LEDGER_REFUSED" as const,
        detail: linked.refusal,
      };
    const itemId = linked.value.itemId;
    const sys = {
      organizationId: caller.organizationId,
      environment: caller.environment,
      id: `acceptance:${quoteId}`,
      kind: "SYSTEM" as const,
    };
    const items = await this.deps.ledger.overview(
      this.reader(caller),
      q.missionId,
    );
    const stage = items.ok
      ? items.value.items.find((i) => i.itemId === itemId)?.stage
      : undefined;
    if (stage !== "APPROVED") {
      const moved = await this.deps.ledger.transition(
        basis === "PERSON" ? caller : sys,
        itemId,
        { to: "APPROVED", idempotencyKey: `accept-approve-${quoteId}` },
      );
      if (!moved.ok)
        return {
          ok: false as const,
          refusal: "LEDGER_REFUSED" as const,
          detail: moved.refusal,
        };
    }
    const now = this.deps.now();
    const id = `acc_${randomBytes(12).toString("hex")}`;
    const [row] =
      await sql`insert into mission_acceptances (acceptance_id, mission_id, supplier_id, quote_id, negotiation_id, negotiation_version, total_minor, currency, basis,
        accepted_by_kind, accepted_by, checks, override_reason, ledger_item_id, idempotency_key, created_at)
      values (${id}, ${q.missionId}, ${q.view.supplierId}, ${quoteId}, ${negotiation?.negotiationId ?? null}, ${negotiation?.inForce?.version ?? null}, ${q.view.landed.totalMinor},
        ${q.view.currency}, ${basis}, ${caller.kind}, ${caller.id}, ${sql.json(ev.checks as never)}, ${override}, ${itemId}, ${idempotencyKey}, ${now})
      on conflict do nothing returning *`;
    if (!row) {
      const [existing] =
        await sql`select * from mission_acceptances where quote_id = ${quoteId}`;
      return existing
        ? {
            ok: true as const,
            value: {
              outcome: "ACCEPTED" as const,
              acceptance: toAcceptance(existing),
              replayed: true,
            },
          }
        : {
            ok: false as const,
            refusal: "CHECKS_FAILED" as const,
            detail: "NEGOTIATION_ALREADY_CONCLUDED",
          };
    }
    await this.log(
      caller,
      "OFFER_ACCEPTED",
      id,
      { quote: quoteId, totalMinor: q.view.landed.totalMinor!, basis },
      now,
    );
    return {
      ok: true as const,
      value: {
        outcome: "ACCEPTED" as const,
        acceptance: toAcceptance(row),
        replayed: false,
      },
    };
  }

  async withdraw(
    caller: MissionCaller,
    acceptanceId: string,
    rawBody: unknown,
  ): Promise<
    AccResult<{ acceptanceId: string; status: string; replayed: boolean }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = WithdrawSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    if (!/^acc_[a-f0-9]{24}$/u.test(acceptanceId))
      return { ok: false, refusal: "NOT_FOUND" };
    const [a] = await this.deps
      .sql`select a.* from mission_acceptances a join missions m on m.mission_id = a.mission_id
      where a.acceptance_id = ${acceptanceId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!a) return { ok: false, refusal: "NOT_FOUND" };
    if (a.status === "WITHDRAWN")
      return {
        ok: true,
        value: { acceptanceId, status: "WITHDRAWN", replayed: true },
      };
    const moved = await this.deps.ledger.transition(
      caller,
      String(a.ledger_item_id),
      { to: "CANCELLED", idempotencyKey: `withdraw-${acceptanceId}` },
    );
    if (!moved.ok)
      return { ok: false, refusal: "LEDGER_REFUSED", detail: moved.refusal };
    const now = this.deps.now();
    await this.deps
      .sql`update mission_acceptances set status = 'WITHDRAWN', withdrawn_by = ${caller.id}, withdrawn_at = ${now}, withdrawn_reason = ${b.data.reason} where acceptance_id = ${acceptanceId} and status = 'ACCEPTED'`;
    await this.log(caller, "OFFER_ACCEPTANCE_WITHDRAWN", acceptanceId, {}, now);
    return {
      ok: true,
      value: { acceptanceId, status: "WITHDRAWN", replayed: false },
    };
  }

  // ---------------------------------------------------------------------------------------------------- escalate / resolve
  async escalate(
    caller: MissionCaller,
    rawBody: unknown,
  ): Promise<AccResult<{ escalation: EscalationView; replayed: boolean }>> {
    const b = EscalateSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const sql = this.deps.sql;
    let missionId: string;
    let snapshot: unknown;
    if (b.data.kind === "ACCEPTANCE_REQUEST") {
      const q = await this.quoteRow(caller, b.data.quoteId!);
      if (!q) return { ok: false, refusal: "NOT_FOUND" };
      missionId = q.missionId;
      const f = await this.facts(caller, missionId, q.view);
      snapshot = {
        quoteId: q.view.quoteId,
        totalMinor: q.view.landed.totalMinor,
        currency: q.view.currency,
        checks: f?.evaluation.checks ?? [],
        hardFailures: f?.evaluation.hardFailures ?? [],
        softFailures: f?.evaluation.softFailures ?? [],
      };
    } else {
      const [n] =
        await sql`select n.mission_id from mission_negotiations n join missions m on m.mission_id = n.mission_id
        where n.negotiation_id = ${b.data.negotiationId!} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
      if (!n) return { ok: false, refusal: "NOT_FOUND" };
      missionId = String(n.mission_id);
      snapshot = { negotiationId: b.data.negotiationId };
    }
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "NEGOTIATE",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const now = this.deps.now();
    const [prior] =
      await sql`select * from mission_escalations where mission_id = ${missionId} and requested_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return {
        ok: true,
        value: { escalation: toEscalation(prior), replayed: true },
      };
    // One open request per subject: asking again returns the one already waiting.
    const [open] =
      await sql`select * from mission_escalations where mission_id = ${missionId} and status = 'OPEN' and kind = ${b.data.kind}
      and coalesce(quote_id,'') = ${b.data.quoteId ?? ""} and coalesce(negotiation_id,'') = ${b.data.negotiationId ?? ""}`;
    if (open)
      return {
        ok: true,
        value: { escalation: toEscalation(open), replayed: true },
      };
    const id = `esc_${randomBytes(12).toString("hex")}`;
    const [row] =
      await sql`insert into mission_escalations (escalation_id, mission_id, kind, quote_id, negotiation_id, reason, snapshot, requested_by_kind, requested_by, idempotency_key, created_at)
      values (${id}, ${missionId}, ${b.data.kind}, ${b.data.quoteId ?? null}, ${b.data.negotiationId ?? null}, ${b.data.reason}, ${sql.json(snapshot as never)}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now}) returning *`;
    await this.log(caller, "ESCALATION_RAISED", id, { kind: b.data.kind }, now);
    return {
      ok: true,
      value: { escalation: toEscalation(row!), replayed: false },
    };
  }

  async resolve(
    caller: MissionCaller,
    escalationId: string,
    rawBody: unknown,
  ): Promise<
    AccResult<{
      escalationId: string;
      status: string;
      acceptance?: AcceptanceView;
    }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = ResolveSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    if (!/^esc_[a-f0-9]{24}$/u.test(escalationId))
      return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [e] =
      await sql`select e.* from mission_escalations e join missions m on m.mission_id = e.mission_id
      where e.escalation_id = ${escalationId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!e) return { ok: false, refusal: "NOT_FOUND" };
    if (e.status !== "OPEN") return { ok: false, refusal: "ALREADY_RESOLVED" };
    let acceptance: AcceptanceView | undefined;
    if (b.data.decision === "ACCEPT") {
      if (e.kind === "ACCEPTANCE_REQUEST") {
        const r = await this.accept(caller, String(e.quote_id), {
          idempotencyKey:
            b.data.idempotencyKey ?? `resolve-${escalationId}`.padEnd(16, "0"),
          ...(b.data.overrideReason
            ? { overrideReason: b.data.overrideReason }
            : {}),
        });
        if (!r.ok) return r;
        if (r.value.outcome === "ACCEPTED") acceptance = r.value.acceptance;
      }
    }
    const status =
      b.data.decision === "ACCEPT"
        ? "ACCEPTED"
        : b.data.decision === "DECLINE"
          ? "DECLINED"
          : "DISMISSED";
    const now = this.deps.now();
    const [done] =
      await sql`update mission_escalations set status = ${status}, resolved_by = ${caller.id}, resolved_at = ${now}, resolution_note = ${b.data.note}
      where escalation_id = ${escalationId} and status = 'OPEN' returning escalation_id`;
    if (!done) return { ok: false, refusal: "ALREADY_RESOLVED" };
    // Agreeing to a walk-away ends the negotiation (the rules are revoked, one way).
    if (e.kind === "WALK_AWAY_REQUEST" && b.data.decision === "ACCEPT")
      await this.deps.negotiations.revoke(caller, String(e.negotiation_id), {
        reason: "Walked away: " + b.data.note,
      });
    await this.log(
      caller,
      "ESCALATION_RESOLVED",
      escalationId,
      { status },
      now,
    );
    return {
      ok: true,
      value: { escalationId, status, ...(acceptance ? { acceptance } : {}) },
    };
  }
}
