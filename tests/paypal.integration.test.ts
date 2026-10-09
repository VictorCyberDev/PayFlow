import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mandateFingerprint } from "../src/canonical.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import { ExecutionGrantIssuer, type ExecutionGrantClaims } from "../src/execution-grant.js";
import type { AgentPassport, Mandate, Principal, TransactionProposal } from "../src/domain.js";
import { PayPalExecutionRail, PayPalProviderError, type PaymentProvider, type PayPalOrderView } from "../src/paypal.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
class LostResponseProvider implements PaymentProvider {
  createCalls = 0; captureCalls = 0; order: PayPalOrderView | undefined;
  async createOrder(): Promise<PayPalOrderView> { this.createCalls++; this.order = { id: "PAYPAL-ORDER-1", status: "APPROVED", captures: [] }; return this.order; }
  async captureOrder(): Promise<PayPalOrderView> { this.captureCalls++; this.order = { id: "PAYPAL-ORDER-1", status: "COMPLETED", captures: [{ id: "CAPTURE-1", status: "COMPLETED", amountValue: "89.00", currency: "USD" }] }; throw new PayPalProviderError("AMBIGUOUS", "SIMULATED_RESPONSE_LOSS"); }
  async getOrder(): Promise<PayPalOrderView> { if (!this.order) throw new Error("ORDER_NOT_FOUND"); return this.order; }
}

run("Milestone 2D durable PayPal execution", () => {
  let repo: PostgresTrustRepository; let auth: DurableAuthorizationService; let issuer: ExecutionGrantIssuer;
  const now = "2026-10-09T12:00:00.000Z"; const { privateKey } = generateKeyPairSync("ed25519");
  const principal: Principal = { id: "p2d", displayName: "Principal" };
  const agent: AgentPassport = { id: "a2d", principalId: principal.id, displayName: "Agent", issuedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", status: "ACTIVE", capabilities: ["CREATE_ORDER"] };
  const mandate: Mandate = { id: "m2d", principalId: principal.id, authorizedAgentId: agent.id, purpose: "Keyboard", category: "KEYBOARD", currency: "USD", maxSingleTransactionMinor: 10000, cumulativeLimitMinor: 10000, allowedConditions: ["NEW"], merchantRiskCeiling: "MEDIUM", autonomousPurchaseThresholdMinor: 10000, humanApprovalThresholdMinor: 10000, allowedCapabilities: ["CREATE_ORDER"], createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", version: 1, nonce: "mandate-2d-nonce" };
  const proposal: TransactionProposal = { id: "proposal-2d", agentId: agent.id, mandateId: mandate.id, mandateFingerprint: mandateFingerprint(mandate), amount: { currency: "USD", minor: 8900 }, merchant: { id: "merchant-2d", displayName: "Merchant" }, category: "KEYBOARD", condition: "NEW", requestedCapability: "CREATE_ORDER", proposedAt: now, nonce: "proposal-2d-nonce", metadata: { sku: "keyboard" } };
  beforeAll(async () => { repo = PostgresTrustRepository.connect(url!); await repo.sql`drop schema public cascade`; await repo.sql`create schema public`; await repo.migrate(await readFile("db/migrations/001_milestone_2a_durable_foundation.sql", "utf8")); await repo.migrate(await readFile("db/migrations/002_milestone_2c_execution_grants.sql", "utf8")); await repo.migrate(await readFile("db/migrations/003_milestone_2d_paypal_execution.sql", "utf8")); });
  afterAll(async () => repo.close());
  beforeEach(async () => { await repo.sql`truncate execution_grants,evidence_events,payment_attempts,authorization_reservations,approvals,decision_receipts,transaction_proposals,replay_keys,mandates,agent_passports,principals restart identity cascade`; await repo.savePrincipal(principal); await repo.saveAgent(agent); await repo.saveMandate(mandate); auth = new DurableAuthorizationService(repo, 60_000); issuer = new ExecutionGrantIssuer(repo, "2d-key", privateKey); });
  async function claimed(): Promise<{ claims: ExecutionGrantClaims; reservationId: string }> { await repo.saveProposal(proposal); const decision = await auth.authorizeProposal(proposal.id, "LOW", now); const reservationId = decision.reservation!.id; const token = await issuer.issue(reservationId, now); const claims = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as ExecutionGrantClaims; await repo.sql`update execution_grants set status='CLAIMED',claimed_at=${now} where id=${claims.jti}`; await repo.sql`update authorization_reservations set status='EXECUTING' where id=${reservationId}`; return { claims, reservationId }; }

  it("quarantines unknown capture and restart reconciliation discovers the existing capture exactly once", async () => {
    const { claims, reservationId } = await claimed(); const provider = new LostResponseProvider(); const rail = new PayPalExecutionRail(repo, provider);
    await expect(rail.execute(claims)).rejects.toThrow("PAYPAL_CAPTURE_UNKNOWN");
    const attempts = await repo.sql`select * from payment_attempts`; expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe("CAPTURE_UNKNOWN"); expect(provider.createCalls).toBe(1); expect(provider.captureCalls).toBe(1);
    const restarted = PostgresTrustRepository.connect(url!); const recovered = new PayPalExecutionRail(restarted, provider); expect(await recovered.reconcile(String(attempts[0]!.id), "2026-10-09T12:01:00.000Z")).toBe("CAPTURED"); expect(provider.captureCalls).toBe(1);
    const finalAttempt = await restarted.sql`select status,provider_capture_id from payment_attempts`; expect(finalAttempt[0]!.status).toBe("CAPTURED"); expect(finalAttempt[0]!.provider_capture_id).toBe("CAPTURE-1");
    const reservation = await restarted.sql`select status from authorization_reservations where id=${reservationId}`; const grant = await restarted.sql`select status from execution_grants where id=${claims.jti}`; expect(reservation[0]!.status).toBe("COMMITTED"); expect(grant[0]!.status).toBe("CONSUMED"); await restarted.close();
  });

  it("concurrent duplicate rail invocation creates one logical attempt", async () => {
    const { claims } = await claimed(); const provider = new LostResponseProvider(); const rail = new PayPalExecutionRail(repo, provider); await Promise.allSettled([rail.execute(claims), rail.execute(claims)]); const attempts = await repo.sql`select id from payment_attempts`; expect(attempts).toHaveLength(1);
  });
});
