import { mandateFingerprint } from "../canonical.js";
import { kernelFixture } from "../network/benchmark.js";
import { DeterministicFakeRail } from "../network/rail.js";
import {
  FinancialAuthorityGateway,
  GATEWAY_AUDIENCE,
} from "../network/gateway.js";
import type { McpAuthorityServices } from "./mcp.js";

/**
 * Sandbox-only MCP services: an in-memory Authority, the real Trust Kernel,
 * and the deterministic FAKE rail. Verification fails closed because the
 * sandbox holds no trusted issuer keys. No provider is ever contacted.
 */
export function createSandboxMcpServices(
  now: () => string,
): McpAuthorityServices {
  const { mandate, agent } = kernelFixture();
  const claimed = new Set<string>();
  let issued = 0;
  const gateway = new FinancialAuthorityGateway({
    loadMandate: (id) => Promise.resolve(id === mandate.id ? mandate : null),
    loadAgent: (id) => Promise.resolve(id === agent.id ? agent : null),
    authorityState: () => Promise.resolve("ACTIVE"),
    cumulativeSpentMinor: () => Promise.resolve(0),
    consumedQuantity: () => Promise.resolve(0),
    claimReplayKey: (scope, key) => {
      const composite = `${scope}:${key}`;
      if (claimed.has(composite)) return Promise.resolve(false);
      claimed.add(composite);
      return Promise.resolve(true);
    },
    issueExecutionCapability: (_receipt, p) => {
      issued += 1;
      return Promise.resolve({
        grantId: `sandbox-grant:${p.id}:${issued}`,
        expiresAt: new Date(Date.parse(now()) + 60_000).toISOString(),
        proposalDigest: mandateFingerprint(mandate),
      });
    },
  });
  const access = {
    clientId: "sandbox-mcp",
    agentId: agent.id,
    principalId: mandate.principalId,
    audience: GATEWAY_AUDIENCE,
    scopes: ["authority:read" as const, "action:request" as const],
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "ACTIVE" as const,
  };
  const rail = new DeterministicFakeRail("sandbox-fake-rail", "SUCCESS");
  const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  return {
    checkFinancialAuthority: async (args) => {
      const input = asRecord(args);
      if (input.authorityId !== mandate.id) {
        return {
          authorityId: String(input.authorityId),
          fits: false,
          reasonCodes: ["AUTHORITY_NOT_FOUND"],
          environment: "SANDBOX",
        };
      }
      // Read-only: the same kernel through Gateway.checkAction, with no replay claim,
      // reservation, capability or rail contact.
      const result = await gateway.checkAction(
        access,
        { ...asRecord(input.proposedAction), mandateId: mandate.id },
        { now: now(), merchantRisk: "LOW" },
      );
      return {
        authorityId: mandate.id,
        fits: result.decision.decision === "ALLOW",
        decision: result.decision.decision,
        reasonCodes: result.decision.reasonCodes,
        environment: "SANDBOX",
      };
    },
    requestAuthorizedAction: async (args) => {
      const result = await gateway.requestAction(
        access,
        asRecord(args).action,
        { now: now(), merchantRisk: "LOW" },
      );
      return {
        requestId: result.requestId,
        decision: result.decision.decision,
        reasonCodes: result.decision.reasonCodes,
        executionCapability: result.executionCapability
          ? {
              grantId: result.executionCapability.grantId,
              expiresAt: result.executionCapability.expiresAt,
            }
          : null,
        environment: "SANDBOX",
      };
    },
    verifyAuthority: () =>
      Promise.resolve({
        verdict: "INVALID",
        reason: "SANDBOX_HAS_NO_TRUSTED_ISSUER_KEYS",
        environment: "SANDBOX",
      }),
    verifyFinancialProof: () =>
      Promise.resolve({
        valid: false,
        reason: "SANDBOX_HAS_NO_TRUSTED_ISSUER_KEYS",
        environment: "SANDBOX",
      }),
    reconcileFinancialAction: async (args) => {
      const evidence = await rail.lookup(
        String(asRecord(args).attemptId),
        now(),
      );
      // Lookup only. Reconciliation never executes, so it cannot duplicate an effect.
      return {
        attemptId: String(asRecord(args).attemptId),
        state: evidence.state,
        effectCount: evidence.effectCount,
        reason: evidence.reason,
        environment: "SANDBOX",
      };
    },
  };
}
