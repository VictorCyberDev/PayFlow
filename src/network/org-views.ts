import type { Sql } from "postgres";
import type { Environment } from "./ops-controls.js";

/**
 * Read-only organization projections. Every query is scoped by organization AND environment
 * through authority_ownership / organization_agents, so another tenant's data is not visible and
 * its existence is not disclosed. Nothing here can mutate Authority or move money.
 *
 * Exposure vocabulary (mirrors what the Trust Kernel counts as consumed):
 *   reserved = reservations AUTHORIZED (decided, not yet executing)
 *   pending  = reservations EXECUTING (money may be in flight; UNKNOWN outcomes stay here)
 *   settled  = reservations COMMITTED (provider effect confirmed)
 *   available = limit - (reserved + pending + settled)
 * "Committed obligations" beyond a reservation (invoices, subscriptions) are NOT modelled yet and
 * are deliberately not shown as a number.
 */
export interface AuthorityExposure {
  readonly authorityId: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly currency: string;
  readonly status: "ACTIVE" | "REVOKED" | "EXPIRED";
  readonly expiresAt: string;
  readonly limitMinor: number | null;
  readonly perActionAutonomousMinor: number;
  readonly reservedMinor: number;
  readonly pendingMinor: number;
  readonly settledMinor: number;
  readonly availableMinor: number | null;
}

const n = (v: unknown): number => Number(v ?? 0);

export async function authorityExposures(
  sql: Sql,
  organizationId: string,
  environment: Environment,
  now: string,
  authorityId?: string,
): Promise<readonly AuthorityExposure[]> {
  const rows = await sql`
    select m.id, m.authorized_agent_id, m.expires_at, m.revoked_at, m.cumulative_limit_minor,
           m.document->>'purpose' purpose, m.document->>'currency' currency,
           (m.document->>'autonomousPurchaseThresholdMinor')::bigint autonomous,
      coalesce(sum(r.amount_minor) filter (where r.status in ('PENDING','AUTHORIZED')), 0) reserved,
      coalesce(sum(r.amount_minor) filter (where r.status = 'EXECUTING'), 0) pending,
      coalesce(sum(r.amount_minor) filter (where r.status = 'COMMITTED'), 0) settled
    from authority_ownership o
    join mandates m on m.id = o.mandate_id
    left join authorization_reservations r on r.mandate_id = m.id
    where o.organization_id = ${organizationId} and o.environment = ${environment}
      and (${authorityId ?? null}::text is null or m.id = ${authorityId ?? null})
    group by m.id
    order by m.created_at desc, m.id
    limit 500`;
  return rows.map((r) => {
    const limit =
      r.cumulative_limit_minor === null ? null : n(r.cumulative_limit_minor);
    const consumed = n(r.reserved) + n(r.pending) + n(r.settled);
    const expires = new Date(r.expires_at as string).toISOString();
    return {
      authorityId: String(r.id),
      agentId: String(r.authorized_agent_id),
      purpose: String(r.purpose ?? ""),
      currency: String(r.currency ?? ""),
      status:
        r.revoked_at !== null
          ? "REVOKED"
          : Date.parse(expires) <= Date.parse(now)
            ? "EXPIRED"
            : "ACTIVE",
      expiresAt: expires,
      limitMinor: limit,
      perActionAutonomousMinor: n(r.autonomous),
      reservedMinor: n(r.reserved),
      pendingMinor: n(r.pending),
      settledMinor: n(r.settled),
      availableMinor: limit === null ? null : Math.max(0, limit - consumed),
    } satisfies AuthorityExposure;
  });
}

export interface PendingDecision {
  readonly receiptId: string;
  readonly proposalId: string;
  readonly authorityId: string;
  readonly agentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantId: string;
  readonly autonomousLimitMinor: number;
  readonly requestedAt: string;
}

