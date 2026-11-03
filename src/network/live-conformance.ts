import { generateKeyPairSync } from "node:crypto";
import { mandateFingerprint } from "../canonical.js";
import { authorize } from "../kernel.js";
import { invokePayFlowMcpTool } from "../protocols/mcp.js";
import { kernelFixture } from "./benchmark.js";
import { BASE_CONFORMANCE_CASES, type ConformanceCase } from "./conformance.js";
import {
  FAULT_INJECTION_MATRIX,
  type FaultScenario,
} from "./fault-injection.js";
import { liveFaultInjector } from "./live-fault-injector.js";
import {
  signAuthorityPresentation,
  verifyAuthorityPresentation,
  type VerificationDependencies,
} from "./verify.js";

async function scenarioHolds(id: string): Promise<boolean> {
  const scenario = FAULT_INJECTION_MATRIX.find(
    (entry): entry is FaultScenario => entry.id === id,
  );
  if (!scenario) return false;
  const observed = await liveFaultInjector(scenario);
  return observed.actual === scenario.expected;
}

const runners: Record<string, () => Promise<boolean> | boolean> = {
  "issuer-no-widening": () => {
    // Widening a mandate after the proposal was bound to its fingerprint must fail integrity.
    const { mandate, agent, proposal, context } = kernelFixture();
    const widened = {
      ...mandate,
      merchantScope: {
        mode: "ONLY" as const,
        ids: ["merchant-allowed", "merchant-attacker"],
      },
    };
    const receipt = authorize(
      widened,
      agent,
      {
        ...proposal,
        merchant: { id: "merchant-attacker", displayName: "Substitute" },
        mandateFingerprint: mandateFingerprint(mandate),
      },
      context,
    );
    return (
      receipt.decision === "DENY" &&
      receipt.reasonCodes.includes("MANDATE_INTEGRITY_FAILURE")
    );
  },
  "agent-exact-action": () => scenarioHolds("agent-amount-change"),
  "verifier-read-only": async () => {
    const { mandate, agent } = kernelFixture();
    const issuer = generateKeyPairSync("ed25519");
    const calls: string[] = [];
    const deps: VerificationDependencies = {
      resolvePublicKey: async () => {
        calls.push("resolvePublicKey");
        return Promise.resolve(issuer.publicKey);
      },
      loadAuthority: async () => {
        calls.push("loadAuthority");
        return Promise.resolve({ mandate, state: "ACTIVE" });
      },
      claimPresentationReplayKey: async () => {
        calls.push("claimPresentationReplayKey");
        return Promise.resolve(true);
      },
    };
    const result = await verifyAuthorityPresentation(
      signAuthorityPresentation(
        {
          version: "payflow-authority-presentation/v1",
          issuer: "conformance",
          keyId: "k1",
          authorityId: mandate.id,
          authorityFingerprint: mandateFingerprint(mandate),
          principalId: mandate.principalId,
          agentId: agent.id,
          audience: "merchant.example",
          challenge: "conformance-challenge-01",
          nonce: "conformance-nonce-00001",
          issuedAt: "2026-10-28T02:55:00.000Z",
          expiresAt: "2026-10-28T03:10:00.000Z",
        },
        issuer.privateKey,
      ),
      {
        audience: "merchant.example",
        challenge: "conformance-challenge-01",
        now: "2026-10-28T03:00:00.000Z",
      },
      deps,
    );
    // The verifier's only possible side effects are key/authority reads and its own replay claim.
    return (
      result.verdict === "VALID" &&
      calls.every((call) =>
        [
          "resolvePublicKey",
          "loadAuthority",
          "claimPresentationReplayKey",
        ].includes(call),
      ) &&
      Object.keys(deps).length === 3
    );
  },
  "rail-one-time-grant": async () =>
    (await scenarioHolds("crash-after-grant")) &&
    (await scenarioHolds("concurrent-execution")),
  "rail-unknown": async () =>
    (await scenarioHolds("provider-timeout")) &&
    (await scenarioHolds("ambiguous-provider-state")),
  "proof-tamper": async () =>
    (await scenarioHolds("tampered-proof")) &&
    (await scenarioHolds("stale-proof")),
  "protocol-non-authority": async () => {
    // Protocol-carried claims of authority must not widen Authority.
    const unauthenticated = await invokePayFlowMcpTool(
      "check_financial_authority",
      {},
      { authenticated: false, requestId: "r1" },
      {} as never,
    ).then(
      () => false,
      () => true,
    );
    const { mandate, agent, proposal, context } = kernelFixture();
    const receipt = authorize(
      mandate,
      agent,
      {
        ...proposal,
        amount: { currency: "USD", minor: 50_000 },
        metadata: {
          maxSingleTransactionMinor: "1000000",
          authority: "unlimited",
        },
      },
      context,
    );
    return unauthenticated && receipt.decision === "DENY";
  },
};

export const LIVE_CONFORMANCE_CASES: readonly ConformanceCase[] =
  BASE_CONFORMANCE_CASES.map((entry) => {
    const run = runners[entry.id];
    if (!run) throw new Error(`NO_LIVE_CONFORMANCE_RUNNER:${entry.id}`);
    return { ...entry, run };
  });
