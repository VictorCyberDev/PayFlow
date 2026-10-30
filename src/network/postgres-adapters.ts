import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { VerificationDependencies } from "./verify.js";
import {
  assertEnvironmentBoundary,
  assertSameTenant,
  type ControlPlaneEnvironment,
} from "./control-plane.js";
import { transitionAgentLifecycle, type AgentLifecycle } from "./enterprise.js";
import type { UsageEvent, UsageMeter } from "./metering.js";

/**
 * Durable adapters for the M7–M60 control plane. Every query that touches
 * tenant-owned rows is scoped by (organization, environment) in SQL, so a
 * caller cannot reach another tenant's rows by guessing identifiers.
 */
export class PostgresNetworkStore {
  constructor(private readonly sql: Sql) {}

  /** Atomic first-use claim for Verify presentations. Stored as a digest, never the raw key. */
  claimVerificationReplay: VerificationDependencies["claimPresentationReplayKey"] =
    async (scope, key) => {
      const digest = createHash("sha256").update(key, "utf8").digest("hex");
      const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
      const rows = await this.sql`
        insert into verification_replay_keys (scope, replay_key, expires_at)
        values (${scope}, ${digest}, ${expiresAt})
        on conflict do nothing
        returning replay_key`;
      return rows.length === 1;
    };

  async createOrganization(id: string, displayName: string): Promise<void> {
    await this
      .sql`insert into organizations (id, display_name) values (${id}, ${displayName})`;
  }

  async assignAuthority(
    organizationId: string,
    environment: ControlPlaneEnvironment,
    mandateId: string,
    ownerPrincipalId: string,
  ): Promise<void> {
    await this.sql`
      insert into authority_ownership (mandate_id, organization_id, environment, owner_principal_id)
      values (${mandateId}, ${organizationId}, ${environment}, ${ownerPrincipalId})`;
  }

  /** Tenant-scoped listing: only this organization's rows in this environment. */
  async listAuthorityIds(
    organizationId: string,
    environment: ControlPlaneEnvironment,
  ): Promise<readonly string[]> {
    const rows = await this.sql`
      select mandate_id from authority_ownership
      where organization_id = ${organizationId} and environment = ${environment}
      order by mandate_id`;
    return rows.map((row) => String(row.mandate_id));
  }

  /**
   * Resolves ownership first, then enforces the tenant and environment
   * boundary, so existence of another tenant's Authority is not disclosed
   * differently from absence.
   */
  async requireOwnedAuthority(
    callerOrganizationId: string,
    callerEnvironment: ControlPlaneEnvironment,
    mandateId: string,
  ): Promise<{ mandateId: string; ownerPrincipalId: string }> {
    const rows = await this.sql`
      select organization_id, environment, owner_principal_id
      from authority_ownership where mandate_id = ${mandateId}`;
    const row = rows[0];
    if (!row) throw new Error("CROSS_TENANT_ACCESS_DENIED");
    assertSameTenant(callerOrganizationId, String(row.organization_id));
    assertEnvironmentBoundary(
      callerEnvironment,
      row.environment as ControlPlaneEnvironment,
    );
    return { mandateId, ownerPrincipalId: String(row.owner_principal_id) };
  }

  async registerAgent(
    organizationId: string,
    environment: ControlPlaneEnvironment,
    agentId: string,
    sponsorPrincipalId: string,
  ): Promise<void> {
    await this.sql`
      insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
      values (${organizationId}, ${agentId}, ${environment}, ${sponsorPrincipalId})`;
  }

  /** Monotone lifecycle: REVOKED and RETIRED are terminal. Compare-and-set on the current state. */
  async transitionAgent(
    organizationId: string,
    environment: ControlPlaneEnvironment,
    agentId: string,
    to: AgentLifecycle,
  ): Promise<AgentLifecycle> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        select lifecycle from organization_agents
        where organization_id = ${organizationId} and environment = ${environment} and agent_id = ${agentId}
        for update`;
      const current = rows[0]?.lifecycle as AgentLifecycle | undefined;
      if (!current) throw new Error("CROSS_TENANT_ACCESS_DENIED");
      const next = transitionAgentLifecycle(current, to);
      await tx`
        update organization_agents set lifecycle = ${next}, updated_at = now()
        where organization_id = ${organizationId} and environment = ${environment} and agent_id = ${agentId}`;
      return next;
    });
  }

  async agentLifecycle(
    organizationId: string,
    environment: ControlPlaneEnvironment,
    agentId: string,
  ): Promise<AgentLifecycle | null> {
    const rows = await this.sql`
      select lifecycle from organization_agents
      where organization_id = ${organizationId} and environment = ${environment} and agent_id = ${agentId}`;
    return (rows[0]?.lifecycle as AgentLifecycle | undefined) ?? null;
  }

  /** Idempotent by key: a retried delivery never double-counts usage. */
  async recordUsage(event: UsageEvent): Promise<"RECORDED" | "DUPLICATE"> {
    const rows = await this.sql`
      insert into usage_events (id, organization_id, environment, meter, quantity, occurred_at, idempotency_key)
      values (${event.id}, ${event.organizationId}, ${event.environment}, ${event.meter}, ${event.quantity}, ${event.occurredAt}, ${event.idempotencyKey})
      on conflict (idempotency_key) do nothing
      returning id`;
    return rows.length === 1 ? "RECORDED" : "DUPLICATE";
  }

  async usageEvents(
    organizationId: string,
    environment: ControlPlaneEnvironment,
    from: string,
    to: string,
  ): Promise<readonly UsageEvent[]> {
    const rows = await this.sql`
      select id, organization_id, environment, meter, quantity, occurred_at, idempotency_key
      from usage_events
      where organization_id = ${organizationId} and environment = ${environment}
        and occurred_at >= ${from} and occurred_at < ${to}
      order by occurred_at, id`;
    return rows.map((row) => ({
      id: String(row.id),
      organizationId: String(row.organization_id),
      environment: row.environment as ControlPlaneEnvironment,
      meter: row.meter as UsageMeter,
      quantity: Number(row.quantity),
      occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
      idempotencyKey: String(row.idempotency_key),
    }));
  }
}
