import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  HumanConfirmationBoundary,
  reviewHash,
} from "../src/intent-activation.js";
import { mandateFingerprint, proposalDigest } from "../src/canonical.js";
import { authorize } from "../src/kernel.js";
import type {
  Mandate,
  AgentPassport,
  TransactionProposal,
} from "../src/domain.js";
const now = new Date("2026-10-10T00:00:00.000Z");
const binding = {
  action: "CONFIRM_EXACT_TERMS" as const,
  agentId: "a",
  reviewId: "r",
  draftFingerprint: "a".repeat(64),
  reviewedHash: "b".repeat(64),
  challengeHash: "c".repeat(64),
};
function boundary(
  identity: unknown = {
    principalId: "p",
    actor: "HUMAN",
    authenticatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
  },
) {
  return new HumanConfirmationBoundary(
    {
      verify: async (proof, b) => {
        await Promise.resolve();
        expect(proof).toBe("external-proof");
        expect(b).toEqual(binding);
        return identity;
      },
    },
    () => now,
  );
}
const mandate: Mandate = {
  id: "m",
  principalId: "p",
  authorizedAgentId: "a",
  purpose: "keyboard",
  category: "KEYBOARD",
  currency: "USD",
  maxSingleTransactionMinor: 10000,
  cumulativeLimitMinor: 10000,
  allowedConditions: ["NEW"],
  merchantRiskCeiling: "LOW",
  autonomousPurchaseThresholdMinor: 10000,
  humanApprovalThresholdMinor: 10000,
  allowedCapabilities: ["CREATE_ORDER"],
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
  version: 1,
  nonce: "mandate-nonce-0001",
  quantityLimit: 1,
  merchantScope: { mode: "ONLY", ids: ["Amazon"] },
};
const agent: AgentPassport = {
  id: "a",
  principalId: "p",
  displayName: "Agent",
  issuedAt: mandate.createdAt,
  expiresAt: mandate.expiresAt,
  status: "ACTIVE",
  capabilities: ["CREATE_ORDER"],
};
function proposal(m = mandate): TransactionProposal {
  return {
    id: "tx",
    agentId: "a",
    mandateId: "m",
    mandateFingerprint: mandateFingerprint(m),
    amount: { minor: 100, currency: "USD" },
    merchant: { id: "Amazon", displayName: "Amazon" },
    category: "KEYBOARD",
    condition: "NEW",
    requestedCapability: "CREATE_ORDER",
    proposedAt: now.toISOString(),
    nonce: "proposal-nonce-0001",
    metadata: {},
    quantity: 1,
  };
}
function decision(p = proposal(), m = mandate, consumedQuantity = 0) {
  return authorize(m, agent, p, {
    now: now.toISOString(),
    merchantRisk: "LOW",
    cumulativeSpentMinor: 0,
    consumedQuantity,
    replaySeen: false,
  });
}
describe("3C authentication and deterministic commerce boundary", () => {
  it("accepts only a context sealed by the configured boundary", async () => {
    const b = boundary();
    const c = await b.authenticate("external-proof", binding);
    expect(b.require(c, binding).identity.principalId).toBe("p");
    for (const fake of [
      { principalId: "p", confirmed: true },
      { ...c },
      JSON.parse(JSON.stringify(c)),
      null,
    ])
      expect(() => b.require(fake, binding)).toThrow("AUTHENTICATION_REQUIRED");
    expect(() => boundary().require(c, binding)).toThrow(
      "AUTHENTICATION_REQUIRED",
    );
  });
  it.each([
    "agentId",
    "reviewId",
    "draftFingerprint",
    "reviewedHash",
    "challengeHash",
  ])("binds authenticated action to %s", async (field) => {
    const b = boundary(),
      c = await b.authenticate("external-proof", binding);
    expect(() => b.require(c, { ...binding, [field]: "different" })).toThrow(
      "AUTHENTICATION_REQUIRED",
    );
  });
  it.each([
    { actor: "AGENT" },
    { principalId: "" },
    { expiresAt: now.toISOString() },
    { authenticatedAt: "2026-10-11T00:00:00.000Z" },
    { expiresAt: "2026-10-11T00:00:00.000Z" },
    { confirmed: true },
  ])("rejects malformed/stale authenticator result %j", async (patch) => {
    const b = boundary({
      principalId: "p",
      actor: "HUMAN",
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300000).toISOString(),
      ...patch,
    });
    await expect(b.authenticate("external-proof", binding)).rejects.toThrow();
  });
  it("canonical hashes bind values and ignore property insertion order", () => {
    expect(reviewHash({ a: 1, b: 2 })).toBe(reviewHash({ b: 2, a: 1 }));
    expect(reviewHash({ a: 1, b: 2 })).not.toBe(reviewHash({ a: 2, b: 2 }));
  });
  it("allows exactly bounded quantity and merchant", () =>
    expect(decision().decision).toBe("ALLOW"));
  it.each([2, undefined])("denies excess or missing quantity %s", (quantity) =>
    expect(decision({ ...proposal(), quantity }).reasonCodes).toContain(
      "QUANTITY_EXHAUSTED",
    ),
  );
  it("denies exhausted quantity despite remaining money", () =>
    expect(decision(proposal(), mandate, 1).reasonCodes).toContain(
      "QUANTITY_EXHAUSTED",
    ));
  it.each(["amazon", "eBay", ""])("denies substituted merchant %s", (id) =>
    expect(
      decision({ ...proposal(), merchant: { id, displayName: "Amazon" } })
        .decision,
    ).toBe("DENY"),
  );
  it("supports ANY and multiple exact merchant identifiers", () => {
    for (const scope of [
      { mode: "ANY" as const },
      { mode: "ONLY" as const, ids: ["Amazon", "eBay"] },
    ]) {
      const m = { ...mandate, merchantScope: scope };
      expect(
        decision(
          { ...proposal(m), merchant: { id: "eBay", displayName: "Other" } },
          m,
        ).decision,
      ).toBe("ALLOW");
    }
  });
  it("binds quantity and merchant changes cryptographically", () => {
    expect(mandateFingerprint({ ...mandate, quantityLimit: 2 })).not.toBe(
      mandateFingerprint(mandate),
    );
    expect(
      mandateFingerprint({ ...mandate, merchantScope: { mode: "ANY" } }),
    ).not.toBe(mandateFingerprint(mandate));
    expect(proposalDigest({ ...proposal(), quantity: 2 })).not.toBe(
      proposalDigest(proposal()),
    );
  });
  it("model transitive imports cannot reach authentication, activation, accounting, grants or PayPal", async () => {
    const allowed = new Set([
        "intent-model",
        "intent-model-schema",
        "intent-semantics",
        "intent-json",
        "intent",
        "domain",
      ]),
      visited = new Set<string>(),
      queue = ["intent-model"];
    while (queue.length) {
      const name = queue.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      expect(allowed.has(name)).toBe(true);
      const text = await readFile(`src/${name}.ts`, "utf8");
      for (const match of text.matchAll(/from\s+["']\.\/([^"']+)\.js["']/g))
        queue.push(match[1]!);
    }
    for (const forbidden of [
      "intent-activation",
      "persistence",
      "execution-grant",
      "paypal",
      "durable-service",
    ])
      expect(visited.has(forbidden)).toBe(false);
  });
  it("authenticated identity cannot be mutated after verification", async () => {
    const b = boundary(),
      c = await b.authenticate("external-proof", binding);
    const identity = b.require(c, binding).identity;
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() =>
      Object.assign(identity, { principalId: "attacker" }),
    ).toThrow();
    expect(b.require(c, binding).identity.principalId).toBe("p");
  });
});
