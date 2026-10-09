import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mandateFingerprint } from "../src/canonical.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import {
  ExecutionGrantIssuer,
  type ExecutionGrantClaims,
} from "../src/execution-grant.js";
import type {
  AgentPassport,
  Mandate,
  Principal,
  TransactionProposal,
} from "../src/domain.js";
import {
  PayPalExecutionRail,
  PayPalProviderError,
  type PaymentProvider,
  type PayPalOrderView,
} from "../src/paypal.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
class LostResponseProvider implements PaymentProvider {
  createCalls = 0;
  captureCalls = 0;
  order: PayPalOrderView | undefined;
  async createOrder(): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.createCalls++;
    this.order = {
      id: "PAYPAL-ORDER-1",
      status: "APPROVED",
      purchaseUnits: [
        { referenceId: "proposal-2d", amountValue: "89.00", currency: "USD" },
      ],
      captures: [],
    };
    return this.order;
  }
  async captureOrder(): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.captureCalls++;
    this.order = {
      id: "PAYPAL-ORDER-1",
      status: "COMPLETED",
      purchaseUnits: [
        { referenceId: "proposal-2d", amountValue: "89.00", currency: "USD" },
      ],
      captures: [
        {
          id: "CAPTURE-1",
          status: "COMPLETED",
          amountValue: "89.00",
          currency: "USD",
        },
      ],
    };
    throw new PayPalProviderError("AMBIGUOUS", "SIMULATED_RESPONSE_LOSS");
  }
  async getOrder(): Promise<PayPalOrderView> {
    await Promise.resolve();
    if (!this.order) throw new Error("ORDER_NOT_FOUND");
    return this.order;
  }
}

class RecoveryProvider implements PaymentProvider {
  createIds: string[] = [];
  captureIds: string[] = [];
  calls: string[] = [];
  logicalOrders = 0;
  financialSideEffects = 0;
  createLosses = 0;
  captureLosses = 1;
  captureDespiteLoss = true;
  order: PayPalOrderView | undefined;
  afterGet?: () => Promise<void>;
  captureResult?: (order: PayPalOrderView) => PayPalOrderView;
  checkNetworkBoundary?: () => Promise<void>;
  async createOrder(
    input: Parameters<PaymentProvider["createOrder"]>[0],
  ): Promise<PayPalOrderView> {
    await this.checkNetworkBoundary?.();
    this.calls.push("CREATE");
    const newKey = !this.createIds.includes(input.requestId);
    this.createIds.push(input.requestId);
    if (newKey) {
      this.logicalOrders++;
      this.order = {
        id:
          this.logicalOrders === 1
            ? "RECOVERED-ORDER"
            : `RECOVERED-ORDER-${this.logicalOrders}`,
        status: "APPROVED",
        purchaseUnits: [
          {
            referenceId: input.merchantReference,
            amountValue: input.amountValue,
            currency: input.currency,
          },
        ],
        captures: [],
      };
    }
    if (this.createLosses-- > 0)
      throw new PayPalProviderError("AMBIGUOUS", "CREATE_RESPONSE_LOST");
    if (!this.order) throw new Error("ORDER_NOT_FOUND");
    return this.order;
  }
  async getOrder(id: string): Promise<PayPalOrderView> {
    await this.checkNetworkBoundary?.();
    this.calls.push("GET");
    if (!this.order || this.order.id !== id) throw new Error("ORDER_NOT_FOUND");
    await this.afterGet?.();
    return this.order;
  }
  async captureOrder(id: string, requestId: string): Promise<PayPalOrderView> {
    await this.checkNetworkBoundary?.();
    this.calls.push("CAPTURE");
    this.captureIds.push(requestId);
    if (!this.order || this.order.id !== id) throw new Error("ORDER_NOT_FOUND");
    const lost = this.captureLosses-- > 0;
    if ((!lost || this.captureDespiteLoss) && !this.order.captures.length) {
      this.financialSideEffects++;
      this.order = {
        ...this.order,
        status: "COMPLETED",
        captures: [
          {
            id: "RECOVERED-CAPTURE",
            status: "COMPLETED",
            amountValue: "89.00",
            currency: "USD",
          },
        ],
      };
    }
    if (lost)
      throw new PayPalProviderError("AMBIGUOUS", "CAPTURE_RESPONSE_LOST");
    return this.captureResult ? this.captureResult(this.order) : this.order;
  }
}

