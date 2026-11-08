import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import { MissionContractSchema } from "./contract.js";
import {
  TalentScopeSchema,
  scopeProblems,
  type MissionFacts,
  type TalentScope,
} from "./talent-scope.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M46 — proposing, approving and revoking a mission's talent scope. A version is proposed by an agent (DRAFT) or a person and always
 * waits for the owner; it is checked against the mission when proposed and again at approval. One version is in force at a time.
 */
export type TsRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "SCOPE_INVALID"
  | "NOT_PENDING"
  | "MEMBER_ONLY";
export type TResult<T> =
  { ok: true; value: T } | { ok: false; refusal: TsRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const ProposeSchema = z
  .object({ document: TalentScopeSchema, idempotencyKey: Idem })
  .strict();
const DecideSchema = z
  .object({ reason: z.string().trim().max(300).default("") })
  .strict();
const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
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

export interface ScopeView {
  readonly scopeId: string;
  readonly missionId: string;
  readonly version: number;
  readonly status: string;
  readonly document: TalentScope;
  readonly digest: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly notice: string;
}
const NOTICE =
  "A talent scope only takes effect once the owner approves it. It limits what may be shortlisted, offered or paid; it hires no one.";
const toView = (r: Row): ScopeView => ({
  scopeId: String(r.scope_id),
  missionId: String(r.mission_id),
  version: Number(r.version),
  status: String(r.status),
  document: r.document as TalentScope,
  digest: String(r.document_digest).trim(),
  proposedBy: `${String(r.proposed_by_kind).toLowerCase()}:${String(r.proposed_by)}`,
  proposedAt: iso(r.proposed_at),
  decidedBy: (r.decided_by as string | null) ?? null,
  decisionReason: (r.decision_reason as string | null) ?? null,
  notice: NOTICE,
});

export class TalentScopeService {
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
        subjectKind: "MISSION_TALENT_SCOPE",
        subjectId,
        detail: {},
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async missionFacts(missionId: string): Promise<MissionFacts | null> {
    const [m] = await this.deps
      .sql`select * from missions where mission_id = ${missionId}`;
    if (!m) return null;
    const v =
      m.active_version === null
        ? Number(m.latest_version)
        : Number(m.active_version);
    const [row] = await this.deps
      .sql`select contract from mission_versions where mission_id = ${missionId} and version = ${v}`;
    const c = MissionContractSchema.parse(row!.contract);
    return {
      currency: c.currency,
      maxCommitmentMinor: c.maxCommitmentMinor,
      totalBudgetMinor: c.totalBudgetMinor,
      spendingCategories: c.spendingCategories,
      providerTypes: c.approvedProviderTypes,
      expiresAt: c.expiresAt,
    };
  }

  async propose(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<TResult<{ scope: ScopeView; replayed: boolean }>> {
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
    const facts = await this.missionFacts(missionId);
    if (!facts) return { ok: false, refusal: "NOT_FOUND" };
    const now = this.deps.now();
    const problems = scopeProblems(b.data.document, facts, now);
    if (problems.length > 0)
      return {
        ok: false,
        refusal: "SCOPE_INVALID",
        detail: problems.join(","),
      };
    const sql = this.deps.sql;
    const digest = sha(b.data.document);
    const out = await sql.begin(
      async (tx): Promise<TResult<{ row: Row; replayed: boolean }>> => {
        await tx`select 1 from missions where mission_id = ${missionId} for update`;
        const [prior] =
          await tx`select * from mission_talent_scopes where mission_id = ${missionId} and proposed_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
        if (prior)
          return String(prior.document_digest).trim() === digest
            ? { ok: true, value: { row: prior, replayed: true } }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        const [{ v }] =
          (await tx`select coalesce(max(version),0)::int + 1 v from mission_talent_scopes where mission_id = ${missionId}`) as unknown as [
            { v: number },
          ];
        const id = `tsc_${randomBytes(12).toString("hex")}`;
        const [row] =
          await tx`insert into mission_talent_scopes (scope_id, mission_id, version, document, document_digest, proposed_by_kind, proposed_by, idempotency_key, proposed_at)
        values (${id}, ${missionId}, ${v}, ${tx.json(b.data.document)}, ${digest}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now}) returning *`;
        return { ok: true, value: { row: row!, replayed: false } };
      },
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.log(
        caller,
        "TALENT_SCOPE_PROPOSED",
        String(out.value.row.scope_id),
        now,
      );
    return {
      ok: true,
      value: { scope: toView(out.value.row), replayed: out.value.replayed },
    };
  }

  private async scopeRow(
    t: Pick<MissionCaller, "organizationId" | "environment">,
    id: string,
  ): Promise<Row | null> {
    if (!/^tsc_[a-f0-9]{24}$/u.test(id)) return null;
    const [r] = await this.deps
      .sql`select s.* from mission_talent_scopes s join missions m on m.mission_id = s.mission_id
      where s.scope_id = ${id} and m.organization_id = ${t.organizationId} and m.environment = ${t.environment}`;
    return r ?? null;
  }

  async decide(
    caller: MissionCaller,
    scopeId: string,
    decision: "APPROVED" | "REJECTED",
    rawBody: unknown,
  ): Promise<TResult<{ scope: ScopeView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = DecideSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const r = await this.scopeRow(caller, scopeId);
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    if (r.status === decision)
      return { ok: true, value: { scope: toView(r), replayed: true } };
    if (r.status !== "PENDING_APPROVAL")
      return { ok: false, refusal: "NOT_PENDING", detail: String(r.status) };
    const now = this.deps.now();
    if (decision === "APPROVED") {
      // The mission may have changed since it was proposed: check again before it takes effect.
      const facts = await this.missionFacts(String(r.mission_id));
      const problems = facts
        ? scopeProblems(r.document as TalentScope, facts, now)
        : ["MISSION_GONE"];
      if (problems.length > 0)
        return {
          ok: false,
          refusal: "SCOPE_INVALID",
          detail: problems.join(","),
        };
    }
    const sql = this.deps.sql;
    const done = await sql.begin(async (tx) => {
      await tx`select 1 from missions where mission_id = ${String(r.mission_id)} for update`;
      if (decision === "APPROVED")
        await tx`update mission_talent_scopes set status = 'SUPERSEDED' where mission_id = ${String(r.mission_id)} and status = 'APPROVED'`;
      return tx`update mission_talent_scopes set status = ${decision}, decided_by = ${caller.id}, decided_at = ${now}, decision_reason = ${b.data.reason || null}
        where scope_id = ${scopeId} and status = 'PENDING_APPROVAL' returning *`;
    });
    if (done.length === 0) return { ok: false, refusal: "NOT_PENDING" };
    await this.log(caller, `TALENT_SCOPE_${decision}`, scopeId, now);
    return { ok: true, value: { scope: toView(done[0]!), replayed: false } };
  }

  async revoke(
    caller: MissionCaller,
    scopeId: string,
    rawBody: unknown,
  ): Promise<TResult<{ scope: ScopeView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = DecideSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const r = await this.scopeRow(caller, scopeId);
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    if (r.status === "REVOKED")
      return { ok: true, value: { scope: toView(r), replayed: true } };
    if (r.status !== "APPROVED")
      return { ok: false, refusal: "NOT_PENDING", detail: String(r.status) };
    const now = this.deps.now();
    const done = await this.deps
      .sql`update mission_talent_scopes set status = 'REVOKED', decided_by = ${caller.id}, decided_at = ${now}, decision_reason = ${b.data.reason || null}
      where scope_id = ${scopeId} and status = 'APPROVED' returning *`;
    if (done.length === 0) return { ok: false, refusal: "NOT_PENDING" };
    await this.log(caller, "TALENT_SCOPE_REVOKED", scopeId, now);
    return { ok: true, value: { scope: toView(done[0]!), replayed: false } };
  }

  /** The scope in force right now, if any. */
  async inForce(missionId: string): Promise<ScopeView | null> {
    const [r] = await this.deps
      .sql`select * from mission_talent_scopes where mission_id = ${missionId} and status = 'APPROVED'`;
    return r ? toView(r) : null;
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<TResult<{ scopes: ScopeView[]; inForce: ScopeView | null }>> {
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
      .sql`select * from mission_talent_scopes where mission_id = ${missionId} order by version`;
    const scopes = rows.map(toView);
    return {
      ok: true,
      value: {
        scopes,
        inForce: scopes.find((s) => s.status === "APPROVED") ?? null,
      },
    };
  }
}
