import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  portableProofPayloadBytes,
  verifyPortableProof,
} from "../../packages/verifier/src/index.js";
import { mandateFingerprint } from "../canonical.js";
import type { AgentPassport, Mandate } from "../domain.js";
import {
  evaluateDelegatedRequest,
  type DelegatedFinancialScope,
} from "../protocols/a2a.js";
import {
  invokePayFlowMcpTool,
  type McpAuthorityServices,
} from "../protocols/mcp.js";
import {
  FinancialActionAuthorityExtensionSchema,
  authorizeFinancialAction,
} from "./action-authorization.js";
import { kernelFixture } from "./benchmark.js";
import { EnterpriseDelegationGraph } from "./enterprise.js";
import {
  PayFlowEventSchema,
  acceptWebhookDeliveryOnce,
  signWebhookDelivery,
  verifyWebhookDelivery,
} from "./events.js";
import type {
  FaultInjectionObservation,
  FaultInjector,
  FaultScenario,
} from "./fault-injection.js";
import { FinancialActionSchema } from "./financial-action.js";
import {
  FinancialAuthorityGateway,
  GATEWAY_AUDIENCE,
  type GatewayActionResult,
} from "./gateway.js";
import {
  ReconciliationOperationsCenter,
  deriveReconciliationState,
  type ReconciliationCase,
} from "./reconciliation-ops.js";
import {
  DeterministicFakeRail,
  financialActionDigest,
  reconcileWithoutReexecution,
  type BoundedRailGrant,
  type FakeRailMode,
} from "./rail.js";
import {
  signAuthorityPresentation,
  verifyAuthorityPresentation,
  type AuthorityLifecycleState,
  type VerificationDependencies,
} from "./verify.js";

/**
 * A fault injector that drives the *production* kernel, gateway, rail
 * contract, reconciliation, verifier and protocol code. The observed outcome
 * is derived from what the real code returned or threw, never from the
 * scenario's expectation. Anything unexpectedly permitted is reported as
 * "UNSAFE", which can never equal a scenario's expected safe outcome.
 */

export const NOW = "2026-10-28T03:00:00.000Z";
const LATER = "2026-10-28T03:05:00.000Z";

type Observed = FaultInjectionObservation["actual"];

export function accessFor(agent: AgentPassport) {
  return {
    clientId: "fault-client",
    agentId: agent.id,
    principalId: agent.principalId,
    audience: GATEWAY_AUDIENCE,
    scopes: ["authority:read" as const, "action:request" as const],
    issuedAt: "2026-10-28T02:00:00.000Z",
    expiresAt: "2026-10-31T03:00:00.000Z",
    status: "ACTIVE" as const,
  };
}

export function makeGateway(
  mandate: Mandate,
  agent: AgentPassport,
  state: AuthorityLifecycleState = "ACTIVE",
) {
  const claimed = new Set<string>();
  let capabilitiesIssued = 0;
  const gateway = new FinancialAuthorityGateway({
    loadMandate: async (id) =>
      Promise.resolve(id === mandate.id ? mandate : null),
    loadAgent: async (id) => Promise.resolve(id === agent.id ? agent : null),
    authorityState: async () => Promise.resolve(state),
    cumulativeSpentMinor: async () => Promise.resolve(0),
    consumedQuantity: async () => Promise.resolve(0),
    claimReplayKey: async (scope, key) => {
      const composite = `${scope}:${key}`;
      if (claimed.has(composite)) return Promise.resolve(false);
      claimed.add(composite);
      return Promise.resolve(true);
    },
    issueExecutionCapability: async (_receipt, proposal) => {
      capabilitiesIssued += 1;
      return Promise.resolve({
        grantId: `grant:${proposal.id}:${capabilitiesIssued}`,
        expiresAt: "2026-10-28T03:01:00.000Z",
        proposalDigest: mandateFingerprint(mandate),
      });
    },
  });
  return { gateway, capabilitiesIssued: () => capabilitiesIssued };
}

export function requestBody(overrides: Record<string, unknown> = {}) {
  const { proposal } = kernelFixture();
  return {
    requestId: "fault-request",
    mandateId: proposal.mandateId,
    agentId: proposal.agentId,
    amount: proposal.amount,
    quantity: proposal.quantity,
    merchant: proposal.merchant,
    category: proposal.category,
    condition: proposal.condition,
    requestedCapability: proposal.requestedCapability,
    proposedAt: NOW,
    nonce: "fault-nonce-0000001",
    metadata: {},
    ...overrides,
  };
}

