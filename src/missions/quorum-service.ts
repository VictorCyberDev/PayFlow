import type { Sql } from "postgres";
import { z } from "zod";
import {
  QuorumPolicySchema,
  evaluateQuorum,
  tierFor,
  type QuorumPolicy,
  type QuorumVerdict,
  type Role,
} from "./quorum.js";
import type { MissionCaller } from "./service.js";

/**
 * V3 M65 — approval quorum in front of mission approval. With no policy it does nothing, so every existing path is unchanged. With one, an
 * approval above a threshold is recorded as a vote and the mission is put in force only when enough distinct, current, eligible owners other
 * than the requester have approved. The arithmetic is quorum.ts; this file only loads facts and stores votes.
 */
export type Gate =
  | { proceed: true }
  | {
      proceed: false;
      verdict: Extract<QuorumVerdict, { state: "WAITING" | "BLOCKED" }>;
    };

const Contract = z.object({ totalBudgetMinor: z.number().int() }).passthrough();
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;

export class QuorumService {
  constructor(private readonly deps: { sql: Sql; now: () => string }) {}

  async getPolicy(t: Tenant): Promise<QuorumPolicy | null> {
    const [r] = await this.deps
      .sql`select policy from org_quorum_policies where organization_id = ${t.organizationId} and environment = ${t.environment}`;
    return r ? QuorumPolicySchema.parse(r.policy) : null;
  }

  /** Replace the policy. `null` removes it (single-owner approval again). Returns false when the policy is not valid. */
  async setPolicy(
    t: Tenant,
    raw: unknown,
    actor: string,
  ): Promise<{ ok: true } | { ok: false }> {
    if (raw === null) {
      await this.deps
        .sql`delete from org_quorum_policies where organization_id = ${t.organizationId} and environment = ${t.environment}`;
      return { ok: true };
    }
    const p = QuorumPolicySchema.safeParse(raw);
    if (!p.success) return { ok: false };
    await this.deps
      .sql`insert into org_quorum_policies (organization_id, environment, policy, updated_by, updated_at)
      values (${t.organizationId}, ${t.environment}, ${this.deps.sql.json(p.data as never)}, ${actor}, ${this.deps.now()})
      on conflict (organization_id, environment) do update set policy = excluded.policy, updated_by = excluded.updated_by, updated_at = excluded.updated_at`;
    return { ok: true };
  }

  /** Called when a member asks to approve `version`. Records the vote when a quorum applies. */
  async gate(
    caller: MissionCaller,
    missionId: string,
    version: number,
  ): Promise<Gate> {
    const policy = await this.getPolicy(caller);
    if (!policy) return { proceed: true };
    const sql = this.deps.sql;
    const [v] =
      await sql`select mv.contract, mv.decision, mv.authored_by_kind, mv.authored_by
      from mission_versions mv join missions m on m.mission_id = mv.mission_id
      where m.mission_id = ${missionId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}
        and mv.version = ${version}`;
    // Anything the mission service would refuse anyway (unknown, already decided) is left for it to refuse.
    if (!v || v.decision !== "PENDING") return { proceed: true };
    const amount = Contract.safeParse(v.contract);
    if (!amount.success) return { proceed: true };
    if (!tierFor(policy, amount.data.totalBudgetMinor))
      return { proceed: true };
    await sql`insert into mission_approval_votes (mission_id, version, member_id, decision, voted_at)
      values (${missionId}, ${version}, ${caller.id}, 'APPROVE', ${this.deps.now()}) on conflict do nothing`;
    const rows =
      await sql`select vt.member_id, vt.voted_at, m.role from mission_approval_votes vt
      join organization_members m on m.member_id = vt.member_id
      where vt.mission_id = ${missionId} and vt.version = ${version} and m.organization_id = ${caller.organizationId}
        and m.environment = ${caller.environment} and m.status = 'ACTIVE'`;
    const requester =
      v.authored_by_kind === "MEMBER" ? String(v.authored_by) : "";
    const verdict = evaluateQuorum(
      policy,
      amount.data.totalBudgetMinor,
      requester,
      rows.map((r) => ({
        memberId: String(r.member_id),
        roleNow: String(r.role) as Role,
        decision: "APPROVE" as const,
        at: new Date(r.voted_at as string).toISOString(),
      })),
      { expiresAt: "9999-12-31T00:00:00.000Z" },
    );
    return verdict.state === "WAITING" || verdict.state === "BLOCKED"
      ? { proceed: false, verdict }
      : { proceed: true };
  }
}
