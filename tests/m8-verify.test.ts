import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mandateFingerprint } from "../src/canonical.js";
import type { Mandate } from "../src/domain.js";
import {
  signAuthorityPresentation,
  verifyAuthorityPresentation,
} from "../src/network/verify.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = "2026-10-28T03:00:00.000Z";
const mandate: Mandate = {
  id: "authority-verify-1",
  principalId: "principal-1",
  authorizedAgentId: "agent-1",
  purpose: "verify bounded purchase authority",
  category: "PROCUREMENT",
  currency: "USD",
  maxSingleTransactionMinor: 20_000,
  allowedConditions: ["NEW"],
  merchantRiskCeiling: "MEDIUM",
  autonomousPurchaseThresholdMinor: 10_000,
  humanApprovalThresholdMinor: 20_000,
  allowedCapabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
  expiresAt: "2026-10-29T03:00:00.000Z",
  createdAt: "2026-10-28T02:00:00.000Z",
  version: 1,
  nonce: "authority-nonce-0001",
};

function signed(overrides: Record<string, unknown> = {}) {
  const payload = {
    version: "payflow-authority-presentation/v1" as const,
    issuer: "https://issuer.example",
    keyId: "key-1",
    authorityId: mandate.id,
    authorityFingerprint: mandateFingerprint(mandate),
    principalId: mandate.principalId,
    agentId: mandate.authorizedAgentId,
    audience: "merchant.example",
    challenge: "challenge-merchant-0001",
    nonce: "presentation-nonce-0001",
    issuedAt: "2026-10-28T02:59:00.000Z",
    expiresAt: "2026-10-28T03:05:00.000Z",
    ...overrides,
  };
  return signAuthorityPresentation(payload, privateKey);
}

function deps(state: "ACTIVE" | "SUSPENDED" | "REVOKED" = "ACTIVE") {
  const used = new Set<string>();
  return {
    resolvePublicKey: async () => publicKey,
    loadAuthority: async () => ({ mandate, state }),
    claimPresentationReplayKey: async (scope: string, key: string) => {
      const composite = `${scope}:${key}`;
      if (used.has(composite)) return false;
      used.add(composite);
      return true;
    },
  };
}

describe("M8 read-only Authority verification", () => {
  it("accepts a valid audience- and challenge-bound presentation", async () => {
    const result = await verifyAuthorityPresentation(
      signed(),
      {
        audience: "merchant.example",
        challenge: "challenge-merchant-0001",
        now,
      },
      deps(),
    );
    expect(result.verdict).toBe("VALID");
  });

  it("distinguishes wrong audience and revoked Authority", async () => {
    const wrongAudience = await verifyAuthorityPresentation(
      signed(),
      { audience: "other.example", challenge: "challenge-merchant-0001", now },
      deps(),
    );
    expect(wrongAudience.verdict).toBe("WRONG_AUDIENCE");

    const revoked = await verifyAuthorityPresentation(
      signed(),
      { audience: "merchant.example", challenge: "challenge-merchant-0001", now },
      deps("REVOKED"),
    );
    expect(revoked.verdict).toBe("REVOKED");
  });

  it("detects signature tampering", async () => {
    const presentation = signed();
    const tampered = {
      ...presentation,
      payload: { ...presentation.payload, agentId: "agent-attacker" },
    };
    const result = await verifyAuthorityPresentation(
      tampered,
      { audience: "merchant.example", challenge: "challenge-merchant-0001", now },
      deps(),
    );
    expect(result.verdict).toBe("TAMPERED");
  });

  it("detects expiry and replay independently", async () => {
    const expired = await verifyAuthorityPresentation(
      signed({ expiresAt: "2026-10-28T02:59:59.000Z" }),
      { audience: "merchant.example", challenge: "challenge-merchant-0001", now },
      deps(),
    );
    expect(expired.verdict).toBe("EXPIRED");

    const sharedDeps = deps();
    const presentation = signed();
    const first = await verifyAuthorityPresentation(
      presentation,
      { audience: "merchant.example", challenge: "challenge-merchant-0001", now },
      sharedDeps,
    );
    const replay = await verifyAuthorityPresentation(
      presentation,
      { audience: "merchant.example", challenge: "challenge-merchant-0001", now },
      sharedDeps,
    );
    expect(first.verdict).toBe("VALID");
    expect(replay.verdict).toBe("REPLAYED");
  });
});
