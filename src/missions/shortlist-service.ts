import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import { rank, shortlistProblems, type Ranked } from "./shortlist.js";
import type { Profile } from "./talent-candidates.js";
import type { TalentScopeService } from "./talent-scope-service.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M48 — ranking candidates and adopting a shortlist. The ranking is computed on demand from the scope in force and the candidates
 * imported under it. An agent may read it; only a person adopts a shortlist. Adopting contacts no one and offers nothing.
 */
export type ShRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NO_SCOPE_IN_FORCE"
  | "NO_SUCH_ROLE"
  | "SHORTLIST_INVALID"
  | "ALREADY_ACTIVE"
  | "MEMBER_ONLY";
export type SResult<T> =
  { ok: true; value: T } | { ok: false; refusal: ShRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
const Role = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u);
export const AdoptSchema = z
  .object({
    roleId: Role,
    candidateIds: z
      .array(z.string().regex(/^tcd_[a-f0-9]{24}$/u))
      .min(1)
      .max(20),
    note: z.string().trim().max(500).default(""),
    idempotencyKey: Idem,
  })
  .strict();
const WithdrawSchema = z
  .object({ reason: z.string().trim().min(1).max(300) })
  .strict();
const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
export interface ShortlistView {
  readonly shortlistId: string;
  readonly missionId: string;
  readonly scopeId: string;
  readonly roleId: string;
  readonly candidateIds: string[];
  readonly snapshot: unknown;
  readonly note: string;
  readonly status: string;
  readonly adoptedBy: string;
  readonly adoptedAt: string;
  readonly notice: string;
}
const NOTICE =
  "Ranking uses only claimed skills, stated price, preferred skills and portfolio - never years of experience or anything standing in for a protected attribute. Skills are claims until a person verifies them. Adopting a shortlist contacts no one.";
const toView = (r: Row): ShortlistView => ({
  shortlistId: String(r.shortlist_id),
  missionId: String(r.mission_id),
  scopeId: String(r.scope_id),
  roleId: String(r.role_id),
  candidateIds: r.candidate_ids as string[],
  snapshot: r.snapshot,
  note: String(r.note),
  status: String(r.status),
  adoptedBy: String(r.adopted_by),
  adoptedAt: iso(r.adopted_at),
  notice: NOTICE,
});

export class ShortlistService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      scopes: TalentScopeService;
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
        subjectKind: "MISSION_TALENT_SHORTLIST",
        subjectId,
        detail: {},
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async ranked(
    missionId: string,
    roleId: string,
  ): Promise<
    SResult<{ scopeId: string; ranked: Ranked[]; staleExcluded: number }>
  > {
    const scope = await this.deps.scopes.inForce(missionId);
    if (!scope) return { ok: false, refusal: "NO_SCOPE_IN_FORCE" };
    const role = scope.document.roles.find((r) => r.roleId === roleId);
    if (!role) return { ok: false, refusal: "NO_SUCH_ROLE" };
    const rows = await this.deps
      .sql`select candidate_id, handle, profile, scope_id from mission_talent_candidates where mission_id = ${missionId} and role_id = ${roleId}`;
    const current = rows.filter((r) => String(r.scope_id) === scope.scopeId);
    return {
      ok: true,
      value: {
        scopeId: scope.scopeId,
        ranked: rank(
          role,
          current.map((r) => ({
            candidateId: String(r.candidate_id),
            handle: String(r.handle),
            profile: r.profile as Profile,
          })),
        ),
        staleExcluded: rows.length - current.length,
      },
    };
  }

  async ranking(
    caller: MissionCaller,
    missionId: string,
    roleId: string,
  ): Promise<
    SResult<{
      roleId: string;
      scopeId: string;
      ranked: Ranked[];
      staleExcluded: number;
      notice: string;
    }>
  > {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "COMPARE",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const r = await this.ranked(missionId, roleId);
    return r.ok
      ? { ok: true, value: { roleId, ...r.value, notice: NOTICE } }
      : r;
  }

  async adopt(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<SResult<{ shortlist: ShortlistView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = AdoptSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [prior] =
      await sql`select * from mission_talent_shortlists where mission_id = ${missionId} and adopted_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.role_id === b.data.roleId &&
        JSON.stringify(prior.candidate_ids) ===
          JSON.stringify(b.data.candidateIds)
        ? { ok: true, value: { shortlist: toView(prior), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const r = await this.ranked(missionId, b.data.roleId);
    if (!r.ok) return r;
    const problems = shortlistProblems(r.value.ranked, b.data.candidateIds);
    if (problems.length > 0)
      return {
        ok: false,
        refusal: "SHORTLIST_INVALID",
        detail: problems.join(","),
      };
    const id = `tsl_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    try {
      const [row] =
        await sql`insert into mission_talent_shortlists (shortlist_id, mission_id, scope_id, role_id, candidate_ids, snapshot, note, adopted_by, idempotency_key, adopted_at)
        values (${id}, ${missionId}, ${r.value.scopeId}, ${b.data.roleId}, ${sql.json(b.data.candidateIds)}, ${sql.json({ ranked: r.value.ranked } as never)}, ${b.data.note}, ${caller.id}, ${b.data.idempotencyKey}, ${now}) returning *`;
      await this.log(caller, "TALENT_SHORTLIST_ADOPTED", id, now);
      return { ok: true, value: { shortlist: toView(row!), replayed: false } };
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_ACTIVE" };
      throw e;
    }
  }

  async withdraw(
    caller: MissionCaller,
    shortlistId: string,
    rawBody: unknown,
  ): Promise<SResult<{ shortlist: ShortlistView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = WithdrawSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    if (!/^tsl_[a-f0-9]{24}$/u.test(shortlistId))
      return { ok: false, refusal: "NOT_FOUND" };
    const sql = this.deps.sql;
    const [r] =
      await sql`select s.* from mission_talent_shortlists s join missions m on m.mission_id = s.mission_id
      where s.shortlist_id = ${shortlistId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    if (r.status === "WITHDRAWN")
      return { ok: true, value: { shortlist: toView(r), replayed: true } };
    const now = this.deps.now();
    const upd =
      await sql`update mission_talent_shortlists set status = 'WITHDRAWN', withdrawn_by = ${caller.id}, withdrawn_at = ${now}, withdrawn_reason = ${b.data.reason}
      where shortlist_id = ${shortlistId} and status = 'ACTIVE' returning *`;
    if (upd.length === 0)
      return { ok: true, value: { shortlist: toView(r), replayed: true } };
    await this.log(caller, "TALENT_SHORTLIST_WITHDRAWN", shortlistId, now);
    return { ok: true, value: { shortlist: toView(upd[0]!), replayed: false } };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<SResult<{ shortlists: ShortlistView[] }>> {
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
      .sql`select * from mission_talent_shortlists where mission_id = ${missionId} order by seq`;
    return { ok: true, value: { shortlists: rows.map(toView) } };
  }
}
