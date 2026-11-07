import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import type { LedgerService } from "./ledger-service.js";
import {
  NegotiationDocSchema,
  PAYMENT_TERMS,
  checkMove,
  problemsWith,
  type Facts,
  type Move,
  type NegotiationDoc,
  type Verdict,
} from "./negotiation.js";
import type { QualificationService } from "./qualification-service.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M36 — proposing, approving and enforcing negotiation rulebooks. A version is proposed by an agent or a person, always waits
 * for a person (the owner) before it is in force, and is re-validated against the facts at that moment (supplier still qualified,
 * limits still inside the mission and the budget, deadline inside the mission's). Only the named negotiator agent may check
 * moves, and every check is made against the version in force right now.
 */
export type NegRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "DOCUMENT_INVALID"
  | "NEGOTIATION_REVOKED"
  | "NOT_PENDING"
  | "NOT_THE_NEGOTIATOR"
  | "MEMBER_ONLY";
export type NResult<T> =
  { ok: true; value: T } | { ok: false; refusal: NegRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const ProposeSchema = z
  .object({
    supplierId: z.string().regex(/^sup_[a-f0-9]{24}$/u),
    document: NegotiationDocSchema,
    idempotencyKey: Idem,
  })
  .strict();
const DecideSchema = z
  .object({ reason: z.string().trim().max(300).default("") })
  .strict();
export const MoveSchema = z
  .object({
    kind: z.enum(["COUNTER", "ACCEPT"]),
    round: z.number().int().min(1).max(100),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    totalMinor: z.number().int().safe().min(1).max(1_000_000_000_000),
    terms: z
      .object({
        warrantyMonths: z.number().int().min(0).max(240).optional(),
        returnWindowDays: z.number().int().min(0).max(365).optional(),
        deliveryDays: z.number().int().min(0).max(365).optional(),
        paymentTerms: z.enum(PAYMENT_TERMS).optional(),
      })
      .strict()
      .default({}),
    quantityIncreasePercent: z.number().int().min(0).max(1000).default(0),
    disclosing: z
      .array(
        z.enum([
          "BUDGET",
          "OTHER_SUPPLIERS_IDENTITY",
          "COMPETING_QUOTES",
          "DEADLINE",
        ]),
      )
      .max(4)
      .default([]),
  })
  .strict();

const sha = (v: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(v, (_k, x: unknown) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(
              Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)),
            )
          : x,
      ),
    )
    .digest("hex");
const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;
export const NEGOTIATION_NOTICE =
  "These are the rules an agent must stay inside. They do not send anything to a supplier and do not accept anything; a person decides on acceptance unless the approved rules and the mission explicitly allow otherwise.";

export interface VersionView {
  readonly version: number;
  readonly document: NegotiationDoc;
  readonly digest: string;
  readonly authoredBy: string;
  readonly createdAt: string;
  readonly decision: "PENDING" | "APPROVED" | "REJECTED";
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}
export interface NegotiationView {
  readonly negotiationId: string;
  readonly missionId: string;
  readonly supplierId: string;
  readonly revoked: boolean;
  readonly status:
    | "IN_FORCE"
    | "WAITING_FOR_A_PERSON"
    | "EXPIRED"
    | "REVOKED"
    | "MISSION_NOT_ACTIVE"
    | "NOT_APPROVED";
  readonly inForce: VersionView | null;
  readonly pending: VersionView | null;
  readonly versions: VersionView[];
  readonly notice: string;
}
const toVersion = (r: Row): VersionView => ({
  version: Number(r.version),
  document: NegotiationDocSchema.parse(r.document),
  digest: String(r.document_digest).trim(),
  authoredBy: `${String(r.authored_by_kind).toLowerCase()}:${String(r.authored_by)}`,
  createdAt: iso(r.created_at),
  decision: r.decision as VersionView["decision"],
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at ? iso(r.decided_at) : null,
  decisionReason: (r.decision_reason as string | null) ?? null,
});

