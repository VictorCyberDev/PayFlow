import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import {
  DelegatedFinancialScopeSchema,
  validateDelegationAttenuation,
  type DelegatedFinancialScope,
  type DelegationViolation,
} from "../protocols/a2a.js";

/** A chain deeper than this is refused: authority should not be passed along without limit. */
export const MAX_DELEGATION_DEPTH = 5;

export type DelegateRefusal =
  | "MALFORMED"
  | "PARENT_NOT_FOUND"
  | "PARENT_REVOKED"
  | "PARENT_EXPIRED"
  | "DEPTH_EXCEEDED"
  | "DUPLICATE_NONCE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "AUTHORITY_MISMATCH"
  | DelegationViolation;

export type ReserveRefusal =
  | "NOT_FOUND"
  | "REVOKED"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "ACTION_KIND_NOT_ALLOWED"
  | "CURRENCY_NOT_ALLOWED"
  | "COUNTERPARTY_NOT_ALLOWED"
  | "AMOUNT_EXCEEDS_CAP"
  | "BUDGET_EXHAUSTED"
  | "AGENT_MISMATCH"
  | "AUTHORITY_MISMATCH";

export interface DelegationSpend {
  readonly actionKind: string;
  readonly currency: string;
  readonly counterpartyId: string;
  readonly amountMinor: number;
  /** The agent presenting the delegation; it must be the leaf's child agent. */
  readonly agentId: string;
  readonly now: string;
  /**
   * The stored Authority the action is for. When given, the delegation must be bound to exactly that Authority; a
   * delegation bound to another Authority, or to none (a pre-tenancy row), is refused.
   */
  readonly authorityId?: string;
}

/** The tenant a delegation belongs to. Taken from the authenticated caller and the stored Authority, never a request body. */
export interface DelegationTenant {
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly authorityId: string;
  readonly createdBy: string;
  readonly createdByKind: "MEMBER" | "AGENT";
  readonly idempotencyKey?: string;
  readonly requestDigest?: string;
}

export type IssueOutcome =
  | { ok: true; delegationId: string; replayed: boolean }
  | { ok: false; reason: DelegateRefusal };

interface Row {
  delegation_id: string;
  root_id: string;
  parent_id: string | null;
  depth: number;
  principal_id: string;
  parent_agent_id: string;
  child_agent_id: string;
  audience: string;
  action_kinds: string[];
  currencies: string[];
  counterparty_ids: string[];
  max_amount_minor: string;
  spent_minor: string;
  issued_at: Date;
  expires_at: Date;
  nonce: string;
  revoked_at: Date | null;
  organization_id: string | null;
  environment: string | null;
  authority_id: string | null;
  created_by: string | null;
  created_by_kind: string | null;
  revoked_reason: string | null;
}

const toScope = (row: Row): DelegatedFinancialScope =>
  DelegatedFinancialScopeSchema.parse({
    principalId: row.principal_id,
    parentAgentId: row.parent_agent_id,
    childAgentId: row.child_agent_id,
    audience: row.audience,
    actionKinds: row.action_kinds,
    currencies: row.currencies,
    counterpartyIds: row.counterparty_ids,
    maxAmountMinor: Number(row.max_amount_minor),
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    nonce: row.nonce,
  });

const newId = () => `dlg_${randomBytes(12).toString("hex")}`;

/**
 * Durable delegation chains. This only decides whether a delegated action may be PRESENTED to the Authority; it
 * never authorizes money movement. Every id, parent, cap and spend comes from this table, never from the peer.
 */
export class PostgresDelegationRegistry {
  constructor(private readonly sql: Sql) {}

  /** The principal's own grant to the first agent. Callers must be trusted server code (not a peer). */
  async issueRoot(
    rawScope: unknown,
    now: string,
    tenant?: DelegationTenant,
  ): Promise<IssueOutcome> {
    const parsed = DelegatedFinancialScopeSchema.safeParse(rawScope);
    if (!parsed.success) return { ok: false, reason: "MALFORMED" };
    return this.insert(this.sql, parsed.data, null, now, tenant);
  }

