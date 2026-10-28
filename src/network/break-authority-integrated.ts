import { verifyPortableProof } from "../../packages/verifier/src/index.js";
import { authorize } from "../kernel.js";
import {
  evaluateDelegatedRequest,
  validateDelegationAttenuation,
} from "../protocols/a2a.js";
import { invokePayFlowMcpTool } from "../protocols/mcp.js";
import { authorizeFinancialAction } from "./action-authorization.js";
import { attack, kernelFixture, type AttackFamily } from "./benchmark.js";
import {
  assertEnvironmentBoundary,
  assertSameTenant,
} from "./control-plane.js";
import { EnterpriseDelegationGraph } from "./enterprise.js";
import {
  NOW,
  accessFor,
  extension,
  financialAction,
  makeGateway,
  presentationFixture,
  railGrant,
  requestBody,
  scope,
  signedProof,
} from "./live-fault-injector.js";
import {
  evaluateMachineEconomicAction,
  type MachineAuthority,
} from "./machine-authority.js";
import { DeterministicFakeRail, type FakeRailMode } from "./rail.js";
import {
  signAuthorityPresentation,
  verifyAuthorityPresentation,
} from "./verify.js";

/**
 * Integrated Break Authority benchmark.
 *
 * Every scenario drives production code: the Trust Kernel, Gateway, Verify,
 * Proof verifier, delegation graph, A2A/MCP adapters, control-plane tenancy
 * guards, machine-authority evaluation and the provider-neutral rail contract
 * (with the deterministic *fake* rail). No real provider is contacted and no
 * money moves; results must be described as local, fake-rail results.
 */
export const INTEGRATED_CATEGORIES = [
  "IDENTITY",
  "DELEGATION",
  "AMOUNT",
  "MERCHANT",
  "PRODUCT",
  "CURRENCY",
  "FEES",
  "REPLAY",
  "CONCURRENCY",
  "PROVIDER_AMBIGUITY",
  "PROTOCOL",
  "PROOF_TAMPERING",
  "PRIVILEGE_ESCALATION",
  "CROSS_TENANT",
  "LIFECYCLE",
  "MACHINE_TO_MACHINE",
] as const;
export type IntegratedCategory = (typeof INTEGRATED_CATEGORIES)[number];

export interface IntegratedScenarioResult {
  readonly id: string;
  readonly category: IntegratedCategory;
  /** True when the system refused / contained the attack (no unauthorized effect). */
  readonly contained: boolean;
  readonly evidence: string;
}

export interface IntegratedBreakAuthorityReport {
  readonly version: "break-authority-integrated/v1";
  readonly scenarioCount: number;
  readonly categories: Readonly<
    Record<IntegratedCategory, { total: number; contained: number }>
  >;
  readonly uncontainedScenarioIds: readonly string[];
  readonly controls: readonly {
    id: string;
    passed: boolean;
    evidence: string;
  }[];
  readonly providerEffectsExercised: false;
  readonly railKind: "deterministic-fake";
  readonly results: readonly IntegratedScenarioResult[];
}

type Run = (
  variant: number,
) => Promise<{ contained: boolean; evidence: string }>;

function kernelFamily(family: AttackFamily): Run {
  return (variant) => {
    const scenario = attack(family, variant);
    const receipt = authorize(
      scenario.mandate,
      scenario.agent,
      scenario.proposal,
      scenario.context,
    );
    return Promise.resolve({
      contained: receipt.decision !== "ALLOW",
      evidence: `kernel:${receipt.decision}:${receipt.reasonCodes.join(",")}`,
    });
  };
}

async function refusal(
  attempt: () => unknown,
  expectedCode?: string,
): Promise<{ contained: boolean; evidence: string }> {
  try {
    await attempt();
    return { contained: false, evidence: "attack-accepted" };
  } catch (error) {
    const message =
      (error as { code?: string; message?: string }).code ??
      (error as Error).message;
    return {
      contained: expectedCode === undefined || message.includes(expectedCode),
      evidence: `refused:${message}`,
    };
  }
}