function gatewayDecision(result: GatewayActionResult): Observed {
  if (result.decision.decision === "DENY") return "DENY";
  if (result.decision.decision === "ESCALATE") return "ESCALATE";
  return "UNSAFE";
}

async function viaGateway(
  overrides: Record<string, unknown>,
  required: string,
  state: AuthorityLifecycleState = "ACTIVE",
  now = NOW,
): Promise<{ actual: Observed; evidence: string }> {
  const { mandate, agent } = kernelFixture();
  const { gateway } = makeGateway(mandate, agent, state);
  try {
    const result = await gateway.requestAction(
      accessFor(agent),
      requestBody(overrides),
      { now, merchantRisk: "LOW" },
    );
    const reasons = result.decision.reasonCodes as readonly string[];
    return {
      // Denied for the *intended* reason, not incidentally.
      actual: reasons.includes(required) ? gatewayDecision(result) : "UNSAFE",
      evidence: `kernel:${result.decision.decision}:${reasons.join(",")}`,
    };
  } catch (error) {
    // A thrown refusal is a fail-closed outcome only when it is the intended typed refusal.
    const code = (error as { code?: unknown }).code;
    return code === required
      ? { actual: "DENY", evidence: `gateway-refusal:${code}` }
      : { actual: "UNSAFE", evidence: `unexpected-error:${String(code)}` };
  }
}

export const extension = FinancialActionAuthorityExtensionSchema.parse({
  version: "financial-action-authority/v1",
  allowedKinds: ["PURCHASE", "INVOICE_SETTLEMENT", "PAYOUT"],
  allowedCounterpartyIds: ["merchant-allowed"],
  monetary: {
    settlementCurrencies: ["USD"],
    maxAmountMinor: 10_000,
    maxFeesMinor: 100,
    maxTaxesMinor: 500,
    maxFxSlippageBps: 50,
    allowFx: false,
  },
  requireInvoiceReferenceForSettlement: true,
  requireRecurringKeyForRecurring: true,
});

export function financialAction(overrides: Record<string, unknown> = {}) {
  return FinancialActionSchema.parse({
    version: "financial-action/v1",
    id: "fault-action-1",
    kind: "PURCHASE",
    principalId: "benchmark-principal",
    agentId: "benchmark-agent",
    counterparty: { id: "merchant-allowed" },
    amount: { currency: "USD", minor: 5_000 },
    fees: [],
    taxes: [],
    purpose: "bounded fault-injection purchase",
    proposedAt: NOW,
    idempotencyKey: "fault-idempotency-key-0001",
    ...overrides,
  });
}

function viaFinancialAction(
  overrides: Record<string, unknown>,
  required: readonly string[],
): {
  actual: Observed;
  evidence: string;
} {
  const { mandate, agent, context } = kernelFixture();
  let action;
  try {
    action = financialAction(overrides);
  } catch {
    return { actual: "REJECT", evidence: "financial-action-schema-rejected" };
  }
  const result = authorizeFinancialAction(
    mandate,
    extension,
    agent,
    action,
    context,
  );
  const intended = required.every((reason) =>
    (result.extensionViolations as readonly string[]).includes(reason),
  );
  return {
    actual: result.decision === "DENY" && intended ? "DENY" : "UNSAFE",
    evidence: `action:${result.decision}:${result.extensionViolations.join(",")}:${result.kernelReceipt.reasonCodes.join(",")}`,
  };
}

export function railGrant(
  action: ReturnType<typeof financialAction>,
  expiresAt = "2026-10-28T03:01:00.000Z",
): BoundedRailGrant {
  return {
    grantId: "fault-grant-1",
    authorityId: "benchmark-authority",
    actionDigest: financialActionDigest(action),
    idempotencyKey: action.idempotencyKey,
    expiresAt,
  };
}

async function executeOn(mode: FakeRailMode, expiresAt?: string) {
  const rail = new DeterministicFakeRail("fault-rail", mode);
  const action = financialAction();
  const evidence = await rail.execute({
    action,
    grant: railGrant(action, expiresAt),
    now: NOW,
  });
  return { rail, action, evidence };
}