/** Escalations waiting for a human. The agent has no path to approve its own. */
export async function pendingDecisions(
  sql: Sql,
  organizationId: string,
  environment: Environment,
): Promise<readonly PendingDecision[]> {
  const rows = await sql`
    select d.id receipt_id, p.id proposal_id, m.id authority_id, p.agent_id, p.amount_minor, p.currency,
           p.document->'merchant'->>'id' merchant, (m.document->>'autonomousPurchaseThresholdMinor')::bigint autonomous,
           p.proposed_at
    from decision_receipts d
    join transaction_proposals p on p.id = d.proposal_id
    join mandates m on m.id = d.mandate_id
    join authority_ownership o on o.mandate_id = m.id
    left join approvals a on a.receipt_id = d.id
    where d.decision = 'ESCALATE' and a.id is null and m.revoked_at is null
      and not exists (select 1 from organization_audit_events e where e.organization_id = o.organization_id and e.action = 'APPROVAL_REJECTED' and e.subject_id = d.id)
      and o.organization_id = ${organizationId} and o.environment = ${environment}
    order by p.proposed_at desc limit 200`;
  return rows.map((r) => ({
    receiptId: String(r.receipt_id),
    proposalId: String(r.proposal_id),
    authorityId: String(r.authority_id),
    agentId: String(r.agent_id),
    amountMinor: n(r.amount_minor),
    currency: String(r.currency),
    merchantId: String(r.merchant ?? ""),
    autonomousLimitMinor: n(r.autonomous),
    requestedAt: new Date(r.proposed_at as string).toISOString(),
  }));
}

export interface AgentRow {
  readonly agentId: string;
  readonly name: string;
  readonly sponsorPrincipalId: string;
  readonly lifecycle: string;
  readonly passportStatus: string;
  readonly activeAuthorities: number;
  readonly exposureMinor: number;
  readonly lastDecisionAt: string | null;
}

export async function agentInventory(
  sql: Sql,
  organizationId: string,
  environment: Environment,
  now: string,
): Promise<readonly AgentRow[]> {
  const agents = await sql`
    select oa.agent_id, oa.sponsor_principal_id, oa.lifecycle, a.display_name, a.status passport
    from organization_agents oa join agent_passports a on a.id = oa.agent_id
    where oa.organization_id = ${organizationId} and oa.environment = ${environment}
    order by oa.agent_id`;
  const exposures = await authorityExposures(
    sql,
    organizationId,
    environment,
    now,
  );
  const last = await sql`
    select p.agent_id, max(d.evaluated_at) last_at
    from decision_receipts d join transaction_proposals p on p.id = d.proposal_id
    join authority_ownership o on o.mandate_id = d.mandate_id
    where o.organization_id = ${organizationId} and o.environment = ${environment}
    group by p.agent_id`;
  const lastBy = new Map<string, string | Date>(
    last.map((r) => [String(r.agent_id), r.last_at as string | Date]),
  );
  return agents.map((a) => {
    const mine = exposures.filter((e) => e.agentId === a.agent_id);
    const at = lastBy.get(String(a.agent_id));
    return {
      agentId: String(a.agent_id),
      name: String(a.display_name),
      sponsorPrincipalId: String(a.sponsor_principal_id),
      lifecycle: String(a.lifecycle),
      passportStatus: String(a.passport),
      activeAuthorities: mine.filter((e) => e.status === "ACTIVE").length,
      exposureMinor: mine
        .filter((e) => e.status === "ACTIVE")
        .reduce((s, e) => s + e.reservedMinor + e.pendingMinor, 0),
      lastDecisionAt: at ? new Date(at).toISOString() : null,
    };
  });
}

export interface FinanceHome {
  readonly currency: string;
  readonly activeAuthorities: number;
  readonly limitMinor: number;
  readonly reservedMinor: number;
  readonly pendingMinor: number;
  readonly settledMinor: number;
  readonly availableMinor: number;
  readonly pendingApprovals: number;
  readonly topAgents: readonly { agentId: string; exposureMinor: number }[];
  /** Obligations beyond reservations are not modelled; stated so nobody infers zero. */
  readonly committedObligations: "NOT_MODELLED";
}

