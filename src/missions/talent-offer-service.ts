import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import type { LedgerService } from "./ledger-service.js";
import {
  OfferTermsSchema,
  canMoveOffer,
  checkProblems,
  checkStanding,
  termsProblems,
  totalOf,
  type CheckFact,
  type CheckKind,
  type OfferStatus,
  type OfferTerms,
} from "./talent-offers.js";
import { CHECKS } from "./talent-scope.js";
import type { TalentScopeService } from "./talent-scope-service.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M49 — contractor checks, offers and contracts. Every check is a person's finding with evidence. An offer is drafted inside the
 * scope's limits, approved by the owner only when the required checks have passed, and then SENT and ANSWERED by a person: PayFlow sends
 * nothing and is not the contracting party. Recording the candidate's acceptance commits each milestone in the budget ledger.
 */
export type OfRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NO_SCOPE_IN_FORCE"
  | "NOT_SHORTLISTED"
  | "TERMS_INVALID"
  | "CHECKS_NOT_PASSED"
  | "ILLEGAL_MOVE"
  | "OFFER_EXPIRED"
  | "SCOPE_CHANGED"
  | "ALREADY_LIVE"
  | "LEDGER_REFUSED"
  | "MEMBER_ONLY";
export type OResult<T> =
  { ok: true; value: T } | { ok: false; refusal: OfRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const CheckSchema = z
  .object({
    candidateId: z.string().regex(/^tcd_[a-f0-9]{24}$/u),
    kind: z.enum(CHECKS),
    result: z.enum(["PASSED", "FAILED"]),
    evidenceKind: z.enum(["OWNER_ATTESTATION", "DOCUMENT_REF"]),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().min(1).max(300).optional(),
    idempotencyKey: Idem,
  })
  .strict();
export const DraftSchema = z
  .object({
    candidateId: z.string().regex(/^tcd_[a-f0-9]{24}$/u),
    terms: OfferTermsSchema,
    idempotencyKey: Idem,
  })
  .strict();
const NoteSchema = z
  .object({ note: z.string().trim().max(300).default("") })
  .strict();
const AnswerSchema = z
  .object({
    outcome: z.enum(["ACCEPTED", "DECLINED"]),
    evidenceKind: z.enum(["OWNER_ATTESTATION", "DOCUMENT_REF"]),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().max(300).default(""),
  })
  .strict();
const sha = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;

export interface OfferView {
  readonly offerId: string;
  readonly missionId: string;
  readonly scopeId: string;
  readonly roleId: string;
  readonly candidateId: string;
  readonly terms: OfferTerms;
  readonly totalMinor: number;
  readonly currency: string;
  readonly status: OfferStatus;
  readonly draftedBy: string;
  readonly expiresAt: string;
  readonly contractId: string | null;
  readonly notice: string;
}
const NOTICE =
  "PayFlow sends nothing and is not a party to this offer. A person records what was sent and what came back; accepting commits budget, it does not pay anyone.";

export class TalentOfferService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      scopes: TalentScopeService;
      ledger: LedgerService;
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
        subjectKind: "MISSION_TALENT_OFFER",
        subjectId,
        detail: {},
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async view(r: Row): Promise<OfferView> {
    const [c] = await this.deps
      .sql`select contract_id from mission_talent_contracts where offer_id = ${String(r.offer_id)}`;
    return {
      offerId: String(r.offer_id),
      missionId: String(r.mission_id),
      scopeId: String(r.scope_id),
      roleId: String(r.role_id),
      candidateId: String(r.candidate_id),
      terms: r.terms as OfferTerms,
      totalMinor: Number(r.total_minor),
      currency: String(r.currency).trim(),
      status: r.status as OfferStatus,
      draftedBy: `${String(r.drafted_by_kind).toLowerCase()}:${String(r.drafted_by)}`,
      expiresAt: iso(r.expires_at),
      contractId: c ? String(c.contract_id) : null,
      notice: NOTICE,
    };
  }
  private async offerRow(
    t: Pick<MissionCaller, "organizationId" | "environment">,
    id: string,
  ): Promise<Row | null> {
    if (!/^ofr_[a-f0-9]{24}$/u.test(id)) return null;
    const [r] = await this.deps
      .sql`select o.* from mission_talent_offers o join missions m on m.mission_id = o.mission_id
      where o.offer_id = ${id} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }
  private async candidate(missionId: string, id: string): Promise<Row | null> {
    const [r] = await this.deps
      .sql`select * from mission_talent_candidates where candidate_id = ${id} and mission_id = ${missionId}`;
    return r ?? null;
  }
  private async facts(candidateId: string): Promise<CheckFact[]> {
    const rows = await this.deps
      .sql`select seq, kind, result from mission_talent_checks where candidate_id = ${candidateId} order by seq`;
    return rows.map((r) => ({
      seq: Number(r.seq),
      kind: r.kind as CheckKind,
      result: r.result as "PASSED" | "FAILED",
    }));
  }

  // ------------------------------------------------------------------------------------------------ checks (a person's findings)
  async recordCheck(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<OResult<{ checkId: string; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = CheckSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (!(await this.candidate(missionId, b.data.candidateId)))
      return { ok: false, refusal: "NOT_FOUND", detail: "candidate" };
    const sql = this.deps.sql;
    const [dup] =
      await sql`select * from mission_talent_checks where mission_id = ${missionId} and recorded_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (dup)
      return dup.candidate_id === b.data.candidateId &&
        dup.kind === b.data.kind &&
        dup.result === b.data.result
        ? { ok: true, value: { checkId: String(dup.check_id), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const id = `tck_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    await sql`insert into mission_talent_checks (check_id, mission_id, candidate_id, kind, result, evidence_kind, evidence_ref, note, recorded_by, idempotency_key, recorded_at)
      values (${id}, ${missionId}, ${b.data.candidateId}, ${b.data.kind}, ${b.data.result}, ${b.data.evidenceKind}, ${b.data.evidenceRef ?? null}, ${b.data.note ?? null}, ${caller.id}, ${b.data.idempotencyKey}, ${now})`;
    await this.log(caller, "TALENT_CHECK_RECORDED", id, now);
    return { ok: true, value: { checkId: id, replayed: false } };
  }
  async checks(
    caller: MissionCaller,
    missionId: string,
    candidateId: string,
  ): Promise<
    OResult<{
      candidateId: string;
      required: string[];
      standing: Record<string, string>;
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
    if (!(await this.candidate(missionId, candidateId)))
      return { ok: false, refusal: "NOT_FOUND" };
    const scope = await this.deps.scopes.inForce(missionId);
    if (!scope) return { ok: false, refusal: "NO_SCOPE_IN_FORCE" };
    const required = scope.document.requiredChecks;
    return {
      ok: true,
      value: {
        candidateId,
        required: [...required],
        standing: checkStanding(required, await this.facts(candidateId)),
      },
    };
  }

  // ------------------------------------------------------------------------------------------------ offers
  async draft(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<OResult<{ offer: OfferView; replayed: boolean }>> {
    const b = DraftSchema.safeParse(rawBody);
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
        "DRAFT",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const sql = this.deps.sql;
    const [prior] =
      await sql`select * from mission_talent_offers where mission_id = ${missionId} and drafted_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return String(prior.terms_digest).trim() === sha(b.data.terms) &&
        prior.candidate_id === b.data.candidateId
        ? { ok: true, value: { offer: await this.view(prior), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const scope = await this.deps.scopes.inForce(missionId);
    if (!scope) return { ok: false, refusal: "NO_SCOPE_IN_FORCE" };
    const cand = await this.candidate(missionId, b.data.candidateId);
    if (!cand) return { ok: false, refusal: "NOT_FOUND", detail: "candidate" };
    const [sl] =
      await sql`select shortlist_id, candidate_ids from mission_talent_shortlists where scope_id = ${scope.scopeId} and role_id = ${String(cand.role_id)} and status = 'ACTIVE'`;
    if (
      !sl ||
      String(cand.scope_id) !== scope.scopeId ||
      !(sl.candidate_ids as string[]).includes(b.data.candidateId)
    )
      return { ok: false, refusal: "NOT_SHORTLISTED" };
    const role = scope.document.roles.find(
      (r) => r.roleId === String(cand.role_id),
    )!;
    const now = this.deps.now();
    const problems = termsProblems(
      b.data.terms,
      role,
      scope.document.currency,
      scope.document.expiresAt,
      now,
    );
    if (problems.length > 0)
      return {
        ok: false,
        refusal: "TERMS_INVALID",
        detail: problems.join(","),
      };
    const id = `ofr_${randomBytes(12).toString("hex")}`;
    try {
      const [row] =
        await sql`insert into mission_talent_offers (offer_id, mission_id, scope_id, role_id, candidate_id, shortlist_id, terms, terms_digest, total_minor, currency, drafted_by_kind, drafted_by, idempotency_key, drafted_at, expires_at)
        values (${id}, ${missionId}, ${scope.scopeId}, ${role.roleId}, ${b.data.candidateId}, ${String(sl.shortlist_id)}, ${sql.json(b.data.terms)}, ${sha(b.data.terms)}, ${totalOf(b.data.terms)}, ${b.data.terms.currency},
         ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now}, ${b.data.terms.expiresAt}) returning *`;
      await this.log(caller, "TALENT_OFFER_DRAFTED", id, now);
      return {
        ok: true,
        value: { offer: await this.view(row!), replayed: false },
      };
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_LIVE" };
      throw e;
    }
  }

  /** Move an offer one step. `from` is where it must be; the database refuses every other move too. */
  private async step(
    caller: MissionCaller,
    offerId: string,
    from: OfferStatus,
    to: OfferStatus,
    set: Record<string, unknown>,
    extra?: () => Promise<OResult<true>>,
  ): Promise<OResult<{ offer: OfferView; replayed: boolean }>> {
    const r = await this.offerRow(caller, offerId);
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    if (r.status === to)
      return { ok: true, value: { offer: await this.view(r), replayed: true } };
    if (r.status !== from || !canMoveOffer(from, to))
      return {
        ok: false,
        refusal: "ILLEGAL_MOVE",
        detail: `${String(r.status)}->${to}`,
      };
    if (
      new Date(r.expires_at as string).getTime() <=
        Date.parse(this.deps.now()) &&
      to !== "EXPIRED" &&
      to !== "WITHDRAWN"
    )
      return { ok: false, refusal: "OFFER_EXPIRED" };
    if (extra) {
      const e = await extra();
      if (!e.ok) return e;
    }
    const sql = this.deps.sql;
    const cols = Object.entries(set);
    const upd =
      await sql`update mission_talent_offers set status = ${to}, ${sql(Object.fromEntries(cols) as never)} where offer_id = ${offerId} and status = ${from} returning *`;
    if (upd.length === 0) return { ok: false, refusal: "ILLEGAL_MOVE" };
    await this.log(caller, `TALENT_OFFER_${to}`, offerId, this.deps.now());
    return {
      ok: true,
      value: { offer: await this.view(upd[0]!), replayed: false },
    };
  }

  async approve(
    caller: MissionCaller,
    offerId: string,
  ): Promise<OResult<{ offer: OfferView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    return this.step(
      caller,
      offerId,
      "DRAFT",
      "APPROVED",
      { approved_by: caller.id, approved_at: this.deps.now() },
      async () => {
        const r = (await this.offerRow(caller, offerId))!;
        const scope = await this.deps.scopes.inForce(String(r.mission_id));
        if (!scope || scope.scopeId !== String(r.scope_id))
          return { ok: false, refusal: "SCOPE_CHANGED" };
        const problems = checkProblems(
          scope.document.requiredChecks,
          await this.facts(String(r.candidate_id)),
        );
        return problems.length > 0
          ? {
              ok: false,
              refusal: "CHECKS_NOT_PASSED",
              detail: problems.join(","),
            }
          : { ok: true, value: true };
      },
    );
  }
  async markSent(
    caller: MissionCaller,
    offerId: string,
    rawBody: unknown,
  ): Promise<OResult<{ offer: OfferView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = NoteSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    return this.step(caller, offerId, "APPROVED", "SENT", {
      sent_by: caller.id,
      sent_at: this.deps.now(),
      sent_note: b.data.note || null,
    });
  }
  async withdraw(
    caller: MissionCaller,
    offerId: string,
    rawBody: unknown,
  ): Promise<OResult<{ offer: OfferView; replayed: boolean }>> {
    const b = NoteSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const r = await this.offerRow(caller, offerId);
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT" && r.drafted_by !== caller.id)
      return { ok: false, refusal: "CAPABILITY_REFUSED" };
    return this.step(caller, offerId, r.status as OfferStatus, "WITHDRAWN", {
      resolved_by: caller.id,
      resolved_at: this.deps.now(),
      resolution_note: b.data.note || null,
    });
  }

  /** A person records the candidate's answer. Acceptance commits every milestone in the budget ledger, then records the contract. */
  async answer(
    caller: MissionCaller,
    offerId: string,
    rawBody: unknown,
  ): Promise<
    OResult<{ offer: OfferView; contractId: string | null; replayed: boolean }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = AnswerSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const r = await this.offerRow(caller, offerId);
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const finish = (o: { offer: OfferView; replayed: boolean }) => ({
      ok: true as const,
      value: {
        offer: o.offer,
        contractId: o.offer.contractId,
        replayed: o.replayed,
      },
    });
    if (r.status === b.data.outcome)
      return finish({ offer: await this.view(r), replayed: true });
    if (r.status !== "SENT")
      return {
        ok: false,
        refusal: "ILLEGAL_MOVE",
        detail: `${String(r.status)}->${b.data.outcome}`,
      };
    const now = this.deps.now();
    if (b.data.outcome === "ACCEPTED") {
      const result = await this.accept(caller, offerId, b.data, now);
      if (!result.ok) return result;
      if (!result.value.replayed) {
        await this.log(caller, "TALENT_OFFER_ACCEPTED", offerId, now);
        for (const after of result.value.afters) await after();
      }
      const [fresh] =
        await sql`select * from mission_talent_offers where offer_id = ${offerId}`;
      return finish({
        offer: await this.view(fresh!),
        replayed: result.value.replayed,
      });
    }
    const upd =
      await sql`update mission_talent_offers set status = 'DECLINED', resolved_by = ${caller.id}, resolved_at = ${now}, resolution_evidence_kind = ${b.data.evidenceKind},
      resolution_evidence_ref = ${b.data.evidenceRef ?? null}, resolution_note = ${b.data.note || null} where offer_id = ${offerId} and status = 'SENT' returning *`;
    if (upd.length === 0) return { ok: false, refusal: "ILLEGAL_MOVE" };
    await this.log(caller, "TALENT_OFFER_DECLINED", offerId, now);
    return finish({ offer: await this.view(upd[0]!), replayed: false });
  }

  /**
   * Acceptance is ONE database transaction (R0): the offer row is locked; its status, expiry, scope, checks and the mission are verified
   * under that lock; every milestone is committed in the ledger on the same connection; the contract is recorded; and the offer moves
   * SENT -> ACCEPTED exactly once. Anything that fails rolls the whole thing back, so there is never a committed milestone without an
   * accepted offer and contract, nor a contract for an offer that was declined or withdrawn meanwhile. Nothing inside calls the pool.
   */
  private async accept(
    caller: MissionCaller,
    offerId: string,
    answer: z.infer<typeof AnswerSchema>,
    now: string,
  ): Promise<OResult<{ afters: (() => Promise<void>)[]; replayed: boolean }>> {
    class Rollback extends Error {
      constructor(readonly refusal: Extract<OResult<never>, { ok: false }>) {
        super("ROLLBACK");
      }
    }
    const refuse = (refusal: string, detail?: string): never => {
      throw new Rollback({
        ok: false,
        refusal: refusal as never,
        ...(detail ? { detail } : {}),
      });
    };
    try {
      return await this.deps.sql.begin(async (tx) => {
        const [o] =
          await tx`select o.* from mission_talent_offers o join missions m on m.mission_id = o.mission_id
          where o.offer_id = ${offerId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment} for update of o`;
        if (!o) return refuse("NOT_FOUND");
        // A concurrent ACCEPT that won the lock first already did everything: this one is a replay, not an error.
        if (o!.status === "ACCEPTED")
          return { ok: true as const, value: { afters: [], replayed: true } };
        if (o!.status !== "SENT")
          return refuse("ILLEGAL_MOVE", `${String(o!.status)}->ACCEPTED`);
        if (new Date(o!.expires_at as string).getTime() <= Date.parse(now))
          return refuse("OFFER_EXPIRED");
        const missionId = String(o!.mission_id);
        const [scope] =
          await tx`select scope_id, document from mission_talent_scopes where mission_id = ${missionId} and status = 'APPROVED'`;
        if (!scope || String(scope.scope_id) !== String(o!.scope_id))
          return refuse("SCOPE_CHANGED");
        const facts =
          await tx`select seq, kind, result from mission_talent_checks where candidate_id = ${String(o!.candidate_id)} order by seq`;
        const problems = checkProblems(
          (scope.document as { requiredChecks: CheckKind[] }).requiredChecks,
          facts.map((f) => ({
            seq: Number(f.seq),
            kind: f.kind as CheckKind,
            result: f.result as "PASSED" | "FAILED",
          })),
        );
        if (problems.length > 0)
          return refuse("CHECKS_NOT_PASSED", problems.join(","));
        const terms = o!.terms as OfferTerms;
        const afters: (() => Promise<void>)[] = [];
        const itemIds: string[] = [];
        for (const [i, ms] of terms.milestones.entries()) {
          const created = await this.deps.ledger.createItemInTx(
            tx,
            caller,
            missionId,
            {
              kind: "CONTRACTOR_MILESTONE",
              label: `Milestone ${i + 1}: ${ms.title}`.slice(0, 200),
              amountMinor: ms.amountMinor,
              currency: terms.currency,
              stage: "COMMITTED",
              verification: "OWNER_REPORTED",
              evidenceKind: "OWNER_REPORTED",
              evidence: { offer: offerId },
              idempotencyKey: `${offerId}-m${i + 1}`.padEnd(16, "-"),
            },
          );
          if (!created.ok)
            return refuse(
              "LEDGER_REFUSED",
              `${created.refusal}@milestone${i + 1}`,
            );
          itemIds.push(created.value.itemId);
          if (created.after) afters.push(created.after);
        }
        const contractId = `tct_${randomBytes(12).toString("hex")}`;
        const milestones = terms.milestones.map((ms, i) => ({
          index: i + 1,
          ...ms,
          ledgerItemId: itemIds[i]!,
        }));
        await tx`insert into mission_talent_contracts (contract_id, mission_id, offer_id, candidate_id, role_id, currency, total_minor, milestones, created_by, created_at)
          values (${contractId}, ${missionId}, ${offerId}, ${String(o!.candidate_id)}, ${String(o!.role_id)}, ${terms.currency}, ${Number(o!.total_minor)}, ${tx.json(milestones)}, ${caller.id}, ${now})`;
        const moved =
          await tx`update mission_talent_offers set status = 'ACCEPTED', resolved_by = ${caller.id}, resolved_at = ${now}, resolution_evidence_kind = ${answer.evidenceKind},
          resolution_evidence_ref = ${answer.evidenceRef ?? null}, resolution_note = ${answer.note || null} where offer_id = ${offerId} and status = 'SENT' returning offer_id`;
        if (moved.length !== 1) return refuse("ILLEGAL_MOVE");
        return { ok: true as const, value: { afters, replayed: false } };
      });
    } catch (e) {
      if (e instanceof Rollback) return e.refusal;
      throw e;
    }
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<OResult<{ offers: OfferView[]; contracts: unknown[] }>> {
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
      .sql`select * from mission_talent_offers where mission_id = ${missionId} order by drafted_at, offer_id`;
    const cons = await this.deps
      .sql`select * from mission_talent_contracts where mission_id = ${missionId} order by created_at, contract_id`;
    const offers: OfferView[] = [];
    for (const r of rows) offers.push(await this.view(r));
    return {
      ok: true,
      value: {
        offers,
        contracts: cons.map((c) => ({
          contractId: String(c.contract_id),
          offerId: String(c.offer_id),
          candidateId: String(c.candidate_id),
          roleId: String(c.role_id),
          currency: String(c.currency).trim(),
          totalMinor: Number(c.total_minor),
          milestones: c.milestones as unknown,
          createdAt: iso(c.created_at),
        })),
      },
    };
  }
}