const machineAuthority: MachineAuthority = {
  authorityId: "m2m-1",
  sponsorPrincipalId: "sponsor-1",
  machineIdentity: "machine-1",
  allowedPurposes: ["inference"],
  allowedResourceKinds: ["API", "COMPUTE"],
  currency: "USD",
  maxSingleActionMinor: 1_000,
  maxTotalMinor: 5_000,
  maxActionsPerHour: 10,
  expiresAt: "2026-10-29T03:00:00.000Z",
};

const runners: Record<IntegratedCategory, Run> = {
  IDENTITY: async (variant) => {
    const { mandate, agent } = kernelFixture();
    const { gateway } = makeGateway(mandate, agent);
    const access =
      variant % 2 === 0
        ? { ...accessFor(agent), agentId: `attacker-${variant}` }
        : { ...accessFor(agent), principalId: `other-principal-${variant}` };
    return refusal(
      () =>
        gateway.requestAction(access, requestBody(), {
          now: NOW,
          merchantRisk: "LOW",
        }),
      variant % 2 === 0 ? "ACCESS_AGENT_MISMATCH" : "ACCESS_PRINCIPAL_MISMATCH",
    );
  },
  DELEGATION: (variant) => {
    const graph = new EnterpriseDelegationGraph();
    graph.addRoot({
      id: "root",
      parentAgentId: "human",
      childAgentId: "root-agent",
      scope: scope({ parentAgentId: "human", childAgentId: "root-agent" }),
      state: "ACTIVE",
    });
    const widenings = [
      { maxAmountMinor: 10_001 + variant },
      { actionKinds: ["PURCHASE", "PAYOUT"] as never },
      { currencies: ["USD", "EUR"] },
      { counterpartyIds: ["merchant-allowed", `extra-${variant}`] },
      { expiresAt: "2026-10-29T09:00:00.000Z" },
    ];
    const widening = widenings[variant % widenings.length] ?? {};
    return refusal(
      () =>
        graph.addChild("root", {
          id: `child-${variant}`,
          parentAgentId: "root-agent",
          childAgentId: `child-agent-${variant}`,
          parentEdgeId: "root",
          scope: scope({
            parentAgentId: "root-agent",
            childAgentId: `child-agent-${variant}`,
            ...widening,
          }),
          state: "ACTIVE",
        }),
      "DELEGATION_WIDENING",
    );
  },
  AMOUNT: kernelFamily("AMOUNT_WIDENING"),
  MERCHANT: (variant) =>
    variant % 2 === 0
      ? kernelFamily("MERCHANT_SUBSTITUTION")(variant)
      : kernelFamily("MERCHANT_RISK_WIDENING")(variant),
  PRODUCT: (variant) =>
    variant % 2 === 0
      ? kernelFamily("CONDITION_SUBSTITUTION")(variant)
      : kernelFamily("QUANTITY_WIDENING")(variant),
  CURRENCY: (variant) =>
    variant % 2 === 0
      ? kernelFamily("CURRENCY_SUBSTITUTION")(variant)
      : Promise.resolve(feeOrCurrency(variant, "currency")),
  FEES: (variant) => Promise.resolve(feeOrCurrency(variant, "fees")),
  REPLAY: async (variant) => {
    const { mandate, agent } = kernelFixture();
    const { gateway, capabilitiesIssued } = makeGateway(mandate, agent);
    const call = () =>
      gateway.requestAction(
        accessFor(agent),
        requestBody({ nonce: `replay-nonce-${variant}-000000` }),
        { now: NOW, merchantRisk: "LOW" },
      );
    const first = await call();
    let last = first;
    for (let attempt = 0; attempt <= variant % 5; attempt += 1) {
      last = await call();
    }
    return {
      contained:
        first.decision.decision === "ALLOW" &&
        last.decision.decision === "DENY" &&
        capabilitiesIssued() === 1,
      evidence: `capabilities=${capabilitiesIssued()}:${last.decision.reasonCodes.join(",")}`,
    };
  },
  CONCURRENCY: async (variant) => {
    const rail = new DeterministicFakeRail("bench-rail", "SUCCESS");
    const action = financialAction({
      id: `bench-action-${variant}`,
      idempotencyKey: `bench-idempotency-${variant}-0000`,
    });
    await Promise.all(
      Array.from({ length: 2 + (variant % 30) }, () =>
        rail.execute({ action, grant: railGrant(action), now: NOW }),
      ),
    );
    return {
      contained: rail.providerEffectWrites === 1,
      evidence: `provider-effects=${rail.providerEffectWrites}`,
    };
  },
  PROVIDER_AMBIGUITY: async (variant) => {
    const modes: FakeRailMode[] = [
      "TIMEOUT_BEFORE_EFFECT",
      "TIMEOUT_AFTER_EFFECT",
    ];
    const mode = modes[variant % modes.length] ?? "TIMEOUT_BEFORE_EFFECT";
    const rail = new DeterministicFakeRail("bench-rail", mode);
    const action = financialAction({
      id: `amb-${variant}`,
      idempotencyKey: `amb-idempotency-${variant}-000000`,
    });
    const evidence = await rail.execute({
      action,
      grant: railGrant(action),
      now: NOW,
    });
    // UNKNOWN must stay UNKNOWN: never success, never failure, never "0 effects".
    return {
      contained:
        evidence.state === "UNKNOWN" &&
        evidence.effectCount === null &&
        rail.providerEffectWrites <= 1,
      evidence: `rail:${evidence.state}:${evidence.reason}`,
    };
  },
  PROTOCOL: async (variant) => {
    if (variant % 3 === 0) {
      return refusal(
        () =>
          invokePayFlowMcpTool(
            "request_authorized_action",
            requestBody(),
            { authenticated: false, requestId: `mcp-${variant}` },
            {} as never,
          ),
        "MCP_AUTHENTICATION_REQUIRED",
      );
    }
    if (variant % 3 === 1) {
      const leaky = async () => Promise.resolve({ private_key: "x" });
      return refusal(
        () =>
          invokePayFlowMcpTool(
            "verify_authority",
            {},
            { authenticated: true, requestId: `mcp-${variant}` },
            {
              verifyAuthority: leaky,
            } as never,
          ),
        "MCP_SECRET_OUTPUT_BLOCKED",
      );
    }
    const parent = scope({
      parentAgentId: "human",
      childAgentId: "root-agent",
    });
    const claimed = new Set<string>();
    const store = {
      claimNonce: async (s: string, n: string) => {
        const key = `${s}:${n}`;
        if (claimed.has(key)) return Promise.resolve(false);
        claimed.add(key);
        return Promise.resolve(true);
      },
    };
    const child = scope({
      parentAgentId: "root-agent",
      childAgentId: "child-agent",
      audience: `other-audience-${variant}`,
    });
    const result = await evaluateDelegatedRequest(
      child,
      parent,
      { audience: "payflow-a2a-v1", now: NOW },
      store,
    );
    return {
      contained: result.verdict === "WRONG_AUDIENCE",
      evidence: `a2a:${result.verdict}`,
    };
  },
  PROOF_TAMPERING: (variant) => {
    const { proof, jwk } = signedProof();
    const tamperings: Array<Record<string, unknown>> = [
      { outcome: "FAILED", effectCount: 0 },
      { effectCount: 2 },
      { evidenceDigest: "b".repeat(64) },
      { actionId: `other-action-${variant}` },
      { authorityId: `other-authority-${variant}` },
      { observedAt: "2026-10-28T03:00:01.000Z" },
    ];
    const mutation = tamperings[variant % tamperings.length] ?? {};
    const result = verifyPortableProof({ ...proof, ...mutation }, jwk, NOW);
    return Promise.resolve({
      contained: !result.valid,
      evidence: `proof:${result.reason}`,
    });
  },
  PRIVILEGE_ESCALATION: (variant) => {
    if (variant % 2 === 0)
      return kernelFamily("CAPABILITY_ESCALATION")(variant);
    const violations = validateDelegationAttenuation(
      scope({ parentAgentId: "human", childAgentId: "root-agent" }),
      scope({
        parentAgentId: "root-agent",
        childAgentId: "child-agent",
        principalId: `other-principal-${variant}`,
      }),
    );
    return Promise.resolve({
      contained: violations.includes("PRINCIPAL_CHANGED"),
      evidence: `delegation:${violations.join(",")}`,
    });
  },
  CROSS_TENANT: (variant) =>
    refusal(
      () => {
        if (variant % 2 === 0) {
          assertSameTenant(`org-${variant}`, `org-${variant + 1}`);
        } else {
          assertEnvironmentBoundary("SANDBOX", "PRODUCTION");
        }
      },
      variant % 2 === 0
        ? "CROSS_TENANT_ACCESS_DENIED"
        : "CROSS_ENVIRONMENT_ACCESS_DENIED",
    ),
  LIFECYCLE: async (variant) => {
    if (variant % 3 === 2) return kernelFamily("EXPIRED_AUTHORITY")(variant);
    const state = variant % 3 === 0 ? "REVOKED" : "SUSPENDED";
    const { mandate, agent } = kernelFixture();
    const { gateway } = makeGateway(mandate, agent, state);
    const gate = await refusal(
      () =>
        gateway.requestAction(
          accessFor(agent),
          requestBody({ nonce: `life-nonce-${variant}-0000000` }),
          { now: NOW, merchantRisk: "LOW" },
        ),
      "AUTHORITY_INACTIVE",
    );
    const fixture = presentationFixture();
    const verdict = await verifyAuthorityPresentation(
      signAuthorityPresentation(fixture.payload, fixture.issuer.privateKey),
      {
        audience: "merchant.example",
        challenge: "fault-challenge-0000001",
        now: NOW,
      },
      fixture.verifierFor(fixture.issuer.publicKey, state),
    );
    return {
      contained: gate.contained && verdict.verdict === "REVOKED",
      evidence: `${gate.evidence}|verify:${verdict.verdict}`,
    };
  },
  MACHINE_TO_MACHINE: (variant) => {
    const base = {
      machineIdentity: "machine-1",
      purpose: "inference",
      resourceKind: "API" as const,
      amountMinor: 500,
      currency: "USD",
      proposedAt: NOW,
    };
    const context = {
      cumulativeSpentMinor: 0,
      actionsInPreviousHour: 0,
      now: NOW,
    };
    const attacks = [
      { action: { ...base, machineIdentity: `rogue-${variant}` }, context },
      { action: { ...base, purpose: "mining" }, context },
      { action: { ...base, resourceKind: "DATA" as const }, context },
      { action: { ...base, amountMinor: 1_001 + variant }, context },
      { action: base, context: { ...context, cumulativeSpentMinor: 4_800 } },
      { action: base, context: { ...context, actionsInPreviousHour: 10 } },
      { action: { ...base, amountMinor: -5 }, context },
      { action: { ...base, currency: "EUR" }, context },
    ];
    const chosen = attacks[variant % attacks.length];
    if (!chosen) throw new Error("benchmark attack invariant");
    const reasons = evaluateMachineEconomicAction(
      machineAuthority,
      chosen.action,
      chosen.context,
    );
    return Promise.resolve({
      contained: reasons.length > 0,
      evidence: `m2m:${reasons.join(",")}`,
    });
  },
};

