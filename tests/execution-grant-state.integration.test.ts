import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mandateFingerprint } from "../src/canonical.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  FakeExecutionSink,
  StaticPublicKeyRing,
} from "../src/execution-grant.js";
import type {
  AgentPassport,
  Mandate,
  Principal,
  TransactionProposal,
} from "../src/domain.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("Milestone 2C state-change edge cases", () => {
  let repo: PostgresTrustRepository;
  let auth: DurableAuthorizationService;
  let issuer: ExecutionGrantIssuer;
  let sink: FakeExecutionSink;
  let boundary: ExecutionBoundary;
  const now = "2026-10-09T12:00:00.000Z";
  const later = "2026-10-09T12:00:30.000Z";
  const keys = generateKeyPairSync("ed25519");
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
    autonomousPurchaseThresholdMinor: 10000,
    humanApprovalThresholdMinor: 10000,
    allowedCapabilities: ["CREATE_ORDER"],
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    version: 1,
    nonce: "mandate-nonce-0001",
  };
  function proposal(id: string, m = mandate): TransactionProposal {
    return {
      id,
      agentId: "a1",
      mandateId: m.id,
      mandateFingerprint: mandateFingerprint(m),
      amount: { currency: "USD", minor: 8900 },
      merchant: { id: "merchant-A", displayName: "Merchant A" },
      category: "KEYBOARD",
      condition: "NEW",
      requestedCapability: "CREATE_ORDER",
      proposedAt: now,
      nonce: `proposal-nonce-${id.padEnd(8, "0")}`,
      metadata: {},
    };
  }
  async function allowToken(
    id: string,
  ): Promise<{ token: string; reservationId: string }> {
    await repo.saveProposal(proposal(id));
    const result = await auth.authorizeProposal(id, "LOW", now);
    return {
      token: await issuer.issue(result.reservation!.id, now),
      reservationId: result.reservation!.id,
    };
  }

  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    await repo.migrate(
      await readFile(
        "db/migrations/001_milestone_2a_durable_foundation.sql",
        "utf8",
      ),
    );
    await repo.migrate(
      await readFile(
        "db/migrations/002_milestone_2c_execution_grants.sql",
        "utf8",
      ),
    );
  });
  afterAll(async () => repo.close());
  beforeEach(async () => {
    await repo.sql`truncate execution_grants,evidence_events,payment_attempts,authorization_reservations,approvals,decision_receipts,transaction_proposals,replay_keys,mandates,agent_passports,principals restart identity cascade`;
    await repo.savePrincipal(principal);
    await repo.saveAgent(agent);
    await repo.saveMandate(mandate);
    auth = new DurableAuthorizationService(repo, 60_000);
    issuer = new ExecutionGrantIssuer(repo, "test-key-1", keys.privateKey);
    sink = new FakeExecutionSink();
    boundary = new ExecutionBoundary(
      repo,
      new StaticPublicKeyRing(new Map([["test-key-1", keys.publicKey]])),
      sink,
    );
  });

  it("rejects a validly changed mandate document/fingerprint after grant issuance", async () => {
    const { token } = await allowToken("changed-mandate");
    const changed = { ...mandate, purpose: "different authorized purpose" };
    await repo.sql`update mandates set document=${repo.sql.json(changed)},fingerprint=${mandateFingerprint(changed)} where id='m1'`;
    await expect(boundary.execute(token, later)).rejects.toThrow(
      "EXECUTION_DIGEST_MISMATCH",
    );
    expect(sink.calls).toBe(0);
  });

  it.each(["REVOKED", "EXPIRED"] as const)(
    "rejects %s escalation approval after grant issuance",
    async (status) => {
      const escalating = {
        ...mandate,
        id: "m2",
        autonomousPurchaseThresholdMinor: 7500,
        nonce: "mandate-nonce-0002",
      } satisfies Mandate;
      await repo.saveMandate(escalating);
      const p = proposal(`approval-${status}`, escalating);
      await repo.saveProposal(p);
      const decision = await auth.authorizeProposal(p.id, "LOW", now);
      const approved = await auth.approveEscalation(
        decision.receipt.receiptId,
        "p1",
        now,
      );
      const token = await issuer.issue(approved.reservation.id, now);
      await repo.sql`update approvals set status=${status} where receipt_id=${decision.receipt.receiptId}`;
      await expect(boundary.execute(token, later)).rejects.toThrow(
        "VALID_APPROVAL_REQUIRED",
      );
      expect(sink.calls).toBe(0);
    },
  );

  it("rejects an approval rebound to a different principal", async () => {
    const escalating = {
      ...mandate,
      id: "m2",
      autonomousPurchaseThresholdMinor: 7500,
      nonce: "mandate-nonce-0002",
    } satisfies Mandate;
    await repo.saveMandate(escalating);
    const p = proposal("wrong-approval", escalating);
    await repo.saveProposal(p);
    const decision = await auth.authorizeProposal(p.id, "LOW", now);
    const approved = await auth.approveEscalation(
      decision.receipt.receiptId,
      "p1",
      now,
    );
    const token = await issuer.issue(approved.reservation.id, now);
    await repo.savePrincipal({ id: "p2", displayName: "Other Principal" });
    await repo.sql`update approvals set principal_id='p2' where receipt_id=${decision.receipt.receiptId}`;
    await expect(boundary.execute(token, later)).rejects.toThrow(
      "VALID_APPROVAL_REQUIRED",
    );
    expect(sink.calls).toBe(0);
  });

  it("successful fake execution commits the reservation", async () => {
    const { token, reservationId } = await allowToken("commit-success");
    await boundary.execute(token, later);
    const rows =
      await repo.sql`select status from authorization_reservations where id=${reservationId}`;
    expect(rows[0]?.status).toBe("COMMITTED");
    expect(sink.calls).toBe(1);
  });
});
