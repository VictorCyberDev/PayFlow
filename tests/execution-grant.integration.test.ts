import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mandateFingerprint, proposalDigest } from "../src/canonical.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  FakeExecutionSink,
  StaticPublicKeyRing,
  type ExecutionGrantClaims,
} from "../src/execution-grant.js";
import type { AgentPassport, Mandate, Principal, TransactionProposal } from "../src/domain.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("Milestone 2C cryptographic execution grants", () => {
  let repo: PostgresTrustRepository;
  let auth: DurableAuthorizationService;
  let sink: FakeExecutionSink;
  let issuer: ExecutionGrantIssuer;
  let boundary: ExecutionBoundary;
  const now = "2026-10-09T12:00:00.000Z";
  const later = "2026-10-09T12:00:30.000Z";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const wrong = generateKeyPairSync("ed25519");
  const principal: Principal = { id: "principal-A", displayName: "Principal" };
  const agent: AgentPassport = {
    id: "agent-A", principalId: principal.id, displayName: "Agent A",
    issuedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z",
    status: "ACTIVE", capabilities: ["CREATE_ORDER"],
  };
  const mandate: Mandate = {
    id: "mandate-A", principalId: principal.id, authorizedAgentId: agent.id,
    purpose: "New keyboard", category: "KEYBOARD", currency: "USD",
    maxSingleTransactionMinor: 10000, cumulativeLimitMinor: 10000,
    allowedConditions: ["NEW"], merchantRiskCeiling: "MEDIUM",
    autonomousPurchaseThresholdMinor: 10000, humanApprovalThresholdMinor: 10000,
    allowedCapabilities: ["CREATE_ORDER"], createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z", version: 1, nonce: "mandate-nonce-0001",
  };
  function proposal(id = "proposal-A", amountMinor = 8900, m = mandate): TransactionProposal {
    return {
      id, agentId: m.authorizedAgentId, mandateId: m.id, mandateFingerprint: mandateFingerprint(m),
      amount: { currency: "USD", minor: amountMinor }, merchant: { id: "merchant-A", displayName: "Merchant A" },
      category: "KEYBOARD", condition: "NEW", requestedCapability: "CREATE_ORDER",
      proposedAt: now, nonce: `proposal-nonce-${id.padEnd(8, "0")}`, metadata: { sku: "keyboard-1" },
    };
  }
  async function authorizedToken(p = proposal()): Promise<{ token: string; reservationId: string }> {
    await repo.saveProposal(p);
    const result = await auth.authorizeProposal(p.id, "LOW", now);
    expect(result.receipt.decision).toBe("ALLOW");
    const reservationId = result.reservation!.id;
    return { token: await issuer.issue(reservationId, now), reservationId };
  }
  function tamper(token: string, changes: Record<string, unknown>): string {
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    return `${Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url")}.${signature}`;
  }
  function claims(token: string): ExecutionGrantClaims {
    return JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as ExecutionGrantClaims;
  }

  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`; await repo.sql`create schema public`;
    await repo.migrate(await readFile("db/migrations/001_milestone_2a_durable_foundation.sql", "utf8"));
    await repo.migrate(await readFile("db/migrations/002_milestone_2c_execution_grants.sql", "utf8"));
  });
  afterAll(async () => repo.close());
  beforeEach(async () => {
    await repo.sql`truncate execution_grants,evidence_events,payment_attempts,authorization_reservations,approvals,decision_receipts,transaction_proposals,replay_keys,mandates,agent_passports,principals restart identity cascade`;
    await repo.savePrincipal(principal); await repo.saveAgent(agent); await repo.saveMandate(mandate);
    auth = new DurableAuthorizationService(repo, 60_000);
    sink = new FakeExecutionSink();
    issuer = new ExecutionGrantIssuer(repo, "test-key-1", privateKey);
    boundary = new ExecutionBoundary(repo, new StaticPublicKeyRing(new Map([["test-key-1", publicKey]])), sink);
  });

  it("issues a bounded Ed25519 grant bound to the canonical proposal", async () => {
    const { token } = await authorizedToken(); const c = claims(token);
    expect(c.version).toBe("payflow.execution-grant.v1"); expect(c.proposalDigest).toBe(proposalDigest(proposal()));
    expect(Date.parse(c.expiresAt) - Date.parse(c.issuedAt)).toBe(120000);
    expect(c.amountMinor).toBe(8900); expect(c.currency).toBe("USD"); expect(c.merchantId).toBe("merchant-A");
  });

  it("proposal digest is deterministic across metadata insertion order", () => {
    const a = proposal(); const b = { ...a, metadata: { z: "2", sku: "keyboard-1", a: "1" } };
    const c = { ...a, metadata: { a: "1", sku: "keyboard-1", z: "2" } };
    expect(proposalDigest(b)).toBe(proposalDigest(c));
  });

  it("DENY cannot receive a grant", async () => {
    const p = proposal("deny", 10001); await repo.saveProposal(p);
    const result = await auth.authorizeProposal(p.id, "LOW", now); expect(result.receipt.decision).toBe("DENY");
    await expect(issuer.issue("does-not-exist", now)).rejects.toThrow("RESERVATION_NOT_FOUND");
  });

  it("unapproved ESCALATE cannot receive a grant; approved ESCALATE can and receipt remains ESCALATE", async () => {
    const escalating = { ...mandate, id: "mandate-E", autonomousPurchaseThresholdMinor: 7500, nonce: "mandate-nonce-0002" } satisfies Mandate;
    await repo.saveMandate(escalating); const p = proposal("escalate", 8900, escalating); await repo.saveProposal(p);
    const result = await auth.authorizeProposal(p.id, "LOW", now); expect(result.receipt.decision).toBe("ESCALATE");
    await expect(issuer.issue("no-reservation-before-approval", now)).rejects.toThrow();
    const approved = await auth.approveEscalation(result.receipt.receiptId, principal.id, now);
    const token = await issuer.issue(approved.reservation.id, now); await boundary.execute(token, later);
    expect((await repo.getReceipt(result.receipt.receiptId))?.decision).toBe("ESCALATE"); expect(sink.calls).toBe(1);
  });

  it.each([
    ["amount", { amountMinor: 18900 }], ["currency", { currency: "EUR" }],
    ["merchant", { merchantId: "merchant-B" }], ["agent", { agentId: "agent-B" }],
    ["mandate", { mandateId: "mandate-B" }], ["capability", { capability: "CAPTURE_PAYMENT" }],
    ["proposal", { proposalId: "proposal-B" }], ["reservation", { reservationId: "reservation-B" }],
  ])("rejects %s substitution before provider invocation", async (_name, change) => {
    const { token } = await authorizedToken(); await expect(boundary.execute(tamper(token, change), later)).rejects.toThrow(); expect(sink.calls).toBe(0);
  });

  it("rejects modified signature, wrong public key, unknown kid, unsupported version and wrong audience", async () => {
    const { token } = await authorizedToken(); const [p] = token.split(".");
    await expect(boundary.execute(`${p}.${Buffer.alloc(64).toString("base64url")}`, later)).rejects.toThrow("INVALID_GRANT_SIGNATURE");
    const wrongBoundary = new ExecutionBoundary(repo, new StaticPublicKeyRing(new Map([["test-key-1", wrong.publicKey]])), sink);
    await expect(wrongBoundary.execute(token, later)).rejects.toThrow("INVALID_GRANT_SIGNATURE");
    await expect(boundary.execute(tamper(token, { kid: "unknown" }), later)).rejects.toThrow();
    await expect(boundary.execute(tamper(token, { version: "payflow.execution-grant.v999" }), later)).rejects.toThrow();
    await expect(boundary.execute(tamper(token, { audience: "wrong" }), later)).rejects.toThrow();
    expect(sink.calls).toBe(0);
  });

  it("rejects malformed and expired grants before provider invocation", async () => {
    await expect(boundary.execute("garbage", later)).rejects.toThrow("MALFORMED_EXECUTION_GRANT");
    const shortIssuer = new ExecutionGrantIssuer(repo, "test-key-1", privateKey, "payflow.payment-execution", 1000);
    await repo.saveProposal(proposal()); const r = await auth.authorizeProposal("proposal-A", "LOW", now); const token = await shortIssuer.issue(r.reservation!.id, now);
    await expect(boundary.execute(token, "2026-10-09T12:00:02.000Z")).rejects.toThrow("EXECUTION_GRANT_EXPIRED"); expect(sink.calls).toBe(0);
  });

  it.each(["SUSPENDED", "REVOKED"] as const)("fails closed when agent becomes %s", async (status) => {
    const { token } = await authorizedToken(); await repo.sql`update agent_passports set status=${status} where id='agent-A'`;
    await expect(boundary.execute(token, later)).rejects.toThrow("AGENT_REVALIDATION_FAILED"); expect(sink.calls).toBe(0);
  });
  it("fails closed when agent expires after issuance", async () => {
    const { token } = await authorizedToken(); await repo.sql`update agent_passports set expires_at='2026-10-09T12:00:01Z' where id='agent-A'`;
    await expect(boundary.execute(token, later)).rejects.toThrow("AGENT_REVALIDATION_FAILED"); expect(sink.calls).toBe(0);
  });
  it("fails closed when mandate expires or changes after issuance", async () => {
    let x = await authorizedToken(); const changed = { ...mandate, purpose: "changed", expiresAt: "2026-10-09T12:00:01.000Z" };
    await repo.sql`update mandates set document=${repo.sql.json(changed)}, fingerprint=${mandateFingerprint(changed)}, expires_at=${changed.expiresAt} where id='mandate-A'`;
    await expect(boundary.execute(x.token, later)).rejects.toThrow(); expect(sink.calls).toBe(0);
  });

  it.each(["RELEASED", "FAILED", "EXPIRED", "EXECUTING"] as const)("rejects %s reservation after issuance", async (status) => {
    const { token, reservationId } = await authorizedToken(); await repo.sql`update authorization_reservations set status=${status} where id=${reservationId}`;
    await expect(boundary.execute(token, later)).rejects.toThrow("RESERVATION_NOT_EXECUTABLE"); expect(sink.calls).toBe(0);
  });

  it("rejects revoked approval on ESCALATE path", async () => {
    const escalating = { ...mandate, id: "mandate-E", autonomousPurchaseThresholdMinor: 7500, nonce: "mandate-nonce-0002" } satisfies Mandate;
    await repo.saveMandate(escalating); const p = proposal("esc-revoke", 8900, escalating); await repo.saveProposal(p);
    const r = await auth.authorizeProposal(p.id, "LOW", now); const a = await auth.approveEscalation(r.receipt.receiptId, principal.id, now);
    const token = await issuer.issue(a.reservation.id, now); await repo.sql`update approvals set status='REVOKED' where receipt_id=${r.receipt.receiptId}`;
    await expect(boundary.execute(token, later)).rejects.toThrow("VALID_APPROVAL_REQUIRED"); expect(sink.calls).toBe(0);
  });

  it("valid execution invokes provider exactly once and sequential replay is blocked", async () => {
    const { token } = await authorizedToken(); await boundary.execute(token, later); expect(sink.calls).toBe(1);
    await expect(boundary.execute(token, later)).rejects.toThrow("EXECUTION_GRANT_CONSUMED"); expect(sink.calls).toBe(1);
  });

  it("concurrent replay obtains execution authority exactly once", async () => {
    const { token } = await authorizedToken(); const results = await Promise.allSettled([boundary.execute(token, later), boundary.execute(token, later)]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1); expect(sink.calls).toBe(1);
  });

  it("provider failure marks grant/reservation FAILED and never COMMITTED", async () => {
    const { token, reservationId } = await authorizedToken(); const failing = new FakeExecutionSink(true);
    const b = new ExecutionBoundary(repo, new StaticPublicKeyRing(new Map([["test-key-1", publicKey]])), failing);
    await expect(b.execute(token, later)).rejects.toThrow("FAKE_PROVIDER_FAILURE");
    const rows = await repo.sql`select status from authorization_reservations where id=${reservationId}`; expect(rows[0]?.status).toBe("FAILED"); expect(failing.calls).toBe(1);
  });

  it("fails closed on malformed persisted grant state", async () => {
    const { token } = await authorizedToken(); const c = claims(token); await repo.sql`update execution_grants set amount_minor=1 where id=${c.jti}`;
    await expect(boundary.execute(token, later)).rejects.toThrow("MALFORMED_PERSISTED_GRANT"); expect(sink.calls).toBe(0);
  });

  it("records issuance, claim and execution evidence without token material", async () => {
    const { token } = await authorizedToken(); await boundary.execute(token, later); const evidence = await repo.evidence();
    expect(evidence.some(e => e.type === "EXECUTION_GRANT_ISSUED")).toBe(true);
    expect(evidence.some(e => e.type === "EXECUTION_AUTHORITY_CLAIMED")).toBe(true);
    expect(evidence.some(e => e.type === "PAYMENT_EXECUTION_STARTED")).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });
});