export function presentationFixture() {
  const { mandate, agent } = kernelFixture();
  const issuer = generateKeyPairSync("ed25519");
  const payload = {
    version: "payflow-authority-presentation/v1" as const,
    issuer: "fault-issuer",
    keyId: "fault-key-1",
    authorityId: mandate.id,
    authorityFingerprint: mandateFingerprint(mandate),
    principalId: mandate.principalId,
    agentId: agent.id,
    audience: "merchant.example",
    challenge: "fault-challenge-0000001",
    nonce: "fault-presentation-nonce-1",
    issuedAt: "2026-10-28T02:55:00.000Z",
    expiresAt: "2026-10-28T03:10:00.000Z",
  };
  const claimed = new Set<string>();
  const verifierFor = (
    publicKey: KeyObject,
    state: AuthorityLifecycleState = "ACTIVE",
  ): VerificationDependencies => ({
    resolvePublicKey: async () => Promise.resolve(publicKey),
    loadAuthority: async () => Promise.resolve({ mandate, state }),
    claimPresentationReplayKey: async (scope, key) => {
      const composite = `${scope}:${key}`;
      if (claimed.has(composite)) return Promise.resolve(false);
      claimed.add(composite);
      return Promise.resolve(true);
    },
  });
  return { issuer, payload, verifierFor, mandate };
}

export function signedProof(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    version: "payflow-proof/v1" as const,
    issuer: "fault-issuer",
    keyId: "fault-key-1",
    authorityId: "benchmark-authority",
    actionId: "fault-action-1",
    outcome: "SUCCEEDED" as const,
    effectCount: 1 as const,
    observedAt: NOW,
    evidenceDigest: "a".repeat(64),
    ...overrides,
  };
  const signature = cryptoSign(
    null,
    portableProofPayloadBytes(payload),
    privateKey,
  ).toString("base64url");
  return {
    proof: { ...payload, signature },
    jwk: publicKey.export({ format: "jwk" }),
  };
}

export function scope(
  overrides: Partial<DelegatedFinancialScope> = {},
): DelegatedFinancialScope {
  return {
    principalId: "principal-1",
    parentAgentId: "root-agent",
    childAgentId: "child-agent",
    audience: "payflow-a2a-v1",
    actionKinds: ["PURCHASE"],
    currencies: ["USD"],
    counterpartyIds: ["merchant-allowed"],
    maxAmountMinor: 10_000,
    issuedAt: "2026-10-28T02:00:00.000Z",
    expiresAt: "2026-10-28T09:00:00.000Z",
    nonce: "delegation-nonce-000001",
    ...overrides,
  };
}

function reconciliationFixture(rail: DeterministicFakeRail, key: string) {
  let stored: ReconciliationCase = {
    id: "case-1",
    attemptId: "attempt-1",
    railId: rail.railId,
    idempotencyKey: key,
    state: "PENDING",
    openedAt: NOW,
    updatedAt: NOW,
    evidence: [],
  };
  const center = new ReconciliationOperationsCenter(
    {
      load: async () => Promise.resolve(stored),
      compareAndSet: async (_id, expectedUpdatedAt, next) => {
        if (stored.updatedAt !== expectedUpdatedAt)
          return Promise.resolve(false);
        stored = next;
        return Promise.resolve(true);
      },
    },
    new Map([[rail.railId, rail]]),
  );
  return { center, current: () => stored };
}

const webhookEvent = PayFlowEventSchema.parse({
  version: "payflow-event/v1",
  id: "event-1",
  type: "action.reconciled",
  organizationId: "org-1",
  environment: "SANDBOX",
  occurredAt: NOW,
  subjectId: "fault-action-1",
  data: {},
});

type Handler = () => Promise<{ actual: Observed; evidence: string }>;

