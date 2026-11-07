import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { PostgresTrustRepository } from "../persistence.js";
import { GATEWAY_AUDIENCE } from "./gateway.js";
import type { AuditLog, Environment } from "./ops-controls.js";
import {
  PostgresDelegationRegistry,
  type DelegationTenant,
  type DelegationView,
  type DelegateRefusal,
} from "./delegation.js";

/**
 * Tenant-facing delegation: product APIs over the local delegation engine.
 *
 * Rules, all enforced here and in the engine, none of them left to the caller:
 *  - A ROOT delegation is made by an authorized MEMBER from a STORED Authority of their own tenant. Its scope comes from
 *    storage: action PURCHASE, the stored currency, merchants within the stored list, and a shared budget no larger than the
 *    Authority's own cumulative limit. A caller cannot name a currency or action kind.
 *  - A HOP is made by the agent that holds the parent delegation (or by a member for it). It can only narrow: omitted fields
 *    default to the parent's, and any field wider than the parent's is refused by the engine.
 *  - Tenant, environment and Authority come from the authenticated caller and the stored parent, never from a request body.
 *  - It never bypasses the Trust Kernel: a delegation is only a constraint checked before the Authority decides.
 */
const DEFAULT_ROOT_TTL = 24 * 3600;
const MAX_TTL = 7 * 24 * 3600;
const IdemKey = z.string().min(16).max(128);
const CounterpartyList = z
  .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u))
  .min(1)
  .max(100);
const Agent = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export const RootRequestSchema = z
  .object({
    childAgentId: Agent,
    budgetMinor: z.number().int().safe().positive(),
    counterpartyIds: CounterpartyList.optional(),
    ttlSeconds: z.number().int().min(60).max(MAX_TTL).optional(),
    idempotencyKey: IdemKey,
  })
  .strict();
export const HopRequestSchema = z
  .object({
    childAgentId: Agent,
    maxAmountMinor: z.number().int().safe().positive().optional(),
    counterpartyIds: CounterpartyList.optional(),
    currencies: z
      .array(z.string().regex(/^[A-Z]{3}$/u))
      .min(1)
      .max(5)
      .optional(),
    actionKinds: z.array(z.string().min(1).max(40)).min(1).max(5).optional(),
    ttlSeconds: z.number().int().min(60).max(MAX_TTL).optional(),
    idempotencyKey: IdemKey,
  })
  .strict();

export type DelegationRefusal =
  | DelegateRefusal
  | "AUTHORITY_NOT_FOUND"
  | "AUTHORITY_REVOKED"
  | "AUTHORITY_EXPIRED"
  | "AUTHORITY_INTEGRITY_FAILED"
  | "MERCHANT_SCOPE_NOT_ENUMERABLE"
  | "NO_CUMULATIVE_LIMIT"
  | "BUDGET_ABOVE_AUTHORITY"
  | "COUNTERPARTY_NOT_IN_AUTHORITY"
  | "AGENT_NOT_IN_ORGANIZATION"
  | "NOT_THE_DELEGATING_AGENT"
  | "DELEGATION_NOT_FOUND";

export type CreateResult =
  | { ok: true; delegationId: string; replayed: boolean; view: DelegationView }
  | { ok: false; refusal: DelegationRefusal };

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");

export interface Caller {
  readonly organizationId: string;
  readonly environment: Environment;
  readonly id: string;
  readonly kind: "MEMBER" | "AGENT";
}

export class DelegationService {
  readonly registry: PostgresDelegationRegistry;
  constructor(
    private readonly deps: {
      sql: Sql;
      repo: PostgresTrustRepository;
      audit: AuditLog;
      now: () => string;
    },
  ) {
    this.registry = new PostgresDelegationRegistry(deps.sql);
  }

  private async agentInTenant(c: Caller, agentId: string): Promise<boolean> {
    const [row] = await this.deps.sql`
      select lifecycle from organization_agents
      where organization_id = ${c.organizationId} and environment = ${c.environment} and agent_id = ${agentId}`;
    return (
      !!row &&
      !["SUSPENDED", "REVOKED", "RETIRED"].includes(String(row.lifecycle))
    );
  }

