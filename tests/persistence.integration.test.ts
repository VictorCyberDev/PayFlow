import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mandateFingerprint } from "../src/canonical.js";
import type {
  AgentPassport,
  DecisionReceipt,
  Mandate,
  Principal,
  TransactionProposal,
} from "../src/domain.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
run("PostgreSQL durable foundation", () => {
  let repo: PostgresTrustRepository;
  const principal: Principal = { id: "p1", displayName: "Principal" };
  const agent: AgentPassport = {
    id: "a1",
    principalId: "p1",
    displayName: "Agent",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    status: "ACTIVE",
    capabilities: ["CREATE_ORDER"],
  };
  const mandate: Mandate = {
    id: "m1",
    principalId: "p1",
    authorizedAgentId: "a1",
    purpose: "keyboard",
    category: "KEYBOARD",
    currency: "USD",
    maxSingleTransactionMinor: 10000,
    cumulativeLimitMinor: 10000,
    allowedConditions: ["NEW"],
    merchantRiskCeiling: "MEDIUM",
    autonomousPurchaseThresholdMinor: 7500,
    humanApprovalThresholdMinor: 10000,
    allowedCapabilities: ["CREATE_ORDER"],
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    version: 1,
    nonce: "mandate-nonce-0001",
  };
  const proposal: TransactionProposal = {
    id: "tx1",
    agentId: "a1",
    mandateId: "m1",
    mandateFingerprint: mandateFingerprint(mandate),
    amount: { currency: "USD", minor: 7000 },
    merchant: { id: "shop", displayName: "Shop" },
    category: "KEYBOARD",
    condition: "NEW",
    requestedCapability: "CREATE_ORDER",
    proposedAt: "2026-10-09T12:00:00.000Z",
    nonce: "proposal-nonce-0001",
    metadata: {},
  };
  const receipt: DecisionReceipt = {
    receiptId: "r1",
    decision: "ALLOW",
    reasonCodes: ["ALLOWED"],
    mandateId: "m1",
    mandateFingerprint: mandateFingerprint(mandate),
    agentId: "a1",
    proposalId: "tx1",
    amount: { currency: "USD", minor: 7000 },
    checks: { mandate: "PASS" },
    evaluatedAt: "2026-10-09T12:00:01.000Z",
    authorizationEngineVersion: "1",
  };
  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    const migration = await readFile(
      "db/migrations/001_milestone_2a_durable_foundation.sql",
      "utf8",
    );
    await repo.migrate(migration);
    await repo.migrate(
      await readFile(
        "db/migrations/004_milestone_2e_security_boundary.sql",
        "utf8",
      ),
    );
  });
  afterAll(async () => repo.close());
  beforeEach(async () => {
    await repo.sql`truncate evidence_events,payment_attempts,authorization_reservations,approvals,decision_receipts,transaction_proposals,replay_keys,mandates,agent_passports,principals restart identity cascade`;
    await repo.savePrincipal(principal);
    await repo.saveAgent(agent);
    await repo.saveMandate(mandate);
  });
  it("persists and validates agent passports and mandates", async () => {
    expect(await repo.getAgent("a1")).toEqual(agent);
    expect(await repo.getMandate("m1")).toEqual(mandate);
  });
  it("persists proposals and receipts", async () => {
    await repo.saveProposal(proposal);
    await repo.saveReceipt(receipt);
    expect(await repo.getProposal("tx1")).toEqual(proposal);
    expect(await repo.getReceipt("r1")).toMatchObject({
      receiptId: "r1",
      decision: "ALLOW",
    });
  });
  it("rejects duplicate proposal IDs and nonces", async () => {
    await repo.saveProposal(proposal);
    await expect(repo.saveProposal(proposal)).rejects.toThrow();
    await expect(
      repo.saveProposal({ ...proposal, id: "tx2" }),
    ).rejects.toThrow();
  });
  it("durably rejects replay keys", async () => {
    expect(await repo.claimReplay("m1", "nonce-x")).toBe(true);
    expect(await repo.claimReplay("m1", "nonce-x")).toBe(false);
  });
  it("binds approvals to the mandate principal", async () => {
    await repo.saveProposal(proposal);
    await repo.saveReceipt(receipt);
    await expect(
      repo.saveApproval({
        id: "ap1",
        receiptId: "r1",
        proposalId: "tx1",
        principalId: "evil",
        status: "APPROVED",
        approvedAt: "2026-10-09T12:01:00.000Z",
      }),
    ).rejects.toThrow("APPROVAL_BINDING_MISMATCH");
    await expect(
      repo.saveApproval({
        id: "ap2",
        receiptId: "r1",
        proposalId: "tx1",
        principalId: "p1",
        status: "APPROVED",
        approvedAt: "2026-10-09T12:01:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
  it("enforces reservation lifecycle", async () => {
    await repo.saveProposal(proposal);
    await repo.saveReceipt(receipt);
    await repo.createReservation({
      id: "res1",
      mandateId: "m1",
      proposalId: "tx1",
      receiptId: "r1",
      amountMinor: 7000,
      currency: "USD",
      status: "PENDING",
      expiresAt: "2026-10-09T13:00:00.000Z",
    });
    await repo.transitionReservation("res1", "AUTHORIZED");
    await repo.transitionReservation("res1", "EXECUTING");
    await repo.transitionReservation("res1", "COMMITTED");
    await expect(
      repo.transitionReservation("res1", "RELEASED"),
    ).rejects.toThrow("INVALID_RESERVATION_TRANSITION");
  });
  it("persists evidence across repository recreation and verifies chain", async () => {
    await repo.appendEvidence("A", { x: 1 }, "2026-10-09T12:00:00.000Z");
    await repo.appendEvidence("B", { x: 2 }, "2026-10-09T12:00:01.000Z");
    const second = PostgresTrustRepository.connect(url!);
    const entries = await second.evidence();
    await second.close();
    expect(PostgresTrustRepository.verifyEvidence(entries)).toBe(true);
    const tampered = entries.map((e, i) =>
      i === 0 ? { ...e, data: { x: 99 } } : e,
    );
    expect(PostgresTrustRepository.verifyEvidence(tampered)).toBe(false);
    expect(PostgresTrustRepository.verifyEvidence([...entries].reverse())).toBe(
      false,
    );
  });
  it("fails closed on malformed persisted critical data", async () => {
    await repo.sql`update mandates set document=jsonb_set(document,'{currency}','\"usd\"'::jsonb) where id='m1'`;
    await expect(repo.getMandate("m1")).rejects.toThrow();
  });
});