const handlers: Record<string, Handler> = {
  "agent-amount-change": () =>
    viaGateway(
      { amount: { currency: "USD", minor: 12_000 } },
      "AMOUNT_EXCEEDS_LIMIT",
    ),
  "merchant-substitution": () =>
    viaGateway(
      { merchant: { id: "merchant-attacker", displayName: "Substitute" } },
      "MERCHANT_NOT_ALLOWED",
    ),
  "sku-substitution": () =>
    viaGateway({ category: "RESTRICTED_GOODS" }, "CATEGORY_DENIED"),
  "condition-substitution": () =>
    viaGateway({ condition: "USED" }, "CONDITION_DENIED"),
  "quantity-widening": () => viaGateway({ quantity: 3 }, "QUANTITY_EXHAUSTED"),
  "currency-change": () =>
    viaGateway(
      { amount: { currency: "EUR", minor: 5_000 } },
      "CURRENCY_MISMATCH",
    ),
  "fee-widening": () =>
    Promise.resolve(
      viaFinancialAction({ fees: [{ currency: "USD", minor: 5_000 }] }, [
        "MONEY:FEE_BOUNDARY_EXCEEDED",
      ]),
    ),
  "revoked-authority": async () => {
    const gateway = await viaGateway({}, "AUTHORITY_INACTIVE", "REVOKED");
    const fixture = presentationFixture();
    const verdict = await verifyAuthorityPresentation(
      signAuthorityPresentation(fixture.payload, fixture.issuer.privateKey),
      {
        audience: "merchant.example",
        challenge: "fault-challenge-0000001",
        now: NOW,
      },
      fixture.verifierFor(fixture.issuer.publicKey, "REVOKED"),
    );
    return gateway.actual === "DENY" && verdict.verdict === "REVOKED"
      ? {
          actual: "DENY",
          evidence: `${gateway.evidence}|verify:${verdict.verdict}`,
        }
      : {
          actual: "UNSAFE",
          evidence: `${gateway.evidence}|${verdict.verdict}`,
        };
  },
  "expired-authority": () =>
    viaGateway({}, "MANDATE_EXPIRED", "ACTIVE", "2026-10-30T03:00:00.000Z"),
  "suspended-authority": () =>
    viaGateway({}, "AUTHORITY_INACTIVE", "SUSPENDED"),
  "wrong-agent": async () => {
    const { mandate, agent } = kernelFixture();
    const { gateway } = makeGateway(mandate, agent);
    try {
      await gateway.requestAction(
        { ...accessFor(agent), agentId: "attacker-agent" },
        requestBody(),
        { now: NOW, merchantRisk: "LOW" },
      );
      return { actual: "UNSAFE", evidence: "wrong agent was accepted" };
    } catch (error) {
      return {
        actual: "DENY",
        evidence: `gateway-refusal:${String((error as { code?: unknown }).code)}`,
      };
    }
  },
  "stale-assertion": async () => {
    const fixture = presentationFixture();
    const verdict = await verifyAuthorityPresentation(
      signAuthorityPresentation(fixture.payload, fixture.issuer.privateKey),
      {
        audience: "merchant.example",
        challenge: "fault-challenge-0000001",
        now: "2026-10-28T04:00:00.000Z",
      },
      fixture.verifierFor(fixture.issuer.publicKey),
    );
    return {
      actual: verdict.verdict === "EXPIRED" ? "REJECT" : "UNSAFE",
      evidence: `verify:${verdict.verdict}:${verdict.reason}`,
    };
  },
  "forged-assertion": async () => {
    const fixture = presentationFixture();
    const attacker = generateKeyPairSync("ed25519");
    const verdict = await verifyAuthorityPresentation(
      signAuthorityPresentation(fixture.payload, attacker.privateKey),
      {
        audience: "merchant.example",
        challenge: "fault-challenge-0000001",
        now: NOW,
      },
      fixture.verifierFor(fixture.issuer.publicKey),
    );
    return {
      actual: verdict.verdict === "TAMPERED" ? "REJECT" : "UNSAFE",
      evidence: `verify:${verdict.verdict}:${verdict.reason}`,
    };
  },
  replay: async () => {
    const { mandate, agent } = kernelFixture();
    const { gateway, capabilitiesIssued } = makeGateway(mandate, agent);
    const call = () =>
      gateway.requestAction(accessFor(agent), requestBody(), {
        now: NOW,
        merchantRisk: "LOW",
      });
    const first = await call();
    const second = await call();
    return first.decision.decision === "ALLOW" &&
      second.decision.decision === "DENY" &&
      second.decision.reasonCodes.includes("REPLAY_DETECTED") &&
      capabilitiesIssued() === 1
      ? { actual: "DENY", evidence: "second use denied REPLAY_DETECTED" }
      : { actual: "UNSAFE", evidence: "replay was not denied" };
  },
  "duplicate-callback": async () => {
    const { rail, action } = await executeOn("SUCCESS");
    const again = await rail.execute({
      action,
      grant: railGrant(action),
      now: NOW,
    });
    return rail.providerEffectWrites === 1 && again.effectCount === 1
      ? {
          actual: "IDEMPOTENT",
          evidence: "duplicate provider callback produced one effect",
        }
      : { actual: "UNSAFE", evidence: `effects=${rail.providerEffectWrites}` };
  },
  "concurrent-execution": async () => {
    const rail = new DeterministicFakeRail("fault-rail", "SUCCESS");
    const action = financialAction();
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        rail.execute({ action, grant: railGrant(action), now: NOW }),
      ),
    );
    const refs = new Set(results.map((entry) => entry.providerReference));
    return rail.providerEffectWrites === 1 && refs.size === 1
      ? {
          actual: "NO_DUPLICATE_EFFECT",
          evidence: "25 concurrent executions produced one provider effect",
        }
      : { actual: "UNSAFE", evidence: `effects=${rail.providerEffectWrites}` };
  },
  "duplicated-webhook": async () => {
    const claimed = new Set<string>();
    const store = {
      claimDelivery: async (id: string) => {
        if (claimed.has(id)) return Promise.resolve(false);
        claimed.add(id);
        return Promise.resolve(true);
      },
    };
    const delivery = signWebhookDelivery(webhookEvent, "secret", "d-1", NOW);
    const first = await acceptWebhookDeliveryOnce(
      webhookEvent,
      delivery,
      "secret",
      NOW,
      store,
    );
    const second = await acceptWebhookDeliveryOnce(
      webhookEvent,
      delivery,
      "secret",
      NOW,
      store,
    );
    return first === "ACCEPTED" && second === "DUPLICATE"
      ? { actual: "IDEMPOTENT", evidence: "second delivery DUPLICATE" }
      : { actual: "UNSAFE", evidence: `${first}/${second}` };
  },
  "delayed-webhook": async () => {
    const { rail, action } = await executeOn("TIMEOUT_AFTER_EFFECT");
    const stale = signWebhookDelivery(
      webhookEvent,
      "secret",
      "d-late",
      "2026-10-28T01:00:00.000Z",
    );
    const accepted = verifyWebhookDelivery(webhookEvent, stale, "secret", NOW);
    const truth = await reconcileWithoutReexecution(
      rail,
      action.idempotencyKey,
      LATER,
    );
    return !accepted && truth.state === "SUCCEEDED" && truth.effectCount === 1
      ? {
          actual: "RECONCILE_ONLY",
          evidence: "late webhook rejected; provider lookup decided truth",
        }
      : { actual: "UNSAFE", evidence: `accepted=${accepted}` };
  },
  "dropped-response": async () => {
    const { evidence } = await executeOn("TIMEOUT_AFTER_EFFECT");
    return {
      actual: evidence.state === "UNKNOWN" ? "UNKNOWN" : "UNSAFE",
      evidence: `rail:${evidence.state}:${evidence.reason}`,
    };
  },
  "provider-timeout": async () => {
    const { evidence } = await executeOn("TIMEOUT_BEFORE_EFFECT");
    return {
      actual:
        evidence.state === "UNKNOWN" && evidence.effectCount === null
          ? "UNKNOWN"
          : "UNSAFE",
      evidence: `rail:${evidence.state}:${evidence.reason}`,
    };
  },
  "provider-effect-network-failure": async () => {
    const { rail, action, evidence } = await executeOn("TIMEOUT_AFTER_EFFECT");
    const truth = await reconcileWithoutReexecution(
      rail,
      action.idempotencyKey,
      LATER,
    );
    return evidence.state === "UNKNOWN" &&
      truth.state === "SUCCEEDED" &&
      rail.providerEffectWrites === 1
      ? {
          actual: "UNKNOWN",
          evidence: "execute stayed UNKNOWN; lookup found exactly one effect",
        }
      : { actual: "UNSAFE", evidence: `effects=${rail.providerEffectWrites}` };
  },
  "ambiguous-provider-state": async () => {
    const rail = new DeterministicFakeRail("fault-rail", "SUCCESS");
    const truth = await rail.lookup("never-executed-key-0001", NOW);
    return truth.state === "UNKNOWN" &&
      deriveReconciliationState(truth) === "UNRESOLVED"
      ? {
          actual: "UNKNOWN",
          evidence: "no provider record stays UNKNOWN/UNRESOLVED",
        }
      : { actual: "UNSAFE", evidence: `state=${truth.state}` };
  },
  "database-retry": async () => {
    const { rail, action } = await executeOn("TIMEOUT_AFTER_EFFECT");
    const { center, current } = reconciliationFixture(
      rail,
      action.idempotencyKey,
    );
    const outcomes = await Promise.allSettled([
      center.investigate("case-1", LATER),
      center.investigate("case-1", LATER),
    ]);
    // Losing compare-and-set writers retry from stored state and converge.
    const retried = await center.investigate("case-1", LATER);
    return current().state === "RESOLVED_SUCCEEDED" &&
      retried.state === "RESOLVED_SUCCEEDED" &&
      rail.providerEffectWrites === 1 &&
      outcomes.some((outcome) => outcome.status === "fulfilled")
      ? {
          actual: "IDEMPOTENT",
          evidence: "contended retries converged on one resolution",
        }
      : { actual: "UNSAFE", evidence: `state=${current().state}` };
  },
  "crash-after-reservation": async () => {
    const rail = new DeterministicFakeRail("fault-rail", "SUCCESS");
    const truth = await reconcileWithoutReexecution(
      rail,
      "reserved-but-never-executed",
      LATER,
    );
    return truth.effectCount === null &&
      truth.state === "UNKNOWN" &&
      rail.providerEffectWrites === 0
      ? {
          actual: "RECONCILE_ONLY",
          evidence: "recovery observed no provider effect without executing",
        }
      : { actual: "UNSAFE", evidence: `state=${truth.state}` };
  },
  "crash-after-grant": async () => {
    const rail = new DeterministicFakeRail("fault-rail", "SUCCESS");
    const action = financialAction();
    let refused = "";
    try {
      // Restart happens after the one-time grant has expired.
      await rail.execute({
        action,
        grant: railGrant(action, "2026-10-28T03:00:30.000Z"),
        now: LATER,
      });
    } catch (error) {
      refused = (error as Error).message;
    }
    const truth = await reconcileWithoutReexecution(
      rail,
      action.idempotencyKey,
      LATER,
    );
    return refused === "EXECUTION_GRANT_EXPIRED" &&
      rail.providerEffectWrites === 0 &&
      truth.state === "UNKNOWN"
      ? {
          actual: "RECONCILE_ONLY",
          evidence: "expired grant refused; recovery is lookup-only",
        }
      : { actual: "UNSAFE", evidence: `refused=${refused}` };
  },
  "crash-after-provider-create": async () => {
    const { rail, action, evidence } = await executeOn("TIMEOUT_AFTER_EFFECT");
    // Same-key retry inside the grant window must not create a second effect.
    const replay = await rail.execute({
      action,
      grant: railGrant(action),
      now: NOW,
    });
    // After the one-time grant expires, execution is refused outright.
    let refusedAfterExpiry = "";
    try {
      await rail.execute({ action, grant: railGrant(action), now: LATER });
    } catch (error) {
      refusedAfterExpiry = (error as Error).message;
    }
    return evidence.state === "UNKNOWN" &&
      replay.state === "SUCCEEDED" &&
      refusedAfterExpiry === "EXECUTION_GRANT_EXPIRED" &&
      rail.providerEffectWrites === 1
      ? {
          actual: "UNKNOWN",
          evidence:
            "pre-recovery state UNKNOWN; same-key retry did not duplicate; expired grant refused",
        }
      : { actual: "UNSAFE", evidence: `effects=${rail.providerEffectWrites}` };
  },
  "crash-after-capture": async () => {
    const rail = new DeterministicFakeRail("fault-rail", "SUCCESS");
    const action = financialAction();
    await rail.execute({ action, grant: railGrant(action), now: NOW });
    // The process died before recording the result: the local ledger knows nothing.
    const locallyRecorded: string | null = null;
    const truth = await reconcileWithoutReexecution(
      rail,
      action.idempotencyKey,
      LATER,
    );
    return locallyRecorded === null &&
      truth.state === "SUCCEEDED" &&
      truth.effectCount === 1 &&
      rail.providerEffectWrites === 1
      ? {
          actual: "UNKNOWN",
          evidence: "local truth UNKNOWN until lookup; exactly one capture",
        }
      : { actual: "UNSAFE", evidence: `effects=${rail.providerEffectWrites}` };
  },
  "reconciliation-race": async () => {
    const rail = new DeterministicFakeRail("fault-rail", "SUCCESS");
    const action = financialAction();
    const { center } = reconciliationFixture(rail, action.idempotencyKey);
    await Promise.allSettled([
      rail.execute({ action, grant: railGrant(action), now: NOW }),
      center.investigate("case-1", NOW),
      center.investigate("case-1", NOW),
    ]);
    return rail.providerEffectWrites === 1
      ? {
          actual: "NO_DUPLICATE_EFFECT",
          evidence: "reconciliation never executes; one provider effect",
        }
      : { actual: "UNSAFE", evidence: `effects=${rail.providerEffectWrites}` };
  },
  "tampered-proof": () => {
    const { proof, jwk } = signedProof();
    const result = verifyPortableProof(
      { ...proof, outcome: "FAILED", effectCount: 0 },
      jwk,
      NOW,
    );
    return Promise.resolve({
      actual: result.valid ? "UNSAFE" : "REJECT",
      evidence: `proof:${result.reason}`,
    });
  },
  "stale-proof": () => {
    const { proof, jwk } = signedProof({
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    const result = verifyPortableProof(proof, jwk, NOW);
    return Promise.resolve({
      actual: result.valid ? "UNSAFE" : "REJECT",
      evidence: `proof:${result.reason}`,
    });
  },
  "delegation-widening": () => {
    const graph = new EnterpriseDelegationGraph();
    graph.addRoot({
      id: "root",
      parentAgentId: "human",
      childAgentId: "root-agent",
      scope: scope({ parentAgentId: "human", childAgentId: "root-agent" }),
      state: "ACTIVE",
    });
    try {
      graph.addChild("root", {
        id: "child",
        parentAgentId: "root-agent",
        childAgentId: "child-agent",
        parentEdgeId: "root",
        scope: scope({
          parentAgentId: "root-agent",
          childAgentId: "child-agent",
          maxAmountMinor: 99_999,
          actionKinds: ["PURCHASE", "PAYOUT"],
        }),
        state: "ACTIVE",
      });
      return Promise.resolve({
        actual: "UNSAFE",
        evidence: "widened child delegation accepted",
      });
    } catch (error) {
      return Promise.resolve({
        actual: "DENY",
        evidence: (error as Error).message,
      });
    }
  },
  "privilege-escalation": () => {
    const graph = new EnterpriseDelegationGraph();
    graph.addRoot({
      id: "root",
      parentAgentId: "human",
      childAgentId: "root-agent",
      scope: scope({ parentAgentId: "human", childAgentId: "root-agent" }),
      state: "ACTIVE",
    });
    try {
      graph.addChild("root", {
        id: "child",
        parentAgentId: "root-agent",
        childAgentId: "child-agent",
        parentEdgeId: "root",
        scope: scope({
          parentAgentId: "root-agent",
          childAgentId: "child-agent",
          principalId: "other-principal",
        }),
        state: "ACTIVE",
      });
      return Promise.resolve({
        actual: "UNSAFE",
        evidence: "cross-principal delegation accepted",
      });
    } catch (error) {
      return Promise.resolve({
        actual: "DENY",
        evidence: (error as Error).message,
      });
    }
  },
  "duplicate-a2a-request": async () => {
    const claimed = new Set<string>();
    const store = {
      claimNonce: async (s: string, n: string) => {
        const key = `${s}:${n}`;
        if (claimed.has(key)) return Promise.resolve(false);
        claimed.add(key);
        return Promise.resolve(true);
      },
    };
    const parent = scope({
      parentAgentId: "human",
      childAgentId: "root-agent",
    });
    const child = scope({
      parentAgentId: "root-agent",
      childAgentId: "child-agent",
      maxAmountMinor: 5_000,
    });
    const expected = { audience: "payflow-a2a-v1", now: NOW };
    const first = await evaluateDelegatedRequest(
      child,
      parent,
      expected,
      store,
    );
    const second = await evaluateDelegatedRequest(
      child,
      parent,
      expected,
      store,
    );
    return first.verdict === "ACCEPTED" && second.verdict === "DUPLICATE"
      ? { actual: "IDEMPOTENT", evidence: "second A2A delegation DUPLICATE" }
      : { actual: "UNSAFE", evidence: `${first.verdict}/${second.verdict}` };
  },
  "duplicate-mcp-invocation": async () => {
    const { mandate, agent } = kernelFixture();
    const { gateway, capabilitiesIssued } = makeGateway(mandate, agent);
    const unsupported = () => Promise.reject(new Error("not used"));
    const services: McpAuthorityServices = {
      checkFinancialAuthority: unsupported,
      verifyAuthority: unsupported,
      verifyFinancialProof: unsupported,
      reconcileFinancialAction: unsupported,
      requestAuthorizedAction: async (args) => {
        const result = await gateway.requestAction(accessFor(agent), args, {
          now: NOW,
          merchantRisk: "LOW",
        });
        return {
          decision: result.decision.decision,
          reasonCodes: result.decision.reasonCodes,
          hasCapability: result.executionCapability !== undefined,
        };
      },
    };
    const call = () =>
      invokePayFlowMcpTool(
        "request_authorized_action",
        requestBody(),
        { authenticated: true, requestId: "mcp-1" },
        services,
      );
    const first = (await call()).structuredContent as { decision: string };
    const second = (await call()).structuredContent as { decision: string };
    return first.decision === "ALLOW" &&
      second.decision === "DENY" &&
      capabilitiesIssued() === 1
      ? {
          actual: "IDEMPOTENT",
          evidence: "second MCP call DENY; one capability",
        }
      : { actual: "UNSAFE", evidence: `${first.decision}/${second.decision}` };
  },
  "malformed-commerce-context": async () => {
    const { mandate, agent } = kernelFixture();
    const { gateway } = makeGateway(mandate, agent);
    try {
      await gateway.requestAction(accessFor(agent), requestBody(), {
        now: NOW,
        merchantRisk: "BOGUS" as never,
      });
      return { actual: "UNSAFE", evidence: "malformed context accepted" };
    } catch (error) {
      return {
        actual: "REJECT",
        evidence: `gateway-refusal:${String((error as { code?: unknown }).code)}`,
      };
    }
  },
  "unsupported-action-type": () => {
    const parsed = FinancialActionSchema.safeParse({
      ...financialAction(),
      kind: "CRYPTO_WITHDRAWAL",
    });
    return Promise.resolve({
      actual: parsed.success ? "UNSAFE" : "REJECT",
      evidence: "financial-action-schema",
    });
  },
  "unsupported-rail": async () => {
    const rail = new DeterministicFakeRail("known-rail", "SUCCESS");
    const { center } = reconciliationFixture(rail, "key");
    const unknownRailCenter = new ReconciliationOperationsCenter(
      {
        load: async () =>
          Promise.resolve({
            id: "case-x",
            attemptId: "a",
            railId: "unknown-rail",
            idempotencyKey: "key",
            state: "PENDING",
            openedAt: NOW,
            updatedAt: NOW,
            evidence: [],
          }),
        compareAndSet: async () => Promise.resolve(true),
      },
      new Map(),
    );
    void center;
    try {
      await unknownRailCenter.investigate("case-x", NOW);
      return { actual: "UNSAFE", evidence: "unknown rail was accepted" };
    } catch (error) {
      return { actual: "REJECT", evidence: (error as Error).message };
    }
  },
  "negative-zero-extreme-amount": () => {
    const attempts = [-1, 0, Number.MAX_SAFE_INTEGER + 1, 1e21, Number.NaN].map(
      (minor) =>
        FinancialActionSchema.safeParse({
          ...financialAction(),
          amount: { currency: "USD", minor },
        }).success,
    );
    return Promise.resolve({
      actual: attempts.some(Boolean) ? "UNSAFE" : "REJECT",
      evidence: `rejected ${attempts.length} hostile amounts`,
    });
  },
  "precision-rounding": () => {
    const attempts = [10.5, 0.1 + 0.2, 4999.999999].map(
      (minor) =>
        FinancialActionSchema.safeParse({
          ...financialAction(),
          amount: { currency: "USD", minor },
        }).success,
    );
    return Promise.resolve({
      actual: attempts.some(Boolean) ? "UNSAFE" : "REJECT",
      evidence: "fractional minor units rejected",
    });
  },
  "cross-currency-mismatch": () =>
    Promise.resolve(
      viaFinancialAction({ amount: { currency: "EUR", minor: 5_000 } }, [
        "MONEY:SETTLEMENT_CURRENCY_DENIED",
      ]),
    ),
  "fee-mismatch": () =>
    Promise.resolve(
      viaFinancialAction(
        {
          fx: {
            sourceCurrency: "EUR",
            settlementCurrency: "USD",
            rateNumerator: 11,
            rateDenominator: 10,
            observedSlippageBps: 500,
          },
          taxes: [{ currency: "USD", minor: 9_000 }],
        },
        [
          "MONEY:TAX_BOUNDARY_EXCEEDED",
          "MONEY:FX_DENIED",
          "MONEY:FX_SLIPPAGE_EXCEEDED",
        ],
      ),
    ),
};

export const liveFaultInjector: FaultInjector = async (
  scenario: FaultScenario,
) => {
  const handler = handlers[scenario.id];
  if (!handler) {
    return {
      scenarioId: scenario.id,
      actual: "UNSAFE",
      evidence: "no live handler for scenario",
    };
  }
  const { actual, evidence } = await handler();
  return { scenarioId: scenario.id, actual, evidence };
};