  /** A member creates the ROOT of a chain from a stored Authority. */
  async createRoot(
    member: Caller,
    authorityId: string,
    rawBody: unknown,
  ): Promise<CreateResult> {
    const parsed = RootRequestSchema.safeParse(rawBody);
    if (!parsed.success) return { ok: false, refusal: "MALFORMED" };
    const req = parsed.data;
    const now = this.deps.now();
    const owned = await this.deps.sql`
      select 1 from authority_ownership
      where mandate_id = ${authorityId} and organization_id = ${member.organizationId} and environment = ${member.environment}`;
    let mandate;
    try {
      mandate = owned[0] ? await this.deps.repo.getMandate(authorityId) : null;
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        (error instanceof Error &&
          error.message === "MALFORMED_PERSISTED_MANDATE")
      )
        return { ok: false, refusal: "AUTHORITY_INTEGRITY_FAILED" };
      throw error;
    }
    if (!mandate) return { ok: false, refusal: "AUTHORITY_NOT_FOUND" };
    const [state] = await this.deps
      .sql`select revoked_at from mandates where id = ${authorityId}`;
    if (state?.revoked_at) return { ok: false, refusal: "AUTHORITY_REVOKED" };
    if (Date.parse(mandate.expiresAt) <= Date.parse(now))
      return { ok: false, refusal: "AUTHORITY_EXPIRED" };
    if (mandate.merchantScope?.mode !== "ONLY")
      return { ok: false, refusal: "MERCHANT_SCOPE_NOT_ENUMERABLE" };
    if (
      mandate.cumulativeLimitMinor === undefined ||
      mandate.cumulativeLimitMinor === null
    )
      return { ok: false, refusal: "NO_CUMULATIVE_LIMIT" };
    if (req.budgetMinor > mandate.cumulativeLimitMinor)
      return { ok: false, refusal: "BUDGET_ABOVE_AUTHORITY" };
    const stored = mandate.merchantScope.ids;
    if (
      req.counterpartyIds &&
      !req.counterpartyIds.every((c) => stored.includes(c))
    )
      return { ok: false, refusal: "COUNTERPARTY_NOT_IN_AUTHORITY" };
    if (!(await this.agentInTenant(member, req.childAgentId)))
      return { ok: false, refusal: "AGENT_NOT_IN_ORGANIZATION" };
    const expiresMs = Math.min(
      Date.parse(now) + (req.ttlSeconds ?? DEFAULT_ROOT_TTL) * 1000,
      Date.parse(mandate.expiresAt),
    );
    const tenant: DelegationTenant = {
      organizationId: member.organizationId,
      environment: member.environment,
      authorityId,
      createdBy: member.id,
      createdByKind: "MEMBER",
      idempotencyKey: req.idempotencyKey,
      requestDigest: digest({ op: "root", authorityId, ...req }),
    };
    const out = await this.registry.issueRoot(
      {
        principalId: mandate.principalId,
        parentAgentId: `principal:${mandate.principalId}`,
        childAgentId: req.childAgentId,
        audience: GATEWAY_AUDIENCE,
        actionKinds: ["PURCHASE"],
        currencies: [mandate.currency],
        counterpartyIds: req.counterpartyIds ?? stored,
        maxAmountMinor: req.budgetMinor,
        issuedAt: now,
        expiresAt: new Date(expiresMs).toISOString(),
        nonce: `n-${randomBytes(12).toString("hex")}`,
      },
      now,
      tenant,
    );
    return this.finish(member, tenant, out, now, "DELEGATION_ROOT_CREATED", {
      authorityId,
      childAgentId: req.childAgentId,
      budgetMinor: req.budgetMinor,
    });
  }

  /**
   * A hop: the caller delegates part of a delegation it holds. An AGENT caller must be the parent's child agent; a MEMBER
   * may create the hop on behalf of the tenant. Omitted fields default to the parent's and only narrowing is accepted.
   */
  async createHop(
    caller: Caller,
    parentId: string,
    rawBody: unknown,
  ): Promise<CreateResult> {
    const parsed = HopRequestSchema.safeParse(rawBody);
    if (!parsed.success) return { ok: false, refusal: "MALFORMED" };
    const req = parsed.data;
    const now = this.deps.now();
    const parent = await this.registry.inspect(caller, parentId, now);
    if (!parent || !parent.authorityId)
      return { ok: false, refusal: "DELEGATION_NOT_FOUND" };
    if (caller.kind === "AGENT" && parent.childAgentId !== caller.id)
      return { ok: false, refusal: "NOT_THE_DELEGATING_AGENT" };
    if (!(await this.agentInTenant(caller, req.childAgentId)))
      return { ok: false, refusal: "AGENT_NOT_IN_ORGANIZATION" };
    const [row] = await this.deps
      .sql`select principal_id from delegations where delegation_id = ${parentId}`;
    const tenant: DelegationTenant = {
      organizationId: caller.organizationId,
      environment: caller.environment,
      authorityId: parent.authorityId,
      createdBy: caller.id,
      createdByKind: caller.kind,
      idempotencyKey: req.idempotencyKey,
      requestDigest: digest({ op: "hop", parentId, ...req }),
    };
    const expiresMs = Math.min(
      Date.parse(now) + (req.ttlSeconds ?? MAX_TTL) * 1000,
      Date.parse(parent.own.expiresAt),
    );
    const out = await this.registry.delegate(
      parentId,
      {
        principalId: String(row?.principal_id),
        parentAgentId: parent.childAgentId,
        childAgentId: req.childAgentId,
        audience: GATEWAY_AUDIENCE,
        actionKinds: req.actionKinds ?? parent.own.actionKinds,
        currencies: req.currencies ?? parent.own.currencies,
        counterpartyIds: req.counterpartyIds ?? parent.own.counterpartyIds,
        maxAmountMinor: req.maxAmountMinor ?? parent.own.maxAmountMinor,
        issuedAt: now,
        expiresAt: new Date(expiresMs).toISOString(),
        nonce: `n-${randomBytes(12).toString("hex")}`,
      },
      now,
      tenant,
    );
    return this.finish(caller, tenant, out, now, "DELEGATION_HOP_CREATED", {
      authorityId: parent.authorityId,
      parentId,
      childAgentId: req.childAgentId,
      maxAmountMinor: req.maxAmountMinor ?? parent.own.maxAmountMinor,
    });
  }

  private async finish(
    caller: Caller,
    tenant: DelegationTenant,
    out: Awaited<ReturnType<PostgresDelegationRegistry["issueRoot"]>>,
    now: string,
    action: string,
    detail: Record<string, string | number>,
  ): Promise<CreateResult> {
    if (!out.ok) return { ok: false, refusal: out.reason };
    const view = await this.registry.inspect(caller, out.delegationId, now);
    if (!view) return { ok: false, refusal: "DELEGATION_NOT_FOUND" };
    if (!out.replayed)
      await this.deps.audit.append({
        organizationId: tenant.organizationId,
        environment: tenant.environment,
        actorKind: caller.kind === "MEMBER" ? "MEMBER" : "AGENT_CREDENTIAL",
        actorId: caller.id,
        action,
        subjectKind: "DELEGATION",
        subjectId: out.delegationId,
        detail,
        occurredAt: now,
      });
    return {
      ok: true,
      delegationId: out.delegationId,
      replayed: out.replayed,
      view,
    };
  }

  inspect(caller: Caller, delegationId: string) {
    return this.registry.inspect(caller, delegationId, this.deps.now());
  }
  list(caller: Caller, authorityId: string) {
    return this.registry.listForAuthority(caller, authorityId, this.deps.now());
  }

  async revoke(caller: Caller, delegationId: string, reason: string) {
    const now = this.deps.now();
    const done = await this.registry.revokeFor(
      caller,
      delegationId,
      reason,
      now,
    );
    if (done.found && !done.alreadyRevoked)
      await this.deps.audit.append({
        organizationId: caller.organizationId,
        environment: caller.environment,
        actorKind: "MEMBER",
        actorId: caller.id,
        action: "DELEGATION_REVOKED",
        subjectKind: "DELEGATION",
        subjectId: delegationId,
        detail: { reason: reason.slice(0, 200) },
        occurredAt: now,
      });
    return done;
  }
}