export async function financeHome(
  sql: Sql,
  organizationId: string,
  environment: Environment,
  now: string,
): Promise<FinanceHome> {
  const all = await authorityExposures(sql, organizationId, environment, now);
  const active = all.filter((e) => e.status === "ACTIVE");
  const byAgent = new Map<string, number>();
  for (const e of active)
    byAgent.set(
      e.agentId,
      (byAgent.get(e.agentId) ?? 0) + e.reservedMinor + e.pendingMinor,
    );
  const sum = (f: (e: AuthorityExposure) => number) =>
    active.reduce((s, e) => s + f(e), 0);
  return {
    currency: active[0]?.currency ?? "USD",
    activeAuthorities: active.length,
    limitMinor: sum((e) => e.limitMinor ?? 0),
    reservedMinor: sum((e) => e.reservedMinor),
    pendingMinor: sum((e) => e.pendingMinor),
    settledMinor: sum((e) => e.settledMinor),
    availableMinor: sum((e) => e.availableMinor ?? 0),
    pendingApprovals: (await pendingDecisions(sql, organizationId, environment))
      .length,
    topAgents: [...byAgent.entries()]
      .map(([agentId, exposureMinor]) => ({ agentId, exposureMinor }))
      .sort(
        (a, b) =>
          b.exposureMinor - a.exposureMinor ||
          a.agentId.localeCompare(b.agentId),
      )
      .slice(0, 5),
    committedObligations: "NOT_MODELLED",
  };
}

export interface SecurityRow {
  readonly agentId: string;
  readonly sponsorPrincipalId: string;
  readonly lifecycle: string;
  readonly activeAuthorities: number;
  /** Most this agent could still commit if it were compromised right now. */
  readonly blastRadiusMinor: number;
  readonly downstreamAgents: number;
  readonly deniedLast24h: number;
}

export async function securityHome(
  sql: Sql,
  organizationId: string,
  environment: Environment,
  now: string,
): Promise<readonly SecurityRow[]> {
  const inv = await agentInventory(sql, organizationId, environment, now);
  const exposures = await authorityExposures(
    sql,
    organizationId,
    environment,
    now,
  );
  const since = new Date(Date.parse(now) - 24 * 3600 * 1000).toISOString();
  const denied = await sql`
    select metadata->>'agentId' agent, count(*)::int c from usage_events
    where organization_id = ${organizationId} and environment = ${environment}
      and meter = 'GOVERNED_ACTION' and metadata->>'decision' <> 'ALLOW' and occurred_at >= ${since}
    group by 1`;
  const down = await sql`
    select parent_agent_id agent, count(distinct child_agent_id)::int c from agent_delegations
    where organization_id = ${organizationId} and environment = ${environment} and state = 'ACTIVE'
    group by 1`;
  const dBy = new Map(denied.map((r) => [String(r.agent), Number(r.c)]));
  const downBy = new Map(down.map((r) => [String(r.agent), Number(r.c)]));
  return inv.map((a) => ({
    agentId: a.agentId,
    sponsorPrincipalId: a.sponsorPrincipalId,
    lifecycle: a.lifecycle,
    activeAuthorities: a.activeAuthorities,
    blastRadiusMinor: exposures
      .filter((e) => e.agentId === a.agentId && e.status === "ACTIVE")
      .reduce((s, e) => s + (e.availableMinor ?? 0), 0),
    downstreamAgents: downBy.get(a.agentId) ?? 0,
    deniedLast24h: dBy.get(a.agentId) ?? 0,
  }));
}

export interface UnknownOperation {
  readonly operationId: string;
  readonly attemptId: string;
  readonly authorityId: string;
  readonly agentId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: string;
  readonly providerOrderId: string | null;
  readonly providerCaptureId: string | null;
  readonly since: string;
  readonly ageSeconds: number;
}

