import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  portableProofPayloadBytes,
  verifyPortableProof,
} from "../packages/verifier/src/index.js";
import {
  CONSUMER_AUTHORITY_PROFILES,
  ENTERPRISE_AUTHORITY_PROFILES,
} from "../src/network/embedded-profiles.js";
import {
  externalAuthorityAssertionBytes,
} from "../src/network/federation.js";
import { FinancialActionSchema } from "../src/network/financial-action.js";
import { demonstrateGlobalFinancialAuthorityNetwork } from "../src/network/global-network.js";
import { evaluateRecourseEvidence } from "../src/network/network-rules.js";
import {
  DeterministicFakeRail,
  financialActionDigest,
} from "../src/network/rail.js";

describe("M56/M57 embedded profiles", () => {
  it("covers consumer and enterprise authority without treating templates as activation", () => {
    expect(CONSUMER_AUTHORITY_PROFILES.map((profile) => profile.id)).toEqual(
      expect.arrayContaining(["travel", "groceries", "subscriptions", "household-bills"]),
    );
    expect(ENTERPRISE_AUTHORITY_PROFILES.map((profile) => profile.id)).toEqual(
      expect.arrayContaining([
        "erp-procurement",
        "accounts-payable",
        "marketplace",
        "agent-platform",
      ]),
    );
  });
});

describe("M59 recourse evidence", () => {
  it("keeps UNKNOWN unresolved until reconciliation evidence exists", () => {
    expect(
      evaluateRecourseEvidence("UNKNOWN", {
        authorityReference: "a1",
        actionReference: "x1",
        proofReference: "p1",
      }).state,
    ).toBe("UNRESOLVED");
    expect(
      evaluateRecourseEvidence("UNKNOWN", {
        authorityReference: "a1",
        actionReference: "x1",
        proofReference: "p1",
        reconciliationEvidence: "r1",
      }).state,
    ).toBe("EVIDENCE_COMPLETE");
  });
});

describe("M60 global Financial Authority Network local demonstrator", () => {
  it("preserves one authority truth across external identity, issuer, verifier, replaceable rail, reconciliation and portable Proof", async () => {
    const action = FinancialActionSchema.parse({
      version: "financial-action/v1",
      id: "global-action-1",
      kind: "PURCHASE",
      principalId: "principal-1",
      agentId: "agent-from-platform",
      counterparty: { id: "merchant-1" },
      amount: { currency: "USD", minor: 2500 },
      purpose: "approved purchase",
      proposedAt: "2026-10-28T03:00:00.000Z",
      idempotencyKey: "global-network-idempotency-0001",
    });
    const rail = new DeterministicFakeRail("replaceable-rail-b", "TIMEOUT_AFTER_EFFECT");
    const grant = {
      grantId: "global-grant-1",
      authorityId: "external-authority-1",
      actionDigest: financialActionDigest(action),
      idempotencyKey: action.idempotencyKey,
      expiresAt: "2026-10-28T03:10:00.000Z",
    };
    const issuerKeys = generateKeyPairSync("ed25519");
    const issuerPayload = {
      schemaVersion: "financial-authority/v1",
      issuer: "https://issuer.example",
      authorityId: grant.authorityId,
      principalId: action.principalId,
      agentId: action.agentId,
      actionKinds: ["PURCHASE"],
      currencies: ["USD"],
      maxAmountMinor: 5000,
      delegationDepth: 0,
      audience: "merchant.example",
      issuedAt: "2026-10-28T02:55:00.000Z",
      expiresAt: "2026-10-28T04:00:00.000Z",
    };
    const issuerSignature = sign(
      null,
      externalAuthorityAssertionBytes(issuerPayload),
      issuerKeys.privateKey,
    ).toString("base64url");
    const result = await demonstrateGlobalFinancialAuthorityNetwork({
      originPlatform: "assistant-platform.example",
      identity: {
        provider: "identity.example",
        subject: "subject-1",
        agentId: action.agentId,
        audience: "merchant.example",
        authenticatedAt: "2026-10-28T02:59:00.000Z",
      },
      issuerAssertion: {
        payload: issuerPayload,
        keyId: "issuer-key-1",
        signature: issuerSignature,
      },
      issuerPublicJwk: issuerKeys.publicKey.export({ format: "jwk" }),
      issuerTrustProfile: {
        issuer: "https://issuer.example",
        status: "TRUSTED",
        acceptedSchemaVersions: ["financial-authority/v1"],
        maxDelegationDepth: 1,
        allowedActionKinds: ["PURCHASE"],
        allowedCurrencies: ["USD"],
        maxAmountMinor: 5000,
        updatedAt: "2026-10-28T02:50:00.000Z",
      },
      verifier: {
        domain: "merchant.example",
        verdict: "VALID",
        challenge: "merchant-challenge-0001",
        verifiedAt: "2026-10-28T02:59:30.000Z",
        cryptographicallyVerified: true,
      },
      action,
      grant,
      rail,
      proofIssuer: "https://proof.payflow.example",
      proofKeyId: "demo-proof-key",
      now: "2026-10-28T03:00:00.000Z",
    });
    expect(result.initialRailEvidence.state).toBe("UNKNOWN");
    expect(result.terminalRailEvidence.state).toBe("SUCCEEDED");
    expect(result.terminalRailEvidence.effectCount).toBe(1);
    expect(result.stages).toContain("reconcile:lookup-only");

    const proofKeys = generateKeyPairSync("ed25519");
    const signature = sign(
      null,
      portableProofPayloadBytes(result.proofPayload),
      proofKeys.privateKey,
    ).toString("base64url");
    const proof = { ...result.proofPayload, signature };
    expect(
      verifyPortableProof(
        proof,
        proofKeys.publicKey.export({ format: "jwk" }),
        "2026-10-28T03:01:00.000Z",
      ),
    ).toMatchObject({ valid: true, reason: "PROOF_VALID" });
  });
});
