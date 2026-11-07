import { randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { Mandate } from "../domain.js";
import { MandateSchema } from "../domain.js";
import type { PostgresTrustRepository } from "../persistence.js";
import type { AuditLog, Environment } from "../network/ops-controls.js";
import { MissionContractSchema, type MissionContract } from "./contract.js";

/**
 * Mission Authority Compiler (V3 M29).
 *
 * A Mission Contract decides nothing. When an owner approves a version, each agent holding PURCHASE gets stored Authorities (the
 * existing `mandates`) compiled from it, and the one Trust Kernel decides every purchase against them. The compiler's whole job is
 * attenuation: a compiled Authority is NEVER broader than the contract, the organization, the owner's approval or the agent:
 *
 *  - merchants: only an explicit `ONLY` list can compile (an Authority needs enumerable merchants; ANY and NONE_ALLOWED do not);
 *  - category: an Authority has one category, so one is compiled per (agent, category), and at least one category is required;
 *  - amounts: maxSingle = min(maximum commitment, allocation); human-approval threshold <= maxSingle; the cumulative limit is the
 *    agent-and-category ALLOCATION of the budget, less what earlier Authorities for the same pair already consumed, so pausing and
 *    resuming (which compiles fresh Authorities) cannot launder spend; and the allocations of one mission sum to at most its budget;
 *  - time: it expires with the contract;
 *  - who: only an agent that the contract granted PURCHASE, and that is active in the organization.
 *
 * Revocation is not an afterthought: pausing, revoking, cancelling, completing, expiring or superseding a mission revokes its
 * Authorities in the SAME transaction as the state change (`revokeCompiledInTx`), so no failure can leave spending power behind.
 * Compilation is the opposite: it happens after commit and is idempotent, and its failure leaves the agent with NO Authority.
 */
export interface CompiledAuthority {
  readonly authorityId: string;
  readonly agentId: string;
  readonly category: string;
  readonly missionVersion: number;
  readonly allocationMinor: number;
  readonly maxSingleTransactionMinor: number;
  readonly status: "ACTIVE" | "REVOKED";
}
export interface NotCompiled {
  readonly agentId: string | null;
  readonly category: string | null;
  readonly reason:
    | "MERCHANTS_NOT_ENUMERABLE"
    | "NO_SPENDING_CATEGORY"
    | "NO_PURCHASING_AGENT"
    | "AGENT_NOT_IN_ORGANIZATION"
    | "ALLOCATION_EXHAUSTED"
    | "MISSION_NOT_ACTIVE";
}

/** Revokes every ACTIVE compiled Authority of a mission. Call inside the transaction that changes the mission. Idempotent. */
export async function revokeCompiledInTx(
  tx: TransactionSql,
  missionId: string,
  reason: string,
  now: string,
): Promise<number> {
  const rows = await tx`
    select authority_id from mission_authorities where mission_id = ${missionId} and status = 'ACTIVE' for update`;
  if (rows.length === 0) return 0;
  await tx`update mandates set revoked_at = ${now} where revoked_at is null and id in
    (select authority_id from mission_authorities where mission_id = ${missionId} and status = 'ACTIVE')`;
  await tx`update mission_authorities set status = 'REVOKED', revoked_reason = ${reason.slice(0, 120)}, revoked_at = ${now}
    where mission_id = ${missionId} and status = 'ACTIVE'`;
  return rows.length;
}

export class MissionAuthorityCompiler {
  constructor(
    private readonly deps: {
      sql: Sql;
      repo: PostgresTrustRepository;
      audit: AuditLog;
      now: () => string;
    },
  ) {}

  /** Brings a mission's Authorities in line with its state: compiles for an ACTIVE mission that has none for its version. */
  async reconcile(
    tenant: { organizationId: string; environment: Environment },
    missionId: string,
  ): Promise<{
    compiled: readonly CompiledAuthority[];
    notCompiled: readonly NotCompiled[];
  }> {
    const now = this.deps.now();
    const out = await this.deps.sql.begin(async (tx) => {
      const [m] =
        await tx`select * from missions where mission_id = ${missionId} and organization_id = ${tenant.organizationId}
        and environment = ${tenant.environment} for update`;
      if (!m)
        return {
          compiled: [] as CompiledAuthority[],
          notCompiled: [] as NotCompiled[],
        };
      if (m.status !== "ACTIVE" || m.active_version === null)
        return {
          compiled: [] as CompiledAuthority[],
          notCompiled: [
            {
              agentId: null,
              category: null,
              reason: "MISSION_NOT_ACTIVE" as const,
            },
          ],
        };
      const version = Number(m.active_version);
      const [v] =
        await tx`select contract from mission_versions where mission_id = ${missionId} and version = ${version}`;
      const contract = MissionContractSchema.parse(v!.contract);
      return this.compileInTx(tx, missionId, version, contract, tenant, now);
    });
    for (const a of out.compiled)
      await this.deps.audit
        .append({
          organizationId: tenant.organizationId,
          environment: tenant.environment,
          actorKind: "SYSTEM",
          actorId: "mission-compiler",
          action: "MISSION_AUTHORITY_COMPILED",
          subjectKind: "MISSION",
          subjectId: missionId,
          detail: {
            authorityId: a.authorityId,
            agentId: a.agentId,
            allocationMinor: a.allocationMinor,
            version: a.missionVersion,
          },
          occurredAt: now,
        })
        .catch(() => undefined);
    return out;
  }

  private async compileInTx(
    tx: TransactionSql,
    missionId: string,
    version: number,
    contract: MissionContract,
    tenant: { organizationId: string; environment: Environment },
    now: string,
  ): Promise<{ compiled: CompiledAuthority[]; notCompiled: NotCompiled[] }> {
    const compiled: CompiledAuthority[] = [];
    const notCompiled: NotCompiled[] = [];
    const buyers = contract.agents.filter((a) =>
      a.capabilities.includes("PURCHASE"),
    );
    if (buyers.length === 0)
      return {
        compiled,
        notCompiled: [
          { agentId: null, category: null, reason: "NO_PURCHASING_AGENT" },
        ],
      };
    if (contract.merchantRestrictions.mode !== "ONLY")
      return {
        compiled,
        notCompiled: buyers.map((b) => ({
          agentId: b.agentId,
          category: null,
          reason: "MERCHANTS_NOT_ENUMERABLE" as const,
        })),
      };
    if (contract.spendingCategories.length === 0)
      return {
        compiled,
        notCompiled: buyers.map((b) => ({
          agentId: b.agentId,
          category: null,
          reason: "NO_SPENDING_CATEGORY" as const,
        })),
      };
    const merchants = contract.merchantRestrictions.ids;
    const pairs = buyers.flatMap((b) =>
      contract.spendingCategories.map((category) => ({
        agentId: b.agentId,
        category,
      })),
    );
    // Allocations of one mission sum to at most its budget: an even split, rounded down.
    const share = Math.floor(contract.totalBudgetMinor / pairs.length);
    for (const { agentId, category } of pairs) {
      const [existing] =
        await tx`select 1 from mission_authorities where mission_id = ${missionId} and agent_id = ${agentId}
        and category = ${category} and status = 'ACTIVE'`;
      if (existing) continue;
      const [agent] =
        await tx`select sponsor_principal_id, lifecycle from organization_agents where organization_id = ${tenant.organizationId}
        and environment = ${tenant.environment} and agent_id = ${agentId}`;
      if (
        !agent ||
        ["SUSPENDED", "REVOKED", "RETIRED"].includes(String(agent.lifecycle))
      ) {
        notCompiled.push({
          agentId,
          category,
          reason: "AGENT_NOT_IN_ORGANIZATION",
        });
        continue;
      }
      // What earlier Authorities of this mission already used for this pair counts against the allocation (reserved, executing or committed).
      const [spent] = await tx`
        select coalesce(sum(r.amount_minor),0)::bigint n from authorization_reservations r
        join mission_authorities a on a.authority_id = r.mandate_id
        where a.mission_id = ${missionId} and a.agent_id = ${agentId} and a.category = ${category} and r.status in ('COMMITTED','AUTHORIZED','EXECUTING')`;
      const limit = share - Number(spent!.n);
      if (limit < 1) {
        notCompiled.push({ agentId, category, reason: "ALLOCATION_EXHAUSTED" });
        continue;
      }
      const maxSingle = Math.min(contract.maxCommitmentMinor, limit);
      const autonomous = Math.min(
        contract.approvalConditions.humanApprovalAboveMinor ?? maxSingle,
        maxSingle,
      );
      const mandate: Mandate = MandateSchema.parse({
        id: `mission-authority-${missionId.slice(4, 16)}-${randomBytes(6).toString("hex")}`,
        principalId: String(agent.sponsor_principal_id),
        authorizedAgentId: agentId,
        purpose: contract.objective.slice(0, 500),
        category,
        currency: contract.currency,
        maxSingleTransactionMinor: maxSingle,
        cumulativeLimitMinor: limit,
        quantityLimit: contract.maxItemQuantity ?? 1000,
        merchantScope: { mode: "ONLY", ids: [...merchants] },
        allowedConditions: ["NEW"],
        merchantRiskCeiling: "LOW",
        autonomousPurchaseThresholdMinor: autonomous,
        humanApprovalThresholdMinor: maxSingle,
        allowedCapabilities: ["CAPTURE_PAYMENT"],
        version: 1,
        nonce: randomBytes(16).toString("hex"),
        createdAt: now,
        expiresAt: contract.expiresAt,
      });
      await this.deps.repo.saveMandate(mandate, tx);
      await tx`insert into authority_ownership (mandate_id, organization_id, environment, owner_principal_id)
        values (${mandate.id}, ${tenant.organizationId}, ${tenant.environment}, ${mandate.principalId})`;
      await tx`insert into mission_authorities (mission_id, mission_version, authority_id, agent_id, category, allocation_minor, status, compiled_at)
        values (${missionId}, ${version}, ${mandate.id}, ${agentId}, ${category}, ${limit}, 'ACTIVE', ${now})`;
      compiled.push({
        authorityId: mandate.id,
        agentId,
        category,
        missionVersion: version,
        allocationMinor: limit,
        maxSingleTransactionMinor: maxSingle,
        status: "ACTIVE",
      });
    }
    return { compiled, notCompiled };
  }

  /** What has been compiled from a mission, and what could not be and why (computed, not stored). */
  async list(
    tenant: { organizationId: string; environment: Environment },
    missionId: string,
  ) {
    const sql = this.deps.sql;
    const [m] =
      await sql`select * from missions where mission_id = ${missionId} and organization_id = ${tenant.organizationId} and environment = ${tenant.environment}`;
    if (!m) return null;
    const rows =
      await sql`select a.*, d.document->>'maxSingleTransactionMinor' as max_single from mission_authorities a
      join mandates d on d.id = a.authority_id where a.mission_id = ${missionId} order by a.compiled_at, a.authority_id`;
    const authorities: CompiledAuthority[] = rows.map((r) => ({
      authorityId: String(r.authority_id),
      agentId: String(r.agent_id),
      category: String(r.category),
      missionVersion: Number(r.mission_version),
      allocationMinor: Number(r.allocation_minor),
      maxSingleTransactionMinor: Number(r.max_single),
      status: r.status as "ACTIVE" | "REVOKED",
    }));
    // Why a purchasing agent has no Authority: a dry run of the same rules.
    let notCompiled: NotCompiled[] = [];
    if (m.status === "ACTIVE" && m.active_version !== null) {
      const [v] =
        await sql`select contract from mission_versions where mission_id = ${missionId} and version = ${Number(m.active_version)}`;
      const c = MissionContractSchema.parse(v!.contract);
      const buyers = c.agents.filter((a) =>
        a.capabilities.includes("PURCHASE"),
      );
      if (buyers.length === 0)
        notCompiled = [
          { agentId: null, category: null, reason: "NO_PURCHASING_AGENT" },
        ];
      else if (c.merchantRestrictions.mode !== "ONLY")
        notCompiled = buyers.map((b) => ({
          agentId: b.agentId,
          category: null,
          reason: "MERCHANTS_NOT_ENUMERABLE" as const,
        }));
      else if (c.spendingCategories.length === 0)
        notCompiled = buyers.map((b) => ({
          agentId: b.agentId,
          category: null,
          reason: "NO_SPENDING_CATEGORY" as const,
        }));
    } else
      notCompiled = [
        { agentId: null, category: null, reason: "MISSION_NOT_ACTIVE" },
      ];
    return { authorities, notCompiled };
  }
}