/**
 * Operator view of payments whose provider outcome is not yet known. Observation only: this never
 * re-executes, and the Authority behind each row stays held (pending) until the provider's own
 * records settle it.
 */
export async function unknownOperations(
  sql: Sql,
  organizationId: string,
  environment: Environment,
  now: string,
): Promise<readonly UnknownOperation[]> {
  const rows = await sql`
    select a.id attempt_id, a.proposal_id, a.mandate_id, p.agent_id, a.amount_minor, a.currency,
           a.status::text state, a.provider_order_id, a.provider_capture_id, a.updated_at
    from payment_attempts a
    join authority_ownership o on o.mandate_id = a.mandate_id
    left join transaction_proposals p on p.id = a.proposal_id
    where o.organization_id = ${organizationId} and o.environment = ${environment}
      and a.status::text in ('ORDER_CREATE_UNKNOWN','CAPTURE_UNKNOWN','CAPTURE_PENDING_PROVIDER','ORDER_CREATING','CAPTURE_PENDING')
    order by a.updated_at asc limit 200`;
  return rows.map((r) => {
    const since = new Date(r.updated_at as string).toISOString();
    return {
      operationId: String(r.proposal_id),
      attemptId: String(r.attempt_id),
      authorityId: String(r.mandate_id),
      agentId: r.agent_id ? String(r.agent_id) : null,
      amountMinor: n(r.amount_minor),
      currency: String(r.currency),
      state: String(r.state),
      providerOrderId: r.provider_order_id ? String(r.provider_order_id) : null,
      providerCaptureId: r.provider_capture_id
        ? String(r.provider_capture_id)
        : null,
      since,
      ageSeconds: Math.max(
        0,
        Math.floor((Date.parse(now) - Date.parse(since)) / 1000),
      ),
    };
  });
}

export interface DeveloperFunnel {
  readonly credentialsIssued: number;
  readonly authoritiesProvisioned: number;
  readonly firstEvaluatedAt: string | null;
  readonly evaluated: number;
  readonly allowedAndPaid: number;
  readonly denied: number;
  readonly unresolved: number;
  /** Stages with no server-side signal yet, stated so nobody reads them as zero. */
  /** Proof reads with the organization's credentials (each read counts). */
  readonly proofsRead: number;
  /** Distinct calendar days (UTC) with at least one evaluated action. 2 or more is repeat use. */
  readonly activeDays: number;
  readonly notMeasuredServerSide: readonly string[];
}

/**
 * Privacy-safe developer funnel derived only from the audit and usage tables: counts and
 * timestamps, no identities beyond the organization, no payloads, no cookies, no tracking.
 */
export async function developerFunnel(
  sql: Sql,
  organizationId: string,
  environment: Environment,
): Promise<DeveloperFunnel> {
  const a = await sql`
    select action, count(*)::int c from organization_audit_events
    where organization_id = ${organizationId} and environment = ${environment}
      and action in ('CREDENTIAL_ISSUED','AUTHORITY_PROVISIONED','PROOF_READ')
    group by action`;
  const by = new Map(a.map((r) => [String(r.action), Number(r.c)]));
  const u = await sql`
    select count(*)::int total,
      count(*) filter (where metadata->>'status' = 'COMPLETED')::int paid,
      count(*) filter (where metadata->>'status' = 'DENIED')::int denied,
      count(*) filter (where metadata->>'status' = 'UNRESOLVED')::int unresolved,
      min(occurred_at) first_at,
      count(distinct (occurred_at at time zone 'UTC')::date)::int days
    from usage_events
    where organization_id = ${organizationId} and environment = ${environment} and meter = 'GOVERNED_ACTION'`;
  const r = u[0]!;
  return {
    credentialsIssued: by.get("CREDENTIAL_ISSUED") ?? 0,
    authoritiesProvisioned: by.get("AUTHORITY_PROVISIONED") ?? 0,
    firstEvaluatedAt: r.first_at
      ? new Date(r.first_at as string).toISOString()
      : null,
    evaluated: Number(r.total),
    allowedAndPaid: Number(r.paid),
    denied: Number(r.denied),
    unresolved: Number(r.unresolved),
    proofsRead: by.get("PROOF_READ") ?? 0,
    activeDays: Number(r.days),
    notMeasuredServerSide: [
      "visit",
      "docs",
      "sandbox page",
      // Verify runs offline in the browser or the CLI and never contacts PayFlow. That is a
      // privacy property, so it cannot be counted.
      "first verify",
      "partner inquiry",
    ],
  };
}