export class NegotiationService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      qualification: QualificationService;
      ledger: LedgerService;
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
        subjectKind: "MISSION_NEGOTIATION",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private reader(t: Tenant): MissionCaller {
    return {
      organizationId: t.organizationId,
      environment: t.environment,
      id: "negotiation",
      kind: "MEMBER",
    };
  }
  /** The facts a document is judged against, read now. */
  private async facts(
    t: Tenant,
    missionId: string,
    supplierId: string,
    doc: NegotiationDoc,
  ): Promise<Facts | null> {
    const m = await this.deps.missions.get(t, missionId);
    if (!m.ok) return null;
    const contract = m.value.activeContract ?? m.value.latestContract;
    const ql = await this.deps.qualification.list(this.reader(t), missionId);
    const qualified =
      ql.ok &&
      (ql.value.suppliers as { supplierId: string; outcome: string }[]).some(
        (s) => s.supplierId === supplierId && s.outcome === "QUALIFIED",
      );
    const led = await this.deps.ledger.overview(this.reader(t), missionId);
    const [g] =
      m.value.activeVersion === null
        ? []
        : await this.deps
            .sql`select agent_id from mission_agent_grants where mission_id = ${missionId} and version = ${m.value.activeVersion} and agent_id = ${doc.negotiatorAgentId} and 'NEGOTIATE' = any(capabilities)`;
    let baseline: Facts["baseline"] = null;
    if (doc.baselineQuoteId) {
      const [q] = await this.deps
        .sql`select supplier_id, valid_until from mission_quotes where quote_id = ${doc.baselineQuoteId} and mission_id = ${missionId}`;
      const [sup] = q
        ? await this.deps
            .sql`select 1 from mission_quotes where supersedes_quote_id = ${doc.baselineQuoteId}`
        : [];
      baseline = {
        exists: !!q,
        supplierMatches: !!q && q.supplier_id === supplierId,
        current:
          !!q &&
          !sup &&
          Date.parse(iso(q.valid_until)) > Date.parse(this.deps.now()),
      };
    }
    return {
      missionCurrency: contract.currency,
      maxCommitmentMinor: contract.maxCommitmentMinor,
      availableMinor: led.ok ? led.value.summary.availableMinor : null,
      missionExpiresAt: contract.expiresAt ?? "9999-12-31T00:00:00.000Z",
      agentMayNegotiate: () => !!g,
      requireApprovalToContract:
        contract.approvalConditions.requireApprovalToContract,
      humanApprovalAboveMinor:
        contract.approvalConditions.humanApprovalAboveMinor,
      supplierQualified: qualified,
      baseline,
    };
  }

  // ---------------------------------------------------------------------------------------------------- propose
  async propose(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<
    NResult<{
      negotiationId: string;
      version: number;
      replayed: boolean;
      warnings: string[];
    }>
  > {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
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
    const b = ProposeSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 3)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const sql = this.deps.sql;
    const [sup] =
      await sql`select supplier_id from mission_suppliers where supplier_id = ${b.data.supplierId} and mission_id = ${missionId}`;
    if (!sup) return { ok: false, refusal: "NOT_FOUND", detail: "SUPPLIER" };
    if (
      caller.kind === "AGENT" &&
      b.data.document.negotiatorAgentId !== caller.id
    )
      return {
        ok: false,
        refusal: "CAPABILITY_REFUSED",
        detail: "AN_AGENT_MAY_ONLY_PROPOSE_RULES_FOR_ITSELF",
      };
    const facts = await this.facts(
      caller,
      missionId,
      b.data.supplierId,
      b.data.document,
    );
    if (!facts) return { ok: false, refusal: "NOT_FOUND" };
    // Qualification is required to be IN FORCE, not to be PROPOSED: preparing the rules can happen while evidence is being gathered.
    const all = problemsWith(b.data.document, facts, this.deps.now());
    const blocking = all.filter((p) => p !== "SUPPLIER_NOT_QUALIFIED");
    if (blocking.length)
      return {
        ok: false,
        refusal: "DOCUMENT_INVALID",
        detail: blocking.join(","),
      };
    const warnings = all.filter((p) => p === "SUPPLIER_NOT_QUALIFIED");
    const digest = sha(b.data.document);
    const now = this.deps.now();
    const out = await sql.begin(
      async (
        tx,
      ): Promise<
        NResult<{ negotiationId: string; version: number; replayed: boolean }>
      > => {
        await tx`select pg_advisory_xact_lock(hashtext(${"neg|" + missionId + "|" + b.data.supplierId}))`;
        const [prior] =
          await tx`select v.negotiation_id, v.version, v.document_digest from mission_negotiation_versions v join mission_negotiations n on n.negotiation_id = v.negotiation_id
        where n.mission_id = ${missionId} and v.authored_by = ${caller.id} and v.idempotency_key = ${b.data.idempotencyKey}`;
        if (prior)
          return String(prior.document_digest).trim() === digest
            ? {
                ok: true,
                value: {
                  negotiationId: String(prior.negotiation_id),
                  version: Number(prior.version),
                  replayed: true,
                },
              }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        let [n] =
          await tx`select * from mission_negotiations where mission_id = ${missionId} and supplier_id = ${b.data.supplierId}`;
        if (n?.revoked_at) return { ok: false, refusal: "NEGOTIATION_REVOKED" };
        if (!n) {
          [n] =
            await tx`insert into mission_negotiations (negotiation_id, mission_id, supplier_id, created_by_kind, created_by, created_at)
          values (${"ngt_" + randomBytes(12).toString("hex")}, ${missionId}, ${b.data.supplierId}, ${caller.kind}, ${caller.id}, ${now}) returning *`;
        }
        const [{ v }] =
          (await tx`select coalesce(max(version), 0) + 1 as v from mission_negotiation_versions where negotiation_id = ${String(n!.negotiation_id)}`) as unknown as [
            { v: number },
          ];
        await tx`insert into mission_negotiation_versions (negotiation_id, version, document, document_digest, authored_by_kind, authored_by, idempotency_key, created_at)
        values (${String(n!.negotiation_id)}, ${v}, ${tx.json(b.data.document)}, ${digest}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now})`;
        return {
          ok: true,
          value: {
            negotiationId: String(n!.negotiation_id),
            version: Number(v),
            replayed: false,
          },
        };
      },
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.log(
        caller,
        "NEGOTIATION_PROPOSED",
        out.value.negotiationId,
        { version: out.value.version },
        now,
      );
    return { ok: true, value: { ...out.value, warnings } };
  }

  // ---------------------------------------------------------------------------------------------------- decide / revoke
  async decide(
    caller: MissionCaller,
    negotiationId: string,
    version: number,
    decision: "APPROVED" | "REJECTED",
    rawBody: unknown,
  ): Promise<
    NResult<{ negotiationId: string; version: number; decision: string }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = DecideSchema.safeParse(rawBody ?? {});
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const sql = this.deps.sql;
    const [n] =
      await sql`select n.* from mission_negotiations n join missions m on m.mission_id = n.mission_id
      where n.negotiation_id = ${negotiationId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!n) return { ok: false, refusal: "NOT_FOUND" };
    if (n.revoked_at) return { ok: false, refusal: "NEGOTIATION_REVOKED" };
    const [v] =
      await sql`select * from mission_negotiation_versions where negotiation_id = ${negotiationId} and version = ${version}`;
    if (!v) return { ok: false, refusal: "NOT_FOUND" };
    if (v.decision !== "PENDING") return { ok: false, refusal: "NOT_PENDING" };
    const now = this.deps.now();
    if (decision === "APPROVED") {
      // Approval re-checks everything against the facts of this moment, including that the supplier is qualified now.
      const doc = NegotiationDocSchema.parse(v.document);
      const facts = await this.facts(
        caller,
        String(n.mission_id),
        String(n.supplier_id),
        doc,
      );
      if (!facts) return { ok: false, refusal: "NOT_FOUND" };
      const problems = problemsWith(doc, facts, now);
      if (problems.length)
        return {
          ok: false,
          refusal: "DOCUMENT_INVALID",
          detail: problems.join(","),
        };
    }
    const [done] =
      await sql`update mission_negotiation_versions set decision = ${decision}, decided_by = ${caller.id}, decided_at = ${now}, decision_reason = ${b.data.reason}
      where negotiation_id = ${negotiationId} and version = ${version} and decision = 'PENDING' returning version`;
    if (!done) return { ok: false, refusal: "NOT_PENDING" };
    await this.log(
      caller,
      decision === "APPROVED" ? "NEGOTIATION_APPROVED" : "NEGOTIATION_REJECTED",
      negotiationId,
      { version },
      now,
    );
    return { ok: true, value: { negotiationId, version, decision } };
  }

  async revoke(
    caller: MissionCaller,
    negotiationId: string,
    rawBody: unknown,
  ): Promise<
    NResult<{ negotiationId: string; revoked: true; replayed: boolean }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = DecideSchema.safeParse(rawBody ?? {});
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const now = this.deps.now();
    const [n] = await this.deps
      .sql`select n.revoked_at from mission_negotiations n join missions m on m.mission_id = n.mission_id
      where n.negotiation_id = ${negotiationId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!n) return { ok: false, refusal: "NOT_FOUND" };
    if (n.revoked_at)
      return {
        ok: true,
        value: { negotiationId, revoked: true, replayed: true },
      };
    await this.deps
      .sql`update mission_negotiations set revoked_at = ${now}, revoked_by = ${caller.id}, revoke_reason = ${b.data.reason} where negotiation_id = ${negotiationId} and revoked_at is null`;
    await this.log(caller, "NEGOTIATION_REVOKED", negotiationId, {}, now);
    return {
      ok: true,
      value: { negotiationId, revoked: true, replayed: false },
    };
  }

  // ---------------------------------------------------------------------------------------------------- read
  private async views(
    t: Tenant,
    missionId: string,
    onlyId?: string,
  ): Promise<NegotiationView[] | null> {
    const m = await this.deps.missions.get(t, missionId);
    if (!m.ok) return null;
    const sql = this.deps.sql;
    const now = this.deps.now();
    const ns =
      await sql`select * from mission_negotiations where mission_id = ${missionId} and (${onlyId ?? null}::text is null or negotiation_id = ${onlyId ?? null}) order by created_at, negotiation_id`;
    const vs =
      await sql`select * from mission_negotiation_versions where negotiation_id in (select negotiation_id from mission_negotiations where mission_id = ${missionId}) order by negotiation_id, version`;
    return ns.map((n) => {
      const versions = vs
        .filter((v) => v.negotiation_id === n.negotiation_id)
        .map(toVersion);
      const approved =
        [...versions].reverse().find((v) => v.decision === "APPROVED") ?? null;
      const pending =
        [...versions].reverse().find((v) => v.decision === "PENDING") ?? null;
      const revoked = !!n.revoked_at;
      let status: NegotiationView["status"];
      let inForce: VersionView | null = null;
      if (revoked) status = "REVOKED";
      else if (!approved)
        status = pending ? "WAITING_FOR_A_PERSON" : "NOT_APPROVED";
      else if (Date.parse(approved.document.expiresAt) <= Date.parse(now))
        status = "EXPIRED";
      else if (m.value.status !== "ACTIVE") status = "MISSION_NOT_ACTIVE";
      else {
        status = "IN_FORCE";
        inForce = approved;
      }
      return {
        negotiationId: String(n.negotiation_id),
        missionId,
        supplierId: String(n.supplier_id),
        revoked,
        status,
        inForce,
        pending,
        versions,
        notice: NEGOTIATION_NOTICE,
      };
    });
  }
  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<NResult<{ negotiations: NegotiationView[] }>> {
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "READ",
      );
      if (!a.allowed)
        return a.reason === "MISSION_NOT_FOUND"
          ? { ok: false, refusal: "NOT_FOUND" }
          : { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const v = await this.views(caller, missionId);
    return v
      ? { ok: true, value: { negotiations: v } }
      : { ok: false, refusal: "NOT_FOUND" };
  }

  // ---------------------------------------------------------------------------------------------------- the guard
  /**
   * Check one move against the rules in force right now. Later milestones call this before anything is sent or answered. Only the
   * named negotiator may check; a missing, expired, revoked or not-yet-approved rulebook refuses everything; and the move must also
   * fit what the budget can still afford at this moment.
   */
  async check(
    caller: MissionCaller,
    negotiationId: string,
    rawBody: unknown,
  ): Promise<
    NResult<{
      verdict: Verdict;
      version: number | null;
      negotiationStatus: string;
    }>
  > {
    const b = MoveSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 3)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const [n] = await this.deps
      .sql`select n.mission_id from mission_negotiations n join missions m on m.mission_id = n.mission_id
      where n.negotiation_id = ${negotiationId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!n) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(n.mission_id);
    const views = await this.views(caller, missionId, negotiationId);
    const v = views?.[0];
    if (!v) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "NEGOTIATE",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
      if (v.inForce && v.inForce.document.negotiatorAgentId !== caller.id)
        return { ok: false, refusal: "NOT_THE_NEGOTIATOR" };
      if (
        !v.inForce &&
        [...v.versions].every((x) => x.document.negotiatorAgentId !== caller.id)
      )
        return { ok: false, refusal: "NOT_THE_NEGOTIATOR" };
    }
    if (!v.inForce)
      return {
        ok: true,
        value: {
          verdict: {
            verdict: "REFUSE",
            reasons: [`NO_RULES_IN_FORCE:${v.status}`],
          },
          version: null,
          negotiationStatus: v.status,
        },
      };
    const now = this.deps.now();
    const verdict = checkMove(v.inForce.document, b.data as Move, now);
    const reasons = verdict.verdict === "REFUSE" ? [...verdict.reasons] : [];
    // The facts may have moved since approval: the supplier must still be qualified and the money still there.
    const facts = await this.facts(
      caller,
      missionId,
      v.supplierId,
      v.inForce.document,
    );
    if (!facts?.supplierQualified) reasons.push("SUPPLIER_NO_LONGER_QUALIFIED");
    if (
      facts?.availableMinor != null &&
      b.data.totalMinor > facts.availableMinor
    )
      reasons.push("ABOVE_AVAILABLE_BUDGET");
    const final: Verdict =
      reasons.length > 0 ? { verdict: "REFUSE", reasons } : verdict;
    return {
      ok: true,
      value: {
        verdict: final,
        version: v.inForce.version,
        negotiationStatus: v.status,
      },
    };
  }
}
