import { createHash } from "node:crypto";
import type { FinancialAction } from "./financial-action.js";
import {
  evaluateExternalIssuerAssertion,
  type ExternalAuthorityAssertion,
  type IssuerTrustProfile,
} from "./federation.js";
import {
  financialActionDigest,
  reconcileWithoutReexecution,
  type BoundedRailGrant,
  type FinancialRailAdapter,
  type NormalizedRailEvidence,
} from "./rail.js";

export interface ExternalIdentityContext {
  readonly provider: string;
  readonly subject: string;
  readonly agentId: string;
  readonly audience: string;
  readonly authenticatedAt: string;
}

export interface GlobalNetworkDemoInput {
  readonly originPlatform: string;
  readonly identity: ExternalIdentityContext;
  readonly issuerAssertion: ExternalAuthorityAssertion;
  readonly issuerTrustProfile: IssuerTrustProfile;
  readonly verifierDomain: string;
  readonly verifierVerdict: "VALID" | "INVALID";
  readonly action: FinancialAction;
  readonly grant: BoundedRailGrant;
  readonly rail: FinancialRailAdapter;
  readonly now: string;
}

export interface NetworkProofPayload {
  readonly version: "payflow-proof/v1";
  readonly issuer: string;
  readonly keyId: string;
  readonly authorityId: string;
  readonly actionId: string;
  readonly outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  readonly effectCount: 0 | 1 | null;
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

export interface GlobalNetworkDemoResult {
  readonly stages: readonly string[];
  readonly initialRailEvidence: NormalizedRailEvidence;
  readonly terminalRailEvidence: NormalizedRailEvidence;
  readonly proofPayload: NetworkProofPayload;
}

export async function demonstrateGlobalFinancialAuthorityNetwork(
  input: GlobalNetworkDemoInput,
): Promise<GlobalNetworkDemoResult> {
  if (!input.originPlatform || !input.identity.provider) throw new Error("ORIGIN_OR_IDENTITY_PROVIDER_REQUIRED");
  if (input.identity.agentId !== input.action.agentId) throw new Error("IDENTITY_AGENT_MISMATCH");
  if (input.identity.audience !== input.issuerAssertion.audience) throw new Error("IDENTITY_AUDIENCE_MISMATCH");
  const trust = evaluateExternalIssuerAssertion(
    input.issuerAssertion,
    input.issuerTrustProfile,
    input.identity.audience,
    input.now,
  );
  if (!trust.trusted || !trust.assertion) throw new Error(`EXTERNAL_AUTHORITY_NOT_TRUSTED:${trust.reasons.join(",")}`);
  if (trust.assertion.agentId !== input.action.agentId) throw new Error("AUTHORITY_AGENT_MISMATCH");
  if (!trust.assertion.actionKinds.includes(input.action.kind)) throw new Error("AUTHORITY_ACTION_KIND_MISMATCH");
  if (!trust.assertion.currencies.includes(input.action.amount.currency)) throw new Error("AUTHORITY_CURRENCY_MISMATCH");
  if (input.action.amount.minor > trust.assertion.maxAmountMinor) throw new Error("AUTHORITY_AMOUNT_EXCEEDED");
  if (input.verifierVerdict !== "VALID") throw new Error("INDEPENDENT_VERIFICATION_FAILED");
  if (input.grant.authorityId !== trust.assertion.authorityId) throw new Error("GRANT_AUTHORITY_MISMATCH");
  if (input.grant.actionDigest !== financialActionDigest(input.action)) throw new Error("GRANT_ACTION_MISMATCH");

  const initial = await input.rail.execute({ action: input.action, grant: input.grant, now: input.now });
  const terminal =
    initial.state === "UNKNOWN"
      ? await reconcileWithoutReexecution(input.rail, input.action.idempotencyKey, input.now)
      : initial;
  const evidenceDigest = createHash("sha256")
    .update(JSON.stringify({ originPlatform: input.originPlatform, identityProvider: input.identity.provider, verifierDomain: input.verifierDomain, rail: input.rail.railId, initial, terminal }), "utf8")
    .digest("hex");
  const proofPayload: NetworkProofPayload = {
    version: "payflow-proof/v1",
    issuer: input.issuerTrustProfile.issuer,
    keyId: "demo-proof-key",
    authorityId: trust.assertion.authorityId,
    actionId: input.action.id,
    outcome: terminal.state,
    effectCount: terminal.effectCount,
    observedAt: terminal.observedAt,
    evidenceDigest,
  };
  return {
    stages: [
      `origin:${input.originPlatform}`,
      `identity:${input.identity.provider}`,
      `authority:${trust.assertion.issuer}`,
      `verify:${input.verifierDomain}`,
      `rail:${input.rail.railId}`,
      initial.state === "UNKNOWN" ? "reconcile:lookup-only" : "reconcile:not-required",
      "proof:portable",
    ],
    initialRailEvidence: initial,
    terminalRailEvidence: terminal,
    proofPayload,
  };
}
