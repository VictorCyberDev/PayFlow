import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  portableProofPayloadBytes,
  verifyPortableProof,
} from "../packages/verifier/src/index.js";
import {
  BASE_CONFORMANCE_CASES,
  runConformanceSuite,
} from "../src/network/conformance.js";

function signedProof() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    version: "payflow-proof/v1" as const,
    issuer: "issuer-a",
    keyId: "key-1",
    authorityId: "auth-1",
    actionId: "action-1",
    outcome: "SUCCEEDED" as const,
    effectCount: 1 as const,
    observedAt: "2026-10-28T03:00:00.000Z",
    evidenceDigest: "a".repeat(64),
  };
  const signature = sign(
    null,
    portableProofPayloadBytes(payload),
    privateKey,
  ).toString("base64url");
  return {
    proof: { ...payload, signature },
    jwk: publicKey.export({ format: "jwk" }),
  };
}

describe("M47 open verifier", () => {
  it("verifies supported proof without any money-moving API", () => {
    const { proof, jwk } = signedProof();
    expect(
      verifyPortableProof(proof, jwk, "2026-10-28T03:01:00.000Z"),
    ).toMatchObject({ valid: true, reason: "PROOF_VALID" });
  });

  it("rejects tampering and inconsistent effect truth", () => {
    const { proof, jwk } = signedProof();
    expect(
      verifyPortableProof(
        { ...proof, authorityId: "attacker" },
        jwk,
        "2026-10-28T03:01:00.000Z",
      ).valid,
    ).toBe(false);
    expect(
      verifyPortableProof(
        { ...proof, effectCount: 0 },
        jwk,
        "2026-10-28T03:01:00.000Z",
      ).valid,
    ).toBe(false);
  });
});

describe("M48 conformance suite", () => {
  it("produces machine-readable results without certification language", async () => {
    const result = await runConformanceSuite(
      BASE_CONFORMANCE_CASES.map((entry) => ({ ...entry, run: () => true })),
      "2026-10-28T03:00:00.000Z",
    );
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(BASE_CONFORMANCE_CASES.length);
    expect(result.certificationClaim).toBe(false);
  });
});