  /** A hop: `parentId` delegates a narrower scope to a child agent. */
  async delegate(
    parentId: string,
    rawScope: unknown,
    now: string,
    tenant?: DelegationTenant,
  ): Promise<IssueOutcome> {
    const parsed = DelegatedFinancialScopeSchema.safeParse(rawScope);
    if (!parsed.success) return { ok: false, reason: "MALFORMED" };
    return this.sql.begin(async (tx) => {
      const chain = await this.lockedChain(tx, parentId);
      const parent = chain.at(-1);
      if (!parent)
        return { ok: false as const, reason: "PARENT_NOT_FOUND" as const };
      // With a tenant, the parent must belong to it AND to the same Authority; anything else looks like "not found".
      if (
        tenant &&
        (parent.organization_id !== tenant.organizationId ||
          parent.environment !== tenant.environment ||
          parent.authority_id !== tenant.authorityId)
      )
        return { ok: false as const, reason: "PARENT_NOT_FOUND" as const };
      if (chain.some((row) => row.revoked_at !== null))
        return { ok: false as const, reason: "PARENT_REVOKED" as const };
      const at = Date.parse(now);
      if (chain.some((row) => at >= row.expires_at.getTime()))
        return { ok: false as const, reason: "PARENT_EXPIRED" as const };
      if (parent.depth + 1 > MAX_DELEGATION_DEPTH)
        return { ok: false as const, reason: "DEPTH_EXCEEDED" as const };
      const violations = validateDelegationAttenuation(
        toScope(parent),
        parsed.data,
      );
      if (violations.length > 0)
        return { ok: false as const, reason: violations[0]! };
      if (Date.parse(parsed.data.issuedAt) < parent.issued_at.getTime())
        return { ok: false as const, reason: "PARENT_EXPIRED" as const };
      return this.insert(tx, parsed.data, parent, now, tenant);
    });
  }

  /** Revokes this node. Every descendant is then unusable because a spend must find all ancestors un-revoked. */
  async revoke(
    delegationId: string,
    reason: string,
    now: string,
  ): Promise<boolean> {
    const rows = await this.sql`
      UPDATE delegations SET revoked_at = ${now}, revoked_reason = ${reason.slice(0, 200)}
      WHERE delegation_id = ${delegationId} AND revoked_at IS NULL
      RETURNING delegation_id`;
    return rows.length === 1;
  }

  /**
   * Charges `spend` to the leaf and every ancestor in ONE transaction, or to none of them. Rows are locked in a fixed
   * order (root first) so concurrent spends along shared ancestors serialize and can never both pass a cap check.
   */
  async reserve(
    leafId: string,
    spend: DelegationSpend,
  ): Promise<{ ok: true } | { ok: false; reason: ReserveRefusal }> {
    if (!Number.isSafeInteger(spend.amountMinor) || spend.amountMinor <= 0)
      return { ok: false, reason: "AMOUNT_EXCEEDS_CAP" };
    return this.sql.begin(async (tx) => {
      const chain = await this.lockedChain(tx, leafId);
      const leaf = chain.at(-1);
      if (!leaf || leaf.delegation_id !== leafId)
        return { ok: false as const, reason: "NOT_FOUND" as const };
      if (leaf.child_agent_id !== spend.agentId)
        return { ok: false as const, reason: "AGENT_MISMATCH" as const };
      if (
        spend.authorityId !== undefined &&
        leaf.authority_id !== spend.authorityId
      )
        return { ok: false as const, reason: "AUTHORITY_MISMATCH" as const };
      const at = Date.parse(spend.now);
      for (const row of chain) {
        if (row.revoked_at !== null)
          return { ok: false as const, reason: "REVOKED" as const };
        if (at >= row.expires_at.getTime())
          return { ok: false as const, reason: "EXPIRED" as const };
        if (at < row.issued_at.getTime())
          return { ok: false as const, reason: "NOT_YET_VALID" as const };
        if (!row.action_kinds.includes(spend.actionKind))
          return {
            ok: false as const,
            reason: "ACTION_KIND_NOT_ALLOWED" as const,
          };
        if (!row.currencies.includes(spend.currency))
          return {
            ok: false as const,
            reason: "CURRENCY_NOT_ALLOWED" as const,
          };
        if (!row.counterparty_ids.includes(spend.counterpartyId))
          return {
            ok: false as const,
            reason: "COUNTERPARTY_NOT_ALLOWED" as const,
          };
      }
      // The leaf cap bounds one hop's total; each ancestor's cap bounds everything beneath it.
      for (const row of chain) {
        if (spend.amountMinor > Number(row.max_amount_minor))
          return { ok: false as const, reason: "AMOUNT_EXCEEDS_CAP" as const };
        if (
          Number(row.spent_minor) + spend.amountMinor >
          Number(row.max_amount_minor)
        )
          return { ok: false as const, reason: "BUDGET_EXHAUSTED" as const };
      }
      await tx`
        UPDATE delegations SET spent_minor = spent_minor + ${spend.amountMinor}
        WHERE delegation_id IN ${tx(chain.map((row) => row.delegation_id))}`;
      return { ok: true as const };
    });
  }

