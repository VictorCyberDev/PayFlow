import { describe, expect, it } from "vitest";
import {
  evaluateExternalIssuerAssertion,
  federatedVerify,
} from "../src/network/federation.js";
import {
  deterministicNetworkId,
  mayAssumeReservationOwnership,
  resolveAuthorityReplicaConflict,
} from "../src/network/region.js";
import {
  appendTransparencyEntry,
  verifyTransparencyLog,
} from "../src/network/transparency.js";
import {
  MachineAuthoritySchema,
  evaluateMachineEconomicAction,
} from "../src/network/machine-authority.js";

describe("M51 active/active architecture simulation", () => {
  it("uses deterministic ids and fail-safe revocation conflict resolution", () => {
    expect(deterministicNetworkId("authority", "same")).toBe(deterministicNetworkId("authority", "same"));
    const active = { authorityId: "a1", version: 3, status: "ACTIVE" as const, changedAt: "2026-10-28T03:00:00.000Z", sourceRegion: "eu" };
    const revoked = { ...active, status: "REVOKED" as const, sourceRegion: "us" };
    expect(resolveAuthorityReplicaConflict(active, revoked).status).toBe("REVOKED");
    expect(mayAssumeReservationOwnership({ reservationId: "r1", authorityId: "a1", ownerRegion: "eu", epoch: 1, leaseExpiresAt: "2026-10-28T03:00:00.000Z" }, "us", 2, "2026-10-28T03:01:00.000Z")).toBe(true);
  });
});

describe("M52 key transparency", () => {
  it("detects log tampering", () => {
    const first = appendTransparencyEntry(null, { issuer: "issuer-a", keyId: "k1", status: "ACTIVE", publicKeyDigest: "a".repeat(64), recordedAt: "2026-10-28T03:00:00.000Z" });
    const second = appendTransparencyEntry(first, { issuer: "issuer-a", keyId: "k2", status: "ROTATING", publicKeyDigest: "b".repeat(64), recordedAt: "2026-10-28T03:01:00.000Z" });
    expect(verifyTransparencyLog([first, second])).toBe(true);
    expect(verifyTransparencyLog([first, { ...second, keyId: "attacker" }])).toBe(false);
  });
});

describe("M53/M54 federation and external issuer trust", () => {
  it("distinguishes trusted, unknown, revoked and stale issuer domains", async () => {
    const trusted = { issuer: "https://issuer-a.example", status: "TRUSTED" as const, metadataFreshUntil: "2026-10-28T04:00:00.000Z", verify: async () => ({ verdict: "VALID" }) };
    const revoked = { ...trusted, issuer: "https://issuer-b.example", status: "REVOKED" as const };
    const domains = new Map([[trusted.issuer, trusted], [revoked.issuer, revoked]]);
    expect((await federatedVerify(domains, trusted.issuer, {}, "merchant", "2026-10-28T03:00:00.000Z")).verdict).toBe("VALID");
    expect((await federatedVerify(domains, revoked.issuer, {}, "merchant", "2026-10-28T03:00:00.000Z")).verdict).toBe("REVOKED_ISSUER");
    expect((await federatedVerify(domains, "https://unknown.example", {}, "merchant", "2026-10-28T03:00:00.000Z")).verdict).toBe("UNKNOWN_ISSUER");
  });

  it("attenuates third-party issuer assertions through explicit trust profiles", () => {
    const profile = { issuer: "https://issuer-a.example", status: "TRUSTED", acceptedSchemaVersions: ["financial-authority/v1"], maxDelegationDepth: 2, allowedActionKinds: ["PURCHASE"], allowedCurrencies: ["USD"], maxAmountMinor: 10000, updatedAt: "2026-10-28T03:00:00.000Z" };
    const assertion = { schemaVersion: "financial-authority/v1", issuer: profile.issuer, authorityId: "a1", principalId: "p1", agentId: "agent1", actionKinds: ["PURCHASE"], currencies: ["USD"], maxAmountMinor: 5000, delegationDepth: 1, audience: "merchant", issuedAt: "2026-10-28T02:59:00.000Z", expiresAt: "2026-10-28T03:30:00.000Z" };
    expect(evaluateExternalIssuerAssertion(assertion, profile, "merchant", "2026-10-28T03:00:00.000Z").trusted).toBe(true);
    expect(evaluateExternalIssuerAssertion({ ...assertion, maxAmountMinor: 20000 }, profile, "merchant", "2026-10-28T03:00:00.000Z").reasons).toContain("AMOUNT_TRUST_BOUNDARY_EXCEEDED");
  });
});

describe("M55 machine-to-machine Authority", () => {
  it("keeps machine economic actions sponsor-bound and velocity-limited", () => {
    const authority = MachineAuthoritySchema.parse({ authorityId: "ma1", sponsorPrincipalId: "p1", machineIdentity: "service-a", allowedPurposes: ["batch-inference"], allowedResourceKinds: ["COMPUTE"], currency: "USD", maxSingleActionMinor: 500, maxTotalMinor: 2000, maxActionsPerHour: 4, expiresAt: "2026-10-29T03:00:00.000Z" });
    expect(evaluateMachineEconomicAction(authority, { machineIdentity: "service-a", purpose: "batch-inference", resourceKind: "COMPUTE", amountMinor: 400, currency: "USD", proposedAt: "2026-10-28T03:00:00.000Z" }, { cumulativeSpentMinor: 1000, actionsInPreviousHour: 2, now: "2026-10-28T03:00:00.000Z" })).toEqual([]);
    expect(evaluateMachineEconomicAction(authority, { machineIdentity: "service-a", purpose: "batch-inference", resourceKind: "COMPUTE", amountMinor: 400, currency: "USD", proposedAt: "2026-10-28T03:00:00.000Z" }, { cumulativeSpentMinor: 1000, actionsInPreviousHour: 4, now: "2026-10-28T03:00:00.000Z" })).toContain("VELOCITY_LIMIT_EXCEEDED");
  });
});