/**
 * V3 M59 — what this organization has actually used, and what that would be billed as.
 *
 * Two things this is careful about, because the alternative would be a lie told in money:
 *
 *  1. **Nothing here charges anyone, and no price has been agreed.** `docs/PRICING-METERING.md` is explicit that the
 *     coefficients in the code are placeholders for testing arithmetic and invoice aggregation, not a published price
 *     sheet. So the preview is built on the DEVELOPER plan, whose every coefficient is zero, and the response says in
 *     words that the organization is not on a paid plan. Showing a non-zero total from a placeholder table would invite
 *     a customer to believe it is what they owe.
 *  2. **Only what is really measured is shown.** The meters are the rows in `usage_events`, which the Gateway writes as
 *     governed actions happen. Nothing is estimated or extrapolated to fill a gap.
 */
export interface UsageMeterLine {
  readonly meter: string;
  readonly thisPeriod: number;
  readonly lifetime: number;
}
export interface UsageHome {
  readonly period: { readonly start: string; readonly end: string };
  readonly meters: readonly UsageMeterLine[];
  readonly totalThisPeriod: number;
  readonly planId: string;
  readonly charged: false;
  readonly invoicePreview: {
    readonly currency: string;
    readonly totalMinor: number;
    readonly lines: readonly {
      readonly meter: string;
      readonly quantity: number;
      readonly unitAmountMinor: number;
      readonly amountMinor: number;
    }[];
  };
  readonly notice: string;
  readonly priceNotice: string;
}

/** The UTC calendar month that `now` falls in. Billing periods are months everywhere else in the product. */
export function usagePeriod(now: string): { start: string; end: string } {
  const d = new Date(now);
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function usageHome(
  sql: Sql,
  organizationId: string,
  environment: Environment,
  now: string,
): Promise<UsageHome> {
  const period = usagePeriod(now);
  const rows = await sql`
    select meter,
      coalesce(sum(quantity) filter (where occurred_at >= ${period.start} and occurred_at < ${period.end}), 0)::bigint this_period,
      coalesce(sum(quantity), 0)::bigint lifetime
    from usage_events
    where organization_id = ${organizationId} and environment = ${environment}
    group by meter order by meter`;
  const meters = rows.map((r) => ({
    meter: String(r.meter),
    thisPeriod: Number(r.this_period),
    lifetime: Number(r.lifetime),
  }));
  const totalThisPeriod = meters.reduce((n, m) => n + m.thisPeriod, 0);
  // The DEVELOPER plan: every coefficient is zero, which is the only total this product can state truthfully today.
  const lines = [
    { meter: "BASE", quantity: 1, unitAmountMinor: 0, amountMinor: 0 },
    ...meters
      .filter((m) => m.thisPeriod > 0)
      .map((m) => ({
        meter: m.meter,
        quantity: m.thisPeriod,
        unitAmountMinor: 0,
        amountMinor: 0,
      })),
  ];
  return {
    period,
    meters,
    totalThisPeriod,
    planId: "DEVELOPER",
    charged: false,
    invoicePreview: { currency: "USD", totalMinor: 0, lines },
    notice:
      "This is what PayFlow has actually measured for you. Nothing here is estimated, and nothing here has been charged.",
    priceNotice:
      "You are not on a paid plan and no price has been agreed. PayFlow has not published a price sheet, so this shows what was used rather than what it would cost.",
  };
}
