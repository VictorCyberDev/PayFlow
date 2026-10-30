import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DurableAuthorizationService } from "../src/durable-service.js";
import type { AgentPassport, Mandate, Principal } from "../src/domain.js";
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  FakeExecutionSink,
  StaticPublicKeyRing,
} from "../src/execution-grant.js";
import { DurableFinancialAuthorityGateway } from "../src/network/durable-gateway.js";
import { GATEWAY_AUDIENCE } from "../src/network/gateway.js";
import { PostgresNetworkStore } from "../src/network/postgres-adapters.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const scalar = (
  rows: readonly Record<string, unknown>[],
  key: string,
): unknown => rows[0]?.[key];
const run = url ? describe : describe.skip;

run("M7–M15 durable Gateway and control-plane adapters (PostgreSQL)", () => {
  let repo: PostgresTrustRepository;
  let gateway: DurableFinancialAuthorityGateway;
  let store: PostgresNetworkStore;
  let sink: FakeExecutionSink;
  let boundary: ExecutionBoundary;
  const now = "2026-10-28T03:00:00.000Z";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const principal: Principal = { id: "principal-1", displayName: "Finance" };
  const agent: AgentPassport = {
    id: "agent-1",
    principalId: principal.id,
    displayName: "Procurement Agent",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "ACTIVE",
    capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
  };
  const mandate: Mandate = {
    id: "mandate-1",
    principalId: principal.id,
    authorizedAgentId: agent.id,
    purpose: "approved lab supplies",
    category: "LAB_SUPPLIES",
    currency: "USD",
    maxSingleTransactionMinor: 10_000,
    cumulativeLimitMinor: 15_000,
    merchantScope: { mode: "ONLY", ids: ["merchant-approved"] },
    allowedConditions: ["NEW"],
    merchantRiskCeiling: "LOW",
    autonomousPurchaseThresholdMinor: 10_000,
    humanApprovalThresholdMinor: 10_000,
    allowedCapabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    version: 1,
    nonce: "mandate-nonce-0001",
  };
  const access = {
    clientId: "client-1",
    agentId: agent.id,
    principalId: principal.id,
    audience: GATEWAY_AUDIENCE,
    scopes: ["authority:read" as const, "action:request" as const],
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "ACTIVE" as const,
  };
  const trusted = { now, merchantRisk: "LOW" as const };
  function body(overrides: Record<string, unknown> = {}) {
    return {
      mandateId: mandate.id,
      agentId: agent.id,
      amount: { currency: "USD", minor: 6_000 },
      merchant: { id: "merchant-approved", displayName: "Approved" },
      category: "LAB_SUPPLIES",
      condition: "NEW",
      requestedCapability: "CAPTURE_PAYMENT",
      proposedAt: now,
      nonce: "gateway-nonce-000001",
      metadata: {},
      ...overrides,
    };
  }

  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    const names = (await readdir("db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    // Fresh-database migration order proves 001..019 apply cleanly together.
    for (const name of names) {
      await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
    }
    store = new PostgresNetworkStore(repo.sql);
  });
  afterAll(async () => repo.close());
  beforeEach(async () => {
    await repo.sql`truncate usage_events,organization_agents,authority_ownership,organizations,verification_replay_keys,execution_grants,evidence_events,payment_attempts,authorization_reservations,approvals,decision_receipts,transaction_proposals,replay_keys,mandates,agent_passports,principals restart identity cascade`;
    await repo.savePrincipal(principal);
    await repo.saveAgent(agent);
    await repo.saveMandate(mandate);
    sink = new FakeExecutionSink();
    gateway = new DurableFinancialAuthorityGateway(
      repo,
      new DurableAuthorizationService(repo, 600_000),
      new ExecutionGrantIssuer(repo, "key-1", privateKey),
    );
    boundary = new ExecutionBoundary(
      repo,
      new StaticPublicKeyRing(new Map([["key-1", publicKey]])),
      sink,
    );
  });

  it("an allowed external request creates one durable Reservation and a grant that executes exactly once", async () => {
    const result = await gateway.requestAction(access, body(), trusted);
    expect(result.decision.decision).toBe("ALLOW");
    expect(result.reservationId).toBeTruthy();
    expect(result.executionGrant).toBeTruthy();
    const count = scalar(
      await repo.sql`select count(*)::int count from authorization_reservations`,
      "count",
    );
    expect(count).toBe(1);

    const executed = await boundary.execute(result.executionGrant!, now);
    expect(executed.executionId).toBeTruthy();
    expect(sink.calls).toBe(1);
    // The grant is one-time: a second presentation must not reach the sink again.
    await expect(
      boundary.execute(result.executionGrant!, now),
    ).rejects.toThrow();
    expect(sink.calls).toBe(1);
  });

  it("drift is denied with no Reservation and no grant", async () => {
    const result = await gateway.requestAction(
      access,
      body({
        amount: { currency: "USD", minor: 12_000 },
        merchant: { id: "merchant-evil", displayName: "Evil" },
      }),
      trusted,
    );
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.reasonCodes).toContain("AMOUNT_EXCEEDS_LIMIT");
    expect(result.decision.reasonCodes).toContain("MERCHANT_NOT_ALLOWED");
    expect(result.executionGrant).toBeUndefined();
    const count = scalar(
      await repo.sql`select count(*)::int count from authorization_reservations`,
      "count",
    );
    expect(count).toBe(0);
  });

  it("20 concurrent identical requests produce exactly one Reservation and one grant", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        gateway.requestAction(access, body(), trusted),
      ),
    );
    const settled = results.flatMap((entry) =>
      entry.status === "fulfilled" ? [entry.value] : [],
    );
    const allowed = settled.filter(
      (entry) => entry.decision.decision === "ALLOW",
    );
    expect(allowed).toHaveLength(1);
    expect(settled.filter((entry) => entry.executionGrant)).toHaveLength(1);
    const count = scalar(
      await repo.sql`select count(*)::int count from authorization_reservations`,
      "count",
    );
    expect(count).toBe(1);
    const spent = scalar(
      await repo.sql`select coalesce(sum(amount_minor),0)::int spent from authorization_reservations`,
      "spent",
    );
    expect(spent).toBe(6_000);
  });

  it("the cumulative limit holds across sequential requests (6000 + 6000 allowed, third denied)", async () => {
    const first = await gateway.requestAction(
      access,
      body({ nonce: "nonce-aaaaaaaaaaaa01" }),
      trusted,
    );
    const second = await gateway.requestAction(
      access,
      body({ nonce: "nonce-aaaaaaaaaaaa02" }),
      trusted,
    );
    const third = await gateway.requestAction(
      access,
      body({ nonce: "nonce-aaaaaaaaaaaa03" }),
      trusted,
    );
    expect(first.decision.decision).toBe("ALLOW");
    expect(second.decision.decision).toBe("ALLOW");
    expect(third.decision.decision).toBe("DENY");
    expect(third.decision.reasonCodes).toContain("CUMULATIVE_LIMIT_EXCEEDED");
    expect(third.executionGrant).toBeUndefined();
  });

  it("a revoked Authority fails closed before any proposal or Reservation is written", async () => {
    await repo.revokeMandate(mandate.id, now);
    await expect(
      gateway.requestAction(access, body(), trusted),
    ).rejects.toMatchObject({
      code: "AUTHORITY_INACTIVE",
    });
    const proposals = scalar(
      await repo.sql`select count(*)::int proposals from transaction_proposals`,
      "proposals",
    );
    expect(proposals).toBe(0);
  });

  it("a revocation after authorization blocks the already-issued grant at the Execution Boundary", async () => {
    const result = await gateway.requestAction(access, body(), trusted);
    await repo.revokeMandate(mandate.id, "2026-10-28T03:00:10.000Z");
    await expect(
      boundary.execute(result.executionGrant!, "2026-10-28T03:00:20.000Z"),
    ).rejects.toThrow();
    expect(sink.calls).toBe(0);
  });

  it("an access token for another agent or principal is refused", async () => {
    await expect(
      gateway.requestAction(
        { ...access, agentId: "agent-other" },
        body(),
        trusted,
      ),
    ).rejects.toMatchObject({ code: "ACCESS_AGENT_MISMATCH" });
    await expect(
      gateway.requestAction(
        { ...access, principalId: "principal-other" },
        body(),
        trusted,
      ),
    ).rejects.toMatchObject({ code: "ACCESS_PRINCIPAL_MISMATCH" });
  });

  describe("tenant isolation", () => {
    beforeEach(async () => {
      await store.createOrganization("org-a", "Org A");
      await store.createOrganization("org-b", "Org B");
      await store.assignAuthority("org-a", "SANDBOX", mandate.id, principal.id);
    });

    it("lists and resolves only the caller's own tenant and environment", async () => {
      expect(await store.listAuthorityIds("org-a", "SANDBOX")).toEqual([
        mandate.id,
      ]);
      expect(await store.listAuthorityIds("org-b", "SANDBOX")).toEqual([]);
      expect(await store.listAuthorityIds("org-a", "PRODUCTION")).toEqual([]);
      await expect(
        store.requireOwnedAuthority("org-b", "SANDBOX", mandate.id),
      ).rejects.toThrow("CROSS_TENANT_ACCESS_DENIED");
      await expect(
        store.requireOwnedAuthority("org-a", "PRODUCTION", mandate.id),
      ).rejects.toThrow("CROSS_ENVIRONMENT_ACCESS_DENIED");
      await expect(
        store.requireOwnedAuthority("org-b", "SANDBOX", "does-not-exist"),
      ).rejects.toThrow("CROSS_TENANT_ACCESS_DENIED");
      expect(
        (await store.requireOwnedAuthority("org-a", "SANDBOX", mandate.id))
          .ownerPrincipalId,
      ).toBe(principal.id);
    });

    it("agent lifecycle is tenant-scoped and monotone (REVOKED is terminal)", async () => {
      await store.registerAgent("org-a", "SANDBOX", agent.id, principal.id);
      await expect(
        store.transitionAgent("org-b", "SANDBOX", agent.id, "ACTIVE"),
      ).rejects.toThrow("CROSS_TENANT_ACCESS_DENIED");
      expect(
        await store.transitionAgent("org-a", "SANDBOX", agent.id, "ACTIVE"),
      ).toBe("ACTIVE");
      expect(
        await store.transitionAgent("org-a", "SANDBOX", agent.id, "REVOKED"),
      ).toBe("REVOKED");
      await expect(
        store.transitionAgent("org-a", "SANDBOX", agent.id, "ACTIVE"),
      ).rejects.toThrow("INVALID_AGENT_LIFECYCLE_TRANSITION");
      expect(await store.agentLifecycle("org-a", "SANDBOX", agent.id)).toBe(
        "REVOKED",
      );
      expect(
        await store.agentLifecycle("org-b", "SANDBOX", agent.id),
      ).toBeNull();
    });

    it("usage metering is idempotent and tenant-scoped", async () => {
      const event = {
        id: "u1",
        organizationId: "org-a",
        environment: "SANDBOX" as const,
        meter: "GOVERNED_ACTION" as const,
        quantity: 1,
        occurredAt: now,
        idempotencyKey: "usage-key-1",
      };
      expect(await store.recordUsage(event)).toBe("RECORDED");
      expect(await store.recordUsage({ ...event, id: "u2" })).toBe("DUPLICATE");
      expect(
        await store.usageEvents(
          "org-a",
          "SANDBOX",
          "2026-10-28T00:00:00Z",
          "2026-10-29T00:00:00Z",
        ),
      ).toHaveLength(1);
      expect(
        await store.usageEvents(
          "org-b",
          "SANDBOX",
          "2026-10-28T00:00:00Z",
          "2026-10-29T00:00:00Z",
        ),
      ).toHaveLength(0);
    });
  });

  it("Verify presentation replay claims are atomic across concurrent verifiers", async () => {
    const claims = await Promise.all(
      Array.from({ length: 15 }, () =>
        store.claimVerificationReplay("verify:aud:challenge", "nonce-1"),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const stored = scalar(
      await repo.sql`select replay_key stored from verification_replay_keys`,
      "stored",
    );
    expect(stored).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored).not.toContain("nonce");
  });
});