function feeOrCurrency(
  variant: number,
  kind: "fees" | "currency",
): { contained: boolean; evidence: string } {
  const { mandate, agent, context } = kernelFixture();
  const overrides =
    kind === "fees"
      ? { fees: [{ currency: "USD", minor: 101 + variant }] }
      : { amount: { currency: "GBP", minor: 5_000 } };
  const result = authorizeFinancialAction(
    mandate,
    extension,
    agent,
    financialAction(overrides),
    context,
  );
  return {
    contained:
      result.decision === "DENY" && result.extensionViolations.length > 0,
    evidence: `action:${result.extensionViolations.join(",")}`,
  };
}

async function controls() {
  const results: Array<{ id: string; passed: boolean; evidence: string }> = [];
  const { mandate, agent } = kernelFixture();
  const { gateway } = makeGateway(mandate, agent);
  const allowed = await gateway.requestAction(accessFor(agent), requestBody(), {
    now: NOW,
    merchantRisk: "LOW",
  });
  results.push({
    id: "valid-action-completes-through-gateway",
    passed:
      allowed.decision.decision === "ALLOW" &&
      allowed.executionCapability !== undefined,
    evidence: allowed.decision.decision,
  });

  const rail = new DeterministicFakeRail("bench-rail", "SUCCESS");
  const action = financialAction();
  const evidence = await rail.execute({
    action,
    grant: railGrant(action),
    now: NOW,
  });
  results.push({
    id: "valid-action-settles-exactly-once-on-fake-rail",
    passed: evidence.state === "SUCCEEDED" && rail.providerEffectWrites === 1,
    evidence: `${evidence.state}:${rail.providerEffectWrites}`,
  });

  const parentScope = scope({
    parentAgentId: "human",
    childAgentId: "root-agent",
  });
  const childScope = scope({
    parentAgentId: "root-agent",
    childAgentId: "child-agent",
    maxAmountMinor: 5_000,
  });
  const violations = validateDelegationAttenuation(parentScope, childScope);
  results.push({
    id: "narrower-delegation-is-accepted",
    passed: violations.length === 0,
    evidence: violations.join(",") || "none",
  });

  const { proof, jwk } = signedProof();
  const verified = verifyPortableProof(proof, jwk, NOW);
  results.push({
    id: "untampered-proof-verifies",
    passed: verified.valid,
    evidence: verified.reason,
  });

  const m2m = evaluateMachineEconomicAction(
    machineAuthority,
    {
      machineIdentity: "machine-1",
      purpose: "inference",
      resourceKind: "API",
      amountMinor: 500,
      currency: "USD",
      proposedAt: NOW,
    },
    { cumulativeSpentMinor: 0, actionsInPreviousHour: 0, now: NOW },
  );
  results.push({
    id: "in-bounds-machine-action-is-allowed",
    passed: m2m.length === 0,
    evidence: m2m.join(",") || "none",
  });
  return results;
}