run("Milestone 2D durable PayPal execution", () => {
  let repo: PostgresTrustRepository;
  let auth: DurableAuthorizationService;
  let issuer: ExecutionGrantIssuer;
  const now = "2026-10-09T12:00:00.000Z";
  const { privateKey } = generateKeyPairSync("ed25519");
  const principal: Principal = { id: "p2d", displayName: "Principal" };
  const agent: AgentPassport = {
    id: "a2d",
    principalId: principal.id,
    displayName: "Agent",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    status: "ACTIVE",
    capabilities: ["CREATE_ORDER"],
  };
  const mandate: Mandate = {
    id: "m2d",
    principalId: principal.id,
    authorizedAgentId: agent.id,
    purpose: "Keyboard",
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
    nonce: "mandate-2d-nonce",
  };
  const proposal: TransactionProposal = {
    id: "proposal-2d",
    agentId: agent.id,
    mandateId: mandate.id,
    mandateFingerprint: mandateFingerprint(mandate),
    amount: { currency: "USD", minor: 8900 },
    merchant: { id: "merchant-2d", displayName: "Merchant" },
    category: "KEYBOARD",
    condition: "NEW",
    requestedCapability: "CREATE_ORDER",
    proposedAt: now,
    nonce: "proposal-2d-nonce",
    metadata: { sku: "keyboard" },
  };
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
    await repo.migrate(
      await readFile(
        "db/migrations/003_milestone_2d_paypal_execution.sql",
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
    issuer = new ExecutionGrantIssuer(repo, "2d-key", privateKey);
  });
  async function claimed(): Promise<{
    claims: ExecutionGrantClaims;
    reservationId: string;
  }> {
    await repo.saveProposal(proposal);
    const decision = await auth.authorizeProposal(proposal.id, "LOW", now);
    const reservationId = decision.reservation!.id;
    const token = await issuer.issue(reservationId, now);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
    ) as ExecutionGrantClaims;
    await repo.sql`update execution_grants set status='CLAIMED',claimed_at=${now} where id=${claims.jti}`;
    await repo.sql`update authorization_reservations set status='EXECUTING' where id=${reservationId}`;
    return { claims, reservationId };
  }

  it("quarantines unknown capture and restart reconciliation discovers the existing capture exactly once", async () => {
    const { claims, reservationId } = await claimed();
    const provider = new LostResponseProvider();
    const rail = new PayPalExecutionRail(repo, provider);
    await expect(rail.execute(claims)).rejects.toThrow(
      "PAYPAL_CAPTURE_UNKNOWN",
    );
    const attempts = await repo.sql`select * from payment_attempts`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("CAPTURE_UNKNOWN");
    expect(provider.createCalls).toBe(1);
    expect(provider.captureCalls).toBe(1);
    const restarted = PostgresTrustRepository.connect(url!);
    const recovered = new PayPalExecutionRail(restarted, provider);
    expect(
      await recovered.reconcile(
        String(attempts[0]!.id),
        "2026-10-09T12:01:00.000Z",
      ),
    ).toBe("CAPTURED");
    expect(provider.captureCalls).toBe(1);
    const finalAttempt =
      await restarted.sql`select status,provider_capture_id from payment_attempts`;
    expect(finalAttempt[0]!.status).toBe("CAPTURED");
    expect(finalAttempt[0]!.provider_capture_id).toBe("CAPTURE-1");
    const reservation =
      await restarted.sql`select status from authorization_reservations where id=${reservationId}`;
    const grant =
      await restarted.sql`select status from execution_grants where id=${claims.jti}`;
    expect(reservation[0]!.status).toBe("COMMITTED");
    expect(grant[0]!.status).toBe("CONSUMED");
    await restarted.close();
  });

  it("concurrent duplicate rail invocation creates one logical attempt", async () => {
    const { claims } = await claimed();
    const provider = new LostResponseProvider();
    const rail = new PayPalExecutionRail(repo, provider);
    await Promise.allSettled([rail.execute(claims), rail.execute(claims)]);
    const attempts = await repo.sql`select id from payment_attempts`;
    expect(attempts).toHaveLength(1);
  });
  const recoveryTime = "2026-10-09T12:01:00.000Z";
  async function unknown(provider: RecoveryProvider): Promise<{
    id: string;
    claims: ExecutionGrantClaims;
    reservationId: string;
  }> {
    const { claims, reservationId } = await claimed();
    await expect(
      new PayPalExecutionRail(repo, provider).execute(claims),
    ).rejects.toThrow("UNKNOWN");
    const rows = await repo.sql`select * from payment_attempts`;
    expect(rows).toHaveLength(1);
    const id = String(rows[0]!.id);
    // Fixed fixture clock, including the original retry-window origin.
    await repo.sql`update payment_attempts set created_at=${now} where id=${id}`;
    return { id, claims, reservationId };
  }
  async function quarantined(id: string, status: string): Promise<void> {
    const rows =
      await repo.sql`select a.status, g.status grant_status, r.status reservation_status
      from payment_attempts a join execution_grants g on g.id=a.grant_id
      join authorization_reservations r on r.id=a.reservation_id where a.id=${id}`;
    expect(rows[0]).toMatchObject({
      status,
      grant_status: "CLAIMED",
      reservation_status: "EXECUTING",
    });
    expect(
      (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
    ).toHaveLength(0);
    expect(
      (await repo.authorityAccounting(mandate.id, mandate.cumulativeLimitMinor))
        .activeReservedMinor,
    ).toBe(8900);
  }
  async function restartRecovery(
    provider: RecoveryProvider,
    id: string,
  ): Promise<string> {
    const restarted = PostgresTrustRepository.connect(url!);
    try {
      return await new PayPalExecutionRail(restarted, provider).reconcile(
        id,
        recoveryTime,
      );
    } finally {
      await restarted.close();
    }
  }

  it("recovers a lost create response after restart using the identical persisted key and one logical order", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 1;
    provider.captureLosses = 0;
    const { id } = await unknown(provider);
    await quarantined(id, "ORDER_CREATE_UNKNOWN");
    const before =
      await repo.sql`select create_order_request_id from payment_attempts where id=${id}`;
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    const after = await repo.sql`select * from payment_attempts where id=${id}`;
    expect(provider.createIds).toEqual([
      before[0]!.create_order_request_id,
      before[0]!.create_order_request_id,
    ]);
    expect(after[0]!.create_order_request_id).toBe(
      before[0]!.create_order_request_id,
    );
    expect(after[0]!.provider_order_id).toBe("RECOVERED-ORDER");
    expect(provider.logicalOrders).toBe(1);
    expect(provider.financialSideEffects).toBe(1);
    expect(await repo.sql`select id from payment_attempts`).toHaveLength(1);
  });

  it("repeated create ambiguity keeps the same key and quarantines authority", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 3;
    const { id } = await unknown(provider);
    expect(await restartRecovery(provider, id)).toBe("ORDER_CREATE_UNKNOWN");
    expect(await restartRecovery(provider, id)).toBe("ORDER_CREATE_UNKNOWN");
    expect(new Set(provider.createIds).size).toBe(1);
    expect(provider.logicalOrders).toBe(1);
    expect(provider.captureIds).toHaveLength(0);
    await quarantined(id, "ORDER_CREATE_UNKNOWN");
  });

  it("recovered create requiring payer action persists the original order without capturing", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 1;
    const { id } = await unknown(provider);
    provider.order = {
      ...provider.order!,
      status: "CREATED",
      payerActionUrl:
        "https://www.sandbox.paypal.com/checkoutnow?token=RECOVERED-ORDER",
    };
    expect(await restartRecovery(provider, id)).toBe("PAYER_ACTION_REQUIRED");
    expect(provider.captureIds).toHaveLength(0);
    expect(provider.logicalOrders).toBe(1);
    const rows =
      await repo.sql`select provider_order_id,payer_action_url from payment_attempts where id=${id}`;
    expect(rows[0]!.provider_order_id).toBe("RECOVERED-ORDER");
    expect(rows[0]!.payer_action_url).toBe(provider.order.payerActionUrl);
    await quarantined(id, "PAYER_ACTION_REQUIRED");
  });

  it("provider DID capture: restart GET discovers capture, never recaptures, side-effect count is exactly 1", async () => {
    const provider = new RecoveryProvider();
    const { id } = await unknown(provider);
    await quarantined(id, "CAPTURE_UNKNOWN");
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.calls).toEqual(["CREATE", "CAPTURE", "GET"]);
    expect(provider.captureIds).toHaveLength(1);
    expect(provider.financialSideEffects).toBe(1);
  });

  it("provider DID NOT capture: GET proves APPROVED with no capture, retry uses identical persisted key", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    expect(provider.financialSideEffects).toBe(0);
    const before =
      await repo.sql`select capture_request_id from payment_attempts where id=${id}`;
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.calls).toEqual(["CREATE", "CAPTURE", "GET", "CAPTURE"]);
    expect(provider.captureIds).toEqual([
      before[0]!.capture_request_id,
      before[0]!.capture_request_id,
    ]);
    const after =
      await repo.sql`select capture_request_id from payment_attempts where id=${id}`;
    expect(after[0]!.capture_request_id).toBe(before[0]!.capture_request_id);
    expect(provider.financialSideEffects).toBe(1);
  });

  it("repeated ambiguous capture retries remain quarantined with no false success", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    provider.captureLosses = 3;
    const { id } = await unknown(provider);
    expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
    expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
    expect(provider.calls).toEqual([
      "CREATE",
      "CAPTURE",
      "GET",
      "CAPTURE",
      "GET",
      "CAPTURE",
    ]);
    expect(new Set(provider.captureIds).size).toBe(1);
    expect(provider.financialSideEffects).toBe(0);
    await quarantined(id, "CAPTURE_UNKNOWN");
  });

  it.each(["CREATED", "COMPLETED", "PAYER_ACTION_REQUIRED"])(
    "does not retry an empty capture in unsafe order state %s",
    async (status) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      provider.order = { ...provider.order!, status };
      expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
      expect(provider.captureIds).toHaveLength(1);
      await quarantined(id, "CAPTURE_UNKNOWN");
    },
  );

  it("failed GET never retries capture and remains quarantined", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    provider.afterGet = () =>
      Promise.reject(new PayPalProviderError("TRANSIENT", "GET_FAILED"));
    expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
    expect(provider.captureIds).toHaveLength(1);
    await quarantined(id, "CAPTURE_UNKNOWN");
  });

  it.each(["order", "reference", "amount", "currency", "capture", "multiple"])(
    "rejects substituted %s before committing or retrying",
    async (binding) => {
      const provider = new RecoveryProvider();
      const { id } = await unknown(provider);
      const order = provider.order!;
      if (binding === "order") provider.order = { ...order, id: "OTHER-ORDER" };
      if (binding === "reference")
        provider.order = {
          ...order,
          purchaseUnits: [
            {
              referenceId: "OTHER-PROPOSAL",
              amountValue: "89.00",
              currency: "USD",
            },
          ],
        };
      if (binding === "amount")
        provider.order = {
          ...order,
          purchaseUnits: [
            { referenceId: proposal.id, amountValue: "90.00", currency: "USD" },
          ],
        };
      if (binding === "currency")
        provider.order = {
          ...order,
          purchaseUnits: [
            { referenceId: proposal.id, amountValue: "89.00", currency: "EUR" },
          ],
        };
      if (binding === "capture")
        provider.order = {
          ...order,
          captures: [{ ...order.captures[0]!, amountValue: "90.00" }],
        };
      if (binding === "multiple")
        provider.order = {
          ...order,
          captures: [
            ...order.captures,
            { ...order.captures[0]!, id: "OTHER-CAPTURE" },
          ],
        };
      if (binding === "order") {
        // Return a substituted ID rather than a lookup error.
        provider.getOrder = () => Promise.resolve(provider.order!);
      }
      await expect(restartRecovery(provider, id)).rejects.toThrow("MISMATCH");
      expect(provider.captureIds).toHaveLength(1);
      await quarantined(id, "CAPTURE_UNKNOWN");
    },
  );

  it.each([
    "grant state",
    "reservation state",
    "grant binding",
    "reservation binding",
  ])(
    "rolls back finalization for wrong %s even when corrupted after GET",
    async (corruption) => {
      const provider = new RecoveryProvider();
      const { id, claims, reservationId } = await unknown(provider);
      provider.afterGet = async () => {
        if (corruption === "grant state")
          await repo.sql`update execution_grants set status='ISSUED' where id=${claims.jti}`;
        if (corruption === "reservation state")
          await repo.sql`update authorization_reservations set status='AUTHORIZED' where id=${reservationId}`;
        if (corruption === "grant binding")
          await repo.sql`update execution_grants set merchant_id='OTHER-MERCHANT' where id=${claims.jti}`;
        if (corruption === "reservation binding")
          await repo.sql`update authorization_reservations set amount_minor=8901 where id=${reservationId}`;
      };
      await expect(restartRecovery(provider, id)).rejects.toThrow(
        corruption.includes("state")
          ? "FINALIZATION_STATE_INVALID"
          : "AUTHORITY_BINDING_MISMATCH",
      );
      const rows =
        await repo.sql`select status,provider_capture_id from payment_attempts where id=${id}`;
      expect(rows[0]).toMatchObject({
        status: "CAPTURE_UNKNOWN",
        provider_capture_id: null,
      });
      const grants =
        await repo.sql`select status from execution_grants where id=${claims.jti}`;
      const reservations =
        await repo.sql`select status from authorization_reservations where id=${reservationId}`;
      expect(grants[0]!.status).toBe(
        corruption === "grant state" ? "ISSUED" : "CLAIMED",
      );
      expect(reservations[0]!.status).toBe(
        corruption === "reservation state" ? "AUTHORIZED" : "EXECUTING",
      );
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(0);
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(1);
    },
  );

  it("verifies affected grant rows and rolls the entire transaction back on a suppressed transition", async () => {
    const provider = new RecoveryProvider();
    const { id } = await unknown(provider);
    await repo.sql.unsafe(
      "create function suppress_grant_transition() returns trigger language plpgsql as $$ begin return null; end $$",
    );
    await repo.sql.unsafe(
      "create trigger suppress_grant before update on execution_grants for each row execute function suppress_grant_transition()",
    );
    try {
      await expect(restartRecovery(provider, id)).rejects.toThrow(
        "PAYMENT_FINALIZATION_STATE_INVALID",
      );
      await quarantined(id, "CAPTURE_UNKNOWN");
      const rows =
        await repo.sql`select provider_capture_id from payment_attempts where id=${id}`;
      expect(rows[0]!.provider_capture_id).toBeNull();
    } finally {
      await repo.sql.unsafe("drop trigger suppress_grant on execution_grants");
      await repo.sql.unsafe("drop function suppress_grant_transition()");
    }
  });

  it.each([true, false])(
    "serializes concurrent restart reconciliation (provider captured=%s) and finalizes once",
    async (captured) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = captured;
      const { id, claims, reservationId } = await unknown(provider);
      const results = await Promise.all([
        restartRecovery(provider, id),
        restartRecovery(provider, id),
      ]);
      expect(results).toEqual(["CAPTURED", "CAPTURED"]);
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(captured ? 1 : 2);
      expect(new Set(provider.captureIds).size).toBe(1);
      const events = await repo.evidence();
      expect(events.filter((e) => e.type === "PAYMENT_COMMITTED")).toHaveLength(
        1,
      );
      expect(
        events.filter((e) => e.type === "PAYPAL_RECONCILIATION_RESOLVED"),
      ).toHaveLength(1);
      expect(
        (
          await repo.sql`select status from execution_grants where id=${claims.jti}`
        )[0]!.status,
      ).toBe("CONSUMED");
      expect(
        (
          await repo.sql`select status from authorization_reservations where id=${reservationId}`
        )[0]!.status,
      ).toBe("COMMITTED");
      expect(
        (await repo.sql`select status from payment_attempts where id=${id}`)[0]!
          .status,
      ).toBe("CAPTURED");
    },
  );

  it("holds no PostgreSQL transaction during recovery provider requests", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 1;
    provider.captureLosses = 0;
    const { id } = await unknown(provider);
    provider.checkNetworkBoundary = async () => {
      const rows =
        await repo.sql`select pid from pg_stat_activity where datname=current_database() and state='idle in transaction'`;
      expect(rows).toHaveLength(0);
    };
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.calls).toEqual(["CREATE", "CREATE", "GET", "CAPTURE"]);
  });

  it.each(["create", "capture"])(
    "does not retry %s beyond the conservative provider idempotency window",
    async (operation) => {
      const provider = new RecoveryProvider();
      provider.createLosses = operation === "create" ? 1 : 0;
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      expect(
        await new PayPalExecutionRail(repo, provider).reconcile(
          id,
          "2026-10-09T18:00:00.000Z",
        ),
      ).toBe(
        operation === "create" ? "ORDER_CREATE_UNKNOWN" : "CAPTURE_UNKNOWN",
      );
      expect(provider.createIds).toHaveLength(1);
      expect(provider.captureIds).toHaveLength(operation === "create" ? 0 : 1);
      await quarantined(
        id,
        operation === "create" ? "ORDER_CREATE_UNKNOWN" : "CAPTURE_UNKNOWN",
      );
    },
  );
  it.each(["order", "reference", "amount", "currency", "order status"])(
    "strictly revalidates %s after safe capture retry",
    async (binding) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      provider.captureResult = (order) => {
        if (binding === "order") return { ...order, id: "OTHER-ORDER" };
        if (binding === "reference")
          return {
            ...order,
            purchaseUnits: [{ referenceId: "OTHER-PROPOSAL" }],
          };
        if (binding === "amount")
          return {
            ...order,
            captures: [{ ...order.captures[0]!, amountValue: "90.00" }],
          };
        if (binding === "currency")
          return {
            ...order,
            captures: [{ ...order.captures[0]!, currency: "EUR" }],
          };
        return { ...order, status: "APPROVED" };
      };
      await expect(restartRecovery(provider, id)).rejects.toThrow("MISMATCH");
      expect(provider.calls).toEqual(["CREATE", "CAPTURE", "GET", "CAPTURE"]);
      expect(provider.captureIds[1]).toBe(provider.captureIds[0]);
      expect(provider.financialSideEffects).toBe(1);
      await quarantined(id, "CAPTURE_UNKNOWN");
    },
  );

  it.each(["PENDING", "UNRECOGNIZED"])(
    "does not report success for capture retry status %s",
    async (status) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      provider.captureResult = (order) => ({
        ...order,
        captures: [{ ...order.captures[0]!, status }],
      });
      const expected =
        status === "PENDING" ? "CAPTURE_PENDING_PROVIDER" : "CAPTURE_UNKNOWN";
      expect(await restartRecovery(provider, id)).toBe(expected);
      expect(provider.captureIds[1]).toBe(provider.captureIds[0]);
      await quarantined(id, expected);
    },
  );
  it.each(["unavailable", "missing", "substituted"])(
    "does not falsely report successful repeated reconciliation when finalized provider capture is %s",
    async (problem) => {
      const provider = new RecoveryProvider();
      const { id } = await unknown(provider);
      expect(await restartRecovery(provider, id)).toBe("CAPTURED");
      if (problem === "unavailable")
        provider.afterGet = () => Promise.reject(new Error("GET_FAILED"));
      if (problem === "missing")
        provider.order = { ...provider.order!, captures: [] };
      if (problem === "substituted")
        provider.order = {
          ...provider.order!,
          captures: [{ ...provider.order!.captures[0]!, id: "OTHER-CAPTURE" }],
        };
      await expect(restartRecovery(provider, id)).rejects.toThrow(
        problem === "unavailable" ? "UNVERIFIED" : "MISMATCH",
      );
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(1);
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(1);
    },
  );
});
