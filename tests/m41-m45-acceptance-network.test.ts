import { describe, expect, it } from "vitest";
import { dispositionForSignals } from "../src/network/abuse-intelligence.js";
import {
  buildEmbeddedAuthorityCandidate,
  validateEmbeddedSession,
} from "../src/network/embedded.js";
import { modelVerificationEconomics } from "../src/network/economics.js";
import { pseudonymousSubjectId } from "../src/network/privacy.js";
import { gateMarkModel } from "../packages/merchant-sdk/src/index.js";

describe("M41 Authority Mark", () => {
  it("never treats the mark itself as proof", () => {
    const supported = gateMarkModel("SUPPORTED");
    expect(supported.ariaLabel).toContain("not proof");
    const unknown = gateMarkModel("UNKNOWN");
    expect(unknown.geometry).toBe("GATE_UNRESOLVED");
  });
});

describe("M42 verification economics", () => {
  it("models cheap verification without inventing usage", () => {
    const result = modelVerificationEconomics({
      verificationCalls: 1000,
      cacheHitRateBps: 8000,
      originCostMinorPerCall: 1,
      cachedCostMinorPerCall: 0,
      governedActions: 100,
      governedActionRevenueMinor: 5,
      enterpriseBaseRevenueMinor: 0,
    });
    expect(result.originCalls).toBe(200);
    expect(result.verificationCostMinor).toBe(200);
    expect(result.contributionMinor).toBe(300);
  });
});

describe("M44 embedded Authority", () => {
  it("creates candidates but cannot skip authenticated human review", () => {
    const session = validateEmbeddedSession(
      {
        sessionId: "s1",
        organizationId: "org1",
        environment: "SANDBOX",
        principalId: "p1",
        allowedTemplateIds: ["procurement"],
        returnUrl: "https://platform.example/return",
        issuedAt: "2026-10-28T02:00:00.000Z",
        expiresAt: "2026-10-28T04:00:00.000Z",
        status: "OPEN",
      },
      "2026-10-28T03:00:00.000Z",
      "org1",
      "SANDBOX",
    );
    expect(() =>
      buildEmbeddedAuthorityCandidate(session, {
        templateId: "procurement",
        constraints: { maxAmountMinor: 1000 },
        humanReviewed: false,
      }),
    ).toThrow("EMBEDDED_HUMAN_REVIEW_REQUIRED");
  });
});

describe("M45 abuse intelligence", () => {
  it("flags and escalates without creating financial Authority", () => {
    const result = dispositionForSignals([
      { type: "REPLAY_CLUSTER", subjectId: "a1", observedAt: "2026-10-28T03:00:00.000Z", score: 40, evidenceRefs: ["e1"] },
      { type: "MERCHANT_SUBSTITUTION", subjectId: "a1", observedAt: "2026-10-28T03:00:01.000Z", score: 35, evidenceRefs: ["e2"] },
    ]);
    expect(result.disposition).toBe("ESCALATE");
    expect(result).not.toHaveProperty("decision", "ALLOW");
  });

  it("uses one-way tenant-scoped pseudonyms", () => {
    const first = pseudonymousSubjectId("org1", "user@example.com");
    expect(first).toMatch(/^psn_[a-f0-9]{64}$/);
    expect(first).not.toContain("user@example.com");
    expect(pseudonymousSubjectId("org2", "user@example.com")).not.toBe(first);
  });
});