export async function runIntegratedBreakAuthority(
  scenarioCount: 100 | 1000,
): Promise<IntegratedBreakAuthorityReport> {
  const results: IntegratedScenarioResult[] = [];
  for (let index = 0; index < scenarioCount; index += 1) {
    const category =
      INTEGRATED_CATEGORIES[index % INTEGRATED_CATEGORIES.length];
    if (!category) throw new Error("benchmark category invariant");
    const variant = Math.floor(index / INTEGRATED_CATEGORIES.length);
    const outcome = await runners[category](variant);
    results.push({
      id: `${category.toLowerCase()}-${String(variant).padStart(3, "0")}`,
      category,
      contained: outcome.contained,
      evidence: outcome.evidence,
    });
  }
  const categories = Object.fromEntries(
    INTEGRATED_CATEGORIES.map((category) => {
      const own = results.filter((result) => result.category === category);
      return [
        category,
        {
          total: own.length,
          contained: own.filter((result) => result.contained).length,
        },
      ];
    }),
  ) as IntegratedBreakAuthorityReport["categories"];
  return {
    version: "break-authority-integrated/v1",
    scenarioCount,
    categories,
    uncontainedScenarioIds: results
      .filter((result) => !result.contained)
      .map((result) => result.id),
    controls: await controls(),
    providerEffectsExercised: false,
    railKind: "deterministic-fake",
    results,
  };
}
