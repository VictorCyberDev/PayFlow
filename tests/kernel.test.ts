import { describe, expect, it } from "vitest";
import { mandateFingerprint } from "../src/canonical.js";
import type {
  AgentPassport,
  Mandate,
  MerchantRisk,
  TransactionProposal,
} from "../src/domain.js";
import { authorize } from "../src/kernel.js";

const now = "2026-10-09T12:00:00.000Z";
const mandate: Mandate = {
  id: "m1",
  principalId: "p1",
  authorizedAgentId: "a1",
  purpose: "keyboard",
  category: "KEYBOARD",
  currency: "USD",
  maxSingleTransactionMinor: 10000,
  cumulativeLimitMinor: 15000,
  allowedConditions: ["NEW"],
  merchantRiskCeiling: "MEDIUM",
  autonomousPurchaseThresholdMinor: 7500,
  humanApprovalThresholdMinor: 10000,
  allowedCapabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
  version: 1,
  nonce: "mandate-nonce-0001",
};
const agent: AgentPassport = {
  id: "a1",
  principalId: "p1",
  displayName: "A",
  issuedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
  status: "ACTIVE",
  capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
};
const fp = mandateFingerprint(mandate);
const proposal = (
  patch: Partial<TransactionProposal> = {},
): TransactionProposal => ({
  id: "tx1",
  agentId: "a1",
  mandateId: "m1",
  mandateFingerprint: fp,
  amount: { currency: "USD", minor: 7000 },
  merchant: { id: "shop", displayName: "Shop" },
  category: "KEYBOARD",
  condition: "NEW",
  requestedCapability: "CREATE_ORDER",
  proposedAt: now,
  nonce: "proposal-nonce-0001",
  metadata: {},
  ...patch,
});
const auth = (
  m: unknown = mandate,
  a: unknown = agent,
  p: unknown = proposal(),
  risk: MerchantRisk = "LOW",
  spent = 0,
  replay = false,
) =>
  authorize(m, a, p, {
    now,
    merchantRisk: risk,
    cumulativeSpentMinor: spent,
    replaySeen: replay,
  });

describe("deterministic authorization kernel", () => {
  it("valid purchase ALLOWs", () => expect(auth().decision).toBe("ALLOW"));
  it("hard maximum DENYs", () =>
    expect(
      auth(
        mandate,
        agent,
        proposal({ amount: { currency: "USD", minor: 10001 } }),
      ).reasonCodes,
    ).toContain("AMOUNT_EXCEEDS_LIMIT"));
  it("above autonomous threshold ESCALATEs", () =>
    expect(
      auth(
        mandate,
        agent,
        proposal({ amount: { currency: "USD", minor: 8000 } }),
      ).decision,
    ).toBe("ESCALATE"));
  it("wrong currency DENYs", () =>
    expect(
      auth(
        mandate,
        agent,
        proposal({ amount: { currency: "EUR", minor: 7000 } }),
      ).reasonCodes,
    ).toContain("CURRENCY_MISMATCH"));
  it("wrong category DENYs", () =>
    expect(
      auth(mandate, agent, proposal({ category: "LAPTOP" })).reasonCodes,
    ).toContain("CATEGORY_DENIED"));
  it("refurbished item DENYs", () =>
    expect(
      auth(mandate, agent, proposal({ condition: "REFURBISHED" })).reasonCodes,
    ).toContain("CONDITION_DENIED"));
  it("high-risk merchant DENYs", () =>
    expect(auth(mandate, agent, proposal(), "EXCESSIVE").reasonCodes).toContain(
      "MERCHANT_RISK_TOO_HIGH",
    ));
  it("unauthorized agent DENYs", () =>
    expect(
      auth(mandate, { ...agent, id: "evil" }, proposal({ agentId: "evil" }))
        .reasonCodes,
    ).toContain("AGENT_UNAUTHORIZED"));
  it("suspended agent DENYs", () =>
    expect(
      auth(mandate, { ...agent, status: "SUSPENDED" }, proposal()).reasonCodes,
    ).toContain("AGENT_SUSPENDED"));
  it("expired agent DENYs", () =>
    expect(
      auth(
        mandate,
        { ...agent, expiresAt: "2026-10-01T00:00:00.000Z" },
        proposal(),
      ).reasonCodes,
    ).toContain("AGENT_EXPIRED"));
  it("expired mandate DENYs", () =>
    expect(
      auth(
        { ...mandate, expiresAt: "2026-10-01T00:00:00.000Z" },
        agent,
        proposal(),
      ),
    ).toMatchObject({ decision: "DENY" }));
  it("missing capability DENYs", () =>
    expect(
      auth(
        { ...mandate, allowedCapabilities: ["CAPTURE_PAYMENT"] },
        agent,
        proposal(),
      ).reasonCodes,
    ).toContain("CAPABILITY_DENIED"));
  it("amount mutation is detected by fingerprint", () =>
    expect(
      auth({ ...mandate, maxSingleTransactionMinor: 12000 }, agent, proposal())
        .reasonCodes,
    ).toContain("MANDATE_INTEGRITY_FAILURE"));
  it("capability mutation is detected by fingerprint", () =>
    expect(
      auth(
        { ...mandate, allowedCapabilities: ["CREATE_ORDER"] },
        agent,
        proposal(),
      ).reasonCodes,
    ).toContain("MANDATE_INTEGRITY_FAILURE"));
  it("malformed critical input fails closed", () =>
    expect(
      auth({ ...mandate, currency: "usd" }, agent, proposal()).reasonCodes,
    ).toEqual(["MALFORMED_INPUT"]));
  it("replay DENYs", () =>
    expect(
      auth(mandate, agent, proposal(), "LOW", 0, true).reasonCodes,
    ).toContain("REPLAY_DETECTED"));
  it("cumulative overspend DENYs", () =>
    expect(auth(mandate, agent, proposal(), "LOW", 9000).reasonCodes).toContain(
      "CUMULATIVE_LIMIT_EXCEEDED",
    ));
});

describe("fingerprint security fields", () => {
  for (const [name, changed] of [
    ["amount", { ...mandate, maxSingleTransactionMinor: 9999 }],
    ["currency", { ...mandate, currency: "EUR" }],
    ["category", { ...mandate, category: "MOUSE" }],
    ["agent", { ...mandate, authorizedAgentId: "a2" }],
    ["expiration", { ...mandate, expiresAt: "2026-12-01T00:00:00.000Z" }],
    ["capability", { ...mandate, allowedCapabilities: ["CREATE_ORDER"] }],
  ] as const)
    it(`${name} changes fingerprint`, () =>
      expect(mandateFingerprint(changed)).not.toBe(fp));
});