  /**
   * Returns budget ONLY when the action is known to have had zero effect (a DENY). An UNKNOWN or completed action
   * keeps its charge: under uncertainty the budget is held, never refunded.
   */
  async release(leafId: string, amountMinor: number): Promise<void> {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return;
    await this.sql.begin(async (tx) => {
      const chain = await this.lockedChain(tx, leafId);
      if (chain.length === 0) return;
      await tx`
        UPDATE delegations SET spent_minor = GREATEST(0, spent_minor - ${amountMinor})
        WHERE delegation_id IN ${tx(chain.map((row) => row.delegation_id))}`;
    });
  }

  async remaining(delegationId: string): Promise<number | null> {
    const [row] = await this.sql<{ remaining: string }[]>`
      SELECT (max_amount_minor - spent_minor)::text AS remaining FROM delegations WHERE delegation_id = ${delegationId}`;
    return row ? Number(row.remaining) : null;
  }

  private async insert(
    q: Sql,
    scope: DelegatedFinancialScope,
    parent: Row | null,
    now: string,
    tenant?: DelegationTenant,
  ): Promise<IssueOutcome> {
    const id = newId();
    // ON CONFLICT instead of catching a unique violation: an error would abort the surrounding transaction.
    const inserted = await q`
      INSERT INTO delegations (delegation_id, root_id, parent_id, depth, principal_id, parent_agent_id, child_agent_id,
        audience, action_kinds, currencies, counterparty_ids, max_amount_minor, issued_at, expires_at, nonce, created_at,
        organization_id, environment, authority_id, created_by, created_by_kind, idempotency_key, request_digest)
      VALUES (${id}, ${parent ? parent.root_id : id}, ${parent ? parent.delegation_id : null},
        ${parent ? parent.depth + 1 : 0}, ${scope.principalId}, ${scope.parentAgentId}, ${scope.childAgentId},
        ${scope.audience}, ${scope.actionKinds}, ${scope.currencies},
        ${scope.counterpartyIds}, ${scope.maxAmountMinor}, ${scope.issuedAt}, ${scope.expiresAt},
        ${scope.nonce}, ${now},
        ${tenant?.organizationId ?? null}, ${tenant?.environment ?? null}, ${tenant?.authorityId ?? null},
        ${tenant?.createdBy ?? null}, ${tenant?.createdByKind ?? null}, ${tenant?.idempotencyKey ?? null},
        ${tenant?.requestDigest ?? null})
      ON CONFLICT DO NOTHING
      RETURNING delegation_id`;
    if (inserted.length === 0) {
      // Either the same idempotent request already succeeded (replay), or the nonce collided.
      if (tenant?.idempotencyKey) {
        const [prior] = await q`
          SELECT delegation_id, request_digest FROM delegations
          WHERE organization_id = ${tenant.organizationId} AND environment = ${tenant.environment}
            AND idempotency_key = ${tenant.idempotencyKey}`;
        if (prior)
          return prior.request_digest === (tenant.requestDigest ?? null)
            ? {
                ok: true,
                delegationId: String(prior.delegation_id),
                replayed: true,
              }
            : { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" };
      }
      return { ok: false, reason: "DUPLICATE_NONCE" };
    }
    return { ok: true, delegationId: id, replayed: false };
  }

  // ------------------------------------------------------------------------------------------ tenant views
  /** A tenant's delegation by id, with its lineage and what it can actually do. Another tenant's id is "not found". */
  async inspect(
    tenant: Pick<DelegationTenant, "organizationId" | "environment">,
    delegationId: string,
    now: string,
  ): Promise<DelegationView | null> {
    const ids = await this.sql<{ delegation_id: string }[]>`
      WITH RECURSIVE up AS (
        SELECT delegation_id, parent_id FROM delegations
        WHERE delegation_id = ${delegationId} AND organization_id = ${tenant.organizationId} AND environment = ${tenant.environment}
        UNION ALL
        SELECT d.delegation_id, d.parent_id FROM delegations d JOIN up ON d.delegation_id = up.parent_id
      )
      SELECT delegation_id FROM up`;
    if (ids.length === 0) return null;
    const chain = await this.sql<Row[]>`
      SELECT * FROM delegations WHERE delegation_id IN ${this.sql(ids.map((r) => r.delegation_id))} ORDER BY depth ASC`;
    const children = await this.sql<{ delegation_id: string }[]>`
      SELECT delegation_id FROM delegations WHERE parent_id = ${delegationId} ORDER BY created_at, delegation_id`;
    return buildView(
      chain,
      children.map((c) => c.delegation_id),
      now,
    );
  }

  async listForAuthority(
    tenant: Pick<DelegationTenant, "organizationId" | "environment">,
    authorityId: string,
    now: string,
  ): Promise<readonly DelegationView[]> {
    const ids = await this.sql<{ delegation_id: string }[]>`
      SELECT delegation_id FROM delegations
      WHERE organization_id = ${tenant.organizationId} AND environment = ${tenant.environment} AND authority_id = ${authorityId}
      ORDER BY depth, created_at, delegation_id LIMIT 500`;
    const views: DelegationView[] = [];
    for (const { delegation_id } of ids) {
      const v = await this.inspect(tenant, delegation_id, now);
      if (v) views.push(v);
    }
    return views;
  }

  /** Revoke within a tenant. Another tenant's id is indistinguishable from a missing one. */
  async revokeFor(
    tenant: Pick<DelegationTenant, "organizationId" | "environment">,
    delegationId: string,
    reason: string,
    now: string,
  ): Promise<{ found: boolean; alreadyRevoked: boolean }> {
    const rows = await this.sql`
      UPDATE delegations SET revoked_at = ${now}, revoked_reason = ${reason.slice(0, 200)}
      WHERE delegation_id = ${delegationId} AND organization_id = ${tenant.organizationId}
        AND environment = ${tenant.environment} AND revoked_at IS NULL
      RETURNING delegation_id`;
    if (rows.length === 1) return { found: true, alreadyRevoked: false };
    const [exists] = await this.sql`
      SELECT 1 FROM delegations WHERE delegation_id = ${delegationId} AND organization_id = ${tenant.organizationId}
        AND environment = ${tenant.environment}`;
    return { found: !!exists, alreadyRevoked: !!exists };
  }

  /**
   * Root → leaf, locked FOR UPDATE in that fixed order, and read AFTER the lock so caps and spend are never stale.
   * The chain's shape (parent links) is immutable, so the ids found first cannot change before they are locked.
   */
  private async lockedChain(q: Sql, leafId: string): Promise<Row[]> {
    const ids = await q<{ delegation_id: string }[]>`
      WITH RECURSIVE up AS (
        SELECT delegation_id, parent_id FROM delegations WHERE delegation_id = ${leafId}
        UNION ALL
        SELECT d.delegation_id, d.parent_id FROM delegations d JOIN up ON d.delegation_id = up.parent_id
      )
      SELECT delegation_id FROM up`;
    if (ids.length === 0) return [];
    return q<Row[]>`
      SELECT * FROM delegations
      WHERE delegation_id IN ${q(ids.map((row) => row.delegation_id))}
      ORDER BY depth ASC
      FOR UPDATE`;
  }
}

export interface DelegationView {
  readonly delegationId: string;
  readonly authorityId: string | null;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly depth: number;
  readonly parentAgentId: string;
  readonly childAgentId: string;
  readonly createdBy: string | null;
  readonly createdByKind: string | null;
  readonly status:
    "ACTIVE" | "REVOKED" | "EXPIRED" | "ANCESTOR_REVOKED" | "ANCESTOR_EXPIRED";
  readonly own: {
    readonly actionKinds: readonly string[];
    readonly currencies: readonly string[];
    readonly counterpartyIds: readonly string[];
    readonly maxAmountMinor: number;
    readonly spentMinor: number;
    readonly notBefore: string;
    readonly expiresAt: string;
  };
  /** What this agent can actually do: the intersection of every hop above it. */
  readonly effective: {
    readonly actionKinds: readonly string[];
    readonly currencies: readonly string[];
    readonly counterpartyIds: readonly string[];
    readonly perActionMaxMinor: number;
    /** The smallest remaining budget on the path: the shared budget is bounded by its tightest ancestor. */
    readonly remainingBudgetMinor: number;
    readonly notBefore: string;
    readonly expiresAt: string;
  };
  readonly lineage: readonly {
    readonly delegationId: string;
    readonly childAgentId: string;
    readonly depth: number;
    readonly revoked: boolean;
  }[];
  readonly childIds: readonly string[];
}

const intersect = (a: readonly string[], b: readonly string[]) =>
  a.filter((x) => b.includes(x));

function buildView(
  chain: Row[],
  childIds: readonly string[],
  now: string,
): DelegationView {
  const leaf = chain.at(-1)!;
  const at = Date.parse(now);
  let kinds = chain[0]!.action_kinds;
  let currencies = chain[0]!.currencies;
  let counterparties = chain[0]!.counterparty_ids;
  let perAction = Number.POSITIVE_INFINITY;
  let remaining = Number.POSITIVE_INFINITY;
  let notBefore = 0;
  let expires = Number.POSITIVE_INFINITY;
  for (const r of chain) {
    kinds = intersect(kinds, r.action_kinds);
    currencies = intersect(currencies, r.currencies);
    counterparties = intersect(counterparties, r.counterparty_ids);
    perAction = Math.min(perAction, Number(r.max_amount_minor));
    remaining = Math.min(
      remaining,
      Number(r.max_amount_minor) - Number(r.spent_minor),
    );
    notBefore = Math.max(notBefore, r.issued_at.getTime());
    expires = Math.min(expires, r.expires_at.getTime());
  }
  const ancestors = chain.slice(0, -1);
  const status: DelegationView["status"] = leaf.revoked_at
    ? "REVOKED"
    : ancestors.some((r) => r.revoked_at)
      ? "ANCESTOR_REVOKED"
      : at >= leaf.expires_at.getTime()
        ? "EXPIRED"
        : ancestors.some((r) => at >= r.expires_at.getTime())
          ? "ANCESTOR_EXPIRED"
          : "ACTIVE";
  return {
    delegationId: leaf.delegation_id,
    authorityId: leaf.authority_id,
    parentId: leaf.parent_id,
    rootId: leaf.root_id,
    depth: leaf.depth,
    parentAgentId: leaf.parent_agent_id,
    childAgentId: leaf.child_agent_id,
    createdBy: leaf.created_by,
    createdByKind: leaf.created_by_kind,
    status,
    own: {
      actionKinds: leaf.action_kinds,
      currencies: leaf.currencies,
      counterpartyIds: leaf.counterparty_ids,
      maxAmountMinor: Number(leaf.max_amount_minor),
      spentMinor: Number(leaf.spent_minor),
      notBefore: leaf.issued_at.toISOString(),
      expiresAt: leaf.expires_at.toISOString(),
    },
    effective: {
      actionKinds: kinds,
      currencies,
      counterpartyIds: counterparties,
      perActionMaxMinor: perAction,
      remainingBudgetMinor: Math.max(0, remaining),
      notBefore: new Date(notBefore).toISOString(),
      expiresAt: new Date(expires).toISOString(),
    },
    lineage: chain.map((r) => ({
      delegationId: r.delegation_id,
      childAgentId: r.child_agent_id,
      depth: r.depth,
      revoked: r.revoked_at !== null,
    })),
    childIds,
  };
}
