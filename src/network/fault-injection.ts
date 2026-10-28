export type FaultDomain =
  | "AUTHORITY"
  | "IDENTITY"
  | "ASSERTION"
  | "REPLAY"
  | "CALLBACK"
  | "CONCURRENCY"
  | "PROVIDER"
  | "RECOVERY"
  | "PROOF"
  | "DELEGATION"
  | "PROTOCOL"
  | "INPUT"
  | "RAIL"
  | "MONEY";

export type SafeFaultOutcome =
  | "DENY"
  | "ESCALATE"
  | "REJECT"
  | "IDEMPOTENT"
  | "UNKNOWN"
  | "RECONCILE_ONLY"
  | "NO_DUPLICATE_EFFECT";

export interface FaultScenario {
  readonly id: string;
  readonly domain: FaultDomain;
  readonly title: string;
  readonly expected: SafeFaultOutcome;
  readonly invariant: string;
}

export const FAULT_INJECTION_MATRIX: readonly FaultScenario[] = [
  {
    id: "agent-amount-change",
    domain: "AUTHORITY",
    title: "agent changes amount",
    expected: "DENY",
    invariant: "exact amount remains inside Authority",
  },
  {
    id: "merchant-substitution",
    domain: "AUTHORITY",
    title: "merchant substitution",
    expected: "DENY",
    invariant: "counterparty cannot widen",
  },
  {
    id: "sku-substitution",
    domain: "AUTHORITY",
    title: "SKU substitution",
    expected: "DENY",
    invariant: "approved product scope cannot widen",
  },
  {
    id: "condition-substitution",
    domain: "AUTHORITY",
    title: "condition substitution",
    expected: "DENY",
    invariant: "product condition remains bounded",
  },
  {
    id: "quantity-widening",
    domain: "AUTHORITY",
    title: "quantity widening",
    expected: "DENY",
    invariant: "quantity cannot widen or be silently clamped",
  },
  {
    id: "currency-change",
    domain: "MONEY",
    title: "currency change",
    expected: "DENY",
    invariant: "settlement currency remains explicit",
  },
  {
    id: "fee-widening",
    domain: "MONEY",
    title: "fee widening",
    expected: "DENY",
    invariant: "fees remain inside explicit boundary",
  },
  {
    id: "revoked-authority",
    domain: "AUTHORITY",
    title: "revoked Authority",
    expected: "DENY",
    invariant: "revocation is revalidated before effect",
  },
  {
    id: "expired-authority",
    domain: "AUTHORITY",
    title: "expired Authority",
    expected: "DENY",
    invariant: "expired Authority cannot execute",
  },
  {
    id: "suspended-authority",
    domain: "AUTHORITY",
    title: "suspended Authority",
    expected: "DENY",
    invariant: "suspension blocks new execution",
  },
  {
    id: "wrong-agent",
    domain: "IDENTITY",
    title: "wrong agent",
    expected: "DENY",
    invariant: "agent binding is exact",
  },
  {
    id: "stale-assertion",
    domain: "ASSERTION",
    title: "stale assertion",
    expected: "REJECT",
    invariant: "assertions are freshness-bound",
  },
  {
    id: "forged-assertion",
    domain: "ASSERTION",
    title: "forged assertion",
    expected: "REJECT",
    invariant: "issuer signature must verify",
  },
  {
    id: "replay",
    domain: "REPLAY",
    title: "replay",
    expected: "DENY",
    invariant: "replayed action cannot consume Authority twice",
  },
  {
    id: "duplicate-callback",
    domain: "CALLBACK",
    title: "duplicate callback",
    expected: "IDEMPOTENT",
    invariant: "callback duplication cannot duplicate financial truth",
  },
  {
    id: "concurrent-execution",
    domain: "CONCURRENCY",
    title: "concurrent execution",
    expected: "NO_DUPLICATE_EFFECT",
    invariant: "reservation/grant concurrency permits at most one effect",
  },
  {
    id: "duplicated-webhook",
    domain: "CALLBACK",
    title: "duplicated webhook",
    expected: "IDEMPOTENT",
    invariant: "webhook delivery is idempotent",
  },
  {
    id: "delayed-webhook",
    domain: "CALLBACK",
    title: "delayed webhook",
    expected: "RECONCILE_ONLY",
    invariant: "late evidence updates truth without re-execution",
  },
  {
    id: "dropped-response",
    domain: "PROVIDER",
    title: "dropped response",
    expected: "UNKNOWN",
    invariant:
      "missing provider response never becomes success/failure by inference",
  },
  {
    id: "provider-timeout",
    domain: "PROVIDER",
    title: "provider timeout",
    expected: "UNKNOWN",
    invariant: "timeout preserves ambiguity",
  },
  {
    id: "provider-effect-network-failure",
    domain: "PROVIDER",
    title: "provider effect followed by network failure",
    expected: "UNKNOWN",
    invariant: "post-effect transport failure is reconciled by lookup",
  },
  {
    id: "ambiguous-provider-state",
    domain: "PROVIDER",
    title: "ambiguous provider state",
    expected: "UNKNOWN",
    invariant: "UNKNOWN is first-class truth",
  },
  {
    id: "database-retry",
    domain: "RECOVERY",
    title: "database retry",
    expected: "IDEMPOTENT",
    invariant: "durable retry cannot consume twice",
  },
  {
    id: "crash-after-reservation",
    domain: "RECOVERY",
    title: "crash after reservation",
    expected: "RECONCILE_ONLY",
    invariant: "reserved authority survives crash safely",
  },
  {
    id: "crash-after-grant",
    domain: "RECOVERY",
    title: "crash after grant",
    expected: "RECONCILE_ONLY",
    invariant: "one-time grant remains replay resistant",
  },
  {
    id: "crash-after-provider-create",
    domain: "RECOVERY",
    title: "crash after provider create",
    expected: "UNKNOWN",
    invariant: "provider-side ambiguity cannot trigger fresh execution",
  },
  {
    id: "crash-after-capture",
    domain: "RECOVERY",
    title: "crash after capture",
    expected: "UNKNOWN",
    invariant: "capture may have happened and must be reconciled",
  },
  {
    id: "reconciliation-race",
    domain: "CONCURRENCY",
    title: "reconciliation racing new execution",
    expected: "NO_DUPLICATE_EFFECT",
    invariant: "reconciliation observes; it never executes",
  },
  {
    id: "tampered-proof",
    domain: "PROOF",
    title: "tampered Proof",
    expected: "REJECT",
    invariant: "tampered evidence fails verification",
  },
  {
    id: "stale-proof",
    domain: "PROOF",
    title: "stale Proof",
    expected: "REJECT",
    invariant: "verification enforces freshness policy",
  },
  {
    id: "delegation-widening",
    domain: "DELEGATION",
    title: "downstream delegation widening",
    expected: "DENY",
    invariant: "delegation is monotonic attenuation",
  },
  {
    id: "privilege-escalation",
    domain: "DELEGATION",
    title: "privilege escalation",
    expected: "DENY",
    invariant: "roles/scopes cannot self-expand",
  },
  {
    id: "duplicate-a2a-request",
    domain: "PROTOCOL",
    title: "duplicate A2A request",
    expected: "IDEMPOTENT",
    invariant: "transport duplication cannot duplicate financial effect",
  },
  {
    id: "duplicate-mcp-invocation",
    domain: "PROTOCOL",
    title: "duplicated MCP invocation",
    expected: "IDEMPOTENT",
    invariant: "tool invocation uses replay/idempotency boundary",
  },
  {
    id: "malformed-commerce-context",
    domain: "INPUT",
    title: "malformed commerce context",
    expected: "REJECT",
    invariant: "untrusted input is strictly parsed",
  },
  {
    id: "unsupported-action-type",
    domain: "INPUT",
    title: "unsupported action type",
    expected: "REJECT",
    invariant: "unknown financial semantics fail closed",
  },
  {
    id: "unsupported-rail",
    domain: "RAIL",
    title: "unsupported rail",
    expected: "REJECT",
    invariant: "unknown rail cannot consume a grant",
  },
  {
    id: "negative-zero-extreme-amount",
    domain: "MONEY",
    title: "negative/zero/extreme amounts",
    expected: "REJECT",
    invariant:
      "money uses safe positive integer minor units where effect is consequential",
  },
  {
    id: "precision-rounding",
    domain: "MONEY",
    title: "precision/rounding cases",
    expected: "REJECT",
    invariant: "no floating-point money widening",
  },
  {
    id: "cross-currency-mismatch",
    domain: "MONEY",
    title: "cross-currency mismatch",
    expected: "DENY",
    invariant: "fees/taxes/settlement currencies stay coherent",
  },
  {
    id: "fee-mismatch",
    domain: "MONEY",
    title: "fee mismatch",
    expected: "DENY",
    invariant: "observed fees cannot exceed Authority",
  },
] as const;

export interface FaultInjectionObservation {
  readonly scenarioId: string;
  readonly actual: SafeFaultOutcome;
  readonly evidence: string;
}

export type FaultInjector = (
  scenario: FaultScenario,
) => Promise<FaultInjectionObservation> | FaultInjectionObservation;

export interface FaultInjectionReport {
  readonly version: "fault-injection/v1";
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly (FaultInjectionObservation & {
    expected: SafeFaultOutcome;
    pass: boolean;
  })[];
}

export async function runFaultInjectionMatrix(
  injector: FaultInjector,
): Promise<FaultInjectionReport> {
  const results = [] as Array<
    FaultInjectionObservation & { expected: SafeFaultOutcome; pass: boolean }
  >;
  for (const scenario of FAULT_INJECTION_MATRIX) {
    const observation = await injector(scenario);
    if (observation.scenarioId !== scenario.id) {
      throw new Error(`FAULT_SCENARIO_ID_MISMATCH:${scenario.id}`);
    }
    results.push({
      ...observation,
      expected: scenario.expected,
      pass:
        observation.actual === scenario.expected &&
        observation.evidence.length > 0,
    });
  }
  return {
    version: "fault-injection/v1",
    total: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    results,
  };
}
